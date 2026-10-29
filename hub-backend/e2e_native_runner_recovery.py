"""Actual Electron-owned Runner restart against a disposable loopback Hub.

No installed application, real user profile, external Hub, or model is used.
The Electron fixture configures the production lifecycle once; only that
lifecycle owns starting and restarting its real Python Runner subprocess.
"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time


async def run(root):
    # Import settings before any DB/service imports, and explicitly bypass .env.
    from app import config
    from quality_gate import _isolated_env
    for key in config.Settings.model_fields:
        os.environ.pop(key.upper(), None)
    os.environ.update(_isolated_env(dict(os.environ), root, 0, "native-runner-recovery"))
    settings = config.Settings(_env_file=None,
        database_url="sqlite+aiosqlite:///" + (root / "fixture.db").as_posix(),
        auth_secret="isolated-native-runner-recovery-signing-key", cluster_redis_url="",
        report_auto=False, repository_sync_interval_seconds=0)
    config.get_settings = lambda: settings

    from fastapi import FastAPI
    import uvicorn
    from app import models, automation_models
    from app.db import Base, engine, SessionLocal
    from app.api import runner_ws, agents, tasks
    from app.services import device_auth, runner_hub

    backend = Path(__file__).resolve().parent
    client = backend.parent / "client"
    electron = client / "node_modules/electron/dist" / ("electron.exe" if os.name == "nt" else "electron")
    assert electron.is_file(), "Install client Electron dependency before running this isolated check"
    secret = "native-recovery-fixture-secret-" + "x" * 32
    app = FastAPI()
    app.include_router(runner_ws.router)
    app.include_router(agents.router)
    app.include_router(tasks.router)

    @app.get("/__fixture/state")
    async def state():
        current = runner_hub.for_client("fixture-recovered-device")
        async with SessionLocal() as session:
            old = await session.get(automation_models.RunnerNode, "legacy-native-fixture-runner")
            return dict(legacyOwner=old.client_id, recoveredId=current.id if current else "")

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with SessionLocal() as session:
        session.add(models.User(id="fixture-user", username="native-runner-recovery", is_active=True))
        for cid in ("fixture-old-device", "fixture-recovered-device"):
            session.add(models.Client(id=cid, name="Native recovery fixture", user_ref="fixture-user",
                auth_state="active", secret_hash=device_auth.hash_secret(secret)))
        session.add(automation_models.RunnerNode(id="legacy-native-fixture-runner",
            client_id="fixture-old-device", dispatch_mode="accepting"))
        await session.commit()
        token, _ = device_auth.issue_session(await session.get(models.Client, "fixture-recovered-device"))

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    base = "http://127.0.0.1:" + str(sock.getsockname()[1])
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False))
    serving = asyncio.create_task(server.serve(sockets=[sock]))
    while not server.started:
        if serving.done():
            await serving
        await asyncio.sleep(0.02)

    data = root / "electron-profile/runner/data"
    data.mkdir(parents=True)
    (data / "runner-id").write_text("legacy-native-fixture-runner", encoding="utf-8")
    profile = root / "os-profile"
    profile.mkdir()
    fixture = root / "fixture.json"
    fixture.write_text(json.dumps(dict(root=str(root), hub=base, clientId="fixture-recovered-device",
        secret=secret, session=token, startedAt=int(time.time() * 1000))), encoding="utf-8")
    env = {key: value for key, value in os.environ.items() if not key.upper().startswith(("SODUWORK_", "SODUWORK_"))}
    for key in ("PI_CODING_AGENT_DIR", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "PYTHONPATH",
                "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        env.pop(key, None)
    env.update(PYTHONUTF8="1", PYTHONIOENCODING="utf-8", HOME=str(profile), USERPROFILE=str(profile),
        APPDATA=str(profile / "AppData/Roaming"), LOCALAPPDATA=str(profile / "AppData/Local"),
        NO_PROXY="*", SODUWORK_DATA_ROOT=str(data),
        SODUWORK_BUNDLED_PI_CLI=str(client / "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
        SODUWORK_BUNDLED_NODE=shutil.which("node") or "")
    child = None
    try:
        with (root / "electron.log").open("wb") as log:
            options = ["--no-sandbox"]
            if sys.platform.startswith("linux") and not env.get("DISPLAY"):
                options.append("--ozone-platform=headless")
            child = await asyncio.create_subprocess_exec(str(electron), *options,
                str(client / "e2e/fixtures/runner-recovery-electron.cjs"), str(fixture), cwd=root, env=env,
                stdout=log, stderr=log,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        code = await asyncio.wait_for(child.wait(), 260)
        print((root / "electron.log").read_text(encoding="utf-8", errors="replace"), flush=True)
        assert code == 0, f"Electron fixture exited {code}; inspect isolated evidence directory"
        assert not (root / "native-error.json").exists(), (root / "native-error.json").read_text(encoding="utf-8")
        result = json.loads((root / "native-result.json").read_text(encoding="utf-8"))
        assert result["ok"] and result["configureCalls"] == 1
        assert result["initialPid"] != result["recoveredPid"] and result["connected"]["connected"]
        for _ in range(200):
            if not runner_hub.for_client("fixture-recovered-device"):
                break
            await asyncio.sleep(0.1)
        assert not runner_hub.for_client("fixture-recovered-device"), "Electron quit must stop its Runner"
        print("PASS Electron quit disconnects the owned Runner without touching other applications", flush=True)
    finally:
        if child and child.returncode is None:
            # Kill only this freshly created fixture tree, never a shared app.
            if os.name == "nt":
                subprocess.run(["taskkill.exe", "/PID", str(child.pid), "/T", "/F"],
                    capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
            else:
                child.terminate()
            await asyncio.wait_for(child.wait(), 15)
        server.should_exit = True
        await asyncio.wait_for(serving, 15)
        await engine.dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix=".smoke-native-runner-recovery-", dir=args.output.resolve()))
    print("Fixture evidence: " + str(root), flush=True)
    asyncio.run(run(root))
