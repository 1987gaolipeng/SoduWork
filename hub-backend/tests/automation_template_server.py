"""Disposable loopback Hub for the administrator/client template lifecycle test."""
import asyncio
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import secrets
import socket
import sys
import tempfile


async def serve(root):
    os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + (root / "test.db").as_posix()
    os.environ["AUTH_SECRET"] = "automation-fixture-" + secrets.token_hex(32)
    os.environ["CLUSTER_REDIS_URL"] = ""
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from fastapi import Depends, FastAPI
    import uvicorn
    from app import models
    from app.api.admin_schedules import template_router
    from app.api.personal_schedules import router
    from app.auth import sign_token
    from app.db import Base, SessionLocal, engine
    from app.deps import current_user
    from app.services import automation_templates, device_auth
    from app.services.rbac import user_to_api

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with SessionLocal() as db:
        db.add(models.User(id="fixture-admin", username="fixture-admin", is_super=True, is_active=True))
        db.add(models.User(id="fixture-member", username="fixture-member", is_active=True))
        db.add(models.Client(id="fixture-device", user_ref="fixture-admin", auth_state="active"))
        await db.commit()
        db.add(models.AiSchedule(id="fixture-existing", title="Existing automation", note="Keep my instructions",
                                owner_client_id="fixture-device", enabled=True, at_hour=18, at_minute=30))
        await automation_templates.save(db, [
            {"id": "daily-report", "name": "团队日报", "note": "整理今日进展和风险", "every": "daily",
             "atHour": 18, "atMinute": 30, "requiredCapabilities": ["office"],
             "nameLocales": {"en-US": "Daily report"}},
            {"id": "weekly-review", "name": "每周复盘", "note": "回顾本周工作", "every": "weekly"},
        ])
        await db.commit()
        device_token = device_auth.issue_session(await db.get(models.Client, "fixture-device"))[0]
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    token = sign_token("fixture-admin", ttl_hours=1)

    @asynccontextmanager
    async def lifespan(app):
        print(json.dumps({"ready": True, "fixtureOnly": True, "url": f"http://127.0.0.1:{port}",
                          "token": token, "deviceToken": device_token,
                          "memberToken": sign_token("fixture-member", ttl_hours=1)}), flush=True)
        yield
        await engine.dispose()

    app = FastAPI(lifespan=lifespan)
    app.include_router(template_router, prefix="/api/v1/admin")
    app.include_router(router, prefix="/api/v1")

    @app.get("/api/v1/admin/me")
    async def me(user=Depends(current_user)):
        return user_to_api(user)

    @app.get("/healthz")
    async def health():
        return {"ok": True}

    try:
        await uvicorn.Server(uvicorn.Config(app, log_level="warning")).serve(sockets=[sock])
    finally:
        sock.close()
        await engine.dispose()


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="soduwork-automation-template-") as directory:
        asyncio.run(serve(Path(directory)))
