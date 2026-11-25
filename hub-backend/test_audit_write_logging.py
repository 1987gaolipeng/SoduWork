"""Best-effort audit failures remain observable without exposing audit payloads."""
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from sqlalchemy.ext.asyncio import AsyncSession

from app.services import audit


class AuditWriteLoggingTests(unittest.IsolatedAsyncioTestCase):
    async def test_failed_commits_log_context_and_roll_back(self):
        session = Mock(spec=AsyncSession)
        session.commit.side_effect = RuntimeError("private database parameters")
        actor = SimpleNamespace(id="test-actor")
        with self.assertLogs(audit.logger, level="ERROR") as logs:
            for who in (actor, None):
                await audit.log(session, who, "test.change", "domain", "test-domain",
                                "private target label", {"note": "private audit detail"})

        self.assertEqual(session.commit.await_count, 2)
        self.assertEqual(session.rollback.await_count, 2)
        self.assertEqual(len(logs.records), 2)
        counts = []
        for record, actor_id in zip(logs.records, (actor.id, None)):
            message = record.getMessage()
            self.assertIn("action='test.change'", message)
            self.assertIn("target_type='domain'", message)
            self.assertIn("target_id='test-domain'", message)
            self.assertIn(f"actor_id={actor_id!r}", message)
            self.assertIn("error=RuntimeError", message)
            self.assertNotIn("private", message)
            self.assertIsNone(record.exc_info)
            counts.append(int(message.split("process_failures=")[1]))
        self.assertEqual(counts[1], counts[0] + 1)
