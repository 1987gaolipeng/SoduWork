"""Schedule repository authorization uses the owner-visible task catalog.

All queries run against a private in-memory database. Execution and model calls
are replaced only at their external boundaries.
"""
from __future__ import annotations

import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ.setdefault("AUTH_SECRET", "isolated-schedule-scope-test-secret")

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from fastapi import HTTPException

from app import models
from app.services import ai_exec, schedule_conversations, schedules


class ScheduleRepoScopeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        tables = [models.OrgUnit, models.User, models.Client,
                  models.Project, models.Repo, models.Task]
        async with self.engine.begin() as connection:
            for model in tables:
                await connection.run_sync(model.__table__.create)
        self.session = async_sessionmaker(self.engine, expire_on_commit=False)()
        self.owner = models.User(id="owner", username="owner", org_id="team")
        self.client = models.Client(id="device", user_ref="owner",
                                    config={"automationConversationV1": 1})
        self.session.add_all([
            models.OrgUnit(id="company", name="Company"),
            models.OrgUnit(id="team", name="Team", parent_id="company"),
            models.OrgUnit(id="child", name="Child", parent_id="team"),
            models.OrgUnit(id="sibling", name="Sibling", parent_id="company"),
            self.owner, self.client,
        ])
        for key, org, status in [
            ("own", "team", "active"),
            ("parent", "company", "active"),
            ("child", "child", "active"),
            ("hidden", "sibling", "active"),
            ("public", None, "active"),
            ("archived", "team", "archived"),
        ]:
            self.session.add_all([
                models.Project(id="project-" + key, name=key,
                               org_id=org, status=status),
                models.Repo(id=key, name=key, project_id="project-" + key,
                            org_id=org, local_dir=key),
            ])
        await self.session.commit()

    async def asyncTearDown(self):
        await self.session.close()
        await self.engine.dispose()

    def schedule(self, repo="own", **fields):
        values = dict(
            id="schedule", title="Scheduled work", note="Full instruction",
            owner_client_id="device", owner_user_id="owner", assignee_id="local:pi", assignee_type="agent",
            repo_id=repo, flow=False, required_capabilities=[], plugin_binding_id="",
            personal_plugin_key="", plugin_inputs={}, time_zone="Asia/Shanghai",
        )
        values.update(fields)
        return SimpleNamespace(**values)

    async def test_direct_save_rejects_sibling_repository_with_no_capabilities(self):
        with self.assertRaisesRegex(ValueError, "工程.*范围|工程.*不可用"):
            await schedules.validate_execution(self.session, self.schedule("hidden"))

    async def test_personal_save_rejects_sibling_repository(self):
        schedule = self.schedule("hidden", personal_plugin_key="mini-game",
                                 personal_plugin_version_policy="pinned",
                                 personal_plugin_version="1.0.0",
                                 personal_plugin_checksum="a" * 64)
        with self.assertRaisesRegex(ValueError, "工程.*范围|工程.*不可用"):
            await schedules.validate_execution(self.session, schedule)

    async def test_preflight_rejects_hidden_repository_before_runner_probe(self):
        with patch.object(ai_exec, "load", AsyncMock()) as load, \
                patch.object(ai_exec, "resolve_requested_sync", return_value={"id": "pi"}):
            with self.assertRaisesRegex(ValueError, "工程.*范围|工程.*不可用"):
                await schedules.preflight_execution(self.session, self.schedule("hidden"))
        load.assert_not_awaited()

    async def test_api_preflight_reports_blocked_using_authenticated_owner(self):
        from app.api import tasks

        result = await tasks.preflight_my_schedule(
            body={"repoId": "hidden", "assigneeId": "local:pi",
                  "ownerClientId": "other-device"},
            client=self.client, session=self.session)
        self.assertEqual(result["state"], "blocked")
        self.assertIn("工程", result["message"])

    async def test_api_save_reports_conflict_for_hidden_repository(self):
        from app.api import tasks

        with self.assertRaises(HTTPException) as caught:
            await tasks.create_my_schedule(
                body={"title": "Work", "repoId": "hidden", "assigneeId": "local:pi"},
                client=self.client, session=self.session)
        self.assertEqual(caught.exception.status_code, 409)
        self.assertIn("工程", caught.exception.detail)

    async def test_valid_personal_selection_preserves_pinned_snapshot(self):
        schedule = self.schedule(personal_plugin_key="mini-game",
                                 personal_plugin_version_policy="pinned",
                                 personal_plugin_version="1.0.0",
                                 personal_plugin_checksum="a" * 64)
        self.assertIsNone(await schedules.validate_execution(self.session, schedule))
        self.assertEqual(schedules.personal_plugin_spec(schedule), {
            "key": "mini-game", "versionPolicy": "pinned",
            "version": "1.0.0", "checksum": "a" * 64})

    async def test_archived_and_missing_repositories_are_rejected(self):
        for repo in ["archived", "missing"]:
            with self.subTest(repo=repo), self.assertRaises(ValueError):
                await schedules.validate_execution(self.session, self.schedule(repo))

    async def test_owner_catalog_allows_own_parent_child_and_public_repositories(self):
        for repo in ["own", "parent", "child", "public", ""]:
            with self.subTest(repo=repo):
                self.assertIsNone(await schedules.validate_execution(
                    self.session, self.schedule(repo)))

    async def test_admin_scope_is_additional_to_owner_scope(self):
        for repo, scope in [("hidden", {"sibling"}), ("parent", {"team"}),
                            ("own", set())]:
            with self.subTest(repo=repo, scope=scope), self.assertRaises(ValueError):
                await schedules.validate_execution(
                    self.session, self.schedule(repo), org_ids=scope)
        for repo in ["own", "public"]:
            self.assertIsNone(await schedules.validate_execution(
                self.session, self.schedule(repo), org_ids={"team"}))

    async def test_admin_cannot_choose_repo_owned_outside_its_scope(self):
        repo = await self.session.get(models.Repo, "own")
        repo.org_id = "sibling"
        await self.session.commit()
        with self.assertRaises(ValueError):
            await schedules.validate_execution(
                self.session, self.schedule(), org_ids={"team"})

    async def test_owner_without_active_membership_can_only_use_public_repository(self):
        self.owner.is_active = False
        await self.session.commit()
        with self.assertRaises(ValueError):
            await schedules.validate_execution(self.session, self.schedule())
        self.assertIsNone(await schedules.validate_execution(
            self.session, self.schedule("public")))
        self.client.user_ref = None
        await self.session.commit()
        with self.assertRaises(ValueError):
            await schedules.validate_execution(self.session, self.schedule())

    async def test_missing_owner_is_rejected_for_selected_repository(self):
        with self.assertRaises(ValueError):
            await schedules.validate_execution(
                self.session, self.schedule(owner_client_id="missing"))

    async def test_run_rechecks_revoked_scope_before_preparing_conversation(self):
        schedule = self.schedule()
        await schedules.validate_execution(self.session, schedule)
        self.owner.org_id = "sibling"
        await self.session.commit()
        with patch.object(schedule_conversations, "prepare", AsyncMock(
                return_value={"ok": True})) as prepare:
            result = await schedules.run_one(self.session, schedule, schedule_run_id="run")
        self.assertFalse(result["ok"])
        self.assertIn("工程", result["error"])
        prepare.assert_not_awaited()

    async def test_valid_run_passes_the_same_repository_to_conversation(self):
        with patch.object(schedule_conversations, "prepare", AsyncMock(
                return_value={"ok": True})) as prepare:
            result = await schedules.run_one(
                self.session, self.schedule(), schedule_run_id="run")
        self.assertTrue(result["ok"])
        self.assertEqual(prepare.await_args.args[3].id, "own")

    async def test_direct_flow_flag_still_uses_plain_conversation_without_task(self):
        schedule = self.schedule(flow=True)
        with patch.object(schedule_conversations, "prepare", AsyncMock(
                return_value={"ok": True})) as prepare:
            result = await schedules.run_one(
                self.session, schedule, schedule_run_id="run")
        self.assertTrue(result["ok"])
        prepare.assert_awaited_once()
        self.assertEqual((await self.session.execute(select(models.Task))).scalars().all(), [])

    async def test_enterprise_run_rejects_hidden_repository_before_creating_task(self):
        schedule = self.schedule("hidden", plugin_binding_id="binding")
        with patch.object(schedules, "validate_execution", AsyncMock(
                side_effect=ValueError("Binding no longer available"))):
            result = await schedules.run_one(self.session, schedule)
        self.assertFalse(result["ok"])
        tasks = (await self.session.execute(select(models.Task))).scalars().all()
        self.assertEqual(tasks, [], "Forbidden repository must not create an execution Task")

    async def test_retired_plugin_binding_uses_owner_scoped_conversation_without_task(self):
        schedule = self.schedule("own", plugin_binding_id="binding")
        with patch.object(schedule_conversations, "prepare", AsyncMock(
                return_value={"ok": True, "executionMode": schedule_conversations.PROTOCOL})) as prepare:
            result = await schedules.run_one(self.session, schedule, schedule_run_id="run")
        self.assertTrue(result["ok"])
        self.assertEqual(result["executionMode"], schedule_conversations.PROTOCOL)
        self.assertEqual(schedule.plugin_binding_id, "")
        self.assertEqual(prepare.await_args.args[3].id, "own")
        self.assertEqual((await self.session.execute(select(models.Task))).scalars().all(), [])


if __name__ == "__main__":
    unittest.main()
