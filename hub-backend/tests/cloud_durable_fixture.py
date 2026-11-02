"""Private subprocess roles for the real-WebSocket cloud durability acceptance."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import socket
import sys
import time

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
CONTROL = Path(sys.argv[2]).resolve()


def dependency_versions():
    import fastapi
    import starlette
    import pydantic
    return {"fastapi": fastapi.__version__, "starlette": starlette.__version__,
            "pydantic": pydantic.__version__}


async def hub():
    from app import config
    for key in config.Settings.model_fields:
        os.environ.pop(key.upper(), None)
    settings = config.Settings(_env_file=None,
        database_url="sqlite+aiosqlite:///" + (CONTROL / "hub.db").as_posix(),
        auth_secret="isolated-cloud-durable-e2e-not-a-production-key",
        cluster_redis_url="", redis_url="", minio_endpoint="", db_migration_mode="auto",
        report_auto=False, repository_sync_interval_seconds=0,
        hub_local_execution_enabled=False, device_auth_compat=False)
    config.get_settings = lambda: settings
    from sqlalchemy import func, select
    from app import db, models, automation_models as am
    from app.services import device_auth, runner_registry, runner_hub, storage, model_catalog
    from app.main import app
    from unittest.mock import AsyncMock
    import uvicorn

    storage._LOCAL_DIR = str(CONTROL / "hub-objects")
    # Only the vendor model-configuration boundary is synthetic. All scheduling,
    # authentication, socket delivery, event storage and settlement are real.
    model_catalog.resolve = AsyncMock(return_value={
        "base": "http://127.0.0.1:1/v1", "key": "fixture-only", "model": "fixture-model"})
    await db.init_db()
    async with db.SessionLocal() as session:
        user = models.User(id="fixture-owner", username="cloud-durable-fixture",
                           org_id="fixture-org", is_active=True)
        client = models.Client(id="fixture-device", user_ref=user.id, auth_state="active")
        session.add_all([models.OrgUnit(id="fixture-org", name="Isolated fixture organization"), user, client])
        await session.flush()
        key = await runner_registry.issue_key(session, "fixture-cloud", org_id="fixture-org",
                                              owner_user_id=user.id)
        await session.commit()
        token = device_auth.issue_session(client)[0]

    requests = []
    @app.middleware("http")
    async def record_requests(request, call_next):
        requests.append({"method": request.method, "path": request.url.path})
        return await call_next(request)

    @app.get("/__fixture/state")
    async def state():
        live = runner_hub.get("fixture-cloud")
        async with db.SessionLocal() as session:
            row = await session.scalar(select(am.ExecutionSession).order_by(
                am.ExecutionSession.created_at.desc()).limit(1))
            count = await session.scalar(select(func.count()).select_from(am.ExecutionEvent))
            attachments = (await session.scalars(select(models.Attachment))).all()
            return {"runnerOnline": bool(live and live.ready),
                "caps": getattr(live, "caps", []),
                "available": (getattr(live, "capabilities", {}) or {}).get("available", []),
                "state": row.state if row else "", "seq": row.seq if row else 0,
                "persistedThrough": row.persisted_seq if row else 0,
                "deliverySeq": row.delivery_seq if row else 0,
                "metadata": row.metadata_ if row else {}, "eventCount": count,
                "attachments": [a.filename for a in attachments],
                "statusReads": sum("ai-status" in item["path"] for item in requests)}

    @app.post("/__fixture/disconnect")
    async def disconnect():
        live = runner_hub.get("fixture-cloud")
        assert live is not None
        await live.ws.close(code=1012)
        return {"ok": True}

    # The production SPA catch-all is already mounted. Private fixture routes
    # must precede that mount, without changing production route registration.
    fixture_routes = [route for route in app.router.routes
                      if str(getattr(route, "path", "")).startswith("/__fixture/")]
    app.router.routes = fixture_routes + [route for route in app.router.routes if route not in fixture_routes]

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    base = "http://127.0.0.1:%s" % sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False))
    serving = asyncio.create_task(server.serve(sockets=[sock]))
    try:
        while not server.started:
            if serving.done():
                await serving
                raise RuntimeError("Fixture Hub failed to start")
            await asyncio.sleep(.05)
        (CONTROL / "ready.json").write_text(json.dumps({
            "hub": base, "token": token, "runnerKey": key,
            "dependencies": dependency_versions()}), encoding="utf-8")
        while not (CONTROL / "hub-stop").exists() and not serving.done():
            await asyncio.sleep(.1)
    finally:
        server.should_exit = True
        await serving
        (CONTROL / "requests.json").write_text(json.dumps(requests), encoding="utf-8")
        await db.engine.dispose()


async def runner():
    from app.services import local_base, local_process, local_stream, runner_admission
    import runner_main
    (CONTROL / "runner-dependencies.json").write_text(json.dumps(dependency_versions()), encoding="utf-8")
    ready = json.loads((CONTROL / "ready.json").read_text(encoding="utf-8"))
    profile = local_base._PROFILES["codex"]
    profile["bin"] = lambda: sys.executable
    profile.pop("runtime_probe", None)
    profile.pop("runtime_issue", None)
    def command(_exe, args, workspace, _cfg, _profile):
        workspace = Path(workspace)
        (workspace / "hold-process").write_text("fixture", encoding="utf-8")
        (CONTROL / "launched.json").write_text(json.dumps({"workspace": str(workspace)}), encoding="utf-8")
        return [sys.executable, str(Path(__file__).with_name("handoff_vendor_peer.py")), "codex", *args]
    local_process._command_argv = command
    local_process._env_for = lambda *_args, **_kwargs: dict(os.environ)
    local_stream._llm_gate_check = lambda *_args: ""
    (CONTROL / "runner-work").mkdir(parents=True, exist_ok=True)
    machine = runner_main.Runner(ready["hub"], "", "", "fixture-cloud",
                                str(CONTROL / "runner-work"), key=ready["runnerKey"])
    machine._agent_inventory = [{"key": "codex", "name": "Synthetic Codex",
                                 "auth": "authed", "version": "fixture-1.0"}]
    machine._agent_inventory_at = machine._skill_inventory_at = time.monotonic()
    async def no_discovery(*_args, **_kwargs):
        return None
    machine._refresh_agents = machine._refresh_skills = no_discovery
    machine._resource_budget.snapshot = lambda **_: runner_admission.ResourceSnapshot(
        limit=2, cpu_count=4, can_start=True)
    async def stop():
        while not (CONTROL / "runner-stop").exists():
            await asyncio.sleep(.1)
        machine._shutdown_event.set()
        if machine.ws:
            await machine.ws.close()
    stopping = asyncio.create_task(stop())
    try:
        await machine.run()
    finally:
        stopping.cancel()
        for ref in list(local_base._RUNS):
            await asyncio.to_thread(local_stream.stop_sync, {}, ref)
        machine._admission._journal.close()


def observer():
    import httpx
    ready = json.loads((CONTROL / "ready.json").read_text(encoding="utf-8"))
    with httpx.Client(base_url=ready["hub"], trust_env=False, timeout=90,
                      headers={"Authorization": "Device " + ready["token"]}) as client:
        reply = client.post("/api/v1/cloud-conversations/fixture-request", data={"options": json.dumps({
            "sessionId": "fixture-session", "agentId": "codex", "model": "",
            "text": "CLOUD_NEW_TEST: write a short delivery.md report.",
            "title": "Durable independent cloud fixture", "targetRunnerId": "fixture-cloud"})})
        assert reply.is_success, reply.text
        (CONTROL / "accepted.json").write_text(json.dumps(reply.json()), encoding="utf-8")


def reader():
    import httpx
    ready = json.loads((CONTROL / "ready.json").read_text(encoding="utf-8"))
    with httpx.Client(base_url=ready["hub"], trust_env=False, timeout=30,
                      headers={"Authorization": "Device " + ready["token"]}) as client:
        listing = client.get("/api/v1/cloud-execution-sync")
        listing.raise_for_status()
        rows = listing.json()["items"]
        assert len(rows) == 1, rows
        page = client.get("/api/v1/cloud-execution-sync/" + rows[0]["id"])
        page.raise_for_status()
        result = page.json()
        assert result["page"]["status"] == "done", result
        assert result["page"]["items"], result
        delivered = next(item for item in result["attachments"] if item["filename"] == "delivery.md")
        download = client.get(delivered["url"])
        download.raise_for_status()
        assert download.content == ("# Delivered from independent cloud workspace" + os.linesep).encode("utf-8")
        assert hashlib.sha256(download.content).hexdigest() == delivered["sha256"]
        library = client.get("/api/v1/deliveries")
        library.raise_for_status()
        assert library.json()["items"] == [], "Durable attachments must not auto-save to library"
        (CONTROL / "cold-reader.json").write_text(json.dumps(result), encoding="utf-8")


if __name__ == "__main__":
    role = sys.argv[1]
    if role == "hub":
        asyncio.run(hub())
    elif role == "runner":
        asyncio.run(runner())
    elif role == "observer":
        observer()
    elif role == "reader":
        reader()
    else:
        raise ValueError("Unknown fixture role")
