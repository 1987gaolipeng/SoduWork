"""Disposable socket Hub for the desktop memory journey; never loads local .env."""
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
from contextlib import asynccontextmanager

ROOT = Path(sys.argv[1]).resolve()
assert ROOT.is_relative_to(Path(tempfile.gettempdir()).resolve())
assert ROOT.name.startswith("soduwork-memory-http-")
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "hub-backend"))

from app import config
from quality_gate import _isolated_env

# Remove inherited service configuration before constructing the isolated settings.
for key in config.Settings.model_fields:
    os.environ.pop(key.upper(), None)
os.environ.update(_isolated_env(dict(os.environ), ROOT, 0, "memory-http"))
settings = config.Settings(_env_file=None, auth_secret="isolated-memory-e2e-signing-key",
                           report_auto=False, repository_sync_interval_seconds=0)
config.get_settings = lambda: settings

import uvicorn
from sqlalchemy import func, select
from app.main import app, lifespan as production_lifespan
from app.db import SessionLocal, engine
from app import models
from app.services import device_auth
from app.session_memory_models import SessionMemory

requests = []
identities = []


@app.middleware("http")
async def observe(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/api/v1/session-memories"):
        requests.append({"method": request.method, "path": request.url.path,
                         "status": response.status_code})
    return response


@app.get("/__e2e/stats", include_in_schema=False)
async def stats():
    async with SessionLocal() as session:
        count = await session.scalar(select(func.count()).select_from(SessionMemory))
    return {"count": count, "requests": requests}


# The product app already mounted its static frontend at '/'.
app.router.routes.insert(0, app.router.routes.pop())


@asynccontextmanager
async def lifespan(instance):
    async with production_lifespan(instance):
        async with SessionLocal() as session:
            for index in (1, 2):
                uid, cid = f"e2e-memory-user-{index}", f"e2e-memory-device-{index}"
                user = await session.get(models.User, uid)
                if not user:
                    user = models.User(id=uid, username=uid, is_active=True)
                    session.add(user)
                device = await session.get(models.Client, cid)
                if not device:
                    device = models.Client(id=cid, name=cid,
                        secret_hash=device_auth.hash_secret("isolated-fixture"))
                    device_auth.activate(device, user)
                    session.add(device)
                identities.append({"clientId": cid, "session": device_auth.issue_session(device)[0]})
            await session.commit()
        # Readiness is a private parent/child pipe. Tokens never enter test reports.
        print("E2E_READY " + json.dumps({"port": PORT, "identities": identities}), flush=True)
        yield
    await engine.dispose()


app.router.lifespan_context = lifespan
sock = socket.socket()
sock.bind(("127.0.0.1", int(sys.argv[2]) if len(sys.argv) > 2 else 0))
PORT = sock.getsockname()[1]
server = uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False))
server.run(sockets=[sock])
