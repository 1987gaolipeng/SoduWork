"""Actual legacy-row migration followed by HTTP and realtime ACL checks."""
import importlib
import os
import tempfile
import unittest
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
import httpx
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from fastapi import FastAPI, Request
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app import models, automation_models, library_models, session_memory_models, conversation_handoff_models
from app.api import tasks, attachments
from app.db import Base, get_session
from app.deps import current_client
from app.services import task_access, task_requirements, task_notifications
from app.schemas import task_to_api
from app.memory_record_models import MemoryRecord


class MigratedRequirementACLTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="soduwork-requirements-acl-")
        self.addCleanup(self.directory.cleanup)
        database = (Path(self.directory.name)/"fixture.db").as_posix()
        # Build the complete empty schema without async DDL handoffs. Legacy
        # migration, HTTP, realtime and business transactions remain unchanged.
        schema_engine = sa.create_engine("sqlite:///" + database)
        try:
            Base.metadata.create_all(schema_engine)
        finally:
            schema_engine.dispose()
        self.engine = create_async_engine("sqlite+aiosqlite:///" + database)
        self.addAsyncCleanup(self.engine.dispose)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        self.clients = {}
        async with self.sessions() as session:
            session.add_all([models.OrgUnit(id="team", name="Team"), models.OrgUnit(id="foreign", name="Foreign")])
            for uid, oid in (("executor", "team"), ("a", "team"), ("b", "team"), ("peer", "team"), ("stranger", "foreign"),
                             ("requester", "team"), ("assignee", "team"), ("admin", "foreign")):
                session.add(models.User(id=uid, username=uid, org_id=oid, is_active=True, is_super=uid == "admin"))
                self.clients[uid] = models.Client(id=uid, user_ref=uid, auth_state="active")
                session.add(self.clients[uid])
            self.clients["a-second"] = models.Client(id="a-second", user_ref="a", auth_state="active")
            session.add(self.clients["a-second"])
            for tid, shared in (("private-merged", None), ("shared-merged", "team")):
                session.add(models.Task(id=tid, owner_client_id="executor", created_by="executor", status="todo",
                    title="SECRET execution title", note="SECRET execution note", result="SECRET result", work_routing={"SECRET": True}))
                session.add(models.Attachment(id=tid+"-output", task_id=tid, role="output", filename="SECRET-output.md"))
            await session.commit()
        async with self.engine.begin() as connection:
            def seed_and_migrate(conn):
                with Operations.context(MigrationContext.configure(conn)):
                    importlib.import_module("migrations.versions.0030_work_item_pool").upgrade()
                    importlib.import_module("migrations.versions.0032_work_item_participants").upgrade()
                meta=sa.MetaData()
                old=sa.Table("work_item",meta,autoload_with=conn)
                att=models.Attachment.__table__
                for tid, org in (("private-merged", None), ("shared-merged", "team")):
                    for uid in ("a", "b"):
                        rid=tid+"-"+uid
                        conn.execute(old.insert().values(id=rid, org_id=org, delivery_task_id=tid,
                            created_by_user_id=uid, created_by_client_id=uid, created_by_name=uid,
                            title=uid+" original", description=uid+" background", acceptance_criteria=[uid+" criteria"],
                            kind="requirement", priority="normal", source=uid+" source", tags=[uid], status="ready",
                            requester_user_id="requester" if uid == "a" else None,
                            assignee_user_id="assignee" if uid == "b" else None,
                            requester_name="", requester_contact="", assignee_name="", repo_id="", version=4))
                        conn.execute(att.insert().values(id=rid+"-file", task_id=rid, filename=uid+"-private.md",
                            uploaded_by=uid, role="input", source_ref="work-item:"+rid, storage_key="preserved/"+rid,
                            evidence_meta={"criterionText": uid+" criteria"}))
                migration=importlib.import_module("migrations.versions.0053_unified_requirements")
                migration.adopt(conn)
                migration.adopt(conn)
            await connection.run_sync(seed_and_migrate)
        app=FastAPI()
        app.include_router(tasks.router);app.include_router(attachments.router)
        async def actor(request: Request):
            return self.clients[request.headers.get("X-Test-Identity", "executor")]
        async def db():
            async with self.sessions() as session:
                yield session
        app.dependency_overrides[current_client]=actor
        app.dependency_overrides[get_session]=db
        self.http=httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url="http://isolated")
        self.addAsyncCleanup(self.http.aclose)
        self.pub=patch("app.realtime.hub.publish",new_callable=AsyncMock)
        self.published=self.pub.start()
        self.addCleanup(self.pub.stop)

    async def call(self, method, path, who="executor", **kwargs):
        return await self.http.request(method,"/api/v1/"+path,headers={"X-Test-Identity":who},**kwargs)

    async def test_batched_list_matches_single_item_acl_for_every_principal(self):
        async with self.sessions() as session:
            rows = list((await session.scalars(sa.select(models.Task).order_by(models.Task.id))).all())
            for client in self.clients.values():
                apis = await task_access.decorate_many(session, rows, [task_to_api(t) for t in rows], client)
                expected = [await task_requirements.decorate(session, client, t, deepcopy(api))
                            for t, api in zip(rows, apis)]
                actual = await task_requirements.decorate_many(session, client, rows, deepcopy(apis))
                self.assertEqual(actual, expected, client.id)
            # Reuse the same SQLAlchemy session across callers and a revocation:
            # a list must not retain another principal's or an earlier call's ACL.
            await session.execute(sa.delete(models.TaskRequirementAccess).where(
                models.TaskRequirementAccess.principal_id == "a"))
            await session.commit()
            for uid in ("a", "b", "a-second", "admin", "stranger"):
                client = self.clients[uid]
                apis = [task_to_api(t) for t in rows]
                expected = [await task_requirements.decorate(session, client, t, deepcopy(api))
                            for t, api in zip(rows, apis)]
                actual = await task_requirements.decorate_many(session, client, rows, deepcopy(apis))
                self.assertEqual(actual, expected, "after revocation: " + uid)
                if uid in ("a", "a-second"):
                    private = next(row for row in actual if row["id"] == "private-merged")
                    self.assertEqual(private["migratedRequirements"], [])
                    self.assertEqual(private["myRoles"], [])

    async def test_list_permission_queries_are_bounded_across_batch_boundary(self):
        async with self.sessions() as session:
            for index in range(501):
                tid = "bulk-" + str(index)
                session.add(models.Task(id=tid, owner_client_id="executor", created_by="executor",
                    status="todo", title="Private execution", note="Private instructions",
                    requirement_content={"title": "Allowed source", "note": "Original requirement"},
                    legacy_requirements=[{"id": tid + "-source", "title": "Allowed source",
                                          "description": "Original requirement"}]))
                session.add(models.TaskRequirementAccess(task_id=tid, source_id=tid + "-source",
                    principal_kind="user", principal_id="a", role="creator"))
            await session.commit()
            rows = list((await session.scalars(sa.select(models.Task).where(
                models.Task.id.like("bulk-%")).order_by(models.Task.id))).all())
            apis = [task_to_api(t) for t in rows]
            statements = []
            def count(_conn, _cursor, statement, _params, _context, _many):
                statements.append(statement)
            sa.event.listen(self.engine.sync_engine, "before_cursor_execute", count)
            try:
                actual = await task_requirements.decorate_many(session, self.clients["a"], rows, apis)
            finally:
                sa.event.remove(self.engine.sync_engine, "before_cursor_execute", count)
            self.assertEqual(len(actual), 501)
            self.assertLessEqual(len(statements), 8, "Permission queries must not grow per task")
            self.assertEqual(sum("FROM task_requirement_access" in sql for sql in statements), 2)
            self.assertTrue(all(row["canEditRequirement"] and not row["canViewExecution"] for row in actual))
            self.assertTrue(all(row["requirementContent"]["title"] == "Allowed source" for row in actual))
            self.assertNotIn("Private instructions", str(actual))

    async def test_private_source_author_keeps_only_own_requirement_and_files_on_all_devices(self):
        for uid, source in (("a", "a"), ("a-second", "a"), ("b", "b"), ("requester", "a"), ("assignee", "b")):
            rows=(await self.call("GET","tasks",uid)).json()
            private=next(row for row in rows if row["id"]=="private-merged")
            self.assertFalse(private["canViewExecution"])
            self.assertFalse(private["canEditRequirement"])
            self.assertNotIn("SECRET",str(private))
            self.assertEqual(private["acceptanceCriteria"],[source+" criteria"])
            self.assertEqual([row["id"] for row in private["migratedRequirements"]],["private-merged-"+source])
            self.assertEqual(private["requirementContent"]["title"],source+" original")
            detail=(await self.call("GET","tasks/private-merged",uid)).json()
            self.assertEqual(private["requirementContent"],detail["requirementContent"])
            files=(await self.call("GET","tasks/private-merged/attachments",uid)).json()
            self.assertEqual([row["id"] for row in files],["private-merged-"+source+"-file"])
            other="b" if source=="a" else "a"
            self.assertEqual((await self.call("POST","attachments/private-merged-"+other+"-file/access",uid)).status_code,404)
            self.assertEqual((await self.call("POST","attachments/private-merged-"+source+"-file/access",uid)).status_code,200)
            for suffix in ("comments","events","ai-session"):
                self.assertEqual((await self.call("GET","tasks/private-merged/"+suffix,uid)).status_code,404)
            response=await self.call("PATCH","tasks/private-merged",uid,json={"note":"cannot replace another source","requirementVersion":4})
            self.assertEqual(response.status_code,403,response.text)
        self.assertEqual((await self.call("GET","tasks/private-merged","peer")).status_code,404)
        self.assertEqual((await self.call("GET","tasks/shared-merged","stranger")).status_code,404)

    async def test_realtime_matches_http_source_projection_and_never_starts_execution(self):
        async with self.sessions() as session:
            task=await session.get(models.Task,"private-merged")
            await task_access.publish_task(session,task,"task.updated",arrival="handoff",by="Executor")
        events={call.args[0]:call.args[1] for call in self.published.await_args_list}
        self.assertEqual(set(events),{"executor","a","a-second","b","requester","assignee","admin"})
        for uid in ("a","a-second","b","requester","assignee","admin"):
            http=(await self.call("GET","tasks/private-merged",uid)).json()
            self.assertEqual(events[uid]["task"]["requirementContent"],http["requirementContent"])
            self.assertEqual(events[uid]["task"]["migratedRequirements"],http["migratedRequirements"])
            self.assertNotIn("arrival",events[uid]);self.assertNotIn("SECRET",str(events[uid]))
        self.assertEqual(events["executor"]["arrival"],"handoff")
        self.assertFalse(events["admin"]["task"]["canViewExecution"])
        self.assertEqual(len(events["admin"]["task"]["migratedRequirements"]),2)
        async with self.sessions() as session:
            grants = (await session.scalars(sa.select(models.TaskRequirementAccess))).all()
            self.assertEqual(len(grants),12)  # Four sources; creator device+user and one collaborator each.

    async def test_revoke_company_sharing_retains_source_acl_and_redacts_remaining_viewers(self):
        before=(await self.call("GET","tasks/shared-merged","peer")).json()
        self.assertEqual(len(before["migratedRequirements"]),2)
        response=await self.call("PATCH","tasks/shared-merged",json={"visibility":"related","requirementVersion":4})
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(self.published.await_count,0)
        self.assertTrue(await task_notifications.run_once(self.sessions))
        events={call.args[0]:call.args[1] for call in self.published.await_args_list}
        self.assertEqual(events["peer"],{"type":"task.deleted","id":"shared-merged"})
        self.assertEqual(len(events["a"]["task"]["migratedRequirements"]),1)
        self.assertNotIn("b background",str(events["a"]))
        self.assertEqual((await self.call("GET","tasks/shared-merged","peer")).status_code,404)
        self.assertEqual((await self.call("GET","tasks/shared-merged","a")).status_code,200)

    async def test_requirement_cas_edits_keep_original_private_execution_note(self):
        for who in ("executor","admin"):
            current=(await self.call("GET","tasks/shared-merged",who)).json()
            result=await self.call("PATCH","tasks/shared-merged",who,json={"title":"Safe updated title", "note":"Safe updated context", "requirementVersion":current["requirementVersion"]})
            self.assertEqual(result.status_code,200,result.text)
            self.assertEqual(result.json()["requirementContent"],{"title":"Safe updated title","note":"Safe updated context"})
            async with self.sessions() as session:
                task=await session.get(models.Task,"shared-merged")
                self.assertEqual(task.note,"SECRET execution note")
                self.assertEqual(task.title,"SECRET execution title")
        # Organization visibility grants reading, not permission to replace a
        # merged requirement's public content or original execution context.
        peer=(await self.call("GET","tasks/shared-merged","peer")).json()
        self.assertFalse(peer["canEditRequirement"])
        blocked=await self.call("PATCH","tasks/shared-merged","peer",json={
            "note":"forbidden peer edit", "requirementVersion":peer["requirementVersion"]})
        self.assertEqual(blocked.status_code,403,blocked.text)
        # Ordinary execution edit stays private and does not overwrite the public projection.
        await self.call("PATCH","tasks/shared-merged",json={"note":"SECRET revised execution"})
        peer=(await self.call("GET","tasks/shared-merged","peer")).json()
        self.assertEqual(peer["requirementContent"]["note"],"Safe updated context")
        self.assertNotIn("SECRET",str(peer))


if __name__ == '__main__':
    unittest.main()
