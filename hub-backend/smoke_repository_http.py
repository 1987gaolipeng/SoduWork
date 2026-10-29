"""HTTP contract smoke for repository discovery and project branch mappings."""
from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
from pathlib import Path

import httpx

folder = Path(tempfile.mkdtemp(prefix="soduwork-repository-api-"))
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + (folder / "test.db").as_posix()
os.environ["REPOSITORY_SYNC_INTERVAL_SECONDS"] = "0"
os.environ["REPORT_AUTO"] = "false"

from app import automation_models as am, models
from app.auth import sign_token
from app.connectors import REGISTRY
from app.db import Base, SessionLocal, engine
from app.main import app

checks = 0


def ok(value, message: str) -> None:
    global checks
    if not value:
        raise AssertionError(message)
    checks += 1


class FakeGitLab:
    type = "gitlab"
    scheduled = False

    def verify(self, config: dict) -> dict:
        assert config.get("_auth_secret") == "saved-password"
        return {"ok": True, "user": config.get("_auth_user"), "kind": config.get("_auth_kind")}

    def list_repositories(self, config: dict) -> list[dict]:
        assert config.get("token") == "runtime-only-token"
        return [{
            "externalId": "repo-88",
            "fullName": "enterprise/analytics",
            "displayName": "analytics",
            "cloneUrl": "https://git.example/enterprise/analytics.git",
            "sshUrl": "git@git.example:enterprise/analytics.git",
            "webUrl": "https://git.example/enterprise/analytics",
            "defaultBranch": "main",
            "visibility": "private",
        }]

    def list_branches(self, config: dict, external_id: str) -> list[str]:
        assert config.get("token") == "runtime-only-token"
        assert external_id == "repo-88"
        return ["main", "release/customer-a"]


async def main() -> None:
    original = REGISTRY.get("gitlab")
    REGISTRY["gitlab"] = FakeGitLab()
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with SessionLocal() as session:
            org = models.OrgUnit(id="org-http", name="HTTP")
            user = models.User(
                id="user-http", username="http-admin", display_name="HTTP Admin",
                org_id=org.id, is_super=True, is_active=True)
            client = models.Client(
                id="client-http", name="Admin SoduWork", user_ref=user.id,
                git_creds={"token": "runtime-only-token"})
            integration = models.Integration(
                id="integration-http", name="Enterprise GitLab", type="gitlab",
                config={"base_url": "https://git.example"})
            project_a = models.Project(
                id="project-http-a", name="Analytics A", org_id=org.id,
                owner_user_id=user.id)
            project_b = models.Project(
                id="project-http-b", name="Analytics B", org_id=org.id,
                owner_user_id=user.id)
            session.add_all([org, user, client, integration, project_a, project_b])
            await session.commit()

        headers = {"Authorization": "Bearer " + sign_token("user-http")}
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
                transport=transport, base_url="http://soduwork.test") as http:
            empty = await http.get(
                "/api/v1/admin/repository-catalog", headers=headers)
            ok(empty.status_code == 200 and empty.json()["items"] == [],
               "catalog starts empty")

            synced = await http.post(
                "/api/v1/admin/integrations/integration-http/repositories/sync",
                headers=headers, json={"clientId": "client-http"})
            ok(synced.status_code == 200 and synced.json()["total"] == 1,
               "catalog sync works through HTTP")

            catalog = await http.get(
                "/api/v1/admin/repository-catalog?"
                "integrationId=integration-http", headers=headers)
            items = catalog.json()["items"]
            ok(catalog.status_code == 200 and len(items) == 1,
               "synced catalog is queryable")
            catalog_id = items[0]["id"]

            branches = await http.get(
                f"/api/v1/admin/repository-catalog/{catalog_id}/branches?"
                "clientId=client-http", headers=headers)
            ok(branches.status_code == 200
               and branches.json()["items"] == ["main", "release/customer-a"],
               "branches are queried in place")

            created = await http.post(
                "/api/v1/admin/projects/project-http-a/repos/from-catalog",
                headers=headers, json={
                    "catalogId": catalog_id, "branch": "release/customer-a",
                    "mergeBranch": "release/customer-a", "kind": "backend"})
            ok(created.status_code == 200
               and created.json()["branch"] == "release/customer-a",
               "project branch mapping is created")
            repo_id = created.json()["id"]

            duplicate = await http.post(
                "/api/v1/admin/projects/project-http-a/repos/from-catalog",
                headers=headers, json={
                    "catalogId": catalog_id, "branch": "release/customer-a"})
            ok(duplicate.status_code == 409,
               "duplicate mapping has a stable conflict response")

            copied = await http.post(
                f"/api/v1/admin/repos/{repo_id}/copy", headers=headers,
                json={"projectId": "project-http-b", "branch": "main"})
            ok(copied.status_code == 200
               and copied.json()["projectId"] == "project-http-b",
               "mapping is copied to another project")

            duplicate_copy = await http.post(
                f"/api/v1/admin/repos/{repo_id}/copy", headers=headers,
                json={"projectId": "project-http-b", "branch": "main"})
            ok(duplicate_copy.status_code == 409,
               "duplicate copied mapping is rejected")

            account_url = "/api/v1/admin/integrations/integration-http/pull-account"
            saved = await http.post(account_url, headers=headers,
                                    json={"user": "saved-account", "secret": "saved-password", "kind": "password"})
            ok(saved.status_code == 200, "fixed account can be saved through HTTP")
            probe = await http.post(account_url + "/test", headers=headers,
                                    json={"user": "edited-account", "secret": None, "kind": ""})
            ok(probe.status_code == 200 and probe.json() == {
                "ok": True, "user": "edited-account", "kind": ""},
                "HTTP probe forwards partial edits and an explicit automatic mode")
            stored = await http.post(account_url + "/test", headers=headers, json={})
            ok(stored.json() == {"ok": True, "user": "saved-account", "kind": "password"},
               "a temporary HTTP probe does not mutate the saved account")
            invalid = await http.post(account_url + "/test", headers=headers, json={"user": ""})
            ok(invalid.status_code == 200 and invalid.json().get("ok") is False,
               "HTTP probe does not silently ignore an invalid draft")
            renamed = await http.post(account_url, headers=headers,
                                      json={"user": "edited-account", "secret": None, "kind": ""})
            stored = await http.post(account_url + "/test", headers=headers, json={})
            ok(renamed.status_code == 200 and stored.json() == probe.json(),
               "saving the tested draft preserves exactly the same authentication fields")

        async with SessionLocal() as session:
            integration = await session.get(models.Integration, "integration-http")
            ok("token" not in dict(integration.config or {}),
               "runtime credential never reaches integration config")
            repos = list((await session.execute(
                __import__("sqlalchemy").select(models.Repo))).scalars().all())
            ok(len(repos) == 2
               and all(repo.source_repository_id for repo in repos),
               "both mappings retain canonical repository identity")
    finally:
        if original is None:
            REGISTRY.pop("gitlab", None)
        else:
            REGISTRY["gitlab"] = original
        await engine.dispose()


try:
    asyncio.run(main())
    print(f"repository HTTP smoke: {checks} assertions passed")
finally:
    shutil.rmtree(folder, ignore_errors=True)
