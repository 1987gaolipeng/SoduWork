"""Upgrade, rollback and restore of cloud durability without authorizing drafts."""
from contextlib import closing
import io
import importlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from alembic import command
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import JSON, Integer, MetaData, Table, create_engine, inspect

from app.config import get_settings
from app.schema_migrations import _config

OLD = '0073_remote_screen_grants'
NEW = '0074_cloud_execution_durability'


class CloudDurabilityMigrationTests(unittest.TestCase):
    def seed(self, database):
        engine = create_engine('sqlite:///' + database.as_posix())
        try:
            with engine.begin() as connection:
                for name, supplied in (
                    ('conversation_handoff', dict(id='draft', owner_client_id='device', owner_user_id='user',
                        transfer_id='draft', task_id='task', phase='prepared', source={'preserved': True})),
                    ('conversation_message_receipt', dict(id='old-send', owner_client_id='device',
                        task_id='task', message_id='message', phase='uncertain', receipt={'uncertain': True})),
                    ('automation_execution_session', dict(id='execution', task_id='task', ref='original-ref',
                        seq=7, metadata={'round': 2})),
                ):
                    table = Table(name, MetaData(), autoload_with=connection)
                    values = {}
                    for column in table.columns:
                        if column.name in supplied or column.nullable or column.server_default:
                            continue
                        values[column.name] = ({} if isinstance(column.type, JSON) else
                                               0 if isinstance(column.type, Integer) else '')
                    connection.execute(table.insert().values(**{**values, **supplied}))
        finally:
            engine.dispose()

    def assert_preserved(self, database):
        with closing(sqlite3.connect(database)) as connection:
            self.assertEqual(connection.execute('SELECT submitted_at,retry_after,recovery_attempts FROM conversation_handoff').fetchone(),
                             (None, None, 0))
            self.assertEqual(connection.execute('SELECT phase,payload,retry_after,recovery_attempts FROM conversation_message_receipt').fetchone(),
                             ('uncertain', None, None, 0))
            row = connection.execute('SELECT seq,persisted_seq,delivery_seq,delivery_stream_id,delivery_digest,metadata FROM automation_execution_session').fetchone()
            self.assertEqual(row[:5], (7, 0, 0, '', ''))
            self.assertEqual(json.loads(row[5]), {'round': 2})
            self.assertTrue(json.loads(connection.execute('SELECT source FROM conversation_handoff').fetchone()[0])['preserved'])
            self.assertEqual(connection.execute('SELECT version_num FROM alembic_version').fetchone()[0], NEW)

    def test_legacy_upgrade_is_idempotent_and_never_authorizes_drafts(self):
        with tempfile.TemporaryDirectory(prefix='smoke-cloud-migration-') as temp:
            database = Path(temp) / 'test.db'
            env = {'DATABASE_URL': 'sqlite+aiosqlite:///' + database.as_posix()}
            with patch.dict(os.environ, env):
                get_settings.cache_clear()
                try:
                    command.upgrade(_config(), OLD)
                    self.seed(database)
                    command.upgrade(_config(), NEW)
                    command.upgrade(_config(), NEW)
                    self.assert_preserved(database)
                    command.downgrade(_config(), OLD)
                    command.upgrade(_config(), NEW)
                    self.assert_preserved(database)
                    restored = Path(temp) / 'restored.db'
                    with closing(sqlite3.connect(database)) as source, closing(sqlite3.connect(restored)) as target:
                        source.backup(target)
                    self.assert_preserved(restored)
                finally:
                    get_settings.cache_clear()

    def test_postgres_expansion_has_conservative_defaults_and_no_backfill(self):
        output = io.StringIO()
        context = MigrationContext.configure(dialect_name='postgresql', opts={'as_sql': True, 'output_buffer': output})
        migration = importlib.import_module('migrations.versions.' + NEW)
        with Operations.context(context):
            migration.upgrade()
        sql = output.getvalue()
        self.assertIn('ADD COLUMN submitted_at TIMESTAMP WITH TIME ZONE', sql)
        self.assertIn('ADD COLUMN delivery_seq BIGINT', sql)
        self.assertIn('ix_handoff_owner_id', sql)
        self.assertIn('DEFAULT', sql)
        self.assertNotIn('UPDATE ', sql)
        self.assertNotIn('DROP ', sql)


if __name__ == '__main__':
    unittest.main()
