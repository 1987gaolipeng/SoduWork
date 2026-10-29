"""Keep native smoke discovery aligned with the public Client build contract."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from client_test_payload import CLIENT, windows_payload
from scripts.check_packaged_runner_task import delivered_node


class ClientTestPayloadTests(unittest.TestCase):
    def test_runner_uses_the_explicit_delivered_runtime_without_cross_payload_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            payload = Path(directory) / "payload"
            payload.mkdir()
            executable = payload / windows_payload("self-hosted")[1].name
            executable.write_bytes(b"fixture")
            self.assertEqual(delivered_node(payload, executable), executable)
            outside = Path(directory) / "another.exe"
            outside.write_bytes(b"fixture")
            for invalid in (outside, payload / "missing.exe", payload / "SoduWork.cmd"):
                with self.subTest(invalid=invalid.name):
                    with self.assertRaises(AssertionError):
                        delivered_node(payload, invalid)

    def test_public_native_smoke_payload_matches_builder_and_runtime_identity(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "Client packaging contract requires Node")
        script = """
const config = require('./package.json');
const profile = require('./main/distribution.cjs').getProfile('self-hosted');
console.log(JSON.stringify({ directory: config.build.directories.output,
  executable: profile.windowsExecutableName + '.exe' }));
"""
        built = json.loads(subprocess.check_output([node, "-e", script], cwd=CLIENT, text=True))
        with patch.dict(os.environ, {"SODUWORK_DISTRIBUTION": "self-hosted"}):
            payload, executable, shell = windows_payload()
        self.assertEqual(payload, CLIENT / built["directory"] / "win-unpacked")
        self.assertEqual(executable, payload / built["executable"])
        self.assertEqual(shell, payload / "resources" / "shell")
        self.assertFalse((CLIENT / "distributions.json").exists(), "Omitted edition configuration must stay omitted")

    def test_missing_selection_uses_public_profile_and_unknown_values_never_fall_back(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(windows_payload(), windows_payload("self-hosted"))
        for invalid in ("", "unknown", "../self-hosted", "internal", "cn", "global"):
            with self.subTest(distribution=invalid):
                with patch.dict(os.environ, {"SODUWORK_DISTRIBUTION": invalid}):
                    with self.assertRaisesRegex(ValueError, "Unknown public Client distribution"):
                        windows_payload()


if __name__ == "__main__":
    unittest.main()
