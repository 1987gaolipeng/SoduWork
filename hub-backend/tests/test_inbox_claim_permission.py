"""Real HTTP/SQLite checks for the inbox claim permission boundary (Refs #931)."""
import os
import unittest

os.environ.setdefault("AUTH_SECRET", "isolated-inbox-claim-permission-test-key")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from fastapi import Request

from app.api import admin, clients
from app.automation_models import ScmRepository
from app.deps import current_user
from app.models import Task, User
from app.repository_issue_models import RepositoryIssueLink, RepositoryIssueMember, RepositoryIssueSync
import test_unified_requirements as fixtures


class InboxClaimPermissionTests(unittest.IsolatedAsyncioTestCase):
    """Team-pool writes through the administration API require dispatch permission."""

    asyncTearDown = fixtures.UnifiedRequirementTests.asyncTearDown
    call = fixtures.UnifiedRequirementTests.call

    async def asyncSetUp(self):
        await fixtures.UnifiedRequirementTests.asyncSetUp(self)
        self.app.include_router(admin.router)
        self.app.include_router(clients.router)
        self.admin_permissions = set()
        async with self.sessions.begin() as session:
            session.add(Task(id="pool-task", title="Team work", status="todo", pool_org_id="company"))

        async def administrator(request: Request):
            async with self.sessions() as session:
                user = await session.get(User, request.headers.get("X-Test-Identity", "owner"))
                user._perms = set(self.admin_permissions)
                return user
        self.app.dependency_overrides[current_user] = administrator

    async def test_zero_permission_account_cannot_claim_inbox_task(self):
        for who in ("owner", "peer", "outsider"):
            with self.subTest(who=who):
                response = await self.call("POST", "admin/me/inbox/some-task/claim", who, json={})
                self.assertEqual(response.status_code, 403, response.text)
                self.assertIn("权限", response.text)

    async def test_task_view_is_read_only(self):
        self.admin_permissions = {"task.view"}
        response = await self.call("POST", "admin/me/inbox/some-task/claim", "owner", json={})
        self.assertEqual(response.status_code, 403, response.text)

    async def test_dispatcher_can_claim_in_scope_for_their_own_device(self):
        self.admin_permissions = {"task.dispatch"}
        response = await self.call("POST", "admin/me/inbox/pool-task/claim", "owner", json={})
        self.assertEqual(response.status_code, 200, response.text)
        async with self.sessions() as session:
            task = await session.get(Task, "pool-task")
            self.assertEqual((task.owner_user_id, task.owner_client_id), ("owner", "owner"))
            self.assertIsNone(task.pool_org_id)

    async def test_desktop_team_claim_keeps_ordinary_member_access(self):
        response = await self.call("POST", "team/inbox/pool-task/claim", "peer", json={})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["task"]["ownerClientId"], "peer")

    async def test_repository_member_can_claim_without_admin_permissions_or_department(self):
        async with self.sessions.begin() as session:
            member = await session.get(User, "owner")
            member.org_id = None
            session.add_all([
                ScmRepository(id="catalog", integration_id="gitlab", provider="gitlab",
                              external_id="149", full_name="fixture/repo"),
                RepositoryIssueSync(catalog_id="catalog", enabled=True),
                RepositoryIssueMember(catalog_id="catalog", external_user_id="scm-member",
                                      username="scm-member", user_id=member.id, active=True),
                Task(id="repo-task", title="Repository work", origin="gitlab_issue",
                     status="todo", triage_stage="ready"),
                RepositoryIssueLink(id="link", catalog_id="catalog", issue_id="1001", issue_iid=1,
                                    task_id="repo-task", issue_url="https://example.invalid/issues/1"),
            ])
        response = await self.call("POST", "admin/me/inbox/repo-task/claim", "owner", json={})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["task"]["ownerClientId"], "owner")


if __name__ == "__main__":
    unittest.main()
