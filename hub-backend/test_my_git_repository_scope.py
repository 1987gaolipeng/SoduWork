"""Device repository selection uses both repository and project visibility."""
from __future__ import annotations

import os
import unittest

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.agents import get_my_git
from app.models import Client, OrgUnit, Project, Repo, User
from app.services.repo_urls import git_probe_url


class MyGitRepoTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.addAsyncCleanup(engine.dispose)
        async with engine.begin() as connection:
            for model in (User, OrgUnit, Project, Repo):
                await connection.run_sync(model.__table__.create)
        self.session = async_sessionmaker(engine, expire_on_commit=False)()
        self.addAsyncCleanup(self.session.close)
        self.session.add_all([
            OrgUnit(id="left", name="Left"), OrgUnit(id="child", name="Child", parent_id="left"),
            OrgUnit(id="right", name="Right"),
            User(id="member", username="member", org_id="left"),
            User(id="admin", username="admin", is_super=True),
            User(id="solo", username="solo"),
            User(id="disabled", username="disabled", org_id="left", is_active=False),
        ])
        for name, org in (("child", "child"), ("right", "right"), ("shared", None)):
            self.session.add(Project(id=name, name=name, org_id=org))
        for name, project, org in (("own", "child", "child"), ("legacy", "child", None),
                                   ("other", "right", None), ("mismatch", "shared", "right"),
                                   ("shared", "shared", None), ("orphan", "missing", None)):
            self.session.add(Repo(id=name, name=name, project_id=project, org_id=org,
                                  git_url=f"https://example.test/{name}.git"))
        await self.session.commit()

    async def test_bound_account_only_lists_repositories_in_both_scopes(self):
        expected = {
            "member": {"own", "legacy", "shared"},
            "solo": {"shared"},
            "admin": {"own", "legacy", "other", "mismatch", "shared"},
            "disabled": set(), "gone": set(), None: set(),
        }
        for uid, allowed in expected.items():
            with self.subTest(uid=uid):
                device = Client(user_ref=uid)
                result = await get_my_git(device, self.session)
                self.assertEqual({r["id"] for r in result["repos"]}, allowed)
                self.assertIn("git", result)

    async def test_returns_safe_probe_target_without_changing_stored_remote(self):
        original = "https://account:old-value@example.test/team/repo.git?access=old#section"
        repo = await self.session.get(Repo, "own")
        repo.git_url = original
        await self.session.commit()
        result = await get_my_git(Client(user_ref="member"), self.session)
        row = next(r for r in result["repos"] if r["id"] == "own")
        self.assertEqual(row, {"id": "own", "name": "own", "url": "https://example.test/team/repo.git"})
        await self.session.refresh(repo)
        self.assertEqual(repo.git_url, original)


class ProbeUrlTests(unittest.TestCase):
    def test_supported_remotes_and_malformed_historical_values(self):
        for url in ("https://example.test/group/repo.git", "https://[2001:db8::1]:9443/repo.git",
                    "ssh://git@example.test:2222/group/repo.git", "git@example.test:group/repo.git"):
            with self.subTest(url=url):
                self.assertEqual(git_probe_url(url), url)
        for url in ("", "/local/repo.git", "https://[broken", "https://example.test:invalid/repo"):
            with self.subTest(url=url):
                self.assertEqual(git_probe_url(url), "")


if __name__ == "__main__":
    unittest.main()
