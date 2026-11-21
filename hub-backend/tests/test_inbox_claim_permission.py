"""Real HTTP/SQLite checks for the inbox claim permission boundary (Refs #931)."""
import os
import unittest
from unittest.mock import AsyncMock, Mock, patch

os.environ.setdefault("AUTH_SECRET", "isolated-inbox-claim-permission-test-key")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from fastapi import Request

from app.api import admin
from app.deps import current_user
from app.models import User
from test_unified_requirements import UnifiedRequirementTests


class InboxClaimPermissionTests(unittest.IsolatedAsyncioTestCase):
    """Claiming an inbox task through the admin API requires a task permission.

    The desktop claim path stays on the device-side API; a signed-in account with
    no task permission must receive HTTP 403 instead of reaching the claim logic.
    """

    asyncTearDown = UnifiedRequirementTests.asyncTearDown
    call = UnifiedRequirementTests.call

    async def asyncSetUp(self):
        await UnifiedRequirementTests.asyncSetUp(self)
        self.app.include_router(admin.router)
        self.admin_permissions = set()
        async def administrator(request: Request):
            async with self.sessions() as session:
                user = await session.get(User, request.headers.get("X-Test-Identity", "owner"))
                user._perms = set(self.admin_permissions)
                return user
        self.app.dependency_overrides[current_user] = administrator
        self.notices = patch("app.services.notify.notify_task", new_callable=AsyncMock)
        self.notices.start()
        self.addCleanup(self.notices.stop)

    async def test_zero_permission_account_cannot_claim_inbox_task(self):
        for who in ("owner", "peer", "outsider"):
            with self.subTest(who=who):
                response = await self.call("POST", "admin/me/inbox/some-task/claim", who, json={})
                self.assertEqual(response.status_code, 403, response.text)
                self.assertIn("权限", response.text)

    async def test_task_view_account_passes_the_permission_gate(self):
        self.admin_permissions = {"task.view"}
        response = await self.call("POST", "admin/me/inbox/some-task/claim", "owner", json={})
        self.assertNotEqual(response.status_code, 403, response.text)

    async def test_task_dispatch_account_passes_the_permission_gate(self):
        self.admin_permissions = {"task.dispatch"}
        response = await self.call("POST", "admin/me/inbox/some-task/claim", "owner", json={})
        self.assertNotEqual(response.status_code, 403, response.text)


if __name__ == "__main__":
    unittest.main()
