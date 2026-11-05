"""Native Claude installer tests without network access or real Agent binaries."""
import hashlib
import io
import json
import ssl
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

from app.agent_catalog import AGENTS
from app.services import agent_native_install, agent_setup


class AgentNativeInstallTests(unittest.TestCase):
    def test_download_uses_shared_proxy_discovery_and_retries_transient_failures(self):
        response = io.BytesIO(b"2.1.317")
        response.headers = {"Content-Length": "7"}
        with patch.object(agent_native_install.managed_agent_network, "open_download",
                          side_effect=[urllib.error.URLError(TimeoutError()), response]) as download, \
             patch.object(agent_native_install.time, "sleep") as sleep:
            self.assertEqual(agent_native_install._read_url("https://downloads.claude.ai/latest", limit=128), b"2.1.317")
        self.assertEqual(download.call_count, 2)
        sleep.assert_called_once_with(1)

    def test_download_restarts_after_truncation_without_joining_partial_bytes(self):
        responses = [io.BytesIO(b"part"), io.BytesIO(b"complete")]
        for response in responses:
            response.headers = {"Content-Length": "8"}
        with patch.object(agent_native_install.managed_agent_network, "open_download", side_effect=responses), \
             patch.object(agent_native_install.time, "sleep"):
            self.assertEqual(agent_native_install._read_url("https://downloads.claude.ai/binary", limit=128), b"complete")

    def test_download_never_retries_certificate_errors_missing_releases_or_oversized_bodies(self):
        oversized = io.BytesIO(b"too large")
        oversized.headers = {"Content-Length": "9"}
        for result in [urllib.error.URLError(ssl.SSLCertVerificationError()),
                       urllib.error.HTTPError("https://downloads.claude.ai/binary", 404, "missing", {}, None), oversized]:
            with self.subTest(result=type(result).__name__), \
                 patch.object(agent_native_install.managed_agent_network, "open_download",
                              side_effect=result if isinstance(result, Exception) else None,
                              return_value=result) as download, patch.object(agent_native_install.time, "sleep") as sleep:
                with self.assertRaises(RuntimeError):
                    agent_native_install._read_url("https://downloads.claude.ai/binary", limit=8)
                self.assertEqual(download.call_count, 1)
                sleep.assert_not_called()

    def test_exhausted_retries_keep_proxy_credentials_out_of_diagnostics(self):
        with patch.object(agent_native_install.managed_agent_network, "open_download",
                          side_effect=urllib.error.URLError("https://name:private@proxy.invalid/?token=private")) as download, \
             patch.object(agent_native_install.time, "sleep"):
            with self.assertRaises(RuntimeError) as error:
                agent_native_install._read_url("https://downloads.claude.ai/binary", limit=128)
        self.assertEqual(download.call_count, 3)
        self.assertNotIn("private", str(error.exception))

    def test_all_supported_native_platforms_and_libcs(self):
        for system, machine, libc, expected in [
            ('win32', 'AMD64', '', 'win32-x64'), ('win32', 'ARM64', '', 'win32-arm64'),
            ('darwin', 'x86_64', '', 'darwin-x64'), ('darwin', 'arm64', '', 'darwin-arm64'),
            ('linux', 'x86_64', 'glibc', 'linux-x64'), ('linux', 'aarch64', 'glibc', 'linux-arm64'),
            ('linux', 'x86_64', 'musl', 'linux-x64-musl'), ('linux', 'aarch64', 'musl', 'linux-arm64-musl'),
        ]:
            with self.subTest(platform=expected), patch.object(agent_native_install, 'os',
                    SimpleNamespace(name='nt' if system == 'win32' else 'posix', sys=SimpleNamespace(platform=system), environ={})), \
                 patch.object(agent_native_install.platform, 'machine', return_value=machine), \
                 patch.object(agent_native_install.platform, 'architecture', return_value=('64bit', '')), \
                 patch.object(agent_native_install.platform, 'libc_ver', return_value=(libc, '')):
                self.assertEqual(agent_native_install._platform(), expected)

    def test_invalid_manifests_fail_before_downloading_or_activating(self):
        for data in [[], {'platforms': []}, {'platforms': {'win32-x64': []}, 'version': '2.1.0'},
                     {'platforms': {'win32-x64': {'checksum': 'a'*64, 'size': -1}}, 'version': '2.1.0'}]:
            with patch.object(agent_native_install, '_read_url', return_value=json.dumps(data).encode()):
                with self.assertRaises(RuntimeError):
                    agent_native_install._manifest('2.1.0', 'win32-x64')

    def test_catalog_uses_reviewed_native_installer_without_node_package(self):
        install = AGENTS["claude"]["install"]
        self.assertEqual(install["installer"], "native")
        self.assertNotIn("pkg", install)
        self.assertTrue(install["source"].startswith("https://"))

    def test_manifest_accepts_current_release_size(self):
        manifest = {
            "version": "2.1.314",
            "platforms": {
                "win32-x64": {
                    "checksum": "a" * 64,
                    "size": 301_388_448,
                }
            }
        }
        with patch.object(agent_native_install, "_read_url", return_value=json.dumps(manifest).encode()):
            checksum, size = agent_native_install._manifest("2.1.314", "win32-x64")
        self.assertEqual(checksum, "a" * 64)
        self.assertEqual(size, 301_388_448)

    def test_install_downloads_only_verified_platform_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            blob = b"verified Claude fixture"
            digest = hashlib.sha256(blob).hexdigest()
            with (patch.object(agent_native_install, "_platform", return_value="linux-x64"),
                  patch.object(agent_native_install, "_manifest", return_value=(digest, len(blob))),
                  patch.object(agent_native_install, "_read_url", return_value=blob),
                  patch.object(agent_native_install, "_run_version", return_value="2.1.0")):
                ok, detail = agent_native_install._download(folder, "2.1.0", lambda _line: None)
            self.assertTrue(ok)
            self.assertEqual(detail, "2.1.0")
            active = Path(agent_native_install.active_binary(folder))
            self.assertEqual(active.read_bytes(), blob)

    def test_checksum_mismatch_does_not_leave_active_binary(self):
        with tempfile.TemporaryDirectory() as folder:
            with (patch.object(agent_native_install, "_platform", return_value="linux-x64"),
                  patch.object(agent_native_install, "_manifest", return_value=("0" * 64, 4)),
                  patch.object(agent_native_install, "_read_url", return_value=b"bad!")):
                with self.assertRaisesRegex(RuntimeError, "SHA-256"):
                    agent_native_install._download(folder, "2.1.0", lambda _line: None)
            self.assertEqual(agent_native_install.active_binary(folder), "")

    def test_startup_failure_keeps_previous_active_binary(self):
        with tempfile.TemporaryDirectory() as folder:
            current = Path(folder) / "agent-runtimes" / "native" / "claude" / "current"
            current.mkdir(parents=True)
            name = "claude.exe" if agent_native_install.os.name == "nt" else "claude"
            active = current / name
            active.write_bytes(b"previous")
            blob = b"new but unusable"
            with (patch.object(agent_native_install, "_platform", return_value="linux-x64"),
                  patch.object(agent_native_install, "_manifest", return_value=(hashlib.sha256(blob).hexdigest(), len(blob))),
                  patch.object(agent_native_install, "_read_url", return_value=blob),
                  patch.object(agent_native_install, "_run_version", return_value="")):
                with self.assertRaisesRegex(RuntimeError, "startup check"):
                    agent_native_install._download(folder, "2.1.0", lambda _line: None)
            self.assertEqual(active.read_bytes(), b"previous")

    def test_setup_routes_claude_native_install_without_node(self):
        with patch.object(agent_setup, "_spawn") as spawn:
            jid = agent_setup.start_install("claude", "install")
        self.assertTrue(jid)
        spawn.assert_called_once_with(jid, agent_setup._run_native, "claude", "install")


if __name__ == "__main__":
    unittest.main()
