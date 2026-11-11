"""Cross-runtime contract for the Windows client signer/uploader."""
from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


ROOT = Path(__file__).resolve().parent.parent
REPO = ROOT.parent
TEMP = ROOT / f".smoke-client-release-uploader-{os.getpid()}"
KEY_ID = "smoke-node-signer"


def invoke(installer: Path, environment: dict, *, success: bool = True):
    result = subprocess.run(
        ["node", str(REPO / "tools/sign-client-release.mjs"),
         str(installer), "--dry-run"],
        cwd=REPO,
        env=environment,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
    )
    if success and result.returncode:
        raise AssertionError(result.stdout + result.stderr)
    if not success and not result.returncode:
        raise AssertionError("signer unexpectedly accepted invalid input")
    return result


def main() -> None:
    shutil.rmtree(TEMP, ignore_errors=True)
    TEMP.mkdir(parents=True)
    try:
        key = Ed25519PrivateKey.generate()
        private = base64.b64encode(key.private_bytes(
            serialization.Encoding.Raw,
            serialization.PrivateFormat.Raw,
            serialization.NoEncryption(),
        )).decode("ascii")
        public = base64.b64encode(key.public_key().public_bytes(
            serialization.Encoding.Raw,
            serialization.PublicFormat.Raw,
        )).decode("ascii")
        key_file = TEMP / "release.key"
        trust_file = TEMP / "trust.json"
        installer = TEMP / "SoduWork-9.9.1-Setup.exe"
        bundle_file = TEMP / "SoduWork-9.9.1.release.json"
        key_file.write_text(private, encoding="ascii")
        key_file.chmod(0o600)
        trust_file.write_text(json.dumps({"schema": 1, "keys": {KEY_ID: public}}),
                              encoding="utf-8")
        installer.write_bytes((b"SODUWORK-NODE-SIGNER\n" * 100000)[:1300000])
        environment = {
            **os.environ,
            "CLIENT_UPDATE_PUBLIC_KEYS": json.dumps({"keys": {KEY_ID: public}}),
            "SODUWORK_CLIENT_SIGNING_KEY_FILE": str(key_file),
            "DATABASE_URL": "sqlite+aiosqlite:///" + (TEMP / "unused.db").as_posix(),
            "SODUWORK_CLIENT_SIGNING_KEY_ID": KEY_ID,
            "SODUWORK_CLIENT_TRUST_FILE": str(trust_file),
            "SODUWORK_CLIENT_RELEASE_BUNDLE": str(bundle_file),
            "SODUWORK_CLIENT_CHANNEL": "beta",
            "SODUWORK_CLIENT_RELEASE_NOTES": "node signer smoke",
        }

        first = invoke(installer, environment)
        assert "signed client 9.9.1" in first.stdout
        assert bundle_file.is_file()
        original = bundle_file.read_bytes()
        bundle = json.loads(original)
        assert bundle["version"] == "9.9.1"
        assert bundle["channel"] == "beta"
        assert bundle["keyId"] == KEY_ID

        os.environ["CLIENT_UPDATE_PUBLIC_KEYS"] = environment["CLIENT_UPDATE_PUBLIC_KEYS"]
        os.environ["DATABASE_URL"] = environment["DATABASE_URL"]
        from app.services import client_updates
        candidate = client_updates.release_from_bundle(bundle, installer)
        assert candidate.version == "9.9.1"
        assert candidate.sha256 == client_updates.sha256_file(installer)

        second = invoke(installer, environment)
        assert second.returncode == 0
        assert bundle_file.read_bytes() == original

        installer.write_bytes(installer.read_bytes() + b"tampered")
        changed = invoke(installer, environment, success=False)
        assert "does not match this installer" in changed.stderr

        bad_trust = TEMP / "bad-trust.json"
        bad_trust.write_text(json.dumps({"schema": 1, "keys": {KEY_ID: "A" * 44}}),
                             encoding="utf-8")
        invalid_environment = {**environment, "SODUWORK_CLIENT_TRUST_FILE": str(bad_trust)}
        rejected = invoke(installer, invalid_environment, success=False)
        assert "not trusted" in rejected.stderr

        linux_env = {**environment, "SODUWORK_CLIENT_PLATFORM": "linux",
                     "SODUWORK_CLIENT_PUBLISHED_AT": "2026-10-15T02:00:00Z"}
        linux_env.pop("SODUWORK_CLIENT_RELEASE_BUNDLE")
        ids = set()
        for extension in ("deb", "rpm", "tar.gz"):
            artifact = TEMP / f"SoduWork-9.9.1-linux.{extension}"
            artifact.write_bytes(b"fixture" * 200000)
            invoke(artifact, linux_env)
            signed = Path(str(artifact) + ".beta.release.json")
            original = signed.read_bytes()
            bundle = json.loads(original)
            ids.add(bundle["releaseId"])
            client_updates.release_from_bundle(bundle, artifact)
            # Retry after GitLab cleaned the job workspace, not just in-place.
            signed.unlink()
            invoke(artifact, linux_env)
            assert signed.read_bytes() == original
            # A valid signature for another platform must not be reused.
            bundle["platform"] = "darwin"
            payload = {k: v for k, v in bundle.items() if k != "signature"}
            bundle["signature"] = client_updates.sign(payload, private)
            signed.write_text(json.dumps(bundle), encoding="utf-8")
            rejected = invoke(artifact, linux_env, success=False)
            assert "does not match this installer" in rejected.stderr
        assert len(ids) == 3
        print("client release uploader: signature, independent formats and clean-workspace retry passed")
    finally:
        shutil.rmtree(TEMP, ignore_errors=True)


if __name__ == "__main__":
    main()
