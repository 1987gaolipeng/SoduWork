"""Repository membership grants requirement reading/claiming, never execution."""
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch
from types import SimpleNamespace

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("AUTH_SECRET", "repository-issue-isolated-test-secret")
os.environ.setdefault("ADMIN_PASS", "repository-issue-isolated-test-password")
from sqlalchemy import create_engine, delete, event, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app import models, automation_models
from app.db import Base
from app.repository_issue_models import RepositoryIssueLink, RepositoryIssueMember, RepositoryIssueSync
from app.services import repository_issue_access as access, task_requirements, task_access, inbox
from app.schemas import task_to_api


class RepositoryIssueAccessTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        # Build the complete schema once without per-statement async DDL hops.
        # Each test receives a private copy and retains real async transactions.
        cls.template_folder = tempfile.TemporaryDirectory(prefix="soduwork-repository-access-schema-")
        cls.template_path = Path(cls.template_folder.name) / "template.db"
        engine = create_engine("sqlite:///" + cls.template_path.as_posix())
        try:
            Base.metadata.create_all(engine)
        finally:
            engine.dispose()

    @classmethod
    def tearDownClass(cls):
        cls.template_folder.cleanup()

    async def asyncSetUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix="soduwork-repository-access-db-")
        self.db_path = Path(self.folder.name) / "fixture.db"
        shutil.copyfile(self.template_path, self.db_path)
        self.engine = create_async_engine("sqlite+aiosqlite:///" + self.db_path.as_posix())
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        self.clients = {}
        async with self.sessions() as session:
            session.add(models.OrgUnit(id="org", name="Same department"))
            for uid in ("member", "other-member", "peer", "unmapped"):
                session.add(models.User(id=uid, username=uid, org_id="org", is_active=True))
                client = models.Client(id=uid, user_ref=uid, auth_state="active")
                self.clients[uid] = client
                session.add(client)
            session.add(automation_models.ScmRepository(id="catalog", integration_id="gitlab",
                provider="gitlab", external_id="149", full_name="group/repo", org_id="org"))
            session.add(RepositoryIssueSync(catalog_id="catalog", enabled=True, started_label="处理中"))
            for uid in ("member", "other-member"):
                session.add(RepositoryIssueMember(catalog_id="catalog", external_user_id=uid,
                    username=uid, user_id=uid, active=True))
            session.add(RepositoryIssueMember(catalog_id="catalog", external_user_id="external-unmapped",
                username="unmapped", active=True))
            session.add(models.Task(id="issue", title="Issue", note="public input", origin="gitlab_issue",
                status="todo", triage_stage="ready", result="private output", work_routing={"private": True}))
            session.add(RepositoryIssueLink(id="link", catalog_id="catalog", issue_id="1001",
                issue_iid=1, task_id="issue", issue_url="https://gitlab.example/group/repo/-/issues/1"))
            await session.commit()
        self.publish = patch("app.realtime.hub.publish", new_callable=AsyncMock)
        self.published = self.publish.start()

    async def asyncTearDown(self):
        self.publish.stop()
        await self.engine.dispose()
        self.folder.cleanup()

    async def test_members_can_read_and_claim_but_not_execution_and_names_are_not_identity(self):
        async with self.sessions() as session:
            task = await session.get(models.Task, "issue")
            member = self.clients["member"]
            self.assertTrue(await task_requirements.can_read(session, member, task))
            self.assertFalse(await task_access.can_view(session, member, task))
            api = await task_requirements.decorate(session, member, task, task_to_api(task))
            self.assertTrue(api["canClaim"])
            self.assertIn("repository_member", api["myRoles"])
            self.assertEqual({row["id"] for row in api["repositoryIssue"]["relatedUsers"]},
                             {"member", "other-member"})
            self.assertNotIn("result", api)
            self.assertNotIn("workRouting", api)
            self.assertFalse(api["canEditRequirement"])
            for uid in ("peer", "unmapped"):
                self.assertFalse(await task_requirements.can_read(session, self.clients[uid], task))
                self.assertFalse((await access.claim(session, self.clients[uid], task.id))["ok"])

    async def test_list_and_inbox_include_only_active_mapped_members(self):
        async with self.sessions() as session:
            for uid, expected in (("member", {"issue"}), ("peer", set()), ("unmapped", set())):
                clause = await task_requirements.visible_clause(session, self.clients[uid])
                ids = set(await session.scalars(select(models.Task.id).where(clause)))
                self.assertEqual(ids, expected)
                result = await inbox.list_inbox(session, self.clients[uid])
                self.assertEqual({item["id"] for item in result["items"]}, expected)
                self.assertEqual(await inbox.inbox_count(session, self.clients[uid]), len(expected))
            member = await session.get(RepositoryIssueMember, ("catalog", "member"))
            member.active = False
            await session.flush()
            self.assertFalse(await task_requirements.can_read(session, self.clients["member"],
                await session.get(models.Task, "issue")))

    async def test_claim_is_single_owner_and_never_enqueues_start_writeback(self):
        async with self.sessions() as session:
            first = await inbox.claim(session, self.clients["member"], "issue")
            self.assertTrue(first["ok"])
            self.assertFalse(first["task"]["canClaim"])
            self.assertTrue(first["task"]["canViewExecution"])
        async with self.sessions() as session:
            second = await access.claim(session, self.clients["other-member"], "issue")
            self.assertEqual(second["reason"], "already_claimed")
            task = await session.get(models.Task, "issue")
            self.assertEqual(task.owner_client_id, "member")
            self.assertEqual(task.assignee_user_id, "member")
            self.assertEqual(task.status, "todo")
            self.assertIsNone((await session.get(RepositoryIssueLink, "link")).started_at)

    async def test_stale_identity_map_cannot_overwrite_a_claim(self):
        async with self.sessions() as stale:
            task = await stale.get(models.Task, "issue")
            self.assertIsNone(task.owner_client_id)
            async with self.sessions() as winner:
                self.assertTrue((await access.claim(winner, self.clients["member"], "issue"))["ok"])
            loser = await access.claim(stale, self.clients["other-member"], "issue")
            self.assertEqual(loser["reason"], "already_claimed")

    async def test_release_keeps_repository_scope_and_notifies_members_for_reclaim(self):
        async with self.sessions() as session:
            self.assertTrue((await inbox.claim(session, self.clients["member"], "issue"))["ok"])
            self.published.reset_mock()
            self.assertTrue((await inbox.release(session, self.clients["member"], "issue"))["ok"])
            task = await session.get(models.Task, "issue")
            self.assertIsNone(task.pool_org_id)
            self.assertIsNone(task.owner_client_id)
            self.assertIsNone(task.assignee_user_id)
            self.assertEqual((await inbox.list_inbox(session, self.clients["peer"]))["items"], [])
            self.assertEqual(await inbox.inbox_count(session, self.clients["peer"]), 0)
            self.assertFalse(await task_requirements.can_read(session, self.clients["peer"], task))
            self.assertEqual((await inbox.claim(session, self.clients["peer"], "issue"))["reason"], "out_of_scope")
            events = {call.args[0]: call.args[1] for call in self.published.await_args_list}
            self.assertEqual(set(events), {"member", "other-member"})
            for event in events.values():
                self.assertEqual(event["type"], "task.updated")
                self.assertTrue(event["task"]["canClaim"])
                self.assertFalse(event["task"]["canViewExecution"])
                self.assertNotIn("result", event["task"])
            self.assertTrue((await inbox.claim(session, self.clients["other-member"], "issue"))["ok"])

    async def test_repository_member_without_org_can_release_to_repository_pool(self):
        async with self.sessions() as session:
            member = await session.get(models.User, "member")
            member.org_id = None
            await session.commit()
            self.assertTrue((await inbox.claim(session, self.clients["member"], "issue"))["ok"])
            self.assertTrue((await inbox.release(session, self.clients["member"], "issue"))["ok"])
            self.assertIsNone((await session.get(models.Task, "issue")).pool_org_id)

    async def test_user_inbox_and_claim_without_org_preserve_repository_membership(self):
        async with self.sessions() as session:
            member = await session.get(models.User, "member")
            member.org_id = None
            await session.commit()
            result = await inbox.list_for_user(session, member)
            self.assertEqual({row["id"] for row in result["items"]}, {"issue"})
            item = result["items"][0]
            self.assertTrue(item["canClaim"])
            self.assertFalse(item["canViewExecution"])
            self.assertIn("repository_member", item["myRoles"])
            self.assertNotIn("result", item)
            self.assertNotIn("workRouting", item)
            claimed = await inbox.claim_for_user(session, member, "issue")
            self.assertTrue(claimed["ok"])
            task = await session.get(models.Task, "issue")
            self.assertEqual(task.owner_user_id, member.id)
            self.assertTrue((await inbox.release(session, self.clients["member"], "issue"))["ok"])
            self.assertIsNone(task.owner_user_id)
            for call in self.published.await_args_list:
                self.assertEqual(call.kwargs["user_id"], call.args[0])

    async def test_team_claim_binds_account_and_replacement_login_cannot_release(self):
        async with self.sessions() as session:
            task = models.Task(id="team-task", title="Team task", status="todo", pool_org_id="org")
            session.add(task)
            await session.commit()
            client = self.clients["member"]
            claimed = await inbox.claim(session, client, task.id)
            self.assertTrue(claimed["ok"])
            self.assertEqual((task.owner_client_id, task.owner_user_id), (client.id, "member"))
            self.assertTrue(task_access.is_owner(task, client))
            replacement = SimpleNamespace(id=client.id, user_ref="peer")
            denied = await inbox.release(session, replacement, task.id)
            self.assertEqual(denied, {"ok": False, "reason": "not_owner"})
            self.assertEqual((task.owner_client_id, task.owner_user_id), (client.id, "member"))
            self.published.reset_mock()
            self.assertTrue((await inbox.release(session, client, task.id))["ok"])
            self.assertEqual((task.owner_client_id, task.owner_user_id, task.pool_org_id), (None, None, "org"))
            self.published.assert_awaited_once_with(client.id, {"type": "task.deleted", "id": task.id}, user_id="member")

    async def test_legacy_repository_pool_rows_do_not_grant_team_visibility_or_assignment(self):
        async with self.sessions() as session:
            task = await session.get(models.Task, "issue")
            task.pool_org_id = "org"
            await session.commit()
            self.assertEqual((await inbox.list_inbox(session, self.clients["peer"]))["items"], [])
            self.assertEqual(await inbox.inbox_count(session, self.clients["peer"]), 0)
            self.assertEqual((await inbox.list_for_orgs(session, {"org"}))["items"], [])
            self.assertEqual((await inbox.list_for_orgs(session, None))["items"], [])
            peer = await session.get(models.User, "peer")
            self.assertEqual((await inbox.assign_to_user(session, task.id, peer, {"org"}))["reason"], "out_of_scope")
            self.assertIsNone(task.owner_client_id)
            self.assertEqual({row["id"] for row in (await inbox.list_inbox(session,
                self.clients["member"]))["items"]}, {"issue"})
            self.assertEqual(await inbox.inbox_count(session, self.clients["member"]), 1)

    async def test_repository_requirements_cannot_expand_to_company_visibility(self):
        from fastapi import HTTPException
        async with self.sessions() as session:
            self.assertTrue((await inbox.claim(session, self.clients["member"], "issue"))["ok"])
            task = await session.get(models.Task, "issue")
            with self.assertRaises(HTTPException) as raised:
                await task_requirements.apply(session, self.clients["member"], task,
                                               {"visibility": "organization"})
            self.assertEqual(raised.exception.status_code, 403)
            # Previously persisted sharing must not keep exposing source content.
            task.shared_org_id = "org"
            await session.flush()
            self.assertFalse(await task_requirements.can_read(session, self.clients["peer"], task))
            clause = await task_requirements.visible_clause(session, self.clients["peer"])
            self.assertEqual(list(await session.scalars(select(models.Task.id).where(clause))), [])
            self.assertEqual({row.id for row in await task_access.recipient_clients(session, task)},
                             {"member", "other-member"})
            self.assertEqual(task_requirements.fields(task)["visibility"], "related")
            self.assertTrue(await task_access.can_view(session, self.clients["member"], task))

    async def test_archived_invalid_stage_or_finished_issue_cannot_claim(self):
        for field, value in (("archived_at", datetime.now(timezone.utc)),
                             ("triage_stage", "invalid"), ("status", "done"), ("status", "doing")):
            async with self.sessions() as session:
                task = await session.get(models.Task, "issue")
                original = getattr(task, field)
                setattr(task, field, value)
                await session.commit()
                self.assertEqual((await access.claim(session, self.clients["member"], "issue"))["reason"], "not_claimable")
                setattr(task, field, original)
                await session.commit()

    async def _assert_collection_claim_becomes_ready(self, stage, provider="gitlab"):
        from fastapi import HTTPException
        from app.services import tasks
        with patch.object(tasks, "task_to_api_live", AsyncMock(return_value={})), \
                patch.object(task_requirements, "refresh_memory", AsyncMock()), \
                patch.object(task_requirements, "forget_previous_viewers", AsyncMock()), \
                patch.object(task_access, "publish_task", AsyncMock()):
            async with self.sessions() as session:
                task = await session.get(models.Task, "issue")
                task.triage_stage = stage
                task.origin = f"{provider}_issue"
                repo = await session.get(automation_models.ScmRepository, "catalog")
                repo.provider = provider
                await session.commit()
                claim_uid = "peer" if provider == "github" else "member"
                member = self.clients[claim_uid]
                api = await task_requirements.decorate(session, member, task, task_to_api(task))
                self.assertTrue(api["canClaim"])
                self.assertEqual(api["triageStage"], stage)
                self.assertEqual(api["repositoryIssue"]["provider"], provider)
                self.assertEqual({row["id"] for row in api["repositoryIssue"]["relatedUsers"]},
                                 {"member", "other-member", "peer", "unmapped"} if provider == "github"
                                 else {"member", "other-member"})
                for uid in ("member", "peer", "unmapped"):
                    expected = {"issue"} if provider == "github" or uid == "member" else set()
                    clause = await task_requirements.visible_clause(session, self.clients[uid])
                    self.assertEqual(set(await session.scalars(select(models.Task.id).where(clause))), expected)
                    self.assertEqual({row["id"] for row in (await inbox.list_inbox(
                        session, self.clients[uid]))["items"]}, expected)
                    self.assertEqual(await inbox.inbox_count(session, self.clients[uid]), len(expected))
                    if not expected:
                        self.assertFalse((await access.claim(session, self.clients[uid], task.id))["ok"])
                claimed = await inbox.claim(session, member, task.id)
                self.assertTrue(claimed["ok"])
                self.assertEqual(claimed["task"]["triageStage"], "ready")
                self.assertFalse(claimed["task"]["canClaim"])
                self.assertEqual((task.owner_client_id, task.owner_user_id, task.assignee_user_id, task.status),
                                 (claim_uid, claim_uid, claim_uid, "todo"))
                self.assertEqual(task.triage_stage, "ready")
                self.assertIsNone(task.actual_start_at)
                self.assertIsNone(await session.scalar(select(automation_models.ExecutionSession.id)
                    .where(automation_models.ExecutionSession.task_id == task.id)))
                link = await session.get(RepositoryIssueLink, "link")
                self.assertEqual((link.writeback_state, link.writeback_attempts), ("waiting", 0))
                self.assertIsNone(link.started_at)
                with self.assertRaises(HTTPException) as raised:
                    await tasks.update_task(session, "other-member", "issue", {"status": "doing"})
                self.assertEqual(raised.exception.status_code, 403)
                await session.rollback()
                await session.refresh(task)
                await session.refresh(link)
                self.assertEqual((task.status, task.triage_stage), ("todo", "ready"))
                self.assertIsNone(task.actual_start_at)
                self.assertIsNone(link.started_at)
                self.assertEqual((link.writeback_state, link.writeback_attempts), ("waiting", 0))
                await tasks.update_task(session, claim_uid, "issue", {"status": "doing"})
                await session.refresh(link)
                self.assertEqual(task.status, "doing")
                self.assertIsNotNone(link.started_at)
                self.assertEqual((link.writeback_state, link.writeback_attempts), ("pending", 0))

    async def test_intake_issue_claim_becomes_ready_without_starting(self):
        await self._assert_collection_claim_becomes_ready("intake")

    async def test_clarifying_issue_claim_becomes_ready_without_starting(self):
        await self._assert_collection_claim_becomes_ready("clarifying")

    async def test_github_intake_issue_claim_becomes_ready_without_starting(self):
        await self._assert_collection_claim_becomes_ready("intake", "github")

    async def test_github_clarifying_issue_claim_becomes_ready_without_starting(self):
        await self._assert_collection_claim_becomes_ready("clarifying", "github")

    async def test_github_company_scope_includes_sibling_department_without_repository_mapping(self):
        async with self.sessions() as session:
            session.add_all([models.OrgUnit(id="repo-dept", name="Repository department", parent_id="org"),
                models.OrgUnit(id="reader-dept", name="Sibling department", parent_id="org"),
                models.OrgUnit(id="outside", name="Other company")])
            clients = dict(self.clients)
            for uid, org_id, active, superuser in (("sibling", "reader-dept", True, False),
                    ("outsider", "outside", True, False), ("outside-admin", "outside", True, True),
                    ("inactive", "org", False, False), ("no-org", None, True, False)):
                session.add(models.User(id=uid, username=uid, org_id=org_id,
                                        is_active=active, is_super=superuser))
                clients[uid] = models.Client(id=uid, user_ref=uid, auth_state="active")
                session.add(clients[uid])
            repo = await session.get(automation_models.ScmRepository, "catalog")
            repo.provider, repo.org_id = "github", "repo-dept"
            task = await session.get(models.Task, "issue")
            task.origin, task.triage_stage = "github_issue", "intake"
            await session.execute(delete(RepositoryIssueMember))
            await session.commit()
            allowed = {"member", "other-member", "peer", "unmapped", "sibling"}
            self.assertEqual(set(await session.scalars(access.github_user_ids("catalog"))), allowed)
            for uid, client in clients.items():
                expected = {task.id} if uid in allowed else set()
                self.assertEqual(await access.is_member(session, client, task), bool(expected))
                self.assertEqual(await task_requirements.can_read(session, client, task), bool(expected))
                clause = await task_requirements.visible_clause(session, client)
                self.assertEqual(set(await session.scalars(select(models.Task.id).where(clause))), expected)
                self.assertEqual({row["id"] for row in (await inbox.list_inbox(session, client))["items"]}, expected)
                self.assertEqual(await inbox.inbox_count(session, client), len(expected))
                api = await task_requirements.decorate(session, client, task, task_to_api(task))
                self.assertEqual(api["canClaim"], bool(expected))
                if expected:
                    self.assertIn("organization_member", api["myRoles"])
                    self.assertNotIn("repository_member", api["myRoles"])
                    self.assertEqual(api["repositoryIssue"]["visibilityScope"], "organization")
                else:
                    self.assertFalse((await access.claim(session, client, task.id))["ok"])
            self.assertTrue((await inbox.claim(session, clients["sibling"], task.id))["ok"])
            self.assertTrue(await task_access.can_view(session, clients["sibling"], task))
            self.assertFalse(await task_access.can_view(session, clients["peer"], task))
            self.assertEqual({client.id for client in await task_access.recipient_clients(session, task)}, allowed)

    async def test_github_missing_catalog_organization_never_uses_members_or_task_sharing(self):
        async with self.sessions() as session:
            session.add_all([models.OrgUnit(id="dangling", name="Dangling", parent_id="missing"),
                             models.OrgUnit(id="cycle", name="Rootless", parent_id="cycle")])
            repo = await session.get(automation_models.ScmRepository, "catalog")
            repo.provider = "github"
            task = await session.get(models.Task, "issue")
            task.origin, task.shared_org_id = "github_issue", "org"
            for org_id in (None, "missing", "dangling", "cycle"):
                repo.org_id = org_id
                await session.commit()
                client = self.clients["member"]
                self.assertFalse(await access.is_member(session, client, task))
                self.assertFalse(await task_requirements.can_read(session, client, task))
                clause = await task_requirements.visible_clause(session, client)
                self.assertEqual(list(await session.scalars(select(models.Task.id).where(clause))), [])
                self.assertEqual((await inbox.list_inbox(session, client))["items"], [])
                self.assertEqual(await inbox.inbox_count(session, client), 0)
                api = await task_requirements.decorate(session, client, task, task_to_api(task))
                self.assertFalse(api["canClaim"])
                self.assertEqual(api["repositoryIssue"]["relatedUsers"], [])
                self.assertEqual((await access.claim(session, client, task.id))["reason"], "out_of_scope")

    async def test_first_start_is_atomic_idempotent_and_uses_callers_transaction(self):
        async with self.sessions() as session:
            task = await session.get(models.Task, "issue")
            self.assertTrue(await access.record_started(session, task))
            link = await session.get(RepositoryIssueLink, "link")
            first = link.started_at
            self.assertIsNotNone(first)
            self.assertEqual(link.writeback_state, "pending")
            self.assertIsNotNone(link.next_retry_at)
            self.assertEqual(link.writeback_label, "处理中")
            self.assertFalse(await access.record_started(session, task))
            await session.rollback()
        async with self.sessions() as session:
            self.assertIsNone((await session.get(RepositoryIssueLink, "link")).started_at)

    async def test_native_queued_start_and_manual_status_do_not_write_back_until_actual_event(self):
        from fastapi import HTTPException
        from app.services import conversation_turns, task_status
        body = {"conversationId": "chat", "turnId": "turn", "executor": "native"}
        async with self.sessions() as session:
            task = await session.get(models.Task, "issue")
            task.work_routing = {"conversationTurn": {**body, "state": "queued"}}
            with self.assertRaises(HTTPException):
                await conversation_turns.apply(session, task, {**body, "action": "started"})
            with patch.object(task_status, "mark", AsyncMock(return_value=True)):
                await conversation_turns.apply(session, task, {**body, "action": "start"})
            self.assertIsNone((await session.get(RepositoryIssueLink, "link")).started_at)
            await conversation_turns.apply(session, task, {**body, "action": "started"})
            link = await session.get(RepositoryIssueLink, "link")
            self.assertIsNotNone(link.started_at)
            link.writeback_state = "sent"
            await session.flush()
            await conversation_turns.apply(session, task, {**body, "action": "started"})
            await conversation_turns.apply(session, task, {**body, "action": "complete"})
            self.assertEqual(link.writeback_state, "sent")
            with self.assertRaises(HTTPException):
                await conversation_turns.apply(session, task, {**body, "action": "started"})

    async def test_owner_explicit_manual_start_enqueues_but_other_member_cannot_set_status(self):
        from fastapi import HTTPException
        from app.services import tasks
        with patch.object(tasks, "task_to_api_live", AsyncMock(return_value={})), \
                patch.object(task_requirements, "refresh_memory", AsyncMock()), \
                patch.object(task_requirements, "forget_previous_viewers", AsyncMock()), \
                patch.object(task_access, "publish_task", AsyncMock()):
            async with self.sessions() as session:
                task = await session.get(models.Task, "issue")
                task.owner_client_id = "member"
                task.owner_user_id = "member"
                task.assignee_user_id = "member"
                await session.commit()
                with self.assertRaises(HTTPException):
                    await tasks.update_task(session, "other-member", "issue", {"status": "doing"})
                self.assertIsNone((await session.get(RepositoryIssueLink, "link")).started_at)
                await tasks.update_task(session, "member", "issue", {"status": "doing"})
                self.assertIsNotNone((await session.get(RepositoryIssueLink, "link")).started_at)

    async def test_authorized_runner_only_actual_child_marker_enqueues_even_after_short_run(self):
        from app.services import execution_sessions, usage_ledger, tasks
        runner = SimpleNamespace(id="backend-local", client_id="member", host="fixture")
        with \
                patch.object(execution_sessions, "_allowed", AsyncMock(return_value=True)), \
                patch.object(execution_sessions, "_heal_lost_dispatch", AsyncMock(return_value=False)), \
                patch.object(usage_ledger, "from_execution", AsyncMock()), \
                patch.object(tasks, "task_to_api_live", AsyncMock(return_value={} )):
          async with self.sessions() as session:
            snap = {"taskId": "issue", "ref": "fixture-ref", "started": 1730000000}
            for state, marker in (("queued", 1730000000), ("dispatching", 1730000000), ("running", 0)):
                await execution_sessions.ingest_runner_snapshots(session, runner,
                    [{**snap, "status": state, "executionStartedAt": marker}])
                self.assertIsNone((await session.get(RepositoryIssueLink, "link")).started_at, state)
            task = await session.get(models.Task, "issue")
            await execution_sessions.ingest_live_snapshot(session, task, "fixture-ref",
                {"ok": True, "status": "running"}, {"at": 1730000000})
            self.assertIsNone((await session.get(RepositoryIssueLink, "link")).started_at)
            await execution_sessions.ingest_runner_snapshots(session, runner,
                [{**snap, "status": "done", "executionStartedAt": 1730000000}])
            self.assertIsNotNone((await session.get(RepositoryIssueLink, "link")).started_at)

    async def test_disabled_sync_retains_frozen_start_for_resume_and_membership_revocation_denies_claim(self):
        async with self.sessions() as session:
            config = await session.get(RepositoryIssueSync, "catalog")
            config.enabled = False
            config.started_label = "开始处理"
            task = await session.get(models.Task, "issue")
            self.assertTrue(await access.record_started(session, task))
            link = await session.get(RepositoryIssueLink, "link")
            self.assertEqual(link.writeback_label, "开始处理")
            self.assertEqual(link.writeback_state, "pending")
            member = await session.get(RepositoryIssueMember, ("catalog", "member"))
            member.active = False
            await session.flush()
            self.assertEqual((await access.claim(session, self.clients["member"], task.id))["reason"], "out_of_scope")

    async def test_fk_enabled_delete_and_clear_done_keep_issue_identity_tombstones(self):
        from app.services import tasks
        async with self.engine.begin() as conn:
            await conn.execute(text("PRAGMA foreign_keys=ON"))
        async with self.sessions() as session:
            self.assertEqual(await session.scalar(text("PRAGMA foreign_keys")), 1)
            task = await session.get(models.Task, "issue")
            task.owner_client_id = "member"
            task.owner_user_id = "member"
            task.assignee_user_id = "member"
            task.status = "done"
            task.reviewed_at = datetime.now(timezone.utc)
            link = await session.get(RepositoryIssueLink, "link")
            link.writeback_state = "pending"
            link.next_retry_at = datetime.now(timezone.utc)
            await session.commit()
            self.assertTrue((await tasks.delete_task(session, "member", task.id))["ok"])
            await session.refresh(link)
            self.assertIsNone(link.task_id)
            self.assertEqual(link.writeback_state, "manual")
            self.assertIsNone(link.next_retry_at)
            self.assertEqual(link.issue_iid, 1)
            for iid, state in ((2, "error"), (3, "sent")):
                session.add(models.Task(id=f"done-{iid}", title="Delivered", owner_client_id="member", owner_user_id="member",
                    assignee_user_id="member", status="done", origin="gitlab_issue",
                    reviewed_at=datetime.now(timezone.utc)))
                await session.flush()
                session.add(RepositoryIssueLink(id=f"link-{iid}", catalog_id="catalog", issue_id=str(iid),
                    issue_iid=iid, task_id=f"done-{iid}", writeback_state=state,
                    next_retry_at=datetime.now(timezone.utc)))
            await session.commit()
            self.assertEqual((await tasks.clear_done(session, "member"))["removed"], 2)
            for iid, expected in ((2, "manual"), (3, "sent")):
                row = await session.get(RepositoryIssueLink, f"link-{iid}", populate_existing=True)
                self.assertIsNone(row.task_id)
                self.assertEqual(row.writeback_state, expected)
                self.assertIsNone(row.next_retry_at)
            self.assertEqual(len(list(await session.scalars(select(RepositoryIssueLink)))), 3)

    async def test_realtime_members_receive_only_redacted_requirement(self):
        async with self.sessions() as session:
            await task_access.publish_task(session, await session.get(models.Task, "issue"), "task.created")
        events = {call.args[0]: call.args[1] for call in self.published.await_args_list}
        self.assertEqual(set(events), {"member", "other-member"})
        self.assertTrue(events["member"]["task"]["canClaim"])
        self.assertNotIn("result", events["member"]["task"])


if __name__ == "__main__":
    unittest.main()
