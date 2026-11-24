"""PostgreSQL transactions covering review approval racing workflow cancellation."""
import asyncio
import os
import unittest
from uuid import uuid4

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am, models
from app.db import Base
from app.services import release_control, workflow_control
from plugin_smoke.fixtures import actor_fixture


@unittest.skipUnless(os.environ.get("WORKFLOW_APPROVAL_TEST_POSTGRES_URL"), "requires PostgreSQL")
class ApprovalCancellationRace(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        url = os.environ["WORKFLOW_APPROVAL_TEST_POSTGRES_URL"]
        schema = "workflow_approval_" + uuid4().hex
        control = create_async_engine(url)
        self.addAsyncCleanup(control.dispose)
        async with control.begin() as connection:
            await connection.execute(text(f'CREATE SCHEMA "{schema}"'))

        async def drop():
            async with control.begin() as connection:
                await connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))

        self.addAsyncCleanup(drop)
        engine = create_async_engine(url, connect_args={"server_settings": {"search_path": schema}})
        self.addAsyncCleanup(engine.dispose)
        self.sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with self.sessions() as session:
            await release_control.bootstrap(session)
            actor = await actor_fixture(session)
            self.task_id, self.user_id = actor.task.id, actor.creator.id
            run = am.WorkflowRun(task_id=self.task_id, plugin_id="plugin", plugin_version_id="version",
                                 state="waiting_human")
            session.add(run)
            await session.flush()
            artifact, _ = await release_control.ensure_code_candidate(session, actor.task, {
                "commits": [{"sha": "abc123", "subject": "Fixture change"}],
                "files": ["app.py"], "branch": "feature", "target": "main",
            })
            request = await release_control.ensure_request(
                session, actor.task, artifact, "review", context={"workflowRunId": run.id})
            self.run_id, self.artifact_id, self.request_id = run.id, artifact.id, request.id
            await session.commit()

    async def test_uncommitted_review_cannot_leave_a_pending_merge_after_cancellation(self):
        waiting_pid = asyncio.get_running_loop().create_future()

        async def cancel():
            async with self.sessions() as session:
                waiting_pid.set_result(await session.scalar(text("SELECT pg_backend_pid()")))
                run = await session.get(am.WorkflowRun, self.run_id)
                return await workflow_control.cancel_run(session, run, actor="owner")

        async with self.sessions() as voting:
            task = await voting.get(models.Task, self.task_id)
            user = await voting.get(models.User, self.user_id)
            decision = await release_control.decide(
                voting, task, user, action="review", decision="approve", artifact_version_id=self.artifact_id,
                request_id=self.request_id, commit=False)
            self.assertTrue(decision["ok"], decision)
            voting_pid = await voting.scalar(text("SELECT pg_backend_pid()"))
            cancellation = asyncio.create_task(cancel())
            try:
                pid = await asyncio.wait_for(waiting_pid, 5)
                async with self.sessions() as observer:
                    # Release the vote only after the second transaction is actually blocked.
                    async with asyncio.timeout(10):
                        while voting_pid not in await observer.scalar(
                                text("SELECT pg_blocking_pids(:pid)"), {"pid": pid}):
                            await asyncio.sleep(0.01)
                await voting.commit()
                result = await asyncio.wait_for(cancellation, 10)
            finally:
                cancellation.cancel()
                await asyncio.gather(cancellation, return_exceptions=True)
        self.assertEqual(result["cancelledApprovals"], 1)
        async with self.sessions() as session:
            rows = (await session.execute(select(am.ApprovalRequest.action, am.ApprovalRequest.status)
                    .where(am.ApprovalRequest.task_id == self.task_id))).all()
            self.assertEqual(dict(rows), {"review": "approved", "merge": "cancelled"})
