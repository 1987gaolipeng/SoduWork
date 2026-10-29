"""Fast regressions for connector read-only probes, execution location, and redacted status."""
import os
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("AUTH_SECRET", "connector-probe-fixture-signing-key")
os.environ.setdefault("ADMIN_PASS", "connector-probe-fixture-password")
import json
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
import httpx
from app.services import connector_database, mcp_servers


class ProbeTests(unittest.IsolatedAsyncioTestCase):
    async def test_runner_business_auth_failure_keeps_safe_metadata(self):
        class Runner:
            id, host = "runner-a", "host-a"
            async def call(self, *args, **kwargs):
                return {"ok": True, "data": {"ok": False, "tools": ["read"],
                    "connectionState": "needs_auth", "authenticationTested": False,
                    "raw": "must-not-leak", "message": "private-account"}}
        result = await mcp_servers.probe_managed({"name": "fixture", "command": "safe-fixture"}, preferred_runner=Runner())
        self.assertFalse(result["ok"])
        self.assertEqual(result["connectionState"], "needs_auth")
        self.assertEqual(result["runOn"], "runner")
        self.assertNotIn("raw", result)
        self.assertNotIn("private-account", json.dumps(result))

    async def test_personal_http_uses_owner_runner_not_hub(self):
        class Runner:
            id, host = "owner-runner", "owner-host"
            calls = 0
            async def call(self, *args, **kwargs):
                self.calls += 1
                return {"ok": True, "data": {"tools": ["read"]}}
        runner = Runner()
        with patch.object(mcp_servers, "probe_sync", side_effect=AssertionError("Hub must not probe personal HTTP")):
            result = await mcp_servers.probe_managed({"name": "fixture", "type": "http", "url": "https://fixture.invalid/mcp"},
                preferred_runner=runner, run_on_runner=True)
        self.assertEqual(runner.calls, 1)
        self.assertEqual(result["connectionState"], "configured")
        self.assertFalse(result["authenticationTested"])

    async def test_company_http_and_missing_runner_keep_execution_location(self):
        with patch.object(mcp_servers, "probe_sync", return_value={"ok": True, "tools": ["read"]}):
            result = await mcp_servers.probe_managed({"name": "fixture", "type": "http", "url": "https://fixture.invalid/mcp"})
        self.assertEqual(result["runOn"], "hub")
        self.assertEqual(result["connectionState"], "configured")
        with patch("app.services.runner_hub.pick_for", return_value=None):
            result = await mcp_servers.probe_managed({"name": "fixture", "command": "safe-fixture"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["connectionState"], "offline")

    def test_database_health_only_runs_constant_readonly_query(self):
        for kind in ("postgres", "mysql"):
            with self.subTest(kind=kind):
                connection = MagicMock()
                cursor = connection.cursor.return_value
                cursor.fetchone.return_value = (1,)
                with patch.object(connector_database, "config", return_value=(kind, {})), patch.object(connector_database, "connect", return_value=connection):
                    result = json.loads(connector_database.execute({}, "health"))
                self.assertEqual(result["connectionState"], "verified")
                self.assertTrue(result["authenticationTested"])
                sql = [str(call.args[0]) for call in cursor.execute.call_args_list]
                self.assertTrue(any("READ ONLY" in value for value in sql))
                self.assertEqual(sql[-1], "SELECT 1")
                cursor.fetchmany.assert_not_called()
                connection.rollback.assert_called_once()
                connection.close.assert_called_once()

    def test_database_health_classifies_auth_without_returning_driver_details(self):
        cases = [(Exception(1045, "private-account"), "needs_auth"),
                 (Exception({"C": "28P01", "M": "private-account"}), "needs_auth"),
                 (RuntimeError("private-network"), "error")]
        for error, state in cases:
            with self.subTest(state=state), patch.object(connector_database, "config", return_value=("postgres", {})), patch.object(connector_database, "connect", side_effect=error):
                result = json.loads(connector_database.execute({}, "health"))
            self.assertEqual(result["connectionState"], state)
            self.assertFalse(result["ok"])
            self.assertNotIn("private-", json.dumps(result))

    async def test_oauth_network_failure_reaches_ui_as_retryable_error(self):
        from app.api import capabilities
        from app.services import connector_oauth as oauth
        body = {"oauth": {"provider": "google-drive", "connectionId": "fixture"}}
        with patch.object(capabilities, "_personal_mcp_spec", return_value=body), patch.object(oauth, "resolve", AsyncMock(side_effect=oauth.AuthorizationUnavailable("private-network"))):
            result = await capabilities.probe_my_mcp_server(body, client=object(), session=object())
        self.assertFalse(result["ok"])
        self.assertEqual(result["connectionState"], "error")
        self.assertNotIn("private-network", json.dumps(result))

    async def test_oauth_transport_is_bounded_no_redirect_and_safe_errors(self):
        from app.services import connector_oauth as oauth
        original = httpx.AsyncClient
        cases = [(200, '{"id":"fixture"}', None), (401, "private-token", oauth.AuthorizationExpired),
                 (302, "private-token", oauth.AuthorizationUnavailable), (200, "x" * 65537, oauth.AuthorizationUnavailable),
                 (200, "private-invalid-json", oauth.AuthorizationUnavailable)]
        for status, content, exception in cases:
            calls = []
            def handle(request):
                calls.append(request)
                return httpx.Response(status, text=content, headers={"Location": "https://other.invalid/token"})
            def client(**kwargs):
                self.assertIs(kwargs["follow_redirects"], False)
                return original(transport=httpx.MockTransport(handle), **kwargs)
            with self.subTest(status=status, exception=exception), patch.object(oauth.httpx, "AsyncClient", client):
                if exception:
                    with self.assertRaises(exception) as raised:
                        await oauth.request_json("https://identity.fixture.invalid/me", token="fixture-token")
                    self.assertNotIn("private-", str(raised.exception))
                else:
                    self.assertEqual(await oauth.request_json("https://identity.fixture.invalid/me", token="fixture-token"), {"id": "fixture"})
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0].headers["Authorization"], "Bearer fixture-token")


if __name__ == "__main__":
    unittest.main()
