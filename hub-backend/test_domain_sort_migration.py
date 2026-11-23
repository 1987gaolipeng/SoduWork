"""Upgrade legacy SQLite domain ranks while retaining their audit evidence."""
import importlib
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from alembic import command
from alembic.migration import MigrationContext
from alembic.operations import Operations
import sqlalchemy as sa

from app.models import AuditLog, Domain, User
from app.config import get_settings
from app.schema_migrations import _config, _head_revision


migration = importlib.import_module("migrations.versions.0091_domain_sort_validation")


class DomainSortMigrationTests(unittest.TestCase):
    def setUp(self):
        self.engine = sa.create_engine("sqlite://")
        for table in (Domain.__table__, AuditLog.__table__, User.__table__):
            table.create(self.engine)

    def tearDown(self):
        self.engine.dispose()

    def insert_domain(self, connection, identity, sort):
        connection.execute(Domain.__table__.insert().values(
            id=identity, name="Domain " + identity, sort=sort, is_system=False))

    def audits(self, connection):
        return {row.target_id: row.detail for row in connection.execute(sa.select(
            AuditLog.__table__.c.target_id, AuditLog.__table__.c.detail).where(
            AuditLog.__table__.c.action == "domain.sort_repair"))}

    def test_upgrade_preserves_valid_ranks_and_associations_and_audits_bad_values(self):
        valid = {"negative": -7, "zero": 0, "positive": 12, "lower-bound": migration.MIN_SORT}
        invalid = {"text": "abc", "empty": "", "fraction": 3.5, "negative-fraction": -2.5,
                   "large": 2 ** 60, "negative-large": -(2 ** 60), "infinity": float("inf"),
                   "blob": b"\x00\xff\x01"}
        with self.engine.begin() as connection:
            for identity, sort in {**valid, **invalid}.items():
                self.insert_domain(connection, identity, sort)
            connection.execute(User.__table__.insert().values(
                id="owner", username="fixture-owner", domains=list(invalid)))
            before = {row["id"]: dict(row) for row in connection.execute(
                sa.select(Domain.__table__)).mappings()}
            old_user = dict(connection.execute(sa.select(User.__table__)).mappings().one())
            old_bad_order = list(connection.scalars(sa.text(
                "SELECT id FROM domain WHERE typeof(sort) != 'integer' "
                "OR sort < :lo OR sort > :hi ORDER BY sort, created_at, id"
            ), {"lo": migration.MIN_SORT, "hi": migration.MAX_SORT}))
            with Operations.context(MigrationContext.configure(connection)):
                migration.upgrade()
            after = {row["id"]: dict(row) for row in connection.execute(
                sa.select(Domain.__table__)).mappings()}
            self.assertEqual(set(before), set(after))
            for identity, row in before.items():
                expected = row if identity in valid else {**row, "sort": 13 + old_bad_order.index(identity)}
                self.assertEqual(after[identity], expected, identity)
            self.assertEqual(dict(connection.execute(sa.select(User.__table__)).mappings().one()), old_user)
            self.assertEqual(set(connection.scalars(sa.text("SELECT typeof(sort) FROM domain"))), {"integer"})
            audits = self.audits(connection)
            self.assertEqual(set(audits), set(invalid))
            self.assertEqual(audits["text"]["original"], {
                "storageType": "text", "encoding": "text", "value": "abc"})
            self.assertEqual(audits["empty"]["original"]["value"], "")
            self.assertEqual(bytes.fromhex(audits["blob"]["original"]["value"]), invalid["blob"])
            for identity in ("fraction", "negative-fraction", "infinity"):
                self.assertEqual(float.fromhex(audits[identity]["original"]["value"]), invalid[identity])
            for identity in ("large", "negative-large"):
                self.assertEqual(int(audits[identity]["original"]["value"]), invalid[identity])
            # In particular, Infinity and integers beyond JavaScript precision
            # must not leak non-standard JSON or lose their stored representation.
            json.dumps(audits, allow_nan=False)
            for identity, detail in audits.items():
                self.assertEqual(detail["replacement"], after[identity]["sort"])
                self.assertEqual(detail["strategy"], "append")
            self.assertEqual(migration.repair_domain_sorts(connection), 0)
            self.assertEqual(self.audits(connection), audits)
            with Operations.context(MigrationContext.configure(connection)):
                migration.downgrade()
            self.assertEqual(self.audits(connection), audits)

    def test_upper_bound_ties_do_not_block_upgrade_or_change_valid_rows(self):
        for maximum in (migration.MAX_SORT - 1, migration.MAX_SORT):
            with self.subTest(maximum=maximum), self.engine.begin() as connection:
                connection.execute(Domain.__table__.delete())
                connection.execute(AuditLog.__table__.delete())
                self.insert_domain(connection, "valid", maximum)
                self.insert_domain(connection, "bad-a", "abc")
                self.insert_domain(connection, "bad-b", "def")
                self.assertEqual(migration.repair_domain_sorts(connection), 2)
                actual = dict(connection.execute(sa.select(Domain.__table__.c.id, Domain.__table__.c.sort)).all())
                self.assertEqual(actual, {"valid": maximum, "bad-a": migration.MAX_SORT, "bad-b": migration.MAX_SORT})
                audits = self.audits(connection)
                self.assertEqual(audits["bad-a"]["strategy"],
                                 "append" if maximum < migration.MAX_SORT else "upper_bound_tie")
                self.assertEqual(audits["bad-b"]["strategy"], "upper_bound_tie")

    def test_failed_repair_rolls_back_both_prior_repairs_and_audit_records(self):
        with self.engine.begin() as connection:
            self.insert_domain(connection, "first", "a")
            self.insert_domain(connection, "second", "b")
            connection.exec_driver_sql(
                "CREATE TRIGGER fail_second BEFORE UPDATE ON domain WHEN OLD.id = 'second' "
                "BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
        with self.assertRaises(sa.exc.IntegrityError):
            with self.engine.begin() as connection:
                migration.repair_domain_sorts(connection)
        with self.engine.connect() as connection:
            self.assertEqual(dict(connection.execute(sa.text("SELECT id, sort FROM domain")).all()),
                             {"first": "a", "second": "b"})
            self.assertEqual(self.audits(connection), {})

    def test_missing_audit_table_fails_before_overwriting_original_data(self):
        with self.engine.begin() as connection:
            self.insert_domain(connection, "bad", "abc")
            AuditLog.__table__.drop(connection)
            with self.assertRaisesRegex(RuntimeError, "audit_log"):
                migration.repair_domain_sorts(connection)
            self.assertEqual(connection.scalar(sa.text("SELECT sort FROM domain")), "abc")

    def test_empty_and_postgresql_databases_are_untouched(self):
        with self.engine.begin() as connection:
            self.assertEqual(migration.repair_domain_sorts(connection), 0)
            self.assertEqual(self.audits(connection), {})
            Domain.__table__.drop(connection)
            self.assertEqual(migration.repair_domain_sorts(connection), 0)
        postgres = Mock(dialect=SimpleNamespace(name="postgresql"))
        self.assertEqual(migration.repair_domain_sorts(postgres), 0)
        self.assertEqual(postgres.mock_calls, [])

    def test_versioned_database_upgrade_reaches_head_and_preserves_one_audit(self):
        with tempfile.TemporaryDirectory(prefix="soduwork-domain-upgrade-") as directory:
            path = Path(directory) / ".smoke.db"
            engine = sa.create_engine("sqlite:///" + path.as_posix())
            try:
                with engine.begin() as connection:
                    Domain.__table__.create(connection)
                    AuditLog.__table__.create(connection)
                    connection.exec_driver_sql("CREATE TABLE task (id VARCHAR(36) PRIMARY KEY)")
                    connection.exec_driver_sql("CREATE TABLE app_user (id TEXT PRIMARY KEY)")
                    connection.exec_driver_sql("CREATE TABLE alembic_version (version_num VARCHAR(64) PRIMARY KEY)")
                    connection.exec_driver_sql("INSERT INTO alembic_version VALUES ('0090_requirement_creator')")
                    self.insert_domain(connection, "valid", 9)
                    self.insert_domain(connection, "legacy", "abc")
                with patch.dict(os.environ, {"DATABASE_URL": "sqlite+aiosqlite:///" + path.as_posix()}):
                    get_settings.cache_clear()
                    try:
                        command.upgrade(_config(), "head")
                        command.upgrade(_config(), "head")
                    finally:
                        get_settings.cache_clear()
                with engine.connect() as connection:
                    self.assertEqual(connection.scalar(sa.text("SELECT version_num FROM alembic_version")), _head_revision())
                    self.assertEqual(dict(connection.execute(sa.text("SELECT id, sort FROM domain")).all()),
                                     {"valid": 9, "legacy": 10})
                    self.assertEqual(len(self.audits(connection)), 1)
                    self.assertEqual(connection.scalar(sa.text(
                        "SELECT count(*) FROM audit_log WHERE action='domain.sort_repair'")), 1)
            finally:
                engine.dispose()


if __name__ == "__main__":
    unittest.main()
