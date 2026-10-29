"""Real Hub websocket + child Runner + Pi, with isolated DB/files and loopback model.

Run with the backend venv; optional --runner-exe validates the frozen artifact.
No live accounts, production Hub, paid model, or user workspace is used.
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


async def run(root, executable=None):
    os.environ.update(DATABASE_URL="sqlite+aiosqlite:///" + (root / "test.db").as_posix(),
                      AUTH_SECRET="isolated-runner-recovery-fixture-secret", CLUSTER_REDIS_URL="",
                      SODUWORK_DATA_ROOT=str(root / "hub-data"), SODUWORK_ENV="development")
    from fastapi import FastAPI, Request
    from fastapi.responses import StreamingResponse
    import httpx
    import uvicorn
    from app import models, automation_models
    from app.db import Base, engine, SessionLocal
    from app.api import runner_ws, agents, tasks
    from app.services import device_auth, runner_hub

    backend = Path(__file__).resolve().parent
    client = backend.parent / "client"
    app = FastAPI()
    app.include_router(runner_ws.router)
    app.include_router(agents.router)
    app.include_router(tasks.router)
    model_requests = []

    @app.post("/v1/chat/completions")
    async def completion(request: Request):
        body = await request.json()
        model_requests.append(body.get("model"))
        used_tool = any(m.get("role") == "tool" for m in body.get("messages", []))
        if used_tool:
            delta, finish = {"role": "assistant", "content": "RUNNER_RECOVERY_OK"}, "stop"
        else:
            delta, finish = {"role": "assistant", "tool_calls": [{"index": 0, "id": "fixture-write",
                "type": "function", "function": {"name": "write", "arguments": json.dumps({
                    "path": "recovery-result.txt", "content": "RUNNER_RECOVERY_OK"})}}]}, "tool_calls"
        messages = []
        for content, end in [(delta, None), ({}, finish)]:
            messages.append("data: " + json.dumps({"id": "fixture", "object": "chat.completion.chunk",
                "created": 1, "model": "recovery-fixture", "choices": [{"index": 0, "delta": content,
                "finish_reason": end}]}) + "\n\n")
        return StreamingResponse(iter(messages + ["data: [DONE]\n\n"]), media_type="text/event-stream")

    secret = "recovery-fixture-secret-" + "x" * 32
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with SessionLocal() as session:
        session.add(models.User(id="fixture-user", username="runner-recovery-fixture", is_active=True))
        for cid in ("fixture-old-device", "fixture-recovered-device"):
            session.add(models.Client(id=cid, name="Recovery fixture", user_ref="fixture-user",
                                      auth_state="active", secret_hash=device_auth.hash_secret(secret)))
        session.add(automation_models.RunnerNode(id="legacy-fixture-runner", client_id="fixture-old-device",
                                                dispatch_mode="accepting"))
        await session.commit()
        api_session, _ = device_auth.issue_session(await session.get(models.Client, "fixture-recovered-device"))
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    base = "http://127.0.0.1:" + str(sock.getsockname()[1])
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False))
    serving = asyncio.create_task(server.serve(sockets=[sock]))
    while not server.started:
        if serving.done():
            await serving
        await asyncio.sleep(0.02)

    data = root / "runner-data"
    data.mkdir()
    (data / "runner-id").write_text("legacy-fixture-runner", encoding="utf-8")
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8", HOME=str(root / "profile"),
               USERPROFILE=str(root / "profile"), SODUWORK_DATA_ROOT=str(data),
               SODUWORK_BUNDLED_PI_CLI=str(client / "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
               SODUWORK_BUNDLED_NODE=shutil.which("node") or "", SODUWORK_DEVICE_SECRET=secret,
               SODUWORK_SKILL_ROOTS=str(root / "skills"))
    for key in ("SODUWORK_HUB", "SODUWORK_RUNNER_ID", "SODUWORK_RUNNER_KEY", "SODUWORK_RUNNER_TOKEN",
                "PI_CODING_AGENT_DIR", "SODUWORK_PROXY_KEY", "SODUWORK_MCP_KEY", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE",
                "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        env.pop(key, None)
    config = dict(hub=base, clientId="fixture-recovered-device", dataRoot=str(data),
                  workRoot=str(root / "work"), tags=["soduwork-client"], capabilityGrants=[])
    processes, readers, statuses = [], [], []

    async def start(label):
        command = [str(executable)] if executable else [sys.executable, str(backend / "runner_main.py")]
        with (root / (label + ".stderr.log")).open("wb") as errors:
            child = await asyncio.create_subprocess_exec(*command, "--config-stdin", cwd=root, env=env,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=errors,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        processes.append(child)
        async def read():
            async for line in child.stdout:
                prefix = b"@@SODUWORK_RUNNER_STATUS@@"
                if line.startswith(prefix):
                    statuses.append(json.loads(line[len(prefix):]))
        readers.append(asyncio.create_task(read()))
        child.stdin.write(("@@SODUWORK_RUNNER_CONFIG@@" + json.dumps(config) + "\n").encode())
        await child.stdin.drain()
        return child

    try:
        first = await start("first")
        assert await asyncio.wait_for(first.wait(), 40) == 0, "conflict must request a clean restart"
        assert any(s.get("code") == "IDENTITY_CONFLICT" for s in statuses)
        print("PASS real Runner recognizes persisted device conflict and exits for recovery", flush=True)
        current = await start("recovered")
        runner = None
        for _ in range(120):
            runner = runner_hub.for_client("fixture-recovered-device")
            if runner and runner.ready and runner.inventory_ready and runner.agents:
                break
            if current.returncode is not None:
                raise AssertionError("recovered Runner exited: " + (root / "recovered.stderr.log").read_text(errors="replace")[-2500:])
            await asyncio.sleep(0.25)
        assert runner and runner.ready and runner.agents, "Runner must advertise real installed Agents"
        assert runner.id != "legacy-fixture-runner"
        async with httpx.AsyncClient(base_url=base, headers={"X-Soduwork-Device": "fixture-recovered-device",
                                                         "Authorization": "Device " + api_session}, timeout=40, trust_env=False) as api:
            setup = await api.get("/api/v1/agent-setup")
            roster = await api.get("/api/v1/ai-agents")
            assert setup.status_code == 200 and roster.status_code == 200, (setup.status_code, roster.status_code)
            assert setup.json()["machines"] and setup.json()["agents"]
            assert any(a.get("cli") == "pi" for a in roster.json()["agents"]), roster.json()
        print("PASS Agent management and automation roster discover recovered local Pi", flush=True)
        result = await runner.call("job.dispatch", dict(cli="pi", dispatchId="fixture-recovery-dispatch",
            task=dict(id="fixture-recovery-task", title="Recovery verification", note="write recovery-result.txt"),
            cfg=dict(local_cli="pi", llm=dict(base=base + "/v1", key="loopback-fixture", model="recovery-fixture")),
            ctx=dict(workspace=dict(workRoot=str(root / "work")), workRoot=str(root / "work"),
                     workDir=str(root / "work"), requiredAgentCapabilities=[], expectedOutputs=["recovery-result.txt"])), timeout=35)
        assert result.get("ok"), result
        ref = result["data"]["ref"]
        final = {}
        for _ in range(120):
            status = await runner.call("job.status", {"ref": ref}, timeout=10)
            final = status.get("data") or {}
            if final.get("status") in ("done", "completed", "failed", "cancelled", "error"):
                break
            await asyncio.sleep(0.25)
        assert final.get("status") in ("done", "completed"), final
        artifact = Path(final["workDirAbs"]) / "recovery-result.txt"
        assert artifact.read_text(encoding="utf-8") == "RUNNER_RECOVERY_OK" and model_requests
        print("PASS real Hub dispatch -> Runner -> Pi -> loopback model -> file artifact", flush=True)
        async with SessionLocal() as session:
            old = await session.get(automation_models.RunnerNode, "legacy-fixture-runner")
            assert old.client_id == "fixture-old-device"
        assert (data / "runner-id").read_text() == "legacy-fixture-runner"
        assert any(s.get("state") == "online" for s in statuses)
        print("PASS original device/Runner record and legacy identity remain unchanged", flush=True)
    finally:
        for child in processes:
            if child.returncode is None:
                child.stdin.close()
                await asyncio.wait_for(child.wait(), 15)
        await asyncio.gather(*readers)
        server.should_exit = True
        await asyncio.wait_for(serving, 15)
        await engine.dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--runner-exe", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    # Keep isolated evidence for diagnosis; every run gets a fresh database.
    root = Path(tempfile.mkdtemp(prefix=".smoke-runner-recovery-", dir=args.output.resolve()))
    print("Fixture evidence: " + str(root), flush=True)
    asyncio.run(run(root, args.runner_exe.resolve() if args.runner_exe else None))
