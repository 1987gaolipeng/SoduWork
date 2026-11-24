"""Disposable HTTP Hub for the admin locale/release browser acceptance test.

Production login, permission dependencies and release routers run against a fresh
SQLite database. No production lifespan, Runner, installer or remote service runs.
"""
import argparse
import base64
import hashlib
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import secrets
import socket
import sys
import tempfile

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

parser = argparse.ArgumentParser()
parser.add_argument("--root", required=True)
args = parser.parse_args()
root = Path(args.root).resolve()
if root.parent != Path(tempfile.gettempdir()).resolve() or not root.name.startswith("soduwork-admin-release-"):
    raise RuntimeError("Use a fresh soduwork-admin-release-* temporary directory")
if (root / ".smoke-admin-release.db").exists():
    raise RuntimeError("Refusing to reuse a fixture database")
repo = Path(__file__).resolve().parents[3]
os.chdir(root)
sys.path.insert(0, str(repo / "hub-backend"))
signing_key = Ed25519PrivateKey.generate()
public_key = base64.b64encode(signing_key.public_key().public_bytes_raw()).decode()
env = {
    "CLIENT_UPDATE_DIR": str(root / "releases"),
    "CLIENT_UPDATE_PUBLIC_KEYS": json.dumps({"fixture": public_key}),
    "DATABASE_URL": "sqlite+aiosqlite:///" + (root / ".smoke-admin-release.db").as_posix(),
    "AUTH_SECRET": secrets.token_urlsafe(40), "ADMIN_PASS": secrets.token_urlsafe(32),
    "SODUWORK_ENV": "development", "CLUSTER_REDIS_URL": "", "HUB_LOCAL_EXECUTION_ENABLED": "false",
    "SODUWORK_DATA_ROOT": str(root / "data"), "LIBRARY_STORAGE_BACKEND": "local",
    "LIBRARY_STORAGE_DIR": str(root / "library"), "POLL_INTERVAL_SECONDS": "0",
}
from app.config import Settings
Settings.model_config["env_file"] = None
for field in Settings.model_fields:
    os.environ.pop(field.upper(), None)
os.environ.update(env)
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from app.db import Base, engine, SessionLocal
from app.models import User, ClientRelease
from app.release_note_models import ClientReleaseNote
from app.auth import hash_password
from app.api import admin, client_updates, client_release_notes
from app.services import client_updates as contract
import uvicorn

requests = []


@asynccontextmanager
async def lifespan(app):
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with SessionLocal() as db:
        for name, privileged in (("fixture-publisher", True), ("fixture-reader", False)):
            db.add(User(id=name, username=name, display_name=name, is_super=privileged,
                        password_hash=hash_password("fixture-password-only")))
        for identity, platform, filename in (("fixture-release", "win32", "Fixture.exe"),
                                             ("fixture-deb", "linux", "Fixture.deb"),
                                             ("fixture-dmg", "darwin", "Fixture.dmg")):
            data = ("测试安装包 " + identity).encode()
            release = ClientRelease(
                id=identity, version="2.0.0", channel="stable", platform=platform, arch="x64",
                artifact_name=filename, artifact_path=f"{identity}/{filename}", artifact_size=len(data),
                sha256=hashlib.sha256(data).hexdigest(), enabled=True, key_id="fixture",
                mandatory=False, min_version="", notes="Legacy notes", created_by="fixture-publisher",
                created_at=datetime(2026, 1, 1, tzinfo=timezone.utc))
            release.signature = contract.sign(contract.manifest_payload(release),
                                              base64.b64encode(signing_key.private_bytes_raw()).decode())
            artifact = contract.release_root() / release.artifact_path
            artifact.parent.mkdir(parents=True, exist_ok=True)
            artifact.write_bytes(data)
            db.add(release)
        summaries = {"zh-CN": "中文发布说明", "en-US": "English release notes", "ja-JP": "日本語の更新内容", "ko-KR": "한국어 업데이트"}
        db.add(ClientReleaseNote(version="2.0.0", channel="stable", revision=1, status="published", locales={
            locale: {"summary": summary, "sections": [{"id": "fix", "title": "Fixes", "items": [{"id": "one", "text": "<img src=x onerror=alert(1)> literal text"}]}]}
            for locale, summary in summaries.items()}))
        await db.commit()
    (root / "ready.json").write_text(json.dumps({"origin": f"http://127.0.0.1:{port}"}), encoding="utf-8")
    yield
    await engine.dispose()


app = FastAPI(lifespan=lifespan)
app.include_router(admin.router)
app.include_router(client_updates.admin_router)
app.include_router(client_release_notes.admin_router)


@app.middleware("http")
async def record(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        requests.append({"method": request.method, "path": request.url.path, "status": response.status_code})
        (root / "requests.json").write_text(json.dumps(requests, indent=2), encoding="utf-8")
    return response


@app.get("/healthz")
async def health():
    return {"ok": True, "version": "fixture"}


app.mount("/", StaticFiles(directory=repo / "hub-frontend" / "dist", html=True), name="frontend")
sock = socket.socket()
sock.bind(("127.0.0.1", 0))
port = sock.getsockname()[1]
uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False)).run(sockets=[sock])
