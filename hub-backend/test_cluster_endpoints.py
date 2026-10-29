"""No arbitrary Hub-local execution when requests can reach any replica."""
import os
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["CLUSTER_REDIS_URL"] = ""
import unittest
from types import SimpleNamespace
from unittest.mock import patch, AsyncMock
from fastapi import HTTPException
from app.api import agents
from app.services import agent_runner
from app.services.cluster_bus import bus


class EndpointTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.client = SimpleNamespace(id="fixture")
        self.cluster = patch.object(bus, "enabled", True)
        self.cluster.start()
        self.addCleanup(self.cluster.stop)

    async def test_missing_runner_does_not_fall_back_to_hub(self):
        with patch.object(agents.runner_hub, "for_client", return_value=None):
            with self.assertRaises(HTTPException) as error:
                agents._pick_runner(self.client, "")
        self.assertEqual(error.exception.status_code, 409)

    async def test_single_instance_keeps_existing_fallback(self):
        with patch.object(bus, "enabled", False), patch.object(
                agents.runner_hub, "for_client", return_value=None):
            self.assertIsNone(agents._pick_runner(self.client, ""))

    async def test_existing_runner_is_used(self):
        runner = SimpleNamespace(id="online", client_id="fixture")
        with patch.object(agents.runner_hub, "for_client", return_value=runner):
            self.assertIs(agents._pick_runner(self.client, ""), runner)

    async def test_cluster_does_not_advertise_hub_local_agents(self):
        from app.services import execution_aliases
        with patch.object(execution_aliases, "load", new=AsyncMock(return_value={})), \
                patch.object(agents.runner_hub, "online", return_value=[]), \
                patch.object(agents.agent_setup, "detect_all") as detect:
            self.assertEqual(await agents._machines(None, self.client, True), [])
            detect.assert_not_called()

    async def test_old_local_job_is_not_polled_on_random_hub(self):
        with patch.object(agents.agent_setup, "job") as poll:
            with self.assertRaises(HTTPException) as error:
                await agents.get_agent_job("old-job", self.client)
            poll.assert_not_called()
        self.assertEqual(error.exception.status_code, 409)

    async def test_old_admin_execution_never_starts_a_process(self):
        with self.assertRaises(ValueError):
            await agent_runner.start(None, None, "fixture")


if __name__ == "__main__":
    unittest.main()
