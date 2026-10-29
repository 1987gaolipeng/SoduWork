"""Cloud inventory metadata must describe the observed Runner, not the Hub."""
import unittest
from unittest.mock import patch

from app.services.cloud_environments import _available_agents


class CloudAgentInventoryTests(unittest.TestCase):
    def test_bundled_harness_can_prepare_its_missing_executor_on_a_cloud_machine(self):
        items = {row["id"]: row for row in _available_agents([])}
        self.assertFalse(items["harness2"]["installed"])
        self.assertTrue(items["harness2"]["installable"])
        self.assertEqual(items["harness2"]["installer"], "bundled")

    def test_unknown_bundled_agent_cannot_claim_the_reviewed_cloud_installer(self):
        from app.services import cloud_environments
        row = {**cloud_environments.AGENTS["harness2"], "id": "unreviewed"}
        with patch.dict(cloud_environments.AGENTS, {"unreviewed": row}):
            items = {item["id"]: item for item in _available_agents([])}
        self.assertFalse(items["unreviewed"]["installable"])

    def test_versions_are_observed_and_uninstalled_agents_have_no_version(self):
        items = {row['id']: row for row in _available_agents([
            {'key': 'qwen', 'version': '0.25.1'},
        ])}
        self.assertTrue(items['qwen']['ready'])
        self.assertEqual(items['qwen']['version'], '0.25.1')
        self.assertFalse(items['pi']['installed'])
        self.assertEqual(items['pi']['version'], '')

    def test_installed_but_signed_out_is_not_ready_and_does_not_expose_credentials(self):
        rows = _available_agents([{'key': 'qwen', 'version': '0.25.1',
                                  'auth': 'unauthed', 'token': 'synthetic-private-value'}])
        row = next(item for item in rows if item['id'] == 'qwen')
        self.assertTrue(row['installed'])
        self.assertFalse(row['ready'])
        self.assertTrue(row['reason'])
        self.assertNotIn('synthetic-private-value', str(rows))


if __name__ == '__main__':
    unittest.main()
