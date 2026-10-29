"""Lock down rework retry observability through pending_cards and loop_health exposed by
/healthz.rework. A stalled lastOkAt indicates loop failure, while growing pending counts
indicate ineffective redelivery. Verify backlog semantics and heartbeat shape alongside existing
lifecycle and retry tests.
"""

import unittest
from datetime import datetime, timedelta, timezone

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am, models
from app.db import Base
from app.services import task_rework


def _now():
    return datetime.now(timezone.utc)


class ReworkHealthTests(unittest.IsolatedAsyncioTestCase):
    """pending_cards and retry_once share unresolved, active-task, in-window criteria."""

    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def _seed(self, session, *, task_id="rework-1", status="doing",
                    card_at=None, settled_kind=None, settled_after_seconds=1):
        """Create a task with an ai.rework_pending anchor and an optional settlement event."""
        at = card_at if card_at is not None else _now()
        session.add(models.Task(id=task_id, title="家庭菜小网页", status=status,
                                owner_client_id="dev-1", work_routing={}))
        session.add(models.TaskEvent(id=f"ev-{task_id}", task_id=task_id,
                                     kind="ai.rework_pending",
                                     detail={"requestId": "req-1"}, at=at))
        if settled_kind:
            session.add(models.TaskEvent(id=f"ev-{task_id}-settled",
                                         task_id=task_id, kind=settled_kind,
                                         detail={},
                                         at=at + timedelta(seconds=settled_after_seconds)))
        await session.commit()

    async def test_empty_db_counts_zero(self):
        """An empty database returns zero backlog without errors."""
        async with self.sessions() as session:
            self.assertEqual(await task_rework.pending_cards(session), 0)

    async def test_pending_card_counts_one(self):
        """Count one unresolved card for an active task without settlement."""
        async with self.sessions() as session:
            await self._seed(session)
            self.assertEqual(await task_rework.pending_cards(session), 1)

    async def test_settled_card_not_counted(self):
        """A later ai.rework settlement removes the card from the backlog."""
        async with self.sessions() as session:
            await self._seed(session, settled_kind="ai.rework")
            self.assertEqual(await task_rework.pending_cards(session), 0)

    async def test_taken_by_human_not_counted(self):
        """Manual redispatch through ai.rework_taken clears the card consistently."""
        async with self.sessions() as session:
            await self._seed(session, settled_kind="ai.rework_taken")
            self.assertEqual(await task_rework.pending_cards(session), 0)

    async def test_multiple_backlogged_cards_all_counted(self):
        """Count unresolved doing-task cards during backoff as part of the backlog."""
        async with self.sessions() as session:
            await self._seed(session)
            await self._seed(session, task_id="rework-2")
            self.assertEqual(await task_rework.pending_cards(session), 2)

    async def test_settled_anchor_isolated_per_task(self):
        """Keep settlement anchors task-scoped so one task cannot clear another task's backlog."""
        async with self.sessions() as session:
            await self._seed(session, task_id="rework-a")
            await self._seed(session, task_id="rework-b", settled_kind="ai.rework")
            self.assertEqual(await task_rework.pending_cards(session), 1)

    async def test_inactive_task_not_counted(self):
        """Exclude cards when their tasks leave doing/done states."""
        async with self.sessions() as session:
            await self._seed(session, status="todo")
            self.assertEqual(await task_rework.pending_cards(session), 0)

    async def test_out_of_window_not_counted(self):
        """Exclude cards older than the shared three-day retry scan window."""
        async with self.sessions() as session:
            await self._seed(session, card_at=_now() - timedelta(days=4))
            self.assertEqual(await task_rework.pending_cards(session), 0)

    async def test_retry_once_and_pending_share_anchor(self):
        """A due card must be visible to both retry_once and pending_cards."""
        from unittest.mock import AsyncMock, patch

        async with self.sessions() as session:
            await self._seed(session)
        async with self.sessions() as session:
            with patch.object(task_rework, "_retry_one",
                              new=AsyncMock(return_value="backoff")):
                out = await task_rework.retry_once(session)
            self.assertEqual(out["candidates"], 1)
            self.assertEqual(await task_rework.pending_cards(session), 1)

    async def test_loop_health_shape(self):
        """Preserve heartbeat fields consumed by /healthz.rework alerting."""
        expected = ("lastSweepAt", "lastOkAt", "pending",
                    "lastCounts", "consecutiveErrors", "lastError")
        for key in expected:
            self.assertIn(key, task_rework.loop_health)
        self.assertEqual(task_rework.loop_health["consecutiveErrors"], 0)
        self.assertIsNone(task_rework.loop_health["pending"])


if __name__ == "__main__":
    unittest.main()
