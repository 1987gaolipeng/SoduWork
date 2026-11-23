"""Real OpenPGP/RPM round trips using disposable, password-protected fixture keys."""
import base64
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import linux_signing as signing


class SettingsTests(unittest.TestCase):
    def test_missing_credentials_and_malformed_inputs_fail_closed(self):
        env = {signing.PREFIX + "FINGERPRINT": "A" * 40,
               signing.PREFIX + "KEY_B64": base64.b64encode(b"fixture").decode(),
               signing.PREFIX + "PASSPHRASE": "synthetic-fixture"}
        for key in env:
            with self.subTest(key=key), self.assertRaises(ValueError):
                signing.settings({**env, key: ""})
        for suffix, value in [("FINGERPRINT", "short-id"), ("KEY_B64", "!invalid!"),
                              ("PASSPHRASE", "two\nlines")]:
            with self.subTest(suffix=suffix), self.assertRaises(ValueError):
                signing.settings({**env, signing.PREFIX + suffix: value})

    def test_rpm4_and_rpm6_signature_reports_are_accepted_but_digests_alone_are_not(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for index, report in enumerate([
                b'Header V4 RSA/SHA256 Signature, key ID 01234567: OK\nHeader SHA256 digest: OK\n',
                b'Header OpenPGP V4 RSA/SHA256 signature, key fingerprint: ' + b'a' * 40 + b': OK\n',
                b'Header SHA256 digest: OK\nPayload SHA256 digest: OK\n',
            ]):
                home = root / str(index)
                home.mkdir()
                with patch.object(signing, 'command', side_effect=[b'', b'', report]):
                    if index < 2:
                        signing.verify_rpm(root / 'fixture.rpm', root / 'public.asc', home, {})
                    else:
                        with self.assertRaisesRegex(ValueError, 'no verified OpenPGP'):
                            signing.verify_rpm(root / 'fixture.rpm', root / 'public.asc', home, {})


TOOLS = ("gpg", "gpgconf", "rpmbuild", "rpm", "rpmkeys", "rpmsign")


@unittest.skipUnless(os.name == "posix" and all(shutil.which(tool) for tool in TOOLS),
                     "Native Linux signing tests require GnuPG and RPM build/sign tools")
class NativeSigningTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="soduwork-signing-fixture-")
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.root = Path(cls.temporary.name)
        cls.version = "1.2.3"
        with signing.keyring() as (home, env):
            password = "synthetic-test-passphrase"
            signing.gpg(home, env, "--pinentry-mode", "loopback", "--passphrase-fd", "0",
                        "--quick-generate-key", "Linux Signing Fixture <fixture@example.invalid>",
                        "rsa3072", "sign", "1d", data=password.encode())
            listing = signing.gpg(home, env, "--with-colons", "--list-secret-keys").decode()
            fingerprint = next(line.split(":")[9] for line in listing.splitlines() if line.startswith("fpr:"))
            secret = signing.gpg(home, env, "--pinentry-mode", "loopback", "--passphrase-fd", "0",
                                 "--armor", "--export-secret-keys", fingerprint, data=password.encode())
        cls.credentials = {signing.PREFIX + "FINGERPRINT": fingerprint,
                           signing.PREFIX + "KEY_B64": base64.b64encode(secret).decode(),
                           signing.PREFIX + "PASSPHRASE": password}
        cls.fingerprint = fingerprint
        spec = cls.root / "fixture.spec"
        spec.write_text("""Name: soduwork-signing-fixture
Version: 1.2.3
Release: 1
Summary: Disposable signing test
License: MIT
BuildArch: noarch
%description
Disposable signature verification fixture, not the SoduWork application.
%install
mkdir -p %{buildroot}/usr/share/soduwork-signing-fixture
echo fixture > %{buildroot}/usr/share/soduwork-signing-fixture/data
%files
/usr/share/soduwork-signing-fixture/data
""", encoding="utf-8")
        signing.command("rpmbuild", "--define", "_topdir " + str(cls.root / "rpmbuild"),
                        "-bb", spec, env={**os.environ, "LC_ALL": "C"})
        cls.rpm = next((cls.root / "rpmbuild/RPMS").rglob("*.rpm"))
        cls.signed = cls.root / "signed"
        cls.make_packages(cls.signed)
        cls.receipt = signing.sign_packages(cls.signed, cls.version, cls.credentials)

    @classmethod
    def make_packages(cls, folder):
        folder.mkdir()
        for name in signing.package_names(cls.version):
            if name.endswith(".rpm"):
                shutil.copyfile(cls.rpm, folder / name)
            else:
                (folder / name).write_bytes(b"Synthetic detached-signature payload\n")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=self.root)
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name) / "packages"
        shutil.copytree(self.signed, self.folder)

    def test_signed_packages_verify_with_only_the_published_public_key(self):
        self.assertEqual(signing.verify_packages(self.folder, self.version, self.fingerprint), self.receipt)
        self.assertTrue(self.receipt["rpmEmbedded"])
        public_key = (self.folder / signing.PUBLIC_KEY).read_text()
        self.assertIn("BEGIN PGP PUBLIC KEY BLOCK", public_key)
        self.assertNotIn("PRIVATE", public_key)
        self.assertEqual(sorted(p.name for p in self.folder.iterdir()), sorted(signing.asset_names(self.version)))

    def test_corruption_of_each_package_signature_or_public_key_is_rejected(self):
        for name in signing.asset_names(self.version):
            with self.subTest(name=name):
                target = self.folder / name
                original = target.read_bytes()
                target.write_bytes(b"corrupted" + original[9:])
                try:
                    with self.assertRaises(ValueError):
                        signing.verify_packages(self.folder, self.version, self.fingerprint)
                finally:
                    target.write_bytes(original)

    def test_another_trust_fingerprint_and_unsigned_rpm_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "fingerprint differs"):
            signing.verify_packages(self.folder, self.version, "0" * 40)
        with signing.keyring() as (home, env):
            with self.assertRaisesRegex(ValueError, "no verified OpenPGP"):
                signing.verify_rpm(self.rpm, self.folder / signing.PUBLIC_KEY, home, env)

    def test_wrong_passphrase_does_not_change_installers_or_leave_key_material(self):
        before = {name: (self.folder / name).read_bytes() for name in signing.asset_names(self.version)}
        with self.assertRaisesRegex(ValueError, "failed"):
            signing.sign_packages(self.folder, self.version,
                                  {**self.credentials, signing.PREFIX + "PASSPHRASE": "wrong-fixture"})
        self.assertEqual(before, {name: (self.folder / name).read_bytes() for name in before})

    def test_keyring_cleanup_runs_on_failure_and_does_not_inherit_secrets(self):
        with self.assertRaisesRegex(RuntimeError, "fixture"):
            with signing.keyring() as (home, env):
                self.assertEqual(home.stat().st_mode & 0o777, 0o700)
                self.assertFalse(any(key.startswith(signing.PREFIX) for key in env))
                raise RuntimeError("fixture")
        self.assertFalse(home.exists())

    def test_missing_signature_and_symlink_are_rejected(self):
        signature = self.folder / (signing.package_names(self.version)[0] + ".asc")
        signature.unlink()
        with self.assertRaisesRegex(ValueError, "Missing or unsafe"):
            signing.verify_packages(self.folder, self.version, self.fingerprint)
        signature.symlink_to(self.signed / signature.name)
        with self.assertRaisesRegex(ValueError, "Missing or unsafe"):
            signing.verify_packages(self.folder, self.version, self.fingerprint)


if __name__ == "__main__":
    unittest.main()
