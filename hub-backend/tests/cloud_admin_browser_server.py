"""Disposable full Hub + built admin UI for manual cloud management journeys.

Only Runner presence is synthetic. Login, permissions, registration, policy,
removal, audit and the compiled frontend use the production code. Loopback only;
never loads .env or a business database. Create <root>/stop to end the server.
"""
import asyncio
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import socket
import sys
import tempfile

ROOT = Path(sys.argv[1]).resolve()
assert ROOT.parent == Path(tempfile.gettempdir()).resolve()
assert ROOT.name.startswith("soduwork-cloud-admin-")
ROOT.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import config
from quality_gate import _isolated_env

for key in config.Settings.model_fields:
    os.environ.pop(key.upper(), None)
os.environ.update(_isolated_env(dict(os.environ), ROOT, 0, "cloud-admin-browser"))
USER, PASSWORD = "cloud-e2e-admin", "IsolatedCloudReview2026!"
settings = config.Settings(_env_file=None,
    auth_secret="isolated-cloud-admin-signing-key-never-production",
    admin_user=USER, admin_pass=PASSWORD, report_auto=False,
    repository_sync_interval_seconds=0)
config.get_settings = lambda: settings

import uvicorn
from sqlalchemy import select
from app import models
from app.main import app, lifespan as production_lifespan
from app.db import SessionLocal, engine
from app.automation_models import RunnerNode
from app.services import runner_hub, runner_registry


class PreviewSocket:
    async def close(self, code=1000):
        runner_hub._RUNNERS.pop("isolated-cloud-online", None)


class PreviewRunner(runner_hub._Runner):
    def alive(self):
        return True

    async def call(self, op, data, timeout=60):
        return {"ok": False, "error": "隔离验收节点：未连接真实执行进程；此操作未执行"}


@asynccontextmanager
async def lifespan(instance):
    async with production_lifespan(instance):
        async with SessionLocal() as session:
            user = await session.scalar(select(models.User).where(models.User.username == USER))
            for rid, name in (("isolated-cloud-online", "云端验收 · 在线节点"),
                              ("isolated-cloud-offline", "云端验收 · 待接入节点")):
                await runner_registry.issue_key(session, rid, host=name, org_id=user.org_id)
                row = await session.get(RunnerNode, rid)
                row.enroll_name = name
            live = PreviewRunner(PreviewSocket(), {
                "runnerId": "isolated-cloud-online", "host": "isolated-preview-host", "os": "Linux",
                "version": settings.version, "workRoot": str(ROOT / "workspace"),
                "maxConcurrent": 3, "caps": ["handoff1"],
                "capabilities": {"available": ["files", "terminal", "repository"]},
                "agents": [{"key": "pi", "name": "Pi", "auth": "authed"},
                           {"key": "codex", "name": "Codex", "auth": "unauthed"}],
            })
            live.org_id = user.org_id
            live.ready = live.inventory_ready = True
            runner_hub._RUNNERS[live.id] = live
            await runner_registry.record(session, live, force=True)
            await session.commit()
        ready = {"url": "http://127.0.0.1:" + str(PORT), "user": USER,
                 "password": PASSWORD, "stopFile": str(ROOT / "stop"),
                 "boundary": "Disposable DB and synthetic Runner; production login/API/admin UI"}
        (ROOT / "ready.json").write_text(json.dumps(ready, ensure_ascii=False), encoding="utf-8")
        print("E2E_READY " + json.dumps(ready, ensure_ascii=False), flush=True)
        yield
        runner_hub._RUNNERS.clear()
    await engine.dispose()


app.router.lifespan_context = lifespan


async def main():
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False))
    job = asyncio.create_task(server.serve(sockets=[sock]))
    while not job.done() and not (ROOT / "stop").exists():
        await asyncio.sleep(.25)
    server.should_exit = True
    await job


sock = socket.socket()
sock.bind(("127.0.0.1", 0))
PORT = sock.getsockname()[1]
asyncio.run(main())
