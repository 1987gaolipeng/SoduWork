"""Current package names, accepted old bundles and offline signing compatibility."""
import base64
import contextlib
import errno
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
import build_platform_plugins as builder
import import_client_release as importer
import sign_client_release as signer
from app.services import client_updates, plugin_packages


class PackageBrandTests(unittest.TestCase):
    def test_content_addressed_old_archive_is_reused_and_new_archive_has_current_suffix(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = b"immutable-fixture"
            parsed = {"manifest": {"key":"brand-fixture"}, "checksum":"identity", "bytes":data}
            with patch.object(plugin_packages, "package_root", return_value=str(root)):
                for suffix in (".soduwork-plugin",):
                    path = root / "brand-fixture" / ("identity" + suffix)
                    path.parent.mkdir(exist_ok=True)
                    path.write_bytes(data)
                    self.assertEqual(Path(plugin_packages.store(parsed)), path)
                    self.assertEqual(path.read_bytes(), data)
                    path.unlink()
                new = Path(plugin_packages.store(parsed))
                self.assertEqual(new.suffix, ".soduwork-plugin")
                self.assertEqual(new.read_bytes(), data)
                new.write_bytes(b"tampered")
                with self.assertRaisesRegex(RuntimeError, "checksum"):
                    plugin_packages.store(parsed)

    def test_protected_filesystem_publish_preserves_existing_immutable_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "1.0.1.soduwork-plugin"
            with patch.object(builder.os, "link", side_effect=OSError(errno.EXDEV, "fixture protected volume")):
                builder._publish(path, b"accepted")
                builder._publish(path, b"accepted")
                with self.assertRaisesRegex(ValueError, "version bump"):
                    builder._publish(path, b"modified")
            self.assertEqual(path.read_bytes(), b"accepted")
            self.assertEqual(list(path.parent.glob(".platform-*")), [])

    def test_changed_extension_cannot_bypass_existing_version(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old = root / "feishu" / "1.0.0.soduwork-plugin"
            old.parent.mkdir()
            old.write_bytes(b"accepted")
            with patch.object(builder, "package_bytes", return_value=b"new"), patch.object(
                    plugin_packages, "parse", return_value={"manifest":{"version":"1.0.0"}}):
                with self.assertRaisesRegex(ValueError, "version bump"):
                    builder.build(root)
            self.assertEqual(old.read_bytes(), b"accepted")
            self.assertFalse(old.with_suffix(".soduwork-plugin").exists())


class OfflineSigningBrandTests(unittest.IsolatedAsyncioTestCase):
    async def test_new_and_legacy_names_sign_and_verify_without_renaming_signed_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            key = Ed25519PrivateKey.generate()
            keyfile = root / "fixture-key"
            keyfile.write_text(base64.b64encode(key.private_bytes_raw()).decode(), encoding="ascii")
            keyfile.chmod(0o600)
            public = base64.b64encode(key.public_key().public_bytes_raw()).decode()
            for stem in ("SoduWork",):
                with self.subTest(stem=stem):
                    source = root / (stem + "-1.2.3-Setup.exe")
                    source.write_bytes(b"installer-fixture" * 70000)
                    bundle_path = root / (stem + ".json")
                    args = SimpleNamespace(installer=str(source), output=str(bundle_path), key_file=str(keyfile),
                        version="1.2.3", minimum="", channel="stable", platform="win32", arch="x64",
                        key_id="isolated-brand", notes="", mandatory=False)
                    with patch.object(signer, "arguments", return_value=args), contextlib.redirect_stdout(io.StringIO()):
                        signer.main()
                    bundle = json.loads(bundle_path.read_text(encoding="utf8"))
                    self.assertEqual(bundle["artifact"]["name"], source.name)
                    with patch.object(client_updates, "trusted_public_keys", return_value={"isolated-brand":public}):
                        checked = client_updates.release_from_bundle(bundle, source)
                        self.assertEqual(checked.artifact_name, source.name)
                        # Complete all importer validation, stop immediately before storage/DB writes.
                        with patch.object(client_updates, "safe_artifact_path", side_effect=RuntimeError("validated fixture")):
                            with self.assertRaisesRegex(RuntimeError, "validated fixture"):
                                await importer.import_release(SimpleNamespace(installer=str(source), bundle=str(bundle_path)))
                        bundle["artifact"]["name"] = "unexpected-1.2.3-Setup.exe"
                        bundle_path.write_text(json.dumps(bundle), encoding="utf8")
                        with self.assertRaisesRegex(SystemExit, "installer name"):
                            await importer.import_release(SimpleNamespace(installer=str(source), bundle=str(bundle_path)))


if __name__ == "__main__":
    unittest.main()
