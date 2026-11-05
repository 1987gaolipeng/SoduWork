"""Six-platform multichannel client release smoke on an isolated SQLite DB.

Covers the real upload -> enable -> /check -> download chain through the
admin multipart endpoint (real Ed25519 verification, no stubs).
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import os
import shutil
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

ROOT = Path(__file__).resolve().parent
TEMP = ROOT / f".smoke-multichannel-{os.getpid()}"
DB_FILE = TEMP / "multi.db"
ARTIFACT_ROOT = TEMP / "artifacts"
KEY_ID = "smoke-multi-key"
VERSION = "1.13.0-beta.1"

shutil.rmtree(TEMP, ignore_errors=True)
TEMP.mkdir(parents=True)

_KEY = Ed25519PrivateKey.generate()
PRIVATE_KEY = base64.b64encode(_KEY.private_bytes(
    serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
    serialization.NoEncryption(),
)).decode("ascii")
PUBLIC_KEY = base64.b64encode(_KEY.public_key().public_bytes(
    serialization.Encoding.Raw, serialization.PublicFormat.Raw,
)).decode("ascii")

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB_FILE.as_posix()
os.environ["DB_MIGRATION_MODE"] = "auto"
os.environ["CLIENT_UPDATE_DIR"] = ARTIFACT_ROOT.as_posix()
os.environ["CLIENT_UPDATE_PUBLIC_KEYS"] = json.dumps({"keys": {KEY_ID: PUBLIC_KEY}})

from fastapi.testclient import TestClient  # noqa: E402

from app import auth  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Client, User  # noqa: E402
from app.services import client_updates as updates  # noqa: E402
from app.services import device_auth  # noqa: E402

# platform, arch, version, installer filename
# Migration 0057 permits multiple installer formats for one release target.
# Each artifact_name remains immutable within that target.
TARGETS = [
    ("win32", "x64", "1.13.0-beta.1", "SoduWork-1.13.0-beta.1-Setup.exe"),
    ("darwin", "arm64", "1.13.0-beta.1", "SoduWork-1.13.0-beta.1-mac-arm64.dmg"),
    ("darwin", "x64", "1.13.0-beta.1", "SoduWork-1.13.0-beta.1-mac.dmg"),
    ("linux", "x64", "1.13.0-beta.1", "SoduWork-1.13.0-beta.1-linux-x64.deb"),
    ("linux", "x64", "1.13.0-beta.1", "SoduWork-1.13.0-beta.1-linux-x64.rpm"),
    ("linux", "x64", "1.13.0-beta.1", "SoduWork-1.13.0-beta.1-linux-x64.tar.gz"),
    ("linux", "arm64", "1.13.0-beta.1", "SoduWork-1.13.0-beta.1-linux-arm64.AppImage"),
]

DEVICE = "soduwork-multi-smoke"
SECRET = "m" * 43
EXPECTED_MEDIA = {
    ".exe": "application/vnd.microsoft.portable-executable",
    ".dmg": "application/x-apple-diskimage",
    ".deb": "application/vnd.debian.binary-package",
    ".rpm": "application/x-rpm",
    ".tar.gz": "application/gzip",
    ".appimage": "application/x-executable",
}


def build_installer(name: str) -> Path:
    path = TEMP / name
    path.write_bytes((f"SODUWORK-MULTI-{name}\n".encode("ascii") * 150000)[:2_000_000])
    return path


def sign_bundle(installer: Path, platform: str, arch: str, version: str) -> dict:
    data = installer.read_bytes()
    payload = {
        "schema": 1,
        "releaseId": str(uuid.uuid4()),
        "version": version,
        "channel": "beta",
        "platform": platform,
        "arch": arch,
        "artifact": {
            "name": installer.name,
            "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "url": f"/api/v1/client-updates/artifacts/{'x' * 0}",
        },
        "mandatory": False,
        "minVersion": "",
        "notes": "multichannel smoke",
        "publishedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "keyId": KEY_ID,
    }
    payload["artifact"]["url"] = f"/api/v1/client-updates/artifacts/{payload['releaseId']}"
    payload["signature"] = updates.sign(payload, PRIVATE_KEY)
    return payload


async def seed() -> None:
    await init_db()
    async with SessionLocal() as session:
        session.add_all([
            User(id="98765432-1234-4234-8234-123456789001", username="multi-admin",
                 display_name="多通道管理员", is_super=True,
                 password_hash=auth.hash_password("multi-pw-2026")),
            Client(id=DEVICE, secret_hash=device_auth.hash_secret(SECRET),
                   auth_state="active", user_ref="98765432-1234-4234-8234-123456789001",
                   app_version="1.12.81",
                   last_seen_at=datetime.now(timezone.utc)),
        ])
        await session.commit()


def admin_headers(client: TestClient) -> dict:
    res = client.post("/api/v1/admin/login",
                      json={"user": "multi-admin", "pw": "multi-pw-2026"})
    assert res.status_code == 200, res.text
    return {"Authorization": "Bearer " + res.json()["token"]}


def device_headers(client: TestClient) -> dict:
    res = client.post("/api/v1/clients/enroll", json={"device": DEVICE},
                      headers={"X-Device-Key": SECRET})
    assert res.status_code == 200, res.text
    return {"Authorization": "Device " + res.json()["session"]}


def upload_release(client: TestClient, headers: dict, installer: Path,
                   bundle: dict, *, expect_status: int = 200) -> dict:
    res = client.post(
        "/api/v1/admin/client-releases/upload",
        headers=headers,
        files={
            "bundle": ("release.json", json.dumps(bundle).encode("utf-8"),
                       "application/json"),
            "installer": (installer.name, installer.read_bytes(),
                          "application/octet-stream"),
        },
    )
    assert res.status_code == expect_status, res.text
    return res.json() if expect_status == 200 else {}


def main() -> None:
    asyncio.run(seed())
    ok = 0
    with TestClient(app) as client:
        admin = admin_headers(client)
        device = device_headers(client)

        release_ids: dict[str, str] = {}
        for platform, arch, version, name in TARGETS:
            installer = build_installer(name)
            bundle = sign_bundle(installer, platform, arch, version)
            body = upload_release(client, admin, installer, bundle)
            release = body["release"]
            assert release["enabled"] is False, "uploaded releases must stage disabled"
            assert release["platform"] == platform and release["arch"] == arch
            assert release["version"] == version
            release_ids[name] = release["id"]
            ok += 1
        print(f"upload x{len(TARGETS)} staged (disabled) OK")

        # same artifact name re-packaged with a fresh bundle is immutable: rejected
        # Different formats may coexist; conflicting manifests under the same artifact name remain rejected.
        clash = build_installer("SoduWork-1.13.0-beta.1-linux-x64.deb")
        clash_bundle = sign_bundle(clash, "linux", "x64", "1.13.0-beta.1")
        upload_release(client, admin, clash, clash_bundle, expect_status=409)
        ok += 1
        print("same-artifact immutable rejection OK")

        # wrong-suffix installer is rejected by the real signature chain
        wrong = build_installer("SoduWork-1.13.0-beta.1-mac-arm64.exe")
        bad_bundle = sign_bundle(wrong, "darwin", "arm64", "1.13.0-beta.1")
        upload_release(client, admin, wrong, bad_bundle, expect_status=409)
        ok += 1
        print("cross-suffix rejection OK")

        # enable every staged release (server re-verifies signature + integrity)
        for name, release_id in release_ids.items():
            res = client.patch(f"/api/v1/admin/client-releases/{release_id}",
                               json={"enabled": True}, headers=admin)
            assert res.status_code == 200, res.text
            assert res.json()["release"]["enabled"] is True
            ok += 1
        print(f"enable x{len(release_ids)} OK")

        for platform, arch, version, name in TARGETS:
            res = client.get(
                f"/api/v1/client-updates/check?current=1.12.81&platform={platform}&arch={arch}&channel=beta",
                headers=device,
            )
            assert res.status_code == 200, res.text
            body = res.json()
            assert body["hasUpdate"] is True, f"{name}: no update offered"
            manifest = body["manifest"]
            # /check always offers the newest release for the exact target
            newest = max(v for p, a, v, n in TARGETS
                         if p == platform and a == arch)
            assert manifest["version"] == newest, f"{name}: got {manifest['version']}"
            assert manifest["platform"] == platform and manifest["arch"] == arch
            latest_name = next(n for p, a, v, n in TARGETS
                               if p == platform and a == arch and v == newest)
            assert manifest["artifact"]["name"] == latest_name
            artifact = client.get(
                f"/api/v1/client-updates/artifacts/{manifest['releaseId']}",
                headers=device,
            )
            assert artifact.status_code == 200, artifact.text[:200]
            digest = hashlib.sha256(artifact.content).hexdigest()
            assert digest == manifest["artifact"]["sha256"], name
            expected = next(v for k, v in EXPECTED_MEDIA.items()
                            if latest_name.lower().endswith(k))
            assert artifact.headers["content-type"] == expected, \
                f"{latest_name}: content-type {artifact.headers['content-type']}"
            ok += 1
        print("check+download across seven targets OK")

        # non-newest staged formats (deb/rpm beside tar.gz) are still stored
        # and listed; artifact downloads are bound to an update attempt, so
        # verify them via the admin listing metadata instead.
        listing = client.get("/api/v1/admin/client-releases", headers=admin)
        by_id = {r["id"]: r for r in listing.json()["releases"]}
        for name, release_id in release_ids.items():
            if name.endswith(("linux-x64.deb", "linux-x64.rpm")):
                row = by_id[release_id]
                assert row["artifactName"] == name and row["enabled"] is True
                assert len(row["sha256"]) == 64
                ok += 1
        print("side-by-side format metadata OK")

        # no update when only a different arch is staged for the platform
        res = client.get(
            "/api/v1/client-updates/check?current=1.12.81&platform=win32&arch=arm64&channel=beta",
            headers=device,
        )
        assert res.status_code == 200 and res.json()["hasUpdate"] is False
        ok += 1
        print("arch mismatch yields no update OK")

        # list endpoint reflects everything
        listing = client.get("/api/v1/admin/client-releases", headers=admin)
        assert listing.status_code == 200
        assert len(listing.json()["releases"]) == len(TARGETS)
        ok += 1
        print("admin list OK")

    print(f"multichannel client releases: {ok} checks green")
    shutil.rmtree(TEMP, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
