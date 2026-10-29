"""Release history and real recommendation DDL must work on PostgreSQL too."""
import importlib.util
import io
from pathlib import Path
import unittest

from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory

ROOT = Path(__file__).resolve().parent


class ReleaseSchemaHistoryTests(unittest.TestCase):
    def scripts(self):
        config = Config(str(ROOT / 'alembic.ini'))
        config.set_main_option('script_location', str(ROOT / 'migrations'))
        return ScriptDirectory.from_config(config)

    def test_history_has_one_head_and_retains_the_deployed_usage_revision(self):
        scripts = self.scripts()
        self.assertEqual(len(scripts.get_heads()), 1)
        self.assertIn('0064_usage_attribution',
                      {item.revision for item in scripts.walk_revisions()})

    def test_every_revision_fits_the_expanded_postgres_version_column(self):
        for item in self.scripts().walk_revisions():
            with self.subTest(revision=item.revision):
                self.assertLessEqual(len(item.revision), 64)

    def test_recommendation_migration_compiles_a_boolean_default_for_each_database(self):
        file = ROOT / 'migrations/versions/0063_plugin_recommendation_surface.py'
        spec = importlib.util.spec_from_file_location('recommendation_migration', file)
        migration = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(migration)
        for dialect, default in [('postgresql', 'true'), ('sqlite', '1')]:
            with self.subTest(dialect=dialect):
                output = io.StringIO()
                context = MigrationContext.configure(dialect_name=dialect,
                    opts={'as_sql': True, 'output_buffer': output})
                with Operations.context(context):
                    migration.upgrade()
                sql = output.getvalue()
                self.assertIn('CREATE TABLE automation_plugin_recommendation', sql)
                self.assertIn('enabled BOOLEAN DEFAULT ' + default + ' NOT NULL', sql)


if __name__ == '__main__':
    unittest.main()
