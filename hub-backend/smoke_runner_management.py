# -*- coding: utf-8 -*-
"""Runner-management tests with a temporary database and connection fixtures, without business data
or model usage.
"""
import asyncio
import os
import pathlib
import shutil
import sys
import tempfile
import time

# Configure the temporary database before importing app.db.
# Do not let an offline test inherit the business database URL.
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///.smoke-runner-mgmt.db")
sys.path.insert(0, ".")

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402

from app import automation_models as am, models  # noqa: E402
from app.db import Base  # noqa: E402
from app.permissions import ALL_KEYS  # noqa: E402
from app.services import execution_capabilities, runner_hub, runner_registry  # noqa: E402
import runner_main  # noqa: E402

ok = fail = 0
lines = []


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        lines.append("  PASS  " + name)
    else:
        fail += 1
        lines.append("  FAIL  " + name + ("  << " + str(extra)[:300] if extra else ""))


class FakeRunner:
    id = "runner-smoke-manage"
    client_id = "client-smoke-manage"
    host = "研发工作站"
    os = "Windows 11"
    version = "1.5.0"
    work_root = r"D:\SoduWork"
    tags = ["dev", "intranet", runner_hub.CLIENT_TAG]
    agents = [{"key": "pi", "name": "Pi", "version": "0.49"}]
    capabilities = execution_capabilities.clean_report({
        "schemaVersion": 1, "reportedAt": int(time.time()),
        "available": ["files", "terminal", "repository"]})
    busy = 1
    max_concurrent = 3
    connected_at = time.time() - 60
    last_beat = time.time()
    dispatch_mode = "warming"
    ready = True
    inventory_ready = True
    _registry_write = 0.0

    def alive(self):
        return True


class FakeSocket:
    def __init__(self):
        self.closed = []

    async def close(self, code=1000):
        self.closed.append(code)


async def test_registry(session_factory):
    fake = FakeRunner()
    old = dict(runner_hub._RUNNERS)
    runner_hub._RUNNERS.clear()
    runner_hub._RUNNERS[fake.id] = fake
    try:
        async with session_factory() as s:
            s.add(models.User(id="user-runner-smoke", username="zhangsan",
                              display_name="张三", is_active=True))
            s.add(models.Client(id=fake.client_id, name="旧设备名",
                                user_ref="user-runner-smoke", auth_state="active"))
            row = await runner_registry.record(s, fake, force=True)
            s.add(models.Task(id="task-runner-smoke", title="正在开发论坛", status="doing"))
            s.add(am.ExecutionSession(
                id="session-runner-smoke", task_id="task-runner-smoke", ref="ref-runner-smoke",
                runner_id=fake.id, runner_client_id=fake.client_id, host=fake.host,
                engine="pi", state="running"))
            await s.commit()
            chk("登记·新节点默认接单", row.dispatch_mode == "accepting")
            chk("登记·持久状态同步回在线连接", fake.dispatch_mode == "accepting")

        async with session_factory() as s:
            items = await runner_registry.list_nodes(s, {fake.client_id})
            item = items[0] if items else {}
            chk("清单·合并实时在线状态", item.get("online") is True, item)
            chk("清单·展示正在承载的真实任务", item.get("sessions", [{}])[0].get("title") == "正在开发论坛", item)
            chk("清单·客户端内置节点用产品语言标识", item.get("embedded") is True, item)
            chk("清单·内部调度标签不暴露给用户", runner_hub.CLIENT_TAG not in item.get("tags", []), item)
            chk("清单·默认用激活账号姓名命名执行机",
                item.get("owner") == "张三" and item.get("label") == "张三的电脑",
                item)
            row = await runner_registry.set_mode(s, fake.id, "draining")
            await s.commit()
            chk("调度·暂停接单持久保存", row and row.dispatch_mode == "draining")
            chk("调度·暂停节点不再接新任务", not runner_hub.can_dispatch(fake))
            chk("调度·暂停节点仍可查到，既有会话不断", runner_hub.get(fake.id) is fake)

        runner_hub._RUNNERS.clear()
        async with session_factory() as s:
            items = await runner_registry.list_nodes(s, {fake.client_id})
            chk("离线·节点仍保留在管理清单", len(items) == 1 and not items[0].get("online"), items)
            chk("离线·最后能力和工作目录仍可看", items[0].get("workRoot") == fake.work_root, items)
            chk("离线·底座无关能力事实也已持久化",
                "repository" in items[0].get("capabilities", {}).get("available", []), items)
            chk("清单·并发容量作为节点事实持久化并展示",
                items[0].get("maxConcurrent") == 3 and items[0].get("load") == 1, items)
            try:
                await runner_registry.set_mode(s, fake.id, "乱填")
                valid = False
            except ValueError:
                valid = True
            chk("状态·拒绝未知调度状态", valid)
    finally:
        runner_hub._RUNNERS.clear()
        runner_hub._RUNNERS.update(old)


async def test_stale_busy_recovery(session_factory):
    runner = FakeRunner()
    runner.id = "runner-stale-load"
    runner.client_id = "client-stale-load"
    runner.busy = 2
    async with session_factory() as session:
        await runner_registry.record(session, runner, force=True)
        session.add(am.ExecutionSession(
            id="session-stale-load", task_id="task-stale-load",
            ref="ref-stale-load", runner_id=runner.id, state="running"))
        await session.commit()
        row = await session.get(am.RunnerNode, runner.id)
        row.last_seen_at = runner_registry._now() - runner_registry.timedelta(seconds=60)
        await session.commit()
        recovered = await runner_registry.reconcile_stale_busy(session, 30)
        await session.commit()
        chk("offline stale load stays while a durable session is active",
            recovered == 0 and row.busy == 2, (recovered, row.busy))
        active = await session.get(am.ExecutionSession, "session-stale-load")
        active.state = "done"
        await session.commit()
        recovered = await runner_registry.reconcile_stale_busy(session, 30)
        await session.commit()
        chk("offline stale load clears after durable work is terminal",
            recovered == 1 and row.busy == 0, (recovered, row.busy))


def test_preferred_route():
    """Prefer an owner's desktop executor over their server regardless of connection order."""
    desktop = FakeRunner()
    desktop.id = "runner-desktop"
    desktop.tags = [runner_hub.CLIENT_TAG]
    desktop.busy = 4
    desktop.connected_at = time.time()
    desktop.dispatch_mode = "accepting"
    desktop.agents = [{"key": "pi", "name": "Pi", "version": "test"}]

    server = FakeRunner()
    server.id = "runner-server"
    server.tags = ["linux", "server"]
    server.busy = 0
    server.connected_at = time.time() - 3600
    server.dispatch_mode = "accepting"
    server.agents = [
        {"key": "pi", "name": "Pi", "version": "test"},
        {"key": "opencode", "name": "OpenCode", "version": "test"},
    ]

    old = dict(runner_hub._RUNNERS)
    runner_hub._RUNNERS.clear()
    runner_hub._RUNNERS.update({desktop.id: desktop, server.id: server})
    try:
        chk("调度·桌宠在线时优先客户端内置 Runner",
            runner_hub.pick_for(desktop.client_id, "pi") is desktop)
        chk("调度·机器级操作也锁定客户端内置 Runner",
            runner_hub.for_client(desktop.client_id) is desktop)
        chk("调度·本机缺少所选底座时自动选择可用服务器",
            runner_hub.pick_for(desktop.client_id, "opencode") is server)
        for mode in ("draining", "disabled", "warming"):
            desktop.dispatch_mode = mode
            chk(f"调度·本机 {mode} 时新任务绕行可用服务器",
                runner_hub.pick_for(desktop.client_id, "pi") is server)
        desktop.dispatch_mode = "accepting"
        desktop.alive = lambda: False
        chk("调度·本机离线后新任务绕行可用服务器",
            runner_hub.pick_for(desktop.client_id, "pi") is server)
        server.dispatch_mode = "draining"
        chk("调度·没有可接单节点时不误派给暂停或离线节点",
            runner_hub.pick_for(desktop.client_id, "pi") is None)
    finally:
        runner_hub._RUNNERS.clear()
        runner_hub._RUNNERS.update(old)


async def test_connection_identity(session_factory):
    """Reconnects may replace only the same device; stale RPCs must wake immediately."""
    saved = dict(runner_hub._RUNNERS)
    runner_hub._RUNNERS.clear()
    try:
        release_only = runner_hub.add(FakeSocket(), {
            "runnerId": "runner-release-only", "clientId": "client-release",
            "host": "release-only", "agents": [], "inventoryReady": True,
        })
        chk("握手·已确认的空 Agent 清单仍算已上报",
            release_only.inventory_ready and release_only.agents == [])
        first_ws = FakeSocket()
        second_ws = FakeSocket()
        first = runner_hub.add(first_ws, {
            "runnerId": "runner-reconnect", "clientId": "client-a", "host": "old",
        })
        waiter = asyncio.get_running_loop().create_future()
        first._waiters["waiting"] = waiter
        second = runner_hub.add(second_ws, {
            "runnerId": "runner-reconnect", "clientId": "client-a", "host": "new",
        })
        await asyncio.sleep(0)
        chk("重连·同一设备原子替换旧连接",
            runner_hub._RUNNERS.get("runner-reconnect") is second and first_ws.closed == [1012],
            first_ws.closed)
        chk("重连·旧连接上的 RPC 不再等到超时",
            waiter.done() and not waiter.result().get("ok"),
            waiter.result() if waiter.done() else "pending")
        try:
            runner_hub.add(FakeSocket(), {
                "runnerId": "runner-reconnect", "clientId": "client-b", "host": "intruder",
            })
            rejected = False
        except ValueError:
            rejected = True
        chk("身份·不同设备不能用同名 Runner 顶替在线节点",
            rejected and runner_hub._RUNNERS.get("runner-reconnect") is second)

        second.busy = 2
        async with session_factory() as session:
            await runner_registry.record(session, second, force=True)
            await session.commit()
        from app.api import runner_ws as runner_api
        saved_session_local = runner_api.SessionLocal
        runner_api.SessionLocal = session_factory
        try:
            kicked = await runner_api._kick_runner("runner-reconnect")
        finally:
            runner_api.SessionLocal = saved_session_local
        chk("轮换·Runner 钥匙变化会立即断开旧控制通道",
            kicked and second_ws.closed == [4401]
            and runner_hub.get("runner-reconnect") is None, second_ws.closed)
        async with session_factory() as session:
            row = await session.get(am.RunnerNode, "runner-reconnect")
            chk("轮换·强制断线同步清零持久化负载",
                row is not None and row.busy == 0, row.busy if row else None)
    finally:
        runner_hub._RUNNERS.clear()
        runner_hub._RUNNERS.update(saved)


async def test_probe(tmp):
    sent = []
    machine = runner_main.Runner(
        "http://127.0.0.1:1", "", "", "probe-smoke", tmp,
        tags=["dev"], max_concurrent=4)
    async def capture(payload):
        sent.append(payload)
    machine._send = capture
    old_agents, old_busy = runner_main._agents, runner_main._busy_count
    runner_main._agents = lambda: [{"key": "pi", "name": "Pi", "version": "test"}]
    runner_main._busy_count = lambda: 2
    try:
        await machine._on({"op": "runner.probe", "id": "rpc-1"})
    finally:
        runner_main._agents, runner_main._busy_count = old_agents, old_busy
    payload = sent[0] if sent else {}
    data = payload.get("data") or {}
    chk("探活·回执保留 RPC 关联号", payload.get("id") == "rpc-1", payload)
    chk("探活·返回自适应上限/负载/队列/资源/底座/磁盘",
        payload.get("ok") is True and data.get("busy") == 2
        and 1 <= data.get("maxConcurrent", 0) <= 4
        and data.get("concurrencyCeiling") == 4
        and data.get("taskQueueCapacity") == 100
        and "queuedConversations" in data and "queuedTasks" in data
        and "cpuPercent" in data and "memoryPercent" in data
        and data.get("agents", [{}])[0].get("key") == "pi"
        and data.get("freeBytes", 0) > 0, payload)


async def test_runner_capacity_and_send_lock(tmp):
    from app.services import ai_local, dispatch_identity

    old_input_root = runner_main._input_root
    runner_main._input_root = lambda transfer: os.path.join(tmp, "runner-inputs", transfer)
    machine = runner_main.Runner(
        "http://127.0.0.1:1", "", "", "capacity-smoke", tmp,
        tags=["dev"], max_concurrent=1)
    ref = dispatch_identity.execution_ref("f" * 32)
    with ai_local._LOCK:
        previous = ai_local._RUNS.get("capacity-existing")
        ai_local._RUNS["capacity-existing"] = {"state": "running"}
    try:
        capacity_transfer = "a" * 32
        capacity_root = pathlib.Path(runner_main._input_root(capacity_transfer))
        capacity_root.mkdir(parents=True)
        (capacity_root / "payload").write_bytes(b"capacity")
        queued = await machine._job({
            "op": "job.dispatch", "id": "rpc-capacity", "dispatchId": "f" * 32,
            "task": {"id": "task-capacity", "title": "容量保护"},
            "cli": "pi", "cfg": {}, "ctx": {},
            "files": {"transfer": capacity_transfer},
        })
        chk("执行端·资源已满时接收任务并返回标准排队回执",
            queued.get("ok") is True
            and (queued.get("data") or {}).get("state") == "queued"
            and (queued.get("data") or {}).get("queuePosition") == 1, queued)
        chk("执行端·排队任务保留启动时仍要使用的上传附件", capacity_root.exists())
        duplicate_transfer = "b" * 32
        duplicate_root = pathlib.Path(runner_main._input_root(duplicate_transfer))
        duplicate_root.mkdir(parents=True)
        (duplicate_root / "payload").write_bytes(b"duplicate")
        duplicate = await machine._job({
            "op": "job.dispatch", "id": "rpc-duplicate", "dispatchId": "f" * 32,
            "task": {"id": "task-capacity", "title": "容量保护"},
            "cli": "pi", "cfg": {}, "ctx": {},
            "files": {"transfer": duplicate_transfer},
        })
        chk("执行端·同一派活重送返回原排队回执而不启动第二份",
            duplicate.get("ok") is True
            and (duplicate.get("data") or {}).get("duplicate") is True
            and (duplicate.get("data") or {}).get("ref") == ref, duplicate)
        chk("执行端·重复请求只清掉自己新传的附件", not duplicate_root.exists()
            and capacity_root.exists())
        stopped = await machine._job({"op": "job.stop", "ref": ref})
        chk("执行端·排队任务可取消并清理原始附件",
            (stopped.get("data") or {}).get("state") == "cancelled"
            and not capacity_root.exists(), stopped)
    finally:
        runner_main._input_root = old_input_root
        if machine._admission_task:
            machine._admission_task.cancel()
            await asyncio.gather(machine._admission_task, return_exceptions=True)
        with ai_local._LOCK:
            if previous is None:
                ai_local._RUNS.pop("capacity-existing", None)
            else:
                ai_local._RUNS["capacity-existing"] = previous

    class SlowSocket:
        def __init__(self):
            self.active = 0
            self.overlap = False

        async def send(self, _payload):
            self.active += 1
            self.overlap = self.overlap or self.active > 1
            await asyncio.sleep(0.01)
            self.active -= 1

    socket = SlowSocket()
    machine.ws = socket
    await asyncio.gather(machine._send({"n": 1}), machine._send_strict({"n": 2}))
    chk("执行端·心跳、实况与 RPC 回执共享一个发送锁", not socket.overlap)


async def test_control_plane_responsiveness(tmp):
    machine = runner_main.Runner(
        "http://127.0.0.1:1", "", "", "rpc-smoke", tmp,
        tags=["dev"], max_concurrent=1)
    slow_started = asyncio.Event()
    fast_done = asyncio.Event()
    release = asyncio.Event()
    completed: list[str] = []

    async def fake_on(message):
        if message.get("op") == "job.dispatch":
            slow_started.set()
            await release.wait()
        else:
            completed.append(str(message.get("op") or ""))
            fast_done.set()

    class Incoming:
        def __init__(self):
            self.messages = iter([
                '{"op":"job.dispatch","id":"slow"}',
                '{"op":"runner.probe","id":"fast"}',
            ])

        def __aiter__(self):
            return self

        async def __anext__(self):
            try:
                return next(self.messages)
            except StopIteration:
                raise StopAsyncIteration

    machine.ws = Incoming()
    machine._on = fake_on
    await machine._pump()
    started = await asyncio.wait_for(slow_started.wait(), timeout=1)
    responsive = await asyncio.wait_for(fast_done.wait(), timeout=1)
    chk("控制面·慢派活准备期间探活和状态请求仍能立即处理",
        bool(started and responsive) and completed == ["runner.probe"], completed)
    release.set()
    if machine._rpc_tasks:
        await asyncio.gather(*list(machine._rpc_tasks))


def test_contract():
    from app.api import runner_ws
    chk("迁移·旧版固定 1/1 配置不会锁死自适应调度",
        runner_main._configured_concurrency("", {"maxConcurrent": 1}) == 20)
    chk("迁移·新版安全上限和显式参数仍受 1–20 边界保护",
        runner_main._configured_concurrency("", {"concurrencyCeiling": 6}) == 6
        and runner_main._configured_concurrency("99", {}) == 20)
    paths = {getattr(x, "path", "") for x in runner_ws.router.routes}
    chk("接口·客户端有清单/状态/探活三条管理接口",
        {"/api/v1/runners", "/api/v1/runners/{runner_id}/mode",
         "/api/v1/runners/{runner_id}/probe"} <= paths, paths)
    chk("接口·本机与共享 Runner 都有组件安装和进度接口",
        {"/api/v1/runners/{runner_id}/components/{key}/install",
         "/api/v1/runners/{runner_id}/components/jobs/{job_id}",
         "/api/v1/admin/runners/{runner_id}/components/{key}/install",
         "/api/v1/admin/runners/{runner_id}/components/jobs/{job_id}"} <= paths, paths)
    chk("接口·管理端有组织范围 Runner 清单", "/api/v1/admin/runners" in paths)
    chk("权限·Runner 管理是独立权限点", "runner.manage" in ALL_KEYS)

    root = pathlib.Path(__file__).resolve().parent.parent
    js = (root / "client/components/panels/panels-runners.js").read_text(encoding="utf-8")
    css = (root / "client/components/panels/panels-runners.css").read_text(encoding="utf-8")
    agents = (root / "client/components/panels/panels-agents.js").read_text(encoding="utf-8")
    runtime = (root / "client/main/runner-runtime.js").read_text(encoding="utf-8")
    runner_source = (root / "hub-backend/runner_main.py").read_text(encoding="utf-8")
    api = (root / "client/api.js").read_text(encoding="utf-8")
    desk = (root / "client/desk.html").read_text(encoding="utf-8")
    chk("界面·Runner 放在 Agent 管理的独立页签，不新增菜单",
        'data-agtab="runners"' in agents and "RunnerManager.render" in agents and "panels-runners.js" in desk)
    chk("界面·两列节点卡并有窄窗降级", "grid-template-columns:repeat(2" in css and "grid-template-columns:1fr" in css)
    chk("界面·工作目录可复制且有剪贴板兜底", "data-rn-copy" in js and "execCommand('copy')" in js)
    chk("界面·暂停前就地确认，不用原生确认框", "暂停接收新任务" in js and "window.confirm" not in js)
    chk("界面·探活和暂停都走真实接口", "runnerProbe" in api and "runnerMode" in api)
    chk("界面·组件安装先经本机原生确认并持续回报进度",
        "runner-component-confirm" in runtime and "data-rn-cap-install" in js
        and "runnerComponentJob" in api and "安装记录" in js)
    chk("界面·活跃会话可进入任务详情和真实控制台",
        "data-rn-task" in js and "data-rn-console" in js and "openConsoleEntry" in js)
    chk("界面·明确展示首选节点与自动绕行策略",
        'class="rn-preferred">首选</span>' in js and "自动调度" in js
        and "当前优先使用「" in js
        and "使用其他环境时，请明确选择云端或指定执行机。" in js
        and "当前没有可接单节点，任务会保留等待。" in js)
    chk("界面·Runner 会话事件节流刷新且不反复闪加载态",
        "soduwork-work-execution" in agents and "_agRunnerTick" in agents and "if (!loaded)" in agents)
    chk("界面·Runner 页不重复绘制第二个大标题",
        "rn-control-section" in js and "<h3>运行节点</h3>" not in js)
    read_config = runtime[
        runtime.index("function _readConfig(app)"):
        runtime.index("function _stop()")
    ]
    start_runner = runtime[
        runtime.index("function _start(app)"):
        runtime.index("function identity(app)")
    ]
    read_before_spawn = (
        start_runner.index("const cfg = _readConfig(app)")
        < start_runner.index("spawn(spec.bin")
    )
    chk("启动·客户端标记先规范写回再拉起 Runner",
        "soduwork-client" in runtime and "_writeConfig(app, encoded)" in read_config
        and "const cfg = _readConfig(app)" in start_runner
        and "spawn(spec.bin" in start_runner
        and read_before_spawn
    )
    chk("安全·Runner 控制面凭据不会继承给 AI 子进程",
        'os.environ.pop(env_key, None)' in runner_source and
        '"SODUWORK_DEVICE_SECRET", "SODUWORK_RUNNER_KEY", "SODUWORK_RUNNER_TOKEN"' in runner_source)


async def main():
    tmp = tempfile.mkdtemp(prefix="soduwork-runner-manage-")
    engine = create_async_engine("sqlite+aiosqlite:///" + os.path.join(tmp, "smoke.db").replace("\\", "/"))
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        await test_registry(session_factory)
        await test_stale_busy_recovery(session_factory)
        test_preferred_route()
        await test_connection_identity(session_factory)
        await test_probe(tmp)
        await test_runner_capacity_and_send_lock(tmp)
        await test_control_plane_responsiveness(tmp)
        test_contract()
    finally:
        await engine.dispose()
        shutil.rmtree(tmp, ignore_errors=True)
    print("\n".join(lines))
    print("\n%d 通过 / %d 失败" % (ok, fail))
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
