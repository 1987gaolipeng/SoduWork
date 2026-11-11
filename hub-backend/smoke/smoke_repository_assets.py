"""Offline smoke for repository discovery, immutable task targets and leases."""
from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
from pathlib import Path

folder = Path(tempfile.mkdtemp(prefix="soduwork-repository-assets-"))
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + (folder / "test.db").as_posix()

from sqlalchemy import select

from app import automation_models as am, models
from app.connectors import REGISTRY
from app.db import Base, SessionLocal, engine
from app.services import repository_catalog, resource_leases, task_code_targets

checks = 0


def ok(value, message: str) -> None:
    global checks
    if not value:
        raise AssertionError(message)
    checks += 1


class FakeGitLab:
    type = "gitlab"
    scheduled = False

    def __init__(self):
        self.round = 1
        self.saw_secret = False

    def list_repositories(self, config: dict) -> list[dict]:
        self.saw_secret = config.get("token") == "private-token"
        rows = [{
            "externalId": "101", "fullName": "group/service",
            "displayName": "service", "cloneUrl": "https://git/service.git",
            "sshUrl": "git@git:service.git", "webUrl": "https://git/service",
            "defaultBranch": "main", "visibility": "private",
            "metadata": {"namespace": "group"},
        }]
        if self.round == 1:
            rows.append({
                "externalId": "102", "fullName": "group/web",
                "displayName": "web", "cloneUrl": "https://git/web.git",
                "defaultBranch": "develop", "visibility": "private",
            })
        return rows

    def list_branches(self, config: dict, external_id: str) -> list[str]:
        self.saw_secret = self.saw_secret and config.get("token") == "private-token"
        return ["main", "release/project-a", "main"]

    def verify(self, config: dict) -> dict:
        """Expose resolved connector runtime fields in a verification fixture for fixed-account
        assertions.
        """
        return {"ok": True, "detail": "user=" + str(config.get("_auth_user") or "")
                + " kind=" + str(config.get("_auth_kind") or "")}


async def main() -> None:
    manual_a = type("Repo", (), {"source_repository_id": "",
                                  "git_url": "HTTPS://GIT/Group/App.git/"})()
    manual_b = type("Repo", (), {"source_repository_id": "",
                                  "git_url": "https://git/group/app.git"})()
    ok(repository_catalog._mapping_identity(manual_a)
       == repository_catalog._mapping_identity(manual_b),
       "manual mappings of the same remote share one concurrency identity")
    fake = FakeGitLab()
    original = REGISTRY.get("gitlab")
    REGISTRY["gitlab"] = fake
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with SessionLocal() as session:
            org = models.OrgUnit(id="org-engineering", name="Engineering")
            user = models.User(id="user-owner", username="owner", display_name="Owner", org_id=org.id)
            client = models.Client(id="u-repo", name="Owner PC", user_ref=user.id,
                                   git_creds={"token": "private-token"})
            integration = models.Integration(
                name="GitLab", type="gitlab",
                config={"base_url": "https://git", "credentialClientId": client.id})
            project = models.Project(id="project-a", name="Product A", org_id=org.id)
            project_b = models.Project(id="project-b", name="Product B", org_id=org.id)
            session.add_all([org, user, client, integration, project, project_b])
            await session.commit()

            first = await repository_catalog.sync_integration(session, integration.id)
            ok(first == {"ok": True, "total": 2, "created": 2,
                         "updated": 0, "inactive": 0}, "first sync counts")
            ok(fake.saw_secret, "runtime credential reached connector")
            await session.refresh(integration)
            ok("token" not in dict(integration.config or {}), "secret was not persisted")
            ok(integration.repository_sync_ok is True
               and integration.repository_sync_count == 2,
               "repository catalog has independent health state")
            ok(integration.last_pull_at is None,
               "repository sync never overwrites task ingestion health")

            visible = await repository_catalog.list_catalog(
                session, scope={org.id})
            ok(len(visible) == 2, "catalog is visible inside organization")
            ok(not await repository_catalog.list_catalog(
                session, scope={"another-org"}), "catalog is hidden across organizations")

            fake.round = 2
            second = await repository_catalog.sync_integration(session, integration.id)
            ok(second["total"] == 1 and second["inactive"] == 1,
               "missing remote repository becomes inactive")
            automatic = await repository_catalog.sync_all(session)
            ok(automatic["integrations"] == 1
               and automatic["results"][0]["ok"] is True,
               "periodic catalog path refreshes configured integrations")


            await repository_catalog.set_pull_account(
                session, integration.id, user="svc-bot", secret="ldap-pass",
                kind="password", org_id=org.id)
            await session.refresh(integration)
            pull_cfg = dict(integration.config or {}).get("pullAuth") or {}
            ok(pull_cfg.get("user") == "svc-bot" and pull_cfg.get("secret") == "ldap-pass",
               "fixed pull account persists on the integration source")
            probe = await repository_catalog.verify_pull_account(session, integration.id)
            ok(probe.get("ok") and "user=svc-bot" in probe.get("detail", "")
               and "kind=password" in probe.get("detail", ""),
               "verify uses the stored fixed account")
            probe2 = await repository_catalog.verify_pull_account(
                session, integration.id,
                override={"user": "temp", "secret": "s", "kind": ""})
            ok("user=temp" in probe2.get("detail", ""),
               "verify prefers the just-typed override before saving")
            draft_cfg, _ = await repository_catalog._runtime_config(
                session, integration, override={"user": "renamed-draft", "secret": None, "kind": ""})
            ok(draft_cfg.get("_auth_user") == "renamed-draft"
               and draft_cfg.get("_auth_secret") == "ldap-pass"
               and draft_cfg.get("_auth_kind") == "",
               "a partial probe uses the draft username, stored secret and explicit automatic mode")
            token_cfg, _ = await repository_catalog._runtime_config(
                session, integration, override={"secret": "temporary-token", "kind": "token"})
            ok(token_cfg.get("_auth_user") == "svc-bot"
               and token_cfg.get("_auth_secret") == "temporary-token"
               and token_cfg.get("_auth_kind") == "token",
               "a token-only draft retains the stored username without storing the token")
            try:
                await repository_catalog._runtime_config(session, integration, override={"user": ""})
            except ValueError:
                ok(True, "a blank draft username cannot silently test the old account")
            else:
                raise AssertionError("blank draft username was accepted")
            await session.refresh(integration)
            ok(integration.config["pullAuth"] == pull_cfg,
               "temporary probes never modify stored credentials or authentication mode")
            cfg_fixed, _org = await repository_catalog._runtime_config(session, integration)
            ok(cfg_fixed.get("_auth_user") == "svc-bot"
               and cfg_fixed.get("_auth_secret") == "ldap-pass",
               "runtime config prefers the fixed account over the borrowed device")
            ok(_org == org.id, "org attribution comes from the source itself")
            await repository_catalog.set_pull_account(
                session, integration.id, user="svc-bot2", secret=None)
            await session.refresh(integration)
            pull_cfg = dict(integration.config or {}).get("pullAuth") or {}
            ok(pull_cfg.get("user") == "svc-bot2"
               and pull_cfg.get("secret") == "ldap-pass",
               "renaming the account without retyping keeps the stored secret")
            ok(pull_cfg.get("kind") == "password", "omitted authentication mode retains its stored value")
            await repository_catalog.set_pull_account(
                session, integration.id, user="svc-bot2", secret=None, kind="")
            await session.refresh(integration)
            ok(integration.config["pullAuth"].get("kind") == ""
               and integration.config["pullAuth"].get("secret") == "ldap-pass",
               "explicit automatic mode clears password mode while preserving the secret")
            from app.schemas import integration_to_api
            api_view = integration_to_api(integration)
            ok(api_view.get("pullAccountUser") == "svc-bot2"
               and api_view.get("pullAccountSet") is True
               and api_view.get("config", {}).get("pullAuth", {}).get("secret") is None,
               "API masks the pull secret and only reports its presence")
            # Masked configuration round trips must not overwrite stored secrets.
            from app.services import aggregation
            await aggregation.update_integration(
                session, integration.id, config=dict(api_view["config"]))
            await session.refresh(integration)
            ok(dict(integration.config or {}).get("pullAuth", {}).get("secret")
               == "ldap-pass",
               "round-tripping the masked config keeps the stored pull secret")
            # Restore the legacy device-credential fixture for subsequent cases.
            cfg_reset = dict(integration.config or {})
            cfg_reset.pop("pullAuth", None)
            integration.config = cfg_reset
            await session.commit()
            rows = list((await session.execute(select(am.ScmRepository).order_by(
                am.ScmRepository.external_id))).scalars().all())
            source = rows[0]
            ok(rows[0].active and not rows[1].active, "active flags match remote catalog")
            branch_values = await repository_catalog.branches(session, source)
            ok(branch_values == ["main", "release/project-a"], "branches are normalized")

            mapping = await repository_catalog.create_mapping(
                session, project, source, {"branch": "release/project-a",
                                           "mergeBranch": "release/project-a"})
            ok(mapping.source_repository_id == source.id
               and mapping.default_branch == "release/project-a",
               "project branch mapping keeps canonical source")
            duplicate_rejected = False
            try:
                await repository_catalog.create_mapping(
                    session, project, source, {"branch": "release/project-a"})
            except ValueError:
                duplicate_rejected = True
            ok(duplicate_rejected, "duplicate project repository branch is rejected")
            mapping.server_dir = "/production/a"
            mapping.ai_work_dir = "/worker/a"
            mapping.deploy_targets = [{"name": "prod"}]
            await session.commit()
            copied = await repository_catalog.copy_mapping(
                session, mapping, project_b, {"branch": "customer/b"})
            ok(copied.project_id == project_b.id and copied.default_branch == "customer/b",
               "mapping can be copied to another project branch")
            ok(not copied.server_dir and not copied.ai_work_dir and not copied.deploy_targets,
               "copy never carries environment-specific deployment configuration")
            duplicate_copy_rejected = False
            try:
                await repository_catalog.copy_mapping(
                    session, mapping, project_b, {"branch": "customer/b"})
            except ValueError:
                duplicate_copy_rejected = True
            ok(duplicate_copy_rejected, "duplicate copied mapping is rejected")

            task = models.Task(title="Fix", project_id=project.id, repo_id=mapping.id)
            session.add(task)
            await session.flush()
            target = await task_code_targets.freeze(session, task, mapping)
            await session.commit()
            frozen_url, frozen_base = target.git_url, target.base_branch
            mapping.git_url = "https://git/changed.git"
            mapping.default_branch = "changed"
            mapping.merge_branch = "changed"
            await session.commit()
            view = await task_code_targets.repo_view(session, task, mapping)
            ok(view.git_url == frozen_url and view.default_branch == frozen_base,
               "running task ignores later mapping edits")
            ok((await task_code_targets.get(session, task.id)).fingerprint == target.fingerprint,
               "task target fingerprint remains stable")

            lease = await resource_leases.acquire(session, "merge", "repo:main",
                                                   owner="one", ttl_seconds=30)
            async with SessionLocal() as contender:
                busy = False
                try:
                    await resource_leases.acquire(contender, "merge", "repo:main",
                                                   owner="two", ttl_seconds=30)
                except resource_leases.LeaseBusy:
                    busy = True
                ok(busy, "second process cannot claim a live lease")
            ok(await resource_leases.release(session, lease), "lease release is token guarded")
            again = await resource_leases.acquire(session, "merge", "repo:main",
                                                   owner="two", ttl_seconds=30)
            ok(again.owner == "two", "released lease can be reclaimed")
            await resource_leases.release(session, again)
    finally:
        if original is None:
            REGISTRY.pop("gitlab", None)
        else:
            REGISTRY["gitlab"] = original
        await engine.dispose()


try:
    asyncio.run(main())
    print(f"repository assets smoke: {checks} assertions passed")
finally:
    shutil.rmtree(folder, ignore_errors=True)
