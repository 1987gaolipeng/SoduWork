"""An older downloaded installer must not hide a newer trusted release."""
import asyncio
import base64
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


_KEY = Ed25519PrivateKey.generate()
PRIVATE_KEY = base64.b64encode(_KEY.private_bytes(
    serialization.Encoding.Raw,
    serialization.PrivateFormat.Raw,
    serialization.NoEncryption(),
)).decode()
PUBLIC_KEY = base64.b64encode(_KEY.public_key().public_bytes(
    serialization.Encoding.Raw,
    serialization.PublicFormat.Raw,
)).decode()

DB_FILE = Path(__file__).with_name(
    f".smoke-client-update-supersession-{os.getpid()}.db").resolve()
ARTIFACT_ROOT = Path(__file__).with_name(
    f".smoke-client-update-supersession-artifacts-{os.getpid()}").resolve()
DB_FILE.unlink(missing_ok=True)
shutil.rmtree(ARTIFACT_ROOT, ignore_errors=True)
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB_FILE.as_posix()
os.environ["DB_MIGRATION_MODE"] = "auto"
os.environ["CLIENT_UPDATE_DIR"] = ARTIFACT_ROOT.as_posix()
os.environ["CLIENT_UPDATE_PUBLIC_KEYS"] = json.dumps(
    {"keys": {"smoke-key": PUBLIC_KEY}})

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal, engine, init_db
from app.main import app
from app.models import Client, ClientRelease, ClientUpdateAttempt, User
from app.services import client_updates as updates
from app.services import device_auth


DEVICE = "soduwork-smoke-update-supersession"
SECRET = "v" * 43
OLD_RELEASE = "12345678-1234-4234-8234-123456789101"
NEW_RELEASE = "12345678-1234-4234-8234-123456789102"
OLD_ATTEMPT = "12345678-1234-4234-8234-123456789103"


async def seed() -> None:
    await init_db()
    async with SessionLocal() as session:
        user = User(id="12345678-1234-4234-8234-123456789104",
                    username="update-supersession", display_name="Update tester")
        client = Client(
            id=DEVICE, secret_hash=device_auth.hash_secret(SECRET), auth_state="active",
            user_ref=user.id, app_version="1.2.10",
            last_seen_at=datetime.now(timezone.utc),
        )
        session.add_all([user, client])
        for version, release_id in (("1.2.11", OLD_RELEASE), ("1.2.12", NEW_RELEASE)):
            relative = f"stable/win32/x64/{version}/SoduWork-{version}-Setup.exe"
            artifact = ARTIFACT_ROOT / relative
            artifact.parent.mkdir(parents=True, exist_ok=True)
            artifact.write_bytes((f"SODUWORK-{version}\n".encode() * 64))
            release = ClientRelease(
                id=release_id, version=version, channel="stable",
                platform="win32", arch="x64",
                artifact_name=artifact.name, artifact_path=relative,
                artifact_size=artifact.stat().st_size,
                sha256=updates.sha256_file(artifact), signature="",
                key_id="smoke-key", enabled=True,
            )
            session.add(release)
            await session.flush()
            release.signature = updates.sign(
                updates.manifest_payload(release), PRIVATE_KEY)
        session.add(ClientUpdateAttempt(
            id=OLD_ATTEMPT, client_id=DEVICE, release_id=OLD_RELEASE,
            requested_by="auto", current_version="1.2.10",
            target_version="1.2.11", state="downloaded", progress=100,
        ))
        await session.commit()


def auth_headers(client: TestClient) -> dict:
    enrolled = client.post(
        "/api/v1/clients/enroll", json={"device": DEVICE},
        headers={"X-Device-Key": SECRET})
    assert enrolled.status_code == 200, enrolled.text
    return {"Authorization": "Device " + enrolled.json()["session"]}


def main() -> None:
    asyncio.run(seed())
    try:
        with TestClient(app) as client:
            response = client.get(
                "/api/v1/client-updates/check?current=1.2.10&platform=win32&arch=x64",
                headers=auth_headers(client),
            )
            assert response.status_code == 200, response.text
            body = response.json()
            assert body["hasUpdate"] is True
            assert body["manifest"]["version"] == "1.2.12"
            assert body["manifest"]["releaseId"] == NEW_RELEASE

        async def verify() -> None:
            async with SessionLocal() as session:
                old = await session.get(ClientUpdateAttempt, OLD_ATTEMPT)
                assert old.state == "failed"
                assert old.progress == 0
                assert "1.2.12" in old.error
                assert old.completed_at is not None
                rows = list((await session.execute(
                    select(ClientUpdateAttempt).order_by(
                        ClientUpdateAttempt.requested_at)
                )).scalars().all())
                assert len(rows) == 2
                latest = next(row for row in rows if row.id != OLD_ATTEMPT)
                assert latest.release_id == NEW_RELEASE
                assert latest.target_version == "1.2.12"
                assert latest.state == "available"
        asyncio.run(verify())
        print("client update supersession: 12 assertions green")
    finally:
        asyncio.run(engine.dispose())
        DB_FILE.unlink(missing_ok=True)
        shutil.rmtree(ARTIFACT_ROOT, ignore_errors=True)


if __name__ == "__main__":
    main()
