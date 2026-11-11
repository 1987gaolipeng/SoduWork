"""Signed full-client update contract smoke; isolated from business data."""
import base64
import json
import os
from pathlib import Path

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///./.smoke-client-updates-contract.db"

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from app.services import client_updates as updates


class Release:
    id = "12345678-1234-4234-8234-123456789abc"
    version = "1.2.11"
    channel = "stable"
    platform = "win32"
    arch = "x64"
    artifact_name = "SoduWork-1.2.11-Setup.exe"
    artifact_size = 2 * 1024 * 1024
    sha256 = "a" * 64
    mandatory = False
    min_version = ""
    notes = "安全升级"
    key_id = "smoke-key"
    created_at = None
    signature = ""


def main() -> None:
    client_trust = json.loads(
        (Path(__file__).resolve().parents[2] / "client" / "update-trust.json")
        .read_text(encoding="utf-8")
    )
    server_trust = json.loads(
        (Path(__file__).resolve().parent.parent / "client-update-trust.json")
        .read_text(encoding="utf-8")
    )
    assert client_trust == server_trust
    key = Ed25519PrivateKey.generate()
    private = base64.b64encode(key.private_bytes(
        serialization.Encoding.Raw,
        serialization.PrivateFormat.Raw,
        serialization.NoEncryption(),
    )).decode()
    public = base64.b64encode(key.public_key().public_bytes(
        serialization.Encoding.Raw,
        serialization.PublicFormat.Raw,
    )).decode()
    release = Release()
    payload = updates.manifest_payload(release)
    release.signature = updates.sign(payload, private)
    os.environ["CLIENT_UPDATE_PUBLIC_KEYS"] = json.dumps(
        {"keys": {"smoke-key": public}}
    )
    updates.get_settings.cache_clear()
    assert updates.verify(payload, release.signature, public)
    assert updates.assert_trusted_release(release) == payload
    changed = {**payload, "version": "1.2.12"}
    assert not updates.verify(changed, release.signature, public)
    release.version = "1.2.12"
    try:
        updates.assert_trusted_release(release)
        raise AssertionError("tampered release accepted")
    except updates.UpdateContractError:
        pass
    release.version = "1.2.11"
    assert updates.newer("1.2.11", "1.2.10")
    assert not updates.newer("1.2.10", "1.2.10")
    assert not updates.newer("1.2.9", "1.2.10")
    assert not updates.newer("1.2.11", "bad")
    for before, after in (("queued", "available"), ("available", "downloading"),
                          ("downloading", "downloaded"), ("downloaded", "installing"),
                          ("installing", "installed")):
        updates.validate_transition(before, after)
    try:
        updates.validate_transition("queued", "downloaded")
        raise AssertionError("invalid transition accepted")
    except updates.UpdateContractError:
        pass
    print("client updates: 14 assertions green")


if __name__ == "__main__":
    main()
