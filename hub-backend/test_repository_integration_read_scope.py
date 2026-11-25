"""Exercise the organization policy for catalog synchronization and pull accounts."""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app.api import repositories


class IntegrationReadScope(unittest.IsolatedAsyncioTestCase):
    async def test_save_checks_current_owner_and_normalizes_the_destination_before_writing(self):
        session = AsyncMock()
        session.get.return_value = SimpleNamespace(is_archived=False)
        user = SimpleNamespace()
        with patch.object(repositories, "_scope", new_callable=AsyncMock) as scope, \
                patch.object(repositories.catalog, "lock_integration", new_callable=AsyncMock) as lock, \
                patch.object(repositories.catalog, "set_pull_account", new_callable=AsyncMock) as save, \
                patch.object(repositories.audit, "log", new_callable=AsyncMock) as audit:
            scope.return_value = {"department", "child"}
            for owner, body, expected_status, destination in [
                (" department ", {}, 200, ""),
                ("department", {"orgId": " child "}, 200, "child"),
                ("department", {"orgId": "other"}, 403, None),
                ("other", {"orgId": "department"}, 403, None),
                (None, {}, 403, None),
                ("department", {"orgId": []}, 400, None),
            ]:
                with self.subTest(owner=owner, body=body):
                    lock.return_value = SimpleNamespace(config={"orgId": owner})
                    save.reset_mock()
                    audit.reset_mock()
                    if expected_status == 200:
                        result = await repositories.save_pull_account("source", body, user, session)
                        self.assertEqual(result, {"ok": True})
                        self.assertEqual(save.await_args.kwargs["org_id"], destination)
                        audit.assert_awaited_once()
                    else:
                        with self.assertRaises(HTTPException) as error:
                            await repositories.save_pull_account("source", body, user, session)
                        self.assertEqual(error.exception.status_code, expected_status)
                        save.assert_not_awaited()
                        audit.assert_not_awaited()

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

    async def test_sync_uses_same_policy_as_status_before_calling_connector(self):
        session = AsyncMock()
        with patch.object(repositories, "_scope", new_callable=AsyncMock, return_value={"department"}), \
                patch.object(repositories.catalog, "sync_integration", new_callable=AsyncMock) as sync:
            session.get.return_value = SimpleNamespace(config={})
            with self.assertRaises(HTTPException) as error:
                await repositories.sync_repositories("source", {}, SimpleNamespace(), session)
            self.assertEqual(error.exception.status_code, 403)
            sync.assert_not_awaited()
