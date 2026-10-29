import json
import subprocess
import unittest
from pathlib import Path
from app.services import plugin_packages, plugin_drafts

ROOT = Path(__file__).resolve().parent.parent


class ProductIncubatorTests(unittest.TestCase):
    def test_enterprise_workflow_has_portable_handoffs_and_blocking_acceptance(self):
        raw = json.loads((ROOT / "hub-backend/plugins/product-incubator.json").read_text(encoding="utf-8"))
        manifest, workflow, report = plugin_packages.normalize(raw)
        self.assertEqual(manifest["entrypoints"], dict(conversation=True, task=True, automation=True))
        self.assertEqual(len(workflow["nodes"]), 11)
        by_key = {node["key"]: node for node in workflow["nodes"]}
        self.assertEqual(by_key["confirm_scope"]["type"], "human_review")
        self.assertEqual(by_key["accept_release"]["type"], "human_review")
        self.assertEqual(by_key["accept_delivery"]["type"], "human_review")
        self.assertIn("accept_release", by_key["deliver"]["dependsOn"])
        self.assertEqual(by_key["complete"]["dependsOn"], ["accept_delivery"])
        for node in workflow["nodes"]:
            for item in node["inputs"]:
                self.assertIn(item["fromNode"], node["dependsOn"])
            for key in ("agentKind", "model", "runnerId", "hostId"):
                self.assertNotIn(key, node["config"])
        self.assertTrue(any(x["kind"] == "decision" and x["required"] for x in by_key["review"]["outputs"]))
        self.assertTrue((ROOT / "skills/product-incubator/SKILL.md").is_file())

    def test_desktop_export_can_be_reviewed_by_the_same_enterprise_contract(self):
        result = subprocess.run(["node", "-e",
            "console.log(JSON.stringify(require('./client/main/product-incubator-plugin').body({})))"],
            cwd=ROOT, capture_output=True, text=True, encoding="utf-8", check=True)
        draft = json.loads(result.stdout)
        package = plugin_drafts.build(draft)
        parsed = plugin_packages.parse(package)
        self.assertEqual(parsed["manifest"]["key"], "product-incubator")
        self.assertEqual(len(parsed["workflow"]["nodes"]), 11)
        restored = plugin_packages.personal_draft(parsed)
        self.assertEqual(len(restored["resources"]), 3)
        self.assertEqual(restored["workflow"]["nodes"][-1]["key"], "complete")


if __name__ == "__main__":
    unittest.main()
