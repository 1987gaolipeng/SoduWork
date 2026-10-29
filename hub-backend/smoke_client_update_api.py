"""HTTP contract for signed full-client updates on an isolated SQLite DB."""
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

DB_FILE = Path(__file__).with_name(f".smoke-client-update-api-{os.getpid()}.db").resolve()
ARTIFACT_ROOT = Path(__file__).with_name(
    f".smoke-client-update-artifacts-{os.getpid()}").resolve()
DB_FILE.unlink(missing_ok=True)
shutil.rmtree(ARTIFACT_ROOT, ignore_errors=True)
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB_FILE.as_posix()
os.environ["DB_MIGRATION_MODE"] = "auto"
os.environ["CLIENT_UPDATE_DIR"] = ARTIFACT_ROOT.as_posix()
os.environ["CLIENT_UPDATE_PUBLIC_KEYS"] = json.dumps(
    {"keys": {"smoke-key": PUBLIC_KEY}}
)

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal, engine, init_db
from app.main import app
from app import automation_models as am
from app.models import Client, ClientRelease, ClientUpdateAttempt, User
from app.services import client_updates as updates
from app.services import device_auth
from app.services import update_safety


DEVICE = "soduwork-smoke-update"
SECRET = "u" * 43


async def seed() -> tuple[str, str]:
    await init_db()
    async with SessionLocal() as session:
        user = User(id="12345678-1234-4234-8234-123456789001",
                    username="update-smoke", display_name="升级测试")
        client = Client(
            id=DEVICE, secret_hash=device_auth.hash_secret(SECRET), auth_state="active",
            user_ref=user.id, app_version="1.2.10", last_seen_at=datetime.now(timezone.utc),
        )
        artifact = ARTIFACT_ROOT / "stable/win32/x64/1.2.11/SoduWork-1.2.11-Setup.exe"
        artifact.parent.mkdir(parents=True, exist_ok=True)
        artifact.write_bytes((b"SODUWORK-UPDATE-SMOKE\n" * 120000)[:2 * 1024 * 1024])
        release = ClientRelease(
            id="12345678-1234-4234-8234-123456789abc",
            version="1.2.11", channel="stable", platform="win32", arch="x64",
            artifact_name="SoduWork-1.2.11-Setup.exe",
            artifact_path="stable/win32/x64/1.2.11/SoduWork-1.2.11-Setup.exe",
            artifact_size=artifact.stat().st_size, sha256=updates.sha256_file(artifact),
            signature="", key_id="smoke-key", notes="安全升级", enabled=True,
        )
        runner = am.RunnerNode(
            id="runner-update-smoke", client_id=DEVICE, host="smoke-client",
            tags=["soduwork-client"], dispatch_mode="accepting", busy=1,
        )
        execution = am.ExecutionSession(
            id="12345678-1234-4234-8234-123456789def",
            task_id="task-update-smoke", ref="runner:update-smoke",
            runner_id=runner.id, runner_client_id=DEVICE,
            engine="pi", state="running", started_at=datetime.now(timezone.utc),
        )
        session.add_all([user, client, release, runner, execution])
        await session.flush()
        await session.refresh(release)
        release.signature = updates.sign(updates.manifest_payload(release), PRIVATE_KEY)
        await session.commit()
    return PUBLIC_KEY, PRIVATE_KEY


def auth_headers(client: TestClient) -> dict:
    enrolled = client.post("/api/v1/clients/enroll", json={"device": DEVICE},
                           headers={"X-Device-Key": SECRET})
    assert enrolled.status_code == 200, enrolled.text
    token = enrolled.json()["session"]
    return {"Authorization": "Device " + token}


def main() -> None:
    asyncio.run(seed())
    update_safety.QUIESCE_SECONDS = 0
    with TestClient(app) as client:
        headers = auth_headers(client)
        bad = client.get("/api/v1/client-updates/check?current=bad", headers=headers)
        assert bad.status_code == 400
        res = client.get(
            "/api/v1/client-updates/check?current=1.2.10&platform=win32&arch=x64",
            headers=headers,
        )
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["hasUpdate"] is True
        assert body["manifest"]["version"] == "1.2.11"
        artifact = client.get(
            "/api/v1/client-updates/artifacts/12345678-1234-4234-8234-123456789abc",
            headers=headers,
        )
        assert artifact.status_code == 200
        resumed = client.get(
            "/api/v1/client-updates/artifacts/12345678-1234-4234-8234-123456789abc",
            headers={**headers, "Range": "bytes=1024-2047"},
        )
        assert resumed.status_code == 206, resumed.text[:200]
        assert len(resumed.content) == 1024
        assert resumed.headers.get("content-range", "").startswith("bytes 1024-2047/")
        attempt = body["attemptId"]
        for state, progress in [("downloading", 20), ("downloaded", 100)]:
            event = client.post(
                f"/api/v1/client-updates/attempts/{attempt}/events",
                headers=headers,
                json={"state": state, "progress": progress,
                      "currentVersion": "1.2.11" if state == "installed" else "1.2.10"},
            )
            assert event.status_code == 200, event.text
        waiting = client.post(
            f"/api/v1/client-updates/attempts/{attempt}/prepare", headers=headers,
            json={"blockers": [{
                "kind": "local-conversation", "title": "本机直接会话正在收尾",
                "state": "running",
            }]},
        )
        assert waiting.status_code == 200, waiting.text
        assert waiting.json()["safe"] is False
        assert waiting.json()["attempt"]["state"] == "waiting"
        assert waiting.json()["blockers"][0]["kind"] == "runner-session"
        maintenance = waiting.json()["attempt"]["detail"][update_safety.DETAIL_KEY]
        assert maintenance["safe"] is False
        assert maintenance["blockerCount"] == 2
        assert maintenance["blockers"][0]["title"] == "正在执行的任务"
        assert maintenance["blockers"][1]["title"] == "本机直接会话正在收尾"
        assert maintenance["blockers"][1]["source"] == "client"
        assert maintenance["runnerIds"] == ["runner-update-smoke"]

        async def finish_execution():
            async with SessionLocal() as session:
                execution = await session.get(
                    am.ExecutionSession, "12345678-1234-4234-8234-123456789def")
                execution.state = "done"
                execution.finished_at = datetime.now(timezone.utc)
                await session.commit()
        asyncio.run(finish_execution())
        ready = client.post(
            f"/api/v1/client-updates/attempts/{attempt}/prepare", headers=headers,
        )
        assert ready.status_code == 200, ready.text
        assert ready.json()["safe"] is True
        ready_maintenance = ready.json()["attempt"]["detail"][update_safety.DETAIL_KEY]
        assert ready_maintenance["safe"] is True
        assert ready_maintenance["blockerCount"] == 0
        assert ready_maintenance["blockers"] == []

        for state in ("installing", "installed"):
            event = client.post(
                f"/api/v1/client-updates/attempts/{attempt}/events",
                headers=headers,
                json={"state": state, "progress": 100,
                      "currentVersion": "1.2.11" if state == "installed" else "1.2.10"},
            )
            assert event.status_code == 200, event.text
        current = client.get("/api/v1/client-updates/check?current=1.2.11", headers=headers)
        assert current.status_code == 200 and current.json()["hasUpdate"] is False
        old = client.get("/api/v1/updates/check?current=1.2.8")
        assert old.status_code == 200 and old.json().get("retired") is True
    async def verify():
        async with SessionLocal() as session:
            row = (await session.execute(select(ClientUpdateAttempt))).scalars().one()
            assert row.state == "installed" and row.progress == 100
            assert update_safety.DETAIL_KEY not in (row.detail or {})
            device = await session.get(Client, DEVICE)
            assert device.app_version == "1.2.11"
            runner = await session.get(am.RunnerNode, "runner-update-smoke")
            assert runner.dispatch_mode == "accepting"
    asyncio.run(verify())
    asyncio.run(engine.dispose())
    DB_FILE.unlink(missing_ok=True)
    shutil.rmtree(ARTIFACT_ROOT, ignore_errors=True)
    print("client update API: 38 assertions green")


if __name__ == "__main__":
    main()
