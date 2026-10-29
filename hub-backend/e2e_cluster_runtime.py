"""Isolated E2E: two Hub processes + PostgreSQL + Redis + a protocol Runner.

Run against the dedicated loopback containers only. The protocol Runner does not
invoke a model or modify user projects. Worker-only test routes never ship in app/.
"""
from __future__ import annotations
import asyncio
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MODE = sys.argv[1] if len(sys.argv) > 1 else "test"


def child_env(database, namespace):
    return {**os.environ, "DATABASE_URL": database, "DB_MIGRATION_MODE": "check",
            "CLUSTER_REDIS_URL": "redis://127.0.0.1:16389/0",
            "CLUSTER_NAMESPACE": namespace, "CLUSTER_SHARED_FILES": "true",
            "CLUSTER_REFRESH_SECONDS": "0.5", "CLUSTER_LEASE_SECONDS": "10",
            "AUTH_SECRET": "isolated-cluster-test-signing-secret-0908",
            "ADMIN_USER": "cluster-test", "ADMIN_PASS": "isolated-test-admin-0908",
            "REPORT_AUTO": "false", "REPOSITORY_SYNC_INTERVAL_SECONDS": "0",
            "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}


if MODE == "worker":
    from app.main import app
    from app.realtime import hub
    from app.services import runner_hub, cluster_control
    from app.services.cluster_bus import bus
    frames = []

    @app.get("/state")
    async def state():
        return {"peers": len(bus.peers), "leader": cluster_control.leader,
                "runners": [r.id for r in runner_hub.online()],
                "local": list(runner_hub._RUNNERS), "node": bus.node,
                "tokens": {r.id: r.cluster_token for r in runner_hub.online()},
                "devices": sorted(hub.online_devices())}

    @app.post("/rpc")
    async def rpc(body: dict):
        runner = runner_hub.get("cluster-runner")
        if not runner:
            return {"ok": False, "code": "NOT_ONLINE"}
        return await runner.call(body.get("op", "runner.probe"), body.get("data", {}), 5)

    @app.post("/publish")
    async def publish(body: dict):
        await hub.publish("cluster-device", body)
        return {"ok": True}

    @app.post("/revoke")
    async def revoke():
        await hub.close_device("cluster-device")
        return {"ok": True}

    @app.post("/mode")
    async def set_test_mode(body: dict):
        from app.db import SessionLocal
        from app.automation_models import RunnerNode
        async with SessionLocal() as session:
            row = await session.get(RunnerNode, "cluster-runner")
            row.dispatch_mode = body["mode"]
            await session.commit()
        return {"ok": True}

    @app.post("/terminal")
    async def terminal():
        runner = runner_hub.get("cluster-runner")
        return await runner_hub.term_open(runner, "fixture-term", {},
                                         lambda data: frames.append(data))

    @app.get("/frames")
    async def get_frames():
        return frames

    @app.post("/reserve")
    async def reserve(body: dict):
        runner = runner_hub.get("cluster-runner")
        result = await asyncio.to_thread(runner_hub.reserve_dispatch, runner, body["key"])
        return {"ok": result[0], "token": result[1]}

    # Test routes must precede the real admin static root mount.
    from starlette.routing import Mount
    app.router.routes.sort(key=lambda route: isinstance(route, Mount))
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(sys.argv[2]), log_level="warning")
    raise SystemExit()


async def initialize(database):
    os.environ.update(child_env(database, "unused"))
    os.environ["CLUSTER_REDIS_URL"] = ""
    os.environ["DB_MIGRATION_MODE"] = "auto"
    from app.db import init_db, SessionLocal, engine
    from app import models
    await init_db()
    async with SessionLocal() as session:
        session.add(models.User(id="cluster-person", username="cluster-person",
                                display_name="Cluster fixture", is_super=True, is_active=True))
        session.add(models.Client(
            id="cluster-device", name="Cluster fixture", user_ref="cluster-person",
            secret_hash=hashlib.sha256(b"cluster-device-secret").hexdigest(),
            auth_state="active"))
        await session.commit()
    await engine.dispose()


async def run_test():
    import asyncpg
    import httpx
    import websockets
    from redis.asyncio import Redis
    output = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(tempfile.mkdtemp(prefix="soduwork-cluster-evidence-"))
    output.mkdir(parents=True, exist_ok=True)
    database_name = ".smoke_cluster_" + uuid.uuid4().hex[:10]
    root_dsn = "postgresql://soduwork_test:soduwork_test_isolated@127.0.0.1:15489/postgres"
    conn = await asyncpg.connect(root_dsn)
    await conn.execute('CREATE DATABASE "' + database_name + '"')
    await conn.close()
    database = "postgresql+asyncpg://soduwork_test:soduwork_test_isolated@127.0.0.1:15489/" + database_name
    namespace = "smoke_" + uuid.uuid4().hex[:12]
    await initialize(database)
    children, handles, jobs, checks = [], [], [], []
    bases = ["http://127.0.0.1:18481", "http://127.0.0.1:18482"]

    def start(index):
        log = open(output / f"hub-{index}-{len(handles)}.log", "w", encoding="utf-8")
        handles.append(log)
        proc = subprocess.Popen([sys.executable, __file__, "worker", str(18481 + index)],
                                cwd=ROOT, env=child_env(database, namespace),
                                stdout=log, stderr=subprocess.STDOUT,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        children.append(proc)
        return proc

    def check(value, name):
        if not value:
            raise AssertionError(name)
        checks.append(name)
        print("PASS", name, flush=True)

    async with httpx.AsyncClient(timeout=15, trust_env=False) as http:
        async def wait_for(predicate, timeout=35):
            until = time.monotonic() + timeout
            last = None
            while time.monotonic() < until:
                try:
                    last = await predicate()
                    if last:
                        return last
                except Exception:
                    pass
                await asyncio.sleep(.2)
            raise AssertionError("Timed out waiting for cluster condition: " + str(last))

        async def ready():
            return all([(await http.get(base + "/readyz")).status_code == 200 for base in bases])

        async def both_online():
            states = [(await http.get(base + "/state")).json() for base in bases]
            return (all("cluster-runner" in state["runners"] for state in states)
                    and states[0]["tokens"] == states[1]["tokens"])

        async def runner(index):
            headers = {"X-Soduwork-Device": "cluster-device", "X-Soduwork-Secret": "cluster-device-secret"}
            async with websockets.connect(bases[index].replace("http", "ws") + "/api/v1/runner",
                                          additional_headers=headers) as sock:
                await sock.send(json.dumps({"op": "hello", "runnerId": "cluster-runner",
                    "clientId": "cluster-device", "host": "isolated-runner",
                    "agents": [{"key": "pi", "name": "Pi"}], "inventoryReady": True,
                    "maxConcurrent": 1, "taskQueueCapacity": 1, "tags": ["soduwork-client"]}))
                welcome = json.loads(await sock.recv())
                check(welcome.get("op") == "welcome", f"Runner handshake Hub {index}")
                async for raw in sock:
                    message = json.loads(raw)
                    op = message.get("op")
                    if op == "term.open":
                        for sequence in range(20):
                            await sock.send(json.dumps({"op": "term.out", "task": "fixture-term",
                                                        "d": str(sequence)}))
                    if message.get("id"):
                        await sock.send(json.dumps({"op": "reply", "id": message["id"],
                            "ok": True, "data": {"echo": message.get("echo"),
                            "ref": "fixture-ref", "state": "running", "sessions": []}}))

        first = start(0)
        try:
            # Prove actual leader loss, not merely the loss of an arbitrary peer.
            await wait_for(lambda: leader_count(http, bases[:1], 1), 80)
            second = start(1)
            await wait_for(ready, 80)
            check(True, "Two independent Hub processes ready on shared PostgreSQL/Redis")
            states = [(await http.get(base + "/state")).json() for base in bases]
            await wait_for(lambda: leader_count(http, bases, 1))
            check(True, "Exactly one periodic supervisor elected")
            jobs.append(asyncio.create_task(runner(0)))
            await wait_for(both_online)
            check(True, "Runner registered on A visible on B")
            result = (await http.post(bases[1] + "/rpc", json={"data": {"echo": "cross-node"}})).json()
            check(result.get("data", {}).get("echo") == "cross-node", "B routes real RPC through A to Runner")
            results = await asyncio.gather(*(http.post(bases[1] + "/rpc",
                json={"data": {"echo": i}}) for i in range(100)))
            check([r.json().get("data", {}).get("echo") for r in results] == list(range(100)),
                  "Concurrent RPC replies remain correlated")
            dispatched = (await http.post(bases[1] + "/rpc", json={
                "op": "job.dispatch", "data": {"echo": "dispatch"}})).json()
            check(dispatched.get("data", {}).get("echo") == "dispatch",
                  "Cross-node job.dispatch uses the same Runner transport")
            await http.post(bases[1] + "/mode", json={"mode": "disabled"})
            blocked = (await http.post(bases[1] + "/rpc", json={
                "op": "job.dispatch", "data": {"echo": "must-not-run"}})).json()
            check(not blocked.get("ok") and blocked.get("code") == "RUNNER_ADMISSION_REVOKED",
                  "Fresh database admission blocks stale accepting inventory")
            await http.post(bases[1] + "/mode", json={"mode": "accepting"})
            reserves = await asyncio.gather(*(http.post(bases[i] + "/reserve",
                json={"key": f"slot-{i}"}) for i in range(2)))
            check(sum(bool(r.json().get("ok")) for r in reserves) == 1,
                  "Capacity reservation is atomic across Hubs")
            events = bases[0].replace("http", "ws") + "/api/v1/ws?device=cluster-device&secret=cluster-device-secret"
            async with websockets.connect(events) as socket:
                await socket.recv()
                await http.post(bases[1] + "/publish", json={"type": "task.updated", "taskId": "fixture"})
                event = json.loads(await asyncio.wait_for(socket.recv(), 5))
                check(event.get("taskId") == "fixture", "B event delivered to client connected on A")
                await http.post(bases[1] + "/revoke")
                try:
                    await asyncio.wait_for(socket.recv(), 5)
                    check(False, "Cross-node device revocation")
                except websockets.ConnectionClosed:
                    check(True, "Cross-node device revocation closes live channel")
            # Revocation closes Runner too. Reconnect to A, then open terminal from B.
            jobs.append(asyncio.create_task(runner(0)))
            await wait_for(both_online)
            opened = (await http.post(bases[1] + "/terminal")).json()
            check(opened.get("ok"), "Remote terminal acknowledged: " + str(opened.get("code", "")))
            async def frames_ready():
                return len((await http.get(bases[1] + "/frames")).json()) >= 20
            await wait_for(frames_ready)
            check((await http.get(bases[1] + "/frames")).json()[:20] == [str(i) for i in range(20)],
                  "Terminal stream crosses Hubs without reordering")
            # Fast cross-node reconnect fences the old WebSocket incarnation.
            jobs.append(asyncio.create_task(runner(1)))
            async def moved():
                state = (await http.get(bases[0] + "/state")).json()
                return "cluster-runner" not in state["local"] and "cluster-runner" in state["runners"]
            await wait_for(moved)
            result = (await http.post(bases[0] + "/rpc", json={"data": {"echo": "moved"}})).json()
            check(result.get("data", {}).get("echo") == "moved", "Runner reconnects on B; A follows new ownership")
            check((await http.get(bases[0] + "/state")).json()["leader"],
                  "Node being terminated is the elected supervisor")
            await terminate(first)
            async def survivor():
                state = (await http.get(bases[1] + "/state")).json()
                return state["leader"]
            await wait_for(survivor, 40)
            check(True, "Surviving Hub takes over periodic supervisor after process loss")
            result = (await http.post(bases[1] + "/rpc", json={"data": {"echo": "survived"}})).json()
            check(result.get("data", {}).get("echo") == "survived", "Surviving Runner remains usable")
            # The broker is an isolated disposable container, never a shared service.
            await asyncio.to_thread(subprocess.run,
                ["docker", "stop", "soduwork-cluster-test-redis-0908"],
                check=True, stdout=subprocess.DEVNULL)
            try:
                async def unavailable():
                    return (await http.get(bases[1] + "/readyz")).status_code == 503
                await wait_for(unavailable, 15)
                check(True, "Broker outage removes Hub from readiness")
                unavailable_rpc = await http.post(bases[1] + "/rpc", json={})
                check(unavailable_rpc.status_code == 503
                      and unavailable_rpc.headers.get("Retry-After") == "3",
                      "Real application middleware blocks writes with lost coordination")
            finally:
                await asyncio.to_thread(subprocess.run,
                    ["docker", "start", "soduwork-cluster-test-redis-0908"],
                    check=True, stdout=subprocess.DEVNULL)
            async def recovered():
                return (await http.get(bases[1] + "/readyz")).status_code == 200
            await wait_for(recovered, 35)
            check(True, "Broker recovery restores Hub readiness")
            jobs.append(asyncio.create_task(runner(1)))
            async def new_runner_ready():
                state = (await http.get(bases[1] + "/state")).json()
                return "cluster-runner" in state["local"]
            await wait_for(new_runner_ready)
            recovered_rpc = (await http.post(bases[1] + "/rpc", json={"data": {"echo": "recovered"}})).json()
            check(recovered_rpc.get("data", {}).get("echo") == "recovered",
                  "Runner reconnects and executes after broker restart")

        finally:
            for job in jobs:
                job.cancel()
            await asyncio.gather(*jobs, return_exceptions=True)
            for child in children:
                if child.poll() is None:
                    await terminate(child)
            for handle in handles:
                handle.close()
            (output / "result.json").write_text(json.dumps(
                {"checks": checks, "passed": len(checks), "testDatabase": database_name,
                 "scope": "real Hub transports; simulated Runner, no model execution"},
                ensure_ascii=False, indent=2), encoding="utf-8")


async def terminate(child):
    if os.name == "nt":
        await asyncio.to_thread(subprocess.run,
            ["taskkill", "/PID", str(child.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW)
    else:
        child.terminate()
    await asyncio.to_thread(child.wait, 15)


async def leader_count(http, bases, count):
    return sum([(await http.get(base + "/state")).json()["leader"] for base in bases]) == count


if MODE == "test":
    asyncio.run(run_test())
