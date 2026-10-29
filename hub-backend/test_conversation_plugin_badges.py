import unittest
from unittest.mock import patch

from app.services import conversation_plugins, local_stream


class ConversationPluginBadgeTests(unittest.TestCase):
    def test_badges_are_bounded_deduplicated_and_never_contain_grants(self):
        row = {"pluginId": "p", "name": "Plugin", "version": "1", "context": "private",
               "grant": {"ticket": "secret"}, "scopeLabel": "personal"}
        result = conversation_plugins.badges([None, row, row] + [
            {"pluginId": str(i), "name": "x" * 1000} for i in range(10)])
        self.assertEqual(len(result), 3)
        self.assertEqual(result[0], {"pluginId": "p", "name": "Plugin", "version": "1", "scopeLabel": "personal"})
        self.assertEqual(len(result[1]["name"]), 120)
        self.assertEqual(conversation_plugins.badges({}), [])


    def test_followup_persists_only_public_plugin_badges(self):
        recorded = []
        def record(ref, item):
            recorded.append((ref, item))
            return item
        with patch.object(local_stream, "_record_event", record):
            result = local_stream.record_user_sync("run", "user original", [{"name": "a.txt", "path": "/work/a.txt"}],
                                                   [{"pluginId": "p", "name": "插件", "context": "private"}])
        self.assertTrue(result["ok"])
        item = recorded[0][1]
        self.assertEqual(item["full"], "user original")
        self.assertEqual(item["plugins"], [{"pluginId": "p", "name": "插件", "version": "", "scopeLabel": ""}])
        self.assertEqual(item["attachments"][0]["name"], "a.txt")


    def test_old_followup_contract_remains_valid(self):
        with patch.object(local_stream, "_record_event", lambda ref, item: item):
            self.assertEqual(local_stream.record_user_sync("run", "ordinary")["item"]["plugins"], [])


if __name__ == "__main__":
    unittest.main()
