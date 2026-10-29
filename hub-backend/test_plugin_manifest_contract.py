"""Pinned package identity and normalized manifest contracts across module moves."""
import copy
import hashlib
import io
import json
import os
import unittest
import zipfile

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from app.services import plugin_packages


def fixture(workflow=False):
    manifest = {"schemaVersion": 1, "key": "manifest-compat", "version": "1.2.3",
                "name": "清单兼容样例", "description": "固定版本与输入契约",
                "instructions": "读取已声明的资料，提供可核对的工作结果。",
                "capabilities": {"skills": ["research", "research"], "runtime": ["files"]},
                "inputs": [{"key": "enabled", "type": "bool", "default": False}],
                "process": {"enterprise": True, "label": "交付", "environments": [
                    {"label": "验收", "scope": "project"}]}}
    if workflow:
        manifest["workflow"] = {"nodes": [
            {"key": "build", "type": "ai", "config": {
                "prompt": "完成报告", "agentKind": "local:codex", "model": "fixture-model"},
             "outputs": [{"key": "result", "kind": "file", "path": "report.md", "required": True}]},
            {"key": "finish", "type": "publish", "dependsOn": ["build"],
             "config": {"message": "已完成"}},
        ]}
    return manifest


def archive(manifest):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as zipped:
        for name, data in [("plugin.json", json.dumps(manifest, ensure_ascii=False).encode()),
                           ("references/source.txt", "固定资料\n".encode())]:
            info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            zipped.writestr(info, data)
    return output.getvalue()


def digests(parsed):
    normalized = {key: parsed[key] for key in ("manifest", "workflow", "capabilities")}
    return (parsed["checksum"], parsed["contentChecksum"], hashlib.sha256(
        json.dumps(normalized, ensure_ascii=False, sort_keys=True).encode()).hexdigest())


# Captured from the original package parser before extracting manifest policy.
EXPECTED = {
    False: ("56849f85d28fe71c21d5e0c1557e2fa99ccb90e5d14d497a3c45ba1a765b577b",
            "56849f85d28fe71c21d5e0c1557e2fa99ccb90e5d14d497a3c45ba1a765b577b",
            "e9e244b038a35dcc44a02a11fc3101fb4e8668196295d8ba2f75410a68bc2179"),
    True: ("f9a2034deb012b2e69de219ca3b3a390a106498d352d228339e5b61201349083",
           "f9a2034deb012b2e69de219ca3b3a390a106498d352d228339e5b61201349083",
           "2433a568700d6d4b680cf5e5a805e03ba8ab65bbd0d3b69eb51d306102095914"),
}


class PluginManifestContractTests(unittest.TestCase):
    def test_direct_and_workflow_packages_preserve_identity_and_normalized_content(self):
        for workflow in (False, True):
            with self.subTest(workflow=workflow):
                manifest = fixture(workflow)
                original = copy.deepcopy(manifest)
                data = archive(manifest)
                parsed = plugin_packages.parse(data)
                self.assertEqual(parsed["bytes"], data)
                self.assertEqual(digests(parsed), EXPECTED[workflow])
                self.assertEqual(parsed["capabilities"]["hasWorkflow"], workflow)
                plugin_packages.normalize(manifest)
                self.assertEqual(manifest, original)

    def test_dag_and_node_capability_escalation_remain_rejected(self):
        for mode in ("cycle", "missing", "capability"):
            manifest = fixture(True)
            nodes = manifest["workflow"]["nodes"]
            if mode == "cycle":
                nodes[0]["dependsOn"] = ["finish"]
            elif mode == "missing":
                nodes[1]["dependsOn"] = ["missing"]
            else:
                nodes[0]["capabilities"] = {"runtime": ["terminal"]}
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                plugin_packages.normalize(manifest)


if __name__ == "__main__":
    unittest.main()
