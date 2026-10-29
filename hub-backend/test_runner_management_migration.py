"""Migration preserves inventory and cannot erase an active security boundary."""
from importlib import import_module
import unittest

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


class RunnerManagementMigrationTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        self.migration = import_module("migrations.versions.0060_runner_management")
        with self.engine.begin() as connection:
            connection.execute(text(
                "CREATE TABLE automation_runner_node (id VARCHAR(80) PRIMARY KEY, "
                "dispatch_mode VARCHAR(24) NOT NULL)"))
            connection.execute(text(
                "INSERT INTO automation_runner_node VALUES ('existing', 'draining')"))

    def tearDown(self):
        self.engine.dispose()

    def upgrade(self, connection):
        with Operations.context(MigrationContext.configure(connection)):
            self.migration.upgrade()

    def test_upgrade_preserves_existing_policy_and_backfills_normal_state(self):
        with self.engine.begin() as connection:
            self.upgrade(connection)
            row = connection.execute(text(
                "SELECT id, dispatch_mode, management_state FROM automation_runner_node")).one()
            self.assertEqual(tuple(row), ("existing", "draining", ""))
            columns = {c["name"]: c for c in inspect(connection).get_columns("automation_runner_node")}
            self.assertFalse(columns["management_state"]["nullable"])

    def test_downgrade_refuses_every_managed_state_without_changing_inventory(self):
        with self.engine.begin() as connection:
            self.upgrade(connection)
            for state in ("disabled", "pending_setup", "retired"):
                with self.subTest(state=state):
                    connection.execute(text(
                        "UPDATE automation_runner_node SET management_state=:state"), {"state": state})
                    with self.assertRaisesRegex(RuntimeError, "must be resolved"):
                        with Operations.context(MigrationContext.configure(connection)):
                            self.migration.downgrade()
                    row = connection.execute(text(
                        "SELECT dispatch_mode, management_state FROM automation_runner_node")).one()
                    self.assertEqual(tuple(row), ("draining", state))

    def test_downgrade_of_unused_policy_preserves_existing_inventory(self):
        with self.engine.begin() as connection:
            self.upgrade(connection)
            with Operations.context(MigrationContext.configure(connection)):
                self.migration.downgrade()
            self.assertNotIn("management_state", {
                c["name"] for c in inspect(connection).get_columns("automation_runner_node")})
            self.assertEqual(connection.scalar(text(
                "SELECT dispatch_mode FROM automation_runner_node WHERE id='existing'")), "draining")


if __name__ == "__main__":
    unittest.main()
