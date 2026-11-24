"""Exercise the organization policy for catalog status and account checks."""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app.api import repositories


class IntegrationReadScope(unittest.IsolatedAsyncioTestCase):
    async def test_both_read_operations_apply_the_same_scope_before_service_calls(self):
        session = AsyncMock()
        user = SimpleNamespace()
        with patch.object(repositories, "_scope", new_callable=AsyncMock) as scope, \
                patch.object(repositories.catalog, "sync_stage", new_callable=AsyncMock) as stage, \
                patch.object(repositories.catalog, "verify_pull_account", new_callable=AsyncMock) as verify:
            stage.return_value = "listing"
            verify.return_value = {"ok": True}
            for visible, owner, allowed in [
                ({"department", "child"}, "child", True), ({"department"}, "other", False),
                ({"department"}, None, False), ({"department"}, [], False), (set(), "child", False),
                (None, None, True),
            ]:
                with self.subTest(visible=visible, owner=owner):
                    scope.return_value = visible
                    session.get.return_value = SimpleNamespace(config={"orgId": owner})
                    stage.reset_mock()
                    verify.reset_mock()
                    if allowed:
                        self.assertEqual(await repositories.repository_sync_status("source", user, session),
                                         {"stage": "listing"})
                        self.assertEqual(await repositories.test_pull_account("source", {}, user, session),
                                         {"ok": True})
                        stage.assert_awaited_once()
                        verify.assert_awaited_once()
                    else:
                        for operation, args in [(repositories.repository_sync_status, ("source", user, session)),
                                                (repositories.test_pull_account, ("source", {}, user, session))]:
                            with self.assertRaises(HTTPException) as error:
                                await operation(*args)
                            self.assertEqual(error.exception.status_code, 403)
                        stage.assert_not_awaited()
                        verify.assert_not_awaited()

    async def test_missing_integration(self):
        session = AsyncMock()
        session.get.return_value = None
        with self.assertRaises(HTTPException) as error:
            await repositories._assert_integration_scope(session, SimpleNamespace(), "missing")
        self.assertEqual(error.exception.status_code, 404)
