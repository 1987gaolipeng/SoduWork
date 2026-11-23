from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import linux_signing
import release
import validate_signed_linux as validation


class SignedLinuxValidationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.folder = self.root / "output"
        self.ctx = dict(component="client", version="1.2.3", repository="example/fork", commit="a" * 40, runId="123")
        release.write(self.root / "tools/distribution/PUBLIC-SOURCE.json", {"sourceOnly": False})
        release.write(self.root / "third-party/public-release.json", {"schema": 1, "pending": []})

    def test_signed_validation_uses_native_acceptance_and_cannot_be_a_release_receipt(self):
        def native(ctx, shard, folder, scratch):
            self.assertEqual(ctx, self.ctx)
            self.assertEqual(shard, "linux")
            self.assertTrue(scratch.is_dir())
            for name in linux_signing.asset_names(ctx["version"]):
                (folder / name).write_bytes(b"signed fixture")
            return {"ok": True, "linuxSigning": {"schema": 1, "primaryFingerprint": "A" * 40,
                "rpmEmbedded": True, "detached": linux_signing.package_names(ctx["version"]),
                "publicKey": linux_signing.PUBLIC_KEY}}
        with patch.object(validation, "native", side_effect=native):
            report = validation.validate(self.folder, ctx=self.ctx, root=self.root)
        self.assertTrue(report["validationOnly"])
        self.assertFalse(report["publicDistributionAllowed"])
        self.assertEqual(len(report["files"]), 7)
        self.assertFalse((self.folder / "linux-receipt.json").exists())
        self.assertEqual(release.read(self.folder / "signed-linux-validation.json"), report)

    def test_unreviewed_binary_scope_blocks_build_before_creating_output(self):
        release.write(self.root / "tools/distribution/PUBLIC-SOURCE.json", {"sourceOnly": True})
        with patch.object(validation, "native") as native, self.assertRaisesRegex(ValueError, "binary distribution"):
            validation.validate(self.folder, ctx=self.ctx, root=self.root)
        native.assert_not_called()
        self.assertFalse(self.folder.exists())

    def test_failed_or_missing_signing_acceptance_cannot_emit_a_receipt(self):
        for checks in [{"ok": False}, {"ok": True}]:
            folder = self.root / str(checks["ok"])
            with patch.object(validation, "native", return_value=checks), self.assertRaises(ValueError):
                validation.validate(folder, ctx=self.ctx, root=self.root)
            self.assertFalse((folder / "signed-linux-validation.json").exists())
