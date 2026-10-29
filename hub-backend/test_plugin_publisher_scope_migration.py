"""SQLite regression checks for the publisher-scope Alembic migration."""
import importlib.util
from pathlib import Path
import unittest

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


MIGRATIONS = Path(__file__).parent / "migrations" / "versions"


def load_migration(name):
    source = MIGRATIONS / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PublisherScopeMigrationTests(unittest.TestCase):
    def test_upgrade_allows_same_key_in_two_organizations(self):
        old = load_migration("0019_plugin_publisher_keys")
        current = load_migration("0045_plugin_publisher_org_scope")
        engine = create_engine("sqlite:///:memory:")
        with engine.begin() as connection:
            with Operations.context(MigrationContext.configure(connection)):
                old.upgrade()
            connection.execute(text(
                "INSERT INTO automation_plugin_publisher_key "
                "(id, org_id, key_id, publisher_name, public_key, fingerprint) "
                "VALUES ('a', 'org-a', 'shared', 'Publisher', 'key', 'fingerprint')"))
            with Operations.context(MigrationContext.configure(connection)):
                current.upgrade()
            connection.execute(text(
                "INSERT INTO automation_plugin_publisher_key "
                "(id, org_id, key_id, publisher_name, public_key, fingerprint) "
                "VALUES ('b', 'org-b', 'shared', 'Publisher', 'key', 'fingerprint')"))
            indexes = {item["name"] for item in inspect(connection).get_indexes(
                "automation_plugin_publisher_key")}
            self.assertIn("uq_plugin_publisher_org_key", indexes)
            self.assertIn("uq_plugin_publisher_platform_key", indexes)

    def test_downgrade_refuses_duplicate_keys_before_removing_constraints(self):
        old = load_migration("0019_plugin_publisher_keys")
        current = load_migration("0045_plugin_publisher_org_scope")
        engine = create_engine("sqlite:///:memory:")
        with engine.begin() as connection:
            with Operations.context(MigrationContext.configure(connection)):
                old.upgrade()
            connection.execute(text(
                "INSERT INTO automation_plugin_publisher_key "
                "(id, org_id, key_id, publisher_name, public_key, fingerprint) "
                "VALUES ('a', 'org-a', 'shared', 'Publisher', 'key', 'fingerprint')"))
            with Operations.context(MigrationContext.configure(connection)):
                current.upgrade()
            connection.execute(text(
                "INSERT INTO automation_plugin_publisher_key "
                "(id, org_id, key_id, publisher_name, public_key, fingerprint) "
                "VALUES ('b', 'org-b', 'shared', 'Publisher', 'key', 'fingerprint')"))
            with self.assertRaisesRegex(RuntimeError, "multiple scopes"):
                with Operations.context(MigrationContext.configure(connection)):
                    current.downgrade()
            indexes = {item["name"] for item in inspect(connection).get_indexes(
                "automation_plugin_publisher_key")}
            self.assertIn("uq_plugin_publisher_org_key", indexes)
            self.assertIn("uq_plugin_publisher_platform_key", indexes)


if __name__ == "__main__":
    unittest.main()
