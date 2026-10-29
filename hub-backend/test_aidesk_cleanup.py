import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.services import aidesk_cleanup


class _ScalarResult:
    def __init__(self, rows):
        self.rows = rows

    def scalars(self):
        return self

    def all(self):
        return self.rows


class AideskCleanupTests(unittest.IsolatedAsyncioTestCase):
    async def test_cleans_failed_tasks_and_keeps_active_work(self):
        failed = SimpleNamespace(id="failed", status="doing")
        running = SimpleNamespace(id="running", status="doing")
        waiting = SimpleNamespace(id="waiting", status="doing")
        session = SimpleNamespace(
            execute=AsyncMock(return_value=_ScalarResult([failed, running, waiting])),
            commit=AsyncMock(),
        )
        client = SimpleNamespace(id="client", user_ref=None)
        view = {"tasks": [
            {"id": "failed", "phase": "failed"},
            {"id": "running", "phase": "running"},
            {"id": "waiting", "phase": "waiting"},
        ]}

        async def mark(_session, task, status, **_kwargs):
            task.status = status
            return True

        with patch.object(aidesk_cleanup.task_status, "mark", side_effect=mark) as mark_mock, \
                patch.object(aidesk_cleanup.task_events, "record") as event_mock, \
                patch.object(aidesk_cleanup.task_access, "publish_task", new_callable=AsyncMock), \
                patch.object(aidesk_cleanup, "task_to_api_live", new_callable=AsyncMock,
                             return_value={"id": "failed"}):
            result = await aidesk_cleanup.cleanup_abnormal(session, client, view)

        self.assertEqual(result["cleaned"], ["failed"])
        self.assertEqual(result["skipped"], [])
        self.assertEqual(result["candidateCount"], 1)
        self.assertEqual(failed.status, "cancel")
        self.assertEqual(running.status, "doing")
        self.assertEqual(waiting.status, "doing")
        session.commit.assert_awaited_once()
        mark_mock.assert_awaited_once()
        event_mock.assert_called_once()

    async def test_does_not_change_terminal_failed_task(self):
        done = SimpleNamespace(id="done-failed", status="done")
        cancelled = SimpleNamespace(id="cancelled", status="cancel")
        session = SimpleNamespace(
            execute=AsyncMock(return_value=_ScalarResult([done, cancelled])),
            commit=AsyncMock(),
        )
        client = SimpleNamespace(id="client", user_ref=None)
        view = {"tasks": [
            {"id": "done-failed", "phase": "failed"},
            {"id": "cancelled", "phase": "failed"},
        ]}
        with patch.object(aidesk_cleanup.task_status, "mark", new_callable=AsyncMock) as mark_mock:
            result = await aidesk_cleanup.cleanup_abnormal(session, client, view)

        self.assertEqual(result["cleaned"], [])
        self.assertEqual(set(result["skipped"]), {"done-failed", "cancelled"})
        self.assertEqual(result["candidateCount"], 2)
        mark_mock.assert_not_awaited()
        session.commit.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
