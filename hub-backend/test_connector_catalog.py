import copy
import json
import os
import unittest
from unittest.mock import patch, MagicMock
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
from app.services import capability_catalog, connector_catalog, connector_database, mcp_servers, mcp_export, mcp_import
from app.api import mcp_management


class ConnectorContracts(unittest.TestCase):
    def row(self, key="github", env=None):
        return {"id": "test-" + key, "name": "test-" + key, "type": "stdio", "templateKey": "connector-" + key,
                "env": env or {}, "approved": True, "approvedTarget": "connector-" + key, "enabled": False}

    def test_all_catalog_templates_create_export_import_disabled(self):
        templates = connector_catalog.templates()
        self.assertEqual(len(templates), 59)
        self.assertEqual(len({t["key"] for t in templates}), 59)
        for template in templates:
            with self.subTest(template=template["key"]):
                row = mcp_servers.personal_spec(self.row(template["providerId"]))
                self.assertFalse(mcp_servers.is_builtin(row), "configurable connectors can edit and remove")
                exported = mcp_export.personal([row], {"ids": [row["id"]]})
                parsed = mcp_management.personal_candidates(mcp_import.parse(exported["content"].encode(), "x.json"))
                self.assertTrue(parsed["items"][0]["valid"], parsed)
                restored = parsed["items"][0]["row"]
                self.assertFalse(restored["enabled"])
                self.assertNotEqual(restored["env"].get("ALLOW_WRITES"), "true")

    def test_config_validation_and_secret_mask_roundtrip(self):
        row = mcp_servers.personal_spec(self.row("jira", {"TENANT": "company", "JIRA_EMAIL": "user@example.com",
            "JIRA_API_TOKEN": "opaque-sensitive-token", "ALLOW_WRITES": "true"}))
        view = mcp_servers.mask(row)
        self.assertEqual(view["env"]["TENANT"], "company")
        self.assertEqual(view["env"]["ALLOW_WRITES"], "true")
        self.assertNotIn("opaque-sensitive-token", json.dumps(view))
        self.assertEqual(mcp_servers.personal_spec(mcp_servers.restore(view, row)), row)
        portable = mcp_export.personal([row], {"ids": [row["id"]]})
        self.assertNotIn("opaque-sensitive-token", portable["content"])
        self.assertEqual(set(json.loads(portable["content"])["mcpServers"][row["name"]]["env"].values()), {""})
        for env in ({"NODE_OPTIONS": "--inspect"}, {"ALLOW_WRITES": "yes"}, {"TENANT": "good.evil.com"}):
            with self.subTest(env=env), self.assertRaises(ValueError):
                mcp_servers.personal_spec(self.row("jira", env))

    def test_fixed_command_and_arguments_cannot_be_overridden(self):
        row = self.row()
        row.update(command="powershell", args=["malicious"])
        safe = mcp_servers.personal_spec(row)
        self.assertEqual((safe["command"], safe["args"]), ("soduwork-connector", ["github"]))
        document = {"mcpServers": {"unknown": {"command": "soduwork-connector", "args": ["../../private"]}}}
        parsed = mcp_management.personal_candidates(mcp_import.parse(json.dumps(document).encode(), "x.json"))
        self.assertFalse(parsed["items"][0]["valid"])

    def test_actual_node_bridge_discovers_reviewed_tools_without_network_or_shell_command(self):
        row = mcp_servers.personal_spec(self.row("github", {"GITHUB_TOKEN": "fixture-only-not-a-vendor-token"}))
        tools = mcp_servers.bridge_list_sync("fixture-github", row)
        self.assertTrue(any(t["name"] == "get_authenticated_user" for t in tools))
        self.assertFalse(any(t["name"] == "create_issue" for t in tools))
        self.assertTrue(all(t["annotations"]["readOnlyHint"] for t in tools))
        self.assertNotIn("fixture-only-not-a-vendor-token", json.dumps(tools))

    def test_existing_core_templates_stay_protected(self):
        row = {**self.row(), "templateKey": "mcp-filesystem", "approvedTarget": "mcp-filesystem"}
        safe = mcp_servers.personal_spec(row)
        self.assertTrue(mcp_servers.is_builtin(safe))
        with self.assertRaises(ValueError):
            mcp_servers.protect_builtin([safe], [])


class DatabaseContracts(unittest.TestCase):
    def test_only_fixed_queries_and_bounded_identifiers(self):
        for kind in ("postgres", "mysql"):
            sql, params, limit = connector_database.statement(kind, "read_rows", {"table": "orders", "limit": 3})
            self.assertIn("LIMIT %s", sql)
            self.assertEqual(params, (3,))
            for args in ({"table": "orders; DROP TABLE users"}, {"table": "x", "limit": 101},
                         {"table": "x", "limit": True}, {"table": "x", "sql": "SELECT secret"}):
                with self.assertRaises(ValueError):
                    connector_database.statement(kind, "read_rows", args)
            with self.assertRaises(ValueError):
                connector_database.statement(kind, "execute_write", {"sql": "DELETE"})

    def test_mysql_cannot_address_another_database(self):
        with self.assertRaises(ValueError):
            connector_database.statement("mysql", "read_rows", {"schema": "other", "table": "orders"})

    def test_cleanup_cannot_leak_driver_credentials(self):
        connection = MagicMock()
        connection.cursor.side_effect = RuntimeError("private-password")
        connection.rollback.side_effect = RuntimeError("private-password")
        connection.close.side_effect = RuntimeError("private-password")
        with patch.object(connector_database, "config", return_value=("postgres", {})), patch.object(connector_database, "connect", return_value=connection):
            with self.assertRaises(ValueError) as error:
                connector_database.execute({}, "call", "read_rows", {"table": "orders"})
            self.assertNotIn("private-password", str(error.exception))
        connection.close.assert_called_once()

    def test_driver_uses_readonly_transaction_rollback_and_safe_errors(self):
        for kind in ("postgres", "mysql"):
            connection = MagicMock()
            cursor = connection.cursor.return_value
            cursor.description = [("value",)]
            cursor.fetchmany.return_value = [(1,)]
            with patch.object(connector_database, "config", return_value=(kind, {})), patch.object(connector_database, "connect", return_value=connection):
                result = connector_database.execute({}, "call", "read_rows", {"table": "orders", "limit": 1})
                self.assertIn('value', result)
                calls = cursor.execute.call_args_list
                self.assertTrue(any("READ ONLY" in c.args[0] for c in calls))
                self.assertEqual(calls[-1].args[1], (1,))
                connection.rollback.assert_called_once()
                connection.close.assert_called_once()
        with patch.object(connector_database, "config", return_value=("postgres", {})), patch.object(connector_database, "connect", side_effect=RuntimeError("password=private")):
            with self.assertRaises(ValueError) as error:
                connector_database.execute({}, "call", "read_rows", {"table": "orders"})
            self.assertNotIn("private", str(error.exception))

    def test_runner_dispatches_database_without_starting_a_shell(self):
        spec = {"command": "soduwork-connector", "args": ["postgres"]}
        with patch.object(connector_database, "execute", return_value='{"tools": []}') as execute, patch("subprocess.run") as spawn:
            self.assertEqual(mcp_servers.bridge_list_sync("db", spec), [])
            execute.assert_called_once()
            spawn.assert_not_called()


if __name__ == "__main__":
    unittest.main()
