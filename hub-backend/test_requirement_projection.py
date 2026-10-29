"""The board's shared lifecycle against real SQLite, HTTP and event projections."""
import importlib
import os
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
import httpx
from fastapi import FastAPI, Request
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app import models, automation_models as am
from app.api import admin, approvals, tasks
from app.auth import sign_token
from app.db import Base, get_session
from app.deps import current_client
from app.schemas import task_to_api
from app.services import task_access, task_requirement_projection

for model_file in (Path(__file__).parent / "app").glob("*models.py"):
    importlib.import_module("app." + model_file.stem)


class RequirementProjectionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        self.now = datetime.now(timezone.utc)
        async with self.sessions() as session:
            session.add(models.OrgUnit(id="company", name="Company"))
            for uid in ("owner", "peer"):
                session.add(models.User(id=uid, username=uid, org_id="company", is_active=True,
                    is_super=uid == "owner", auth_version=1))
                session.add(models.Client(id=uid, user_ref=uid, auth_state="active"))
            session.add(models.Project(id="project", name="Project", org_id="company"))
            await session.commit()
        app = FastAPI()
        app.include_router(tasks.router)
        app.include_router(admin.router)
        app.include_router(approvals.router)

        async def identity(request: Request):
            async with self.sessions() as session:
                return await session.get(models.Client, request.headers.get("X-Test-Identity", "owner"))

        async def db():
            async with self.sessions() as session:
                yield session

        app.dependency_overrides[current_client] = identity
        app.dependency_overrides[get_session] = db
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture")

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.engine.dispose()

    async def seed(self, tid, *, status="doing", archived=False, kind="files", state="candidate",
                   action="review", approval="pending", expired=False, newer=False, newer_review=False):
        async with self.sessions() as session:
            session.add(models.Task(id=tid, title=tid, owner_client_id="owner", created_by="owner",
                status=status, shared_org_id="company", project_id="project", triage_stage="ready",
                archived_at=self.now if archived else None, created_at=self.now - timedelta(days=3),
                updated_at=self.now, due_at=self.now + timedelta(days=1),
                result="private-result", work_routing={"secret": "private-route"}))
            session.add(am.ArtifactVersion(id=tid + "-v1", task_id=tid, kind=kind, state=state,
                seq=1, checksum="fixture", source_ref="private-execution-ref", created_at=self.now,
                manifest={"schemaVersion": "1.0", "complete": True, "problems": [], "files": [],
                          "primary": [{"id": "output", "name": "report.md", "validation": {"state": "passed"}}]}))
            session.add(am.ApprovalRequest(id=tid + "-r1", task_id=tid, action=action,
                artifact_version_id=tid + "-v1", status=approval, created_at=self.now,
                expires_at=self.now - timedelta(hours=1) if expired else None))
            if newer:
                session.add(am.ArtifactVersion(id=tid + "-v2", task_id=tid, kind="files",
                    state="candidate", seq=2, checksum="fixture-v2", created_at=self.now))
            if newer_review:
                session.add(am.ApprovalRequest(id=tid + "-r2", task_id=tid, action="review",
                    artifact_version_id=tid + "-v1", status="rejected", created_at=self.now + timedelta(seconds=1)))
            await session.commit()

    async def test_only_current_pending_delivery_review_changes_stage(self):
        cases = {
            "review": ({}, "reviewing"), "todo-review": ({"status": "todo"}, "reviewing"),
            "paused": ({"status": "paused", "approval": "approved"}, "delivering"),
            "paused-review": ({"status": "paused"}, "reviewing"),
            "paused-archive": ({"status": "paused", "archived": True}, "closed"),
            "baseline": ({"action": "baseline", "kind": "requirement"}, "delivering"),
            "fake-review-baseline": ({"kind": "requirement"}, "delivering"),
            "merge": ({"action": "merge"}, "delivering"), "deploy": ({"action": "deploy"}, "delivering"),
            "rejected": ({"state": "rejected"}, "delivering"),
            "superseded": ({"state": "superseded"}, "delivering"),
            "expired": ({"expired": True}, "delivering"), "approved": ({"approval": "approved"}, "delivering"),
            "old-artifact": ({"newer": True}, "delivering"), "old-review": ({"newer_review": True}, "delivering"),
            "done": ({"status": "done"}, "delivered"), "closed": ({"status": "cancel"}, "closed"),
            "archive": ({"archived": True}, "closed"),
        }
        for tid, (options, _) in cases.items():
            await self.seed(tid, **options)
        async with self.sessions() as session:
            rows = list((await session.scalars(select(models.Task))).all())
            statements = []
            def capture(conn, cursor, statement, *args):
                if statement.lstrip().upper().startswith("SELECT"):
                    statements.append(statement)
            event.listen(self.engine.sync_engine, "before_cursor_execute", capture)
            try:
                apis = await task_requirement_projection.decorate_many(session, rows, [task_to_api(t) for t in rows])
                batch_queries = len(statements)
                statements.clear()
                await task_requirement_projection.decorate_many(session, rows[:1], [task_to_api(rows[0])])
                single_queries = len(statements)
            finally:
                event.remove(self.engine.sync_engine, "before_cursor_execute", capture)
            for api in apis:
                self.assertEqual(api["requirementStage"], cases[api["id"]][1], api["id"])
            self.assertEqual(batch_queries, single_queries,
                             "maintenance and stage reads stay batched regardless of requirement count")

    async def test_device_detail_list_and_shared_view_use_same_stage_without_private_data(self):
        await self.seed("shared")
        for who in ("owner", "peer"):
            headers = {"X-Test-Identity": who}
            listing = await self.http.get("/api/v1/tasks", headers=headers)
            detail = await self.http.get("/api/v1/tasks/shared", headers=headers)
            self.assertEqual(listing.status_code, 200, listing.text)
            self.assertEqual(detail.status_code, 200, detail.text)
            for api in (listing.json()[0], detail.json()):
                self.assertEqual(api["requirementStage"], "reviewing")
                self.assertGreater(api["updatedAt"], api["created"])
                self.assertNotIn("private-execution-ref", str(api))
                self.assertNotIn("artifactVersionId", api)
                if who == "peer":
                    self.assertFalse(api["canViewExecution"])
                    for key in ("ai", "workRouting", "result", "due", "approval"):
                        self.assertNotIn(key, api, "public stage does not widen execution access")

    async def test_realtime_recomputes_stage_before_per_viewer_redaction(self):
        await self.seed("shared")
        with patch("app.realtime.hub.publish", new_callable=AsyncMock) as publish:
            async with self.sessions() as session:
                task = await session.get(models.Task, "shared")
                await task_access.publish_task(session, task, "task.updated", {**task_to_api(task), "requirementStage": "ready"})
            events = {call.args[0]: call.args[1]["task"] for call in publish.await_args_list}
            self.assertEqual(set(events), {"owner", "peer"})
            self.assertEqual(events["owner"]["requirementStage"], "reviewing")
            self.assertEqual(events["peer"]["requirementStage"], "reviewing")
            self.assertNotIn("workRouting", events["peer"])
            self.assertNotIn("result", events["peer"])

    async def test_flushed_server_timestamp_is_read_in_batch_without_implicit_io(self):
        await self.seed("flushed")
        async with self.sessions() as session:
            task = await session.get(models.Task, "flushed")
            task.note = "Updated requirement"
            await session.flush()
            # Reproduce both PostgreSQL/server-onupdate and SQLite expiration.
            session.expire(task, ["updated_at"])
            api = task_to_api(task)
            self.assertIsNone(api["updatedAt"])
            await task_requirement_projection.decorate_many(session, [task], [api])
            self.assertIsInstance(api["updatedAt"], int)
            self.assertGreater(api["updatedAt"], api["created"])
            self.assertEqual(api["requirementStage"], "reviewing")

    async def test_admin_list_detail_project_and_subordinate_share_projection(self):
        await self.seed("admin-review")
        headers = {"Authorization": "Bearer " + sign_token("owner", 1)}
        routes = [("/tasks", lambda body: body[0]), ("/tasks/admin-review", lambda body: body),
                  ("/projects/project", lambda body: body["tasks"][0]),
                  ("/users/owner/tasks", lambda body: body[0])]
        for path, item in routes:
            response = await self.http.get("/api/v1/admin" + path, headers=headers)
            self.assertEqual(response.status_code, 200, response.text)
            api = item(response.json())
            self.assertEqual(api["requirementStage"], "reviewing", path)
            self.assertGreater(api["updatedAt"], api["created"], path)

    async def test_real_rejection_updates_shared_stage_without_launching_work(self):
        await self.seed("review-rejection")
        async with self.sessions() as session:
            session.add(am.ApprovalAssignment(request_id="review-rejection-r1", user_id="owner", user_name="Owner"))
            await session.commit()
        with patch("app.realtime.hub.publish", new_callable=AsyncMock) as publish, patch(
            "app.services.task_rework.resume_after_rejection", new=AsyncMock(return_value={"started": False}),
        ):
            response = await self.http.post("/api/v1/approvals/review-rejection-r1/decision",
                json={"decision": "reject", "note": "Need more evidence"})
            self.assertEqual(response.status_code, 200, response.text)
        events = {call.args[0]: call.args[1]["task"] for call in publish.await_args_list
                  if call.args[1].get("type") == "task.updated"}
        self.assertEqual(set(events), {"owner", "peer"})
        self.assertEqual(events["peer"]["requirementStage"], "delivering")
        self.assertTrue(events["owner"]["reviewRejected"], "latest rejection must retain the executor's rework entry")
        self.assertNotIn("reviewRejected", events["peer"], "shared visibility does not grant execution access")
        self.assertNotIn("result", events["peer"])
        detail = await self.http.get("/api/v1/tasks/review-rejection")
        self.assertEqual(detail.json()["requirementStage"], "delivering")
        self.assertTrue(detail.json()["reviewRejected"])


if __name__ == "__main__":
    unittest.main()
