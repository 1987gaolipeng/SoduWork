"""Release trust configuration and fail-closed loading contract."""
from __future__ import annotations

import base64
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from app.services import client_updates as updates

BACKEND = Path(__file__).resolve().parent.parent
CLIENT = BACKEND.parent / "client"


class ReleaseTrustTests(unittest.TestCase):
    def test_distribution_trust_stores_match(self):
        server = json.loads((BACKEND / "client-update-trust.json").read_text())
        client = json.loads((CLIENT / "update-trust.json").read_text())
        self.assertEqual(server["schema"], 1)
        self.assertEqual(client, server)
        self.assertIsInstance(server["keys"], dict)
        for key_id, value in server["keys"].items():
            self.assertRegex(key_id, updates.KEY_ID_RE)
            updates.public_key(value)

    def test_empty_configured_trust_is_rejected(self):
        settings = SimpleNamespace(client_update_public_keys='{"schema":1,"keys":{}}')
        with patch.object(updates, "get_settings", return_value=settings):
            with self.assertRaisesRegex(updates.UpdateContractError, "empty"):
                updates.trusted_public_keys()

    def test_explicit_release_key_is_loaded(self):
        key = Ed25519PrivateKey.generate().public_key()
        public = base64.b64encode(key.public_bytes(Encoding.Raw, PublicFormat.Raw)).decode()
        keys = {"fixture-release-key": public}
        settings = SimpleNamespace(client_update_public_keys=json.dumps({"keys": keys}))
        with patch.object(updates, "get_settings", return_value=settings):
            self.assertEqual(updates.trusted_public_keys(), keys)

    def test_file_configuration_is_loaded_or_rejected_when_empty(self):
        keys = json.loads((BACKEND / "client-update-trust.json").read_text())["keys"]
        with patch.object(updates, "get_settings", return_value=SimpleNamespace(client_update_public_keys="")):
            if keys:
                self.assertEqual(updates.trusted_public_keys(), keys)
            else:
                with self.assertRaisesRegex(updates.UpdateContractError, "empty"):
                    updates.trusted_public_keys()

    def test_manual_upgrade_remains_available_before_signature_validation(self):
        updater = (CLIENT / "main" / "client-updater.js").read_text()
        self.assertGreater(updater.find("data.manualInstallRequired"), 0)
        self.assertLess(updater.find("data.manualInstallRequired"), updater.find("contract.validateManifest"))


if __name__ == "__main__":
    unittest.main()
