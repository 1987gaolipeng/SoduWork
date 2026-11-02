"""Isolated regressions for update barriers and assignment delivery."""

import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am, models
from app.db import Base
from app.services import execution_sessions, task_access, update_safety


class UpdateSafetyRegressionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def _seed(self, *, metadata=None, task_status="cancel"):
        now = datetime.now(timezone.utc)
        async with self.sessions() as session:
            session.add_all([
                models.Task(id="task-1", title="fixture", status=task_status,
                            owner_client_id="device-a", owner_user_id="user-a",
                            created_by="user-a"),
                am.ExecutionSession(
                    id="session-1", task_id="task-1", ref="ref-1",
                    runner_id="runner-1", state="running", last_event_at=now,
                    metadata_=metadata or {}),
            ])
            await session.commit()
        return now

    async def test_sqlite_naive_timestamp_is_normalized_and_unconfirmed_stays_live(self):
        now = await self._seed()
        async with self.sessions() as session:
            row = await session.get(am.ExecutionSession, "session-1")
            self.assertIsNone(row.last_event_at.tzinfo)  # SQLite behavior
            await update_safety._sweep_stale_sessions(session, [row], {}, now)
            self.assertEqual(row.state, "running")

    async def test_live_busy_session_is_never_swept_even_with_stop_marker(self):
        now = await self._seed(metadata={"executionStopped": True})
        with patch.object(update_safety.runner_hub, "get",
                          return_value=SimpleNamespace(busy=1)):
            async with self.sessions() as session:
                row = await session.get(am.ExecutionSession, "session-1")
                await update_safety._sweep_stale_sessions(session, [row], {}, now)
                self.assertEqual(row.state, "running")

    async def test_sweep_audit_does_not_consume_runner_event_sequence(self):
        now = await self._seed(metadata={"executionStopped": True})
        async with self.sessions() as session:
            row = await session.get(am.ExecutionSession, "session-1")
            await update_safety._sweep_stale_sessions(session, [row], {}, now)
            await session.flush()
            self.assertEqual(row.state, "failed")
            await execution_sessions._insert_event_once(session, {
                "session_id": row.id, "seq": 1, "kind": "out", "tool": "",
                "text": "REAL RUNNER OUTPUT", "detail": {}, "at": now,
            })
            events = (await session.execute(select(am.ExecutionEvent).where(
                am.ExecutionEvent.session_id == row.id))).scalars().all()
            self.assertEqual([(event.seq, event.text) for event in events],
                             [(1, "REAL RUNNER OUTPUT")])
            audits = (await session.execute(select(models.TaskEvent).where(
                models.TaskEvent.task_id == row.task_id))).scalars().all()
            self.assertEqual([event.kind for event in audits],
                             ["execution.session_swept"])


class AssignmentDeliveryRegressionTests(unittest.IsolatedAsyncioTestCase):
    async def test_assign_arrival_targets_assignee_account(self):
        task = models.Task(id="task-1", title="handoff", owner_client_id="device-a",
                           owner_user_id="user-a",
                           assignee_user_id="user-b")
        old = models.Client(id="device-a", user_ref="user-a")
        new = models.Client(id="device-b", user_ref="user-b")
        outgoing = []

        async def capture(device, event, **_route):
            outgoing.append((device, event.get("arrival"),
                             event.get("task", {}).get("readOnly")))

        with patch.object(task_access, "recipient_clients",
                          new=AsyncMock(return_value=[old, new])), \
             patch.object(task_access, "_name_map", new=AsyncMock(return_value={})), \
             patch.object(task_access, "_device_name_map", new=AsyncMock(return_value={})), \
             patch("app.services.task_requirement_projection.decorate_many",
                   new=AsyncMock()), \
             patch("app.services.requirement_edit_policy.decorate_many",
                   new=AsyncMock()), \
             patch("app.services.task_requirements.prepare_notifications",
                   new=AsyncMock(return_value={old.id: None, new.id: None})), \
             patch("app.services.task_requirements.decorate",
                   new=AsyncMock(side_effect=lambda _s, _c, _t, value, **_inputs: value)), \
             patch.object(task_access.hub, "publish", new=AsyncMock(side_effect=capture)):
            await task_access.publish_task(
                SimpleNamespace(), task, "task.updated",
                {"id": task.id, "title": task.title},
                arrival="assign", by="Owner A")

        self.assertEqual(outgoing[0][0:2], ("device-a", None))
        self.assertEqual(outgoing[1][0:2], ("device-b", "assign"))


if __name__ == "__main__":
    unittest.main()
