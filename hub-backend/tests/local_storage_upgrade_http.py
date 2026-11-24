"""Verify a restored legacy uploads volume through a real Hub on loopback.

Run from the backend environment: python tests/local_storage_upgrade_http.py
The seed prepares the documented legacy flat layout and synthetic ownership rows.
Each Hub boot uses its normal lifespan and the same relocated database and volume.
"""
import asyncio
from contextlib import asynccontextmanager
import hashlib
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile

import httpx
import uvicorn

SCRIPT = Path(__file__).resolve()
BACKEND = SCRIPT.parents[1]
TASK = "storage-upgrade-task"
DEVICE = "storage-upgrade-device"
OWNER = "storage-upgrade-owner"
FRESH_NAME = "new-notes.txt"
FRESH_BYTES = b"uploaded after migration\n"
UPLOADS = Path("uploads")
API = "/api/v1/attachments/"
TASK_FILES = f"/api/v1/tasks/{TASK}/attachments"


def historical_objects():
    # Linux exercises two distinct case-sensitive on-disk objects. Other hosts
    # can restore ordinary files even when their volume is case-insensitive.
    second = "report.txt" if sys.platform.startswith("linux") else "agenda.txt"
    return (("first-row", "Report.txt", b"first historical document\n"),
            ("second-row", second, b"second historical document\n"))


def historical_key(name):
    return f"att/{TASK}/imported/{name}"


def v2_path(key):
    return UPLOADS / "objects-v2" / hashlib.sha256(key.encode("utf-8")).hexdigest()


async def seed():
    from app import db, models

    await db.init_db()
    UPLOADS.mkdir()
    paths = []
    async with db.SessionLocal() as session:
        session.add(models.User(id=OWNER, username=OWNER))
        session.add(models.Client(id=DEVICE, user_ref=OWNER, auth_state="active"))
        session.add(models.Task(id=TASK, title="Upgrade fixture", owner_client_id=DEVICE,
                                owner_user_id=OWNER, created_by=OWNER))
        for aid, name, data in historical_objects():
            key = historical_key(name)
            path = UPLOADS / key.replace("/", "__")
            with path.open("xb") as output:
                output.write(data)
            paths.append(path)
            session.add(models.Attachment(id=aid, task_id=TASK, filename=name, size=len(data),
                                          content_type="text/plain", uploaded_by=DEVICE,
                                          storage_key=key, backend="local"))
        await session.commit()
    assert not paths[0].samefile(paths[1]), "Expected two independent legacy files"
    await db.engine.dispose()


@asynccontextmanager
async def running_hub():
    from app.services import storage
    from app.main import app

    storage._LOCAL_DIR = str(UPLOADS.resolve())
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        server = uvicorn.Server(uvicorn.Config(app, access_log=False, log_level="warning"))
        serving = asyncio.create_task(server.serve(sockets=[listener]))
        try:
            async with asyncio.timeout(90):
                while not server.started:
                    if serving.done():
                        await serving
                        raise RuntimeError("Hub startup failed")
                    await asyncio.sleep(0.05)
            yield f"http://127.0.0.1:{listener.getsockname()[1]}"
        finally:
            server.should_exit = True
            await serving


async def download(client, aid, expected):
    ticket = (await client.post(API + aid + "/access")).raise_for_status().json()
    response = await client.get(ticket["url"])
    assert response.raise_for_status().content == expected, aid


async def verify(upgrade):
    from app import db, models
    from app.services import device_auth

    async with running_hub() as url:
        async with db.SessionLocal() as session:
            token, _ = device_auth.issue_session(await session.get(models.Client, DEVICE))
        async with httpx.AsyncClient(base_url=url, trust_env=False, timeout=30,
                                     headers={"Authorization": "Device " + token}) as client:
            rows = historical_objects()
            surviving = rows if upgrade else rows[1:]
            for aid, name, data in surviving:
                key = historical_key(name)
                await download(client, aid, data)
                assert v2_path(key).read_bytes() == data
                assert not (UPLOADS / key.replace("/", "__")).exists()
            removed_id, removed_name, _ = rows[0]
            if upgrade:
                response = await client.post(TASK_FILES, files={"file": (FRESH_NAME, FRESH_BYTES, "text/plain")})
                fresh_id = response.raise_for_status().json()["id"]
                await download(client, fresh_id, FRESH_BYTES)
                (await client.delete(API + removed_id)).raise_for_status()
            assert (await client.post(API + removed_id + "/access")).status_code == 404
            assert not v2_path(historical_key(removed_name)).exists()
            listing = (await client.get(TASK_FILES)).raise_for_status().json()
            assert len(listing) == 2 and {r["filename"] for r in listing} == {rows[1][1], FRESH_NAME}
            fresh_id = next(r["id"] for r in listing if r["filename"] == FRESH_NAME)
            await download(client, fresh_id, FRESH_BYTES)
            await download(client, rows[1][0], rows[1][2])
            if not upgrade:
                (await client.delete(API + fresh_id)).raise_for_status()
                assert (await client.post(API + fresh_id + "/access")).status_code == 404
                await download(client, rows[1][0], rows[1][2])
    await db.engine.dispose()


def main():
    # Each subprocess loads settings in a clean directory with its own DB and
    # storage. Clean exit closes SQLite before copying the original backup.
    env = {k: v for k, v in os.environ.items() if k.upper() in {
        "PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "APPDATA", "LOCALAPPDATA",
        "USERPROFILE", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "LD_LIBRARY_PATH"}}
    env.update(PYTHONPATH=str(BACKEND), PYTHONUTF8="1", SODUWORK_ENV="test",
               AUTH_SECRET=secrets.token_hex(32), ADMIN_PASS=secrets.token_urlsafe(32),
               DEVICE_AUTH_COMPAT="false", HUB_LOCAL_EXECUTION_ENABLED="false")
    with tempfile.TemporaryDirectory(prefix="soduwork-storage-upgrade-") as tmp:
        original = Path(tmp) / "old"
        relocated = Path(tmp) / "restored"
        original.mkdir()
        for stage, directory in (("seed", original), ("upgrade", relocated), ("restart", relocated)):
            if stage == "upgrade":
                shutil.copytree(original, relocated)
            env.update(DATABASE_URL="sqlite+aiosqlite:///" + (directory / "hub.db").as_posix(),
                       SODUWORK_DATA_ROOT=str(directory / "data"))
            subprocess.run([sys.executable, str(SCRIPT), stage], cwd=directory, env=env, check=True, timeout=150)
        for _, name, data in historical_objects():
            backup_file = original / UPLOADS / historical_key(name).replace("/", "__")
            assert backup_file.read_bytes() == data
    print(f"{sys.platform}: two legacy files restored, HTTP upload and deletion passed, "
          "surviving bytes and original backup verified after restart")


if __name__ == "__main__":
    if len(sys.argv) == 1:
        main()
    else:
        stage = sys.argv[1]
        if stage not in {"seed", "upgrade", "restart"}:
            raise ValueError(f"Unknown stage: {stage}")
        asyncio.run(seed() if stage == "seed" else verify(upgrade=stage == "upgrade"))
