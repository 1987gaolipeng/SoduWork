"""Keep independently installed Python entrypoints above reviewed security floors."""
from pathlib import Path
import unittest

from packaging.requirements import Requirement
from packaging.version import Version


ROOT = Path(__file__).resolve().parent.parent


def requirement(relative_path, package):
    # Office's hashed lock uses continuation lines; only the requirement line
    # contributes its version/marker policy, not the following hash options.
    for raw in (ROOT / relative_path).read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip().removesuffix("\\").strip()
        if not line or line.startswith(("#", "--", "-r ")):
            continue
        parsed = Requirement(line)
        if parsed.name.lower() == package.lower():
            return parsed
    raise AssertionError(f"{relative_path} must directly constrain {package}")


class SecurityDependencyContractTests(unittest.TestCase):
    def test_hub_only_and_runner_only_installations_reject_affected_crypto(self):
        # PyJWT[crypto] alone accepts an already-installed 49.0.0. The direct
        # dependency must apply on all platforms, including an in-place upgrade.
        for filename in ("requirements.txt", "requirements-runner.txt"):
            with self.subTest(entrypoint=filename):
                dependency = requirement(f"hub-backend/{filename}", "cryptography")
                self.assertIsNone(dependency.marker, "Security fixes cannot be platform-conditional")
                self.assertNotIn("49.0.0", dependency.specifier)
                self.assertNotIn("48.0.1", dependency.specifier)

    def test_hub_and_runner_pin_the_same_reviewed_crypto_release(self):
        hub = requirement("hub-backend/requirements.txt", "cryptography")
        runner = requirement("hub-backend/requirements-runner.txt", "cryptography")
        self.assertEqual(hub.specifier, runner.specifier)
        pins = list(hub.specifier)
        self.assertEqual(len(pins), 1)
        self.assertEqual(pins[0].operator, "==")
        # GHSA-g6cj-pr64-35w5 is fixed in 50.0.0; later patched wheels are allowed.
        self.assertGreaterEqual(Version(pins[0].version), Version("50.0.0"))

    def test_hub_and_office_reject_affected_pillow_release(self):
        for filename in ("hub-backend/requirements.txt",
                         "client/scripts/python-office-requirements.txt"):
            with self.subTest(entrypoint=filename):
                dependency = requirement(filename, "Pillow")
                self.assertIsNone(dependency.marker)
                self.assertNotIn("12.3.0", dependency.specifier)
                self.assertIn("13.0.0", dependency.specifier)


if __name__ == "__main__":
    unittest.main()
