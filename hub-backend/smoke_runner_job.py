# -*- coding: utf-8 -*-
"""Live Runner job dispatch and artifact delivery checks."""
import asyncio
import json
import os
import shutil
import sys
import tempfile
import time
import urllib.request

sys.path.insert(0, ".")

from app import models  # noqa: E402
from app.db import SessionLocal  # noqa: E402

ok = fail = 0
log = []
CID = "u-smoke-rjob"
UID = "smoke-rjob-user"
USERNAME = "smoke_runner_job"
SECRET = "smoke-rjob-secret-0123456789abcdef"
HUB = os.environ.get("SMOKE_BASE", "http://127.0.0.1:9080").rstrip("/")
BASE = HUB + "/api/v1"
_OP = urllib.request.build_opener(urllib.request.ProxyHandler({}))
_TMP = []


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        log.append("  PASS  " + name)
    else:
        fail += 1
        log.append("  FAIL  " + name + ("  << " + str(extra)[:400] if extra else ""))


def http(path, timeout=30):
    import urllib.error
    req = urllib.request.Request(BASE + path)
    req.add_header("X-Soduwork-Device", CID)
    req.add_header("X-Soduwork-Secret", SECRET)
    try:
        with _OP.open(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        return e.code, {"detail": e.read().decode("utf-8", "replace")[:200]}
    except Exception as e:  # noqa: BLE001
        return 0, {"detail": "%s: %s" % (type(e).__name__, str(e)[:150])}


async def seed():
    from app.services import device_auth

    async with SessionLocal() as s:
        user = await s.get(models.User, UID)
        if user is None:
            user = models.User(id=UID, username=USERNAME,
                               display_name="（冒烟）Runner", is_active=True)
            s.add(user)
        else:
            user.is_active = True
        c = await s.get(models.Client, CID)
        if c is None:
            c = models.Client(id=CID)
            s.add(c)
        c.secret = None
        c.secret_hash = device_auth.hash_secret(SECRET)
        device_auth.activate(c, user)
        await s.commit()


async def purge():
    """Restore all live-test changes so business data remains unchanged."""
    async with SessionLocal() as s:
        row = await s.get(models.Client, CID)
        if row is not None:
            await s.delete(row)
        await s.flush()
        user = await s.get(models.User, UID)
        if user is not None:
            await s.delete(user)
        await s.commit()
    for d in _TMP:
        shutil.rmtree(d, ignore_errors=True)


# Verify provider routing.
def t_routing():
    from app.services import ai_exec, ai_local, ai_remote
    chk("路由·runner: 前缀进远程那条",
        ai_exec._by_assignee("runner:abc123:pi") is ai_remote)
    chk("路由·local: 前缀还是走本机（老路一行没动）",
        ai_exec._by_assignee("local:pi") is ai_local)
    chk("路由·不带前缀＝默认底座（老行为不变）",
        ai_exec._by_assignee("a98b7661-872b-41ea") is None)
    chk("收件人 id 拆得对", ai_remote._parse("runner:abc123:pi") == ("abc123", "pi"))
    chk("收件人 id 少一段也不炸", ai_remote._parse("runner:abc123") == ("abc123", ""))

    calls = []
    real_kind, real_exact = ai_exec.resolve_kind, ai_exec.resolve_assignee_sync

    def fake_kind(ctx, kind, client_id="", prefer_runner="", required_capabilities=None,
                  runner_tags=None):
        calls.append(("kind", kind, client_id))
        return {"id": "runner:mine:" + kind.rsplit(":", 1)[-1]}

    def fake_exact(ctx, aid, atype=""):
        calls.append(("exact", aid, atype))
        return {"id": aid}

    ai_exec.resolve_kind, ai_exec.resolve_assignee_sync = fake_kind, fake_exact
    try:
        local = ai_exec.resolve_requested_sync({}, "local:pi", "agent", "client-me")
        exact = ai_exec.resolve_requested_sync({}, "runner:server:pi", "agent", "client-me")
        hosted = ai_exec.resolve_requested_sync({}, "hosted", "agent", "client-me")
        chk("请求路由·local 是可移植底座类型，按任务归属人选 Runner",
            local.get("id") == "runner:mine:pi"
            and ("kind", "local:pi", "client-me") in calls, (local, calls))
        chk("请求路由·显式 runner id 仍精确派到指定机器",
            exact.get("id") == "runner:server:pi"
            and ("exact", "runner:server:pi", "agent") in calls, (exact, calls))
        chk("请求路由·hosted 仍按组织默认底座解析",
            hosted.get("id") == "runner:mine:hosted"
            and ("kind", "hosted", "client-me") in calls, (hosted, calls))
    finally:
        ai_exec.resolve_kind, ai_exec.resolve_assignee_sync = real_kind, real_exact


# Verify provider-specific configuration.
def t_cfg():
    """Remote execution uses ai_local's model configuration, not unrelated managed-provider
    settings.
    """
    from types import SimpleNamespace

    from app.services import ai_exec, ai_local, ai_remote
    # Use a hypothetical managed-provider context to preserve configuration-selection coverage.
    # Retired adapters must not remove protection against cross-provider configuration mixing.
    ctx = {"name": "hosted-x",
           "cfg": {"base": "托管的地址", "token": "托管的令牌"},
           "localCfg": {"llm": {"model": "本机该用的模型", "key": "k"}}}
    chk("配置·远程执行机拿到的是 localCfg（不是托管那份）",
        ai_exec._cfg_of(ctx, ai_remote).get("llm", {}).get("model") == "本机该用的模型",
        ai_exec._cfg_of(ctx, ai_remote))
    chk("配置·本机那条还是 localCfg（没被这次改动带坏）",
        ai_exec._cfg_of(ctx, ai_local).get("llm", {}).get("model") == "本机该用的模型")
    chk("配置·托管那条还是拿自己的 cfg",
        ai_exec._cfg_of(ctx, SimpleNamespace()).get("base") == "托管的地址")
    lctx = {"name": "local", "cfg": {"llm": {"model": "就是它"}}}
    chk("配置·底座本来就设成 local 时，远程也拿这一份",
        ai_exec._cfg_of(lctx, ai_remote).get("llm", {}).get("model") == "就是它")


# Fetch artifacts within the correct execution.
def t_artifact_isolation():
    """Technical contract for t artifact isolation."""
    from app.services import ai_local
    a = tempfile.mkdtemp(prefix="smoke-rjob-a-")
    b = tempfile.mkdtemp(prefix="smoke-rjob-b-")
    _TMP.extend([a, b])
    with open(os.path.join(a, "index.html"), "w", encoding="utf-8") as f:
        f.write("我是甲任务的产出")
    with open(os.path.join(b, "index.html"), "w", encoding="utf-8") as f:
        f.write("我是乙任务的产出")
    ref_a, ref_b = "smoke-ref-a", "smoke-ref-b"
    with ai_local._LOCK:
        ai_local._RUNS[ref_a] = {"ws": a, "state": "done"}
        ai_local._RUNS[ref_b] = {"ws": b, "state": "done"}
    try:
        ga = ai_local.fetch_attachment_for_sync({}, ref_a, "index.html")
        gb = ai_local.fetch_attachment_for_sync({}, ref_b, "index.html")
        chk("产出·按执行单甲取到的是甲的", ga == "我是甲任务的产出".encode("utf-8"), ga)
        chk("产出·按执行单乙取到的是乙的", gb == "我是乙任务的产出".encode("utf-8"), gb)
        chk("产出·不存在的执行单取不到（不许回落到别人的文件）",
            ai_local.fetch_attachment_for_sync({}, "没这条", "index.html") is None)
        chk("产出·目录穿越取不到",
            ai_local.fetch_attachment_for_sync({}, ref_a, "../../windows/win.ini") is None)
        chk("产出·老的按文件名找还在（没 ref 时的兜底路）",
            ai_local.fetch_attachment_sync({}, "index.html") is not None)
    finally:
        with ai_local._LOCK:
            ai_local._RUNS.pop(ref_a, None)
            ai_local._RUNS.pop(ref_b, None)


# A route-cache hit performs no discovery round trip.
def t_where_cache():
    from app.services import ai_remote, runner_hub

    class _FakeRunner:
        id, host, client_id = "fake1", "某台机器", "u-fake-runner"
        version = "smoke-runner"
        agents, busy, connected_at = [{"key": "pi", "name": "Pi"}], 0, 0.0

        def alive(self):
            return True

    fake = _FakeRunner()
    calls = []
    real_get, real_online, real_call = runner_hub.get, runner_hub.online, runner_hub.call_sync
    runner_hub.get = lambda rid: fake if rid == "fake1" else None
    runner_hub.online = lambda: [fake]

    def counted(r, op, data, timeout=60.0):
        calls.append(op)
        return {"ok": True, "data": {"has": False}}
    runner_hub.call_sync = counted
    try:
        ai_remote._WHERE["ref-known"] = "fake1"
        calls.clear()
        got = ai_remote._runner_of_ref("ref-known")
        chk("缓存·命中就直接拿到那台", got is fake)
        chk("缓存·命中时一次网络往返都不发（状态是 20 秒轮一次的）", calls == [], calls)
        calls.clear()
        ai_remote._runner_of_ref("ref-unknown")
        chk("缓存·没命中才去问一圈", calls == ["job.has"], calls)
        ai_remote._WHERE["ref-gone"] = "已经下线的那台"
        calls.clear()
        ai_remote._runner_of_ref("ref-gone")
        chk("缓存·记的那台下线了就退回问一圈（不许一直拿着过期答案）",
            calls == ["job.has"] and "ref-gone" not in ai_remote._WHERE, calls)
    finally:
        runner_hub.get, runner_hub.online, runner_hub.call_sync = real_get, real_online, real_call
        for k in ("ref-known", "ref-unknown", "ref-gone"):
            ai_remote._WHERE.pop(k, None)


# Preserve local, remote, and managed provenance in dispatch receipts.
def t_dispatch_receipt():
    from app.services import ai_exec, ai_remote, runner_hub

    class _FakeRunner:
        id, host, client_id = "fake1", "某台机器", "u-fake-runner"
        version = "smoke-runner"
        org_id = "org-smoke"
        ready, inventory_ready, dispatch_mode = True, True, "accepting"
        tags, capabilities = [], {}
        agents, busy, connected_at = [{"key": "pi", "name": "Pi"}], 0, 0.0

        def alive(self):
            return True

    fake = _FakeRunner()
    real_get, real_online, real_call = runner_hub.get, runner_hub.online, runner_hub.call_sync
    runner_hub.get = lambda rid: fake if rid == "fake1" else None
    runner_hub.online = lambda: [fake]
    runner_hub.call_sync = lambda r, op, data, timeout=60.0: {
        "ok": True, "data": {"ref": "新执行单", "identifier": "LOCAL-新执行单"}}

    class _T:
        id, title, note, result = "t1", "标题", "备注", ""
        status, priority, source, created_by_name = "todo", "normal", "", "我"
    try:
        ctx = {"name": "hosted-x", "cfg": {}, "localCfg": {"llm": {"model": "m"}}}
        r = ai_exec.dispatch_sync(ctx, _T(), [], {"id": "runner:fake1:pi", "name": "某台机器 · Pi"}, {})
        chk("派活·回执说得清是远程执行机（不是 local）", r.get("provider") == "runner", r)
        chk("派活·带回了执行单号", r.get("issueId") == "新执行单", r)
        chk("派活·带回了哪台机器", r.get("host") == "某台机器", r)
        chk("派活·顺手记住了这条活在哪台（下次问状态零往返）",
            ai_remote._WHERE.get("新执行单") == "fake1")
        chk("派活·执行机不在线时说人话、不抛异常",
            ai_remote.dispatch_sync({}, _T(), [], {"id": "runner:没这台:pi"}, {}).get("ok") is False)
    finally:
        runner_hub.get, runner_hub.online, runner_hub.call_sync = real_get, real_online, real_call
        ai_remote._WHERE.pop("新执行单", None)


# Verify the complete provider contract.
def t_contract():
    from app.services import ai_exec, ai_remote
    missing = [n for n in ai_exec._REQUIRED if not hasattr(ai_remote, n)]
    chk("契约·远程这条把 adapter 该有的都实现了", not missing, missing)
    chk("契约·产出按执行单取这个可选能力也在", hasattr(ai_remote, "fetch_attachment_for_sync"))
    chk("契约·远程执行能增量读取真实会话", hasattr(ai_remote, "session_sync"))
    import inspect
    src = inspect.getsource(ai_remote)
    chk("契约·同步 provider 不另起事件循环",
        "asyncio.run(" not in src, "发现 asyncio.run")
    chk("契约·异步调用点有自己的安全查询",
        hasattr(ai_remote, "runner_of_ref_async"))
    old_status = ai_remote.status_sync
    try:
        ai_remote.status_sync = lambda _cfg, _ref: {
            "ok": True, "status": "queued", "running": False}
        chk("契约·排队执行仍可通过统一停止入口取消", ai_remote.is_running("queued-ref"))
    finally:
        ai_remote.status_sync = old_status


# Cover deadlock prevention, input attachments, and remote workspace planning.
async def t_safety_and_inputs():
    import ast
    import hashlib
    import pathlib

    from app.services import agent_setup, ai_exec, ai_local, ai_remote, local_base, runner_hub
    import runner_main

    tree = ast.parse(pathlib.Path("app/services/ai_exec.py").read_text(encoding="utf-8"))
    bad = [(fn.name, call.lineno) for fn in ast.walk(tree) if isinstance(fn, ast.AsyncFunctionDef)
           for call in ast.walk(fn) if isinstance(call, ast.Call)
           and isinstance(call.func, ast.Name) and call.func.id == "_by_ref"]
    chk("死锁·异步函数里不再直接调同步 _by_ref", not bad, bad)

    class _AsyncRunner:
        id, host = "async1", "异步执行机"

        async def call(self, op, data, timeout=60):
            await asyncio.sleep(0)
            return {"ok": True, "data": {"has": data.get("ref") == "async-ref"}}

    fake = _AsyncRunner()
    real_online = runner_hub.online
    runner_hub.online = lambda: [fake]
    ai_remote._WHERE.pop("async-ref", None)
    try:
        got = await ai_remote.runner_of_ref_async("async-ref")
        chk("死锁·异步查询直接 await runner RPC", got is fake)
        chk("死锁·异步查询后记住路由", ai_remote._WHERE.get("async-ref") == "async1")
    finally:
        runner_hub.online = real_online
        ai_remote._WHERE.pop("async-ref", None)

    class _RpcSocket:
        sent = None

        async def send_json(self, payload):
            self.sent = payload

    rpc_socket = _RpcSocket()
    rpc_runner = runner_hub._Runner(rpc_socket, {"runnerId": "rpc", "host": "RPC测试机"})
    rpc_runner.ready = True
    rpc_wait = asyncio.create_task(rpc_runner.call(
        "job.file", {"id": "会覆盖旧协议", "fileId": "requirements.md"}, timeout=2))
    await asyncio.sleep(0)
    rpc_msg = rpc_socket.sent or {}
    chk("RPC·业务字段不能覆盖传输层回执编号",
        rpc_msg.get("id") not in ("", "会覆盖旧协议", "requirements.md")
        and rpc_msg.get("fileId") == "requirements.md", rpc_msg)
    rpc_runner.resolve(str(rpc_msg.get("id") or ""), {"ok": True, "data": {"size": 1}})
    chk("RPC·Runner 回执能命中原请求", (await rpc_wait).get("ok") is True)

    session_ref = "smoke-session-ref"
    with ai_local._LOCK:
        ai_local._RUNS[session_ref] = {
            "ref": session_ref, "taskId": "smoke-session-task", "title": "会话桥接", "cli": "pi",
            "state": "running", "seq": 2, "segment": 1, "lines": [
                {"seq": 1, "kind": "step", "tool": "", "text": "正在分析", "at": "now", "seg": 1},
                {"seq": 2, "kind": "do", "tool": "write", "text": "index.html", "at": "now", "seg": 1},
            ], "tokens": {}, "ctxWindow": 0, "ctxWindowKnown": False,
            "detached": False, "error": "", "ws": tempfile.gettempdir(),
        }
    try:
        machine = runner_main.Runner(HUB, "", "", "smoke")
        bridged = await machine._job({"op": "job.session", "ref": session_ref,
                                      "since": 1, "limit": 20})
        rows = (bridged.get("data") or {}).get("items") or []
        chk("会话·Runner 增量返回真实解析事件",
            bridged.get("ok") and len(rows) == 1 and rows[0].get("seq") == 2, bridged)
        # Snapshot collection returns data plus proposed mark advances.
        # Apply advances only after successful sending so disconnects cannot lose events.
        beat1, adv1 = machine._session_snapshots()
        machine._apply_marks(adv1)
        beat2, _ = machine._session_snapshots()
        chk("会话·心跳首次补报、发送确认后无变化不重复发送",
            len(beat1) == 1 and [x.get("seq") for x in beat1[0].get("items", [])] == [1, 2]
            and beat2 == [], (beat1, beat2))
        with ai_local._LOCK:
            run = ai_local._RUNS[session_ref]
            run["state"] = "done"
            run["seq"] = 3
            run["ended"] = time.time()
            run["lines"].append({"seq": 3, "kind": "say", "tool": "", "text": "完成",
                                 "at": "now", "seg": 1})
        beat3, adv3 = machine._session_snapshots()
        machine._apply_marks(adv3)
        chk("会话·心跳只补新事件并同步终态",
            len(beat3) == 1 and beat3[0].get("state") == "done"
            and [x.get("seq") for x in beat3[0].get("items", [])] == [3], beat3)
    finally:
        with ai_local._LOCK:
            ai_local._RUNS.pop(session_ref, None)

    class _SessionRunner:
        id, host = "session-runner", "会话执行机"

        def alive(self):
            return True

    session_machine, session_calls = _SessionRunner(), []
    old_get, old_call = runner_hub.get, runner_hub.call_sync
    runner_hub.get = lambda rid: session_machine if rid == session_machine.id else None
    runner_hub.call_sync = lambda r, op, data, timeout=60: (
        session_calls.append((op, data)) or {"ok": True, "data": {
            "ok": True, "items": [{"seq": 8, "kind": "say", "text": "完成"}], "last": 8,
        }})
    ai_remote._WHERE[session_ref] = session_machine.id
    try:
        remote_session = ai_remote.session_sync({}, session_ref, 7)
        chk("会话·服务端按 since 向正确 Runner 增量读取",
            remote_session.get("last") == 8
            and remote_session.get("host") == session_machine.host
            and session_calls == [("job.session", {"ref": session_ref, "since": 7, "limit": 400})],
            (remote_session, session_calls))
    finally:
        runner_hub.get, runner_hub.call_sync = old_get, old_call
        ai_remote._WHERE.pop(session_ref, None)

    old_runner = type("SessionMachine", (), {"id": "session-old", "host": "OLD-HOST"})()
    new_runner = type("SessionMachine", (), {"id": "session-new", "host": "NEW-HOST"})()
    fallback_calls = []
    old_online = runner_hub.online
    runner_hub.get = lambda rid: old_runner if rid == old_runner.id else new_runner
    runner_hub.online = lambda: [old_runner, new_runner]
    def _session_fallback_call(runner, op, data, timeout=60):
        fallback_calls.append((runner.id, op))
        if runner.id == old_runner.id and op == "job.session":
            return {"ok": False, "error": "不认识的操作：job.session"}
        if op == "job.has":
            return {"ok": True, "data": {"has": True}}
        return {"ok": True, "data": {"ok": True, "items": [], "last": 9}}
    runner_hub.call_sync = _session_fallback_call
    ai_remote._WHERE[session_ref] = old_runner.id
    try:
        fallback = ai_remote.session_sync({}, session_ref, 8)
        chk("会话·旧 Runner 不认识接口时自动切到新版 Runner",
            fallback.get("ok") and fallback.get("runnerId") == new_runner.id
            and ai_remote._WHERE.get(session_ref) == new_runner.id
            and fallback_calls == [
                (old_runner.id, "job.session"),
                (new_runner.id, "job.has"),
                (new_runner.id, "job.session"),
            ], (fallback, fallback_calls))
    finally:
        runner_hub.get, runner_hub.online, runner_hub.call_sync = old_get, old_online, old_call
        ai_remote._WHERE.pop(session_ref, None)

    old_store = local_base._STORE
    root = tempfile.mkdtemp(prefix="smoke-rjob-input-")
    _TMP.append(root)
    local_base._STORE = root
    try:
        staged = ai_local._stage_inputs("input-ref", [
            ("需求.txt", "第一份".encode("utf-8"), "text/plain"),
            ("../需求.txt", b"second", "text/plain"),
        ])
        chk("输入·真实附件落进会话存档", len(staged) == 2 and all(os.path.isfile(x["path"]) for x in staged), staged)
        chk("输入·同名附件不会互相覆盖", staged[0]["path"] != staged[1]["path"])
        prompt = ai_local._compose(type("T", (), {"title": "读附件", "note": "", "id": "t"})(),
                                   {"inputFiles": staged})
        chk("输入·提示词明确给出附件绝对路径", all(x["path"] in prompt for x in staged))
        scope_prompt = ai_local._compose(
            type("T", (), {"title": "修复产品", "note": "还要开发、测试和发布", "id": "t"})(),
            {"pluginNodeName": "明确修复边界", "deliveryMode": "files",
             "expectedOutputs": [{"key": "requirements", "kind": "file",
                                   "label": "修复基线", "path": "requirements.md"}]})
        chk("★★插件文件节点在任务总说明之后锁定当前步骤",
            scope_prompt.rfind("当前工作流节点") > scope_prompt.rfind("还要开发、测试和发布")
            and "不修改项目源码、配置、测试、依赖或 Git 状态" in scope_prompt
            and "requirements.md" in scope_prompt, scope_prompt[-500:])
    finally:
        local_base._STORE = old_store

    calls = []
    real_call = runner_hub.call_sync
    runner_hub.call_sync = lambda r, op, data, timeout=60: (calls.append((op, data)) or {"ok": True})
    payload = b"x" * (ai_remote._INPUT_CHUNK + 123)
    try:
        packet, err = ai_remote._upload_inputs(object(), [("大附件.bin", payload, "application/octet-stream")])
        chunks = [x[1] for x in calls if x[0] == "input.chunk"]
        chk("输入·大附件会分片，不塞爆单个 WebSocket 帧", not err and len(chunks) == 2, len(chunks))
        chk("输入·分片 offset 连续", [x["offset"] for x in chunks] == [0, ai_remote._INPUT_CHUNK])
        chk("输入·清单带大小和 sha256", packet["items"][0]["size"] == len(payload)
            and packet["items"][0]["sha256"] == hashlib.sha256(payload).hexdigest())
    finally:
        runner_hub.call_sync = real_call

    import base64
    protected_root = tempfile.mkdtemp(prefix="smoke-rjob-protected-")
    _TMP.append(protected_root)
    protected_file = os.path.join(protected_root, "带 空格的产出.md")
    protected_blob = ("透明加密产出\n" * 400).encode("utf-8")
    with open(protected_file, "wb") as f:
        f.write(protected_blob)
    piece = runner_main._read_file_chunk(protected_root, "带 空格的产出.md", 17, 777)
    chk("产出·受保护目录由有超时的独立读取通道分片读取",
        piece["size"] == len(protected_blob)
        and base64.b64decode(piece["b64"]) == protected_blob[17:17 + 777], piece)

    remote_blob = b"z" * (ai_remote._OUTPUT_CHUNK * 2 + 77)
    def file_chunks(r, op, data, timeout=60):
        import base64
        off, limit = int(data.get("offset") or 0), int(data.get("limit") or 1)
        part = remote_blob[off:off + limit]
        return {"ok": True, "data": {"b64": base64.b64encode(part).decode("ascii"),
                "offset": off, "size": len(remote_blob), "eof": off + len(part) >= len(remote_blob)}}
    runner_hub.call_sync = file_chunks
    try:
        chk("产出·大文件从 runner 分片取回且字节完整",
            ai_remote._download(object(), "ref", "@bundle/完整.zip") == remote_blob)
    finally:
        runner_hub.call_sync = real_call

    class _Machine:
        work_root = r"D:\\SoduWork 工作区"
    remote_ctx = ai_remote._ctx_for_runner(
        {"workDir": r"/opt/server/wrong", "repo": {"path": r"/opt/server/repo", "name": "演示"}},
        _Machine())
    chk("目录·runner 有自己的根时不再沿用服务端绝对路径",
        remote_ctx["workDir"] == "" and remote_ctx["repo"]["path"] == "")
    chk("目录·把 runner 自己的工作根放进计划", remote_ctx["workspace"]["workRoot"] == _Machine.work_root)

    skill_ctx = {"skills": [
        {"name": "delivery-check", "path": r"/opt/server/skills/delivery-check"},
        {"name": "server-only", "path": r"/opt/server/skills/server-only"},
    ]}
    runner_main._localize_skills(skill_ctx)
    chk("技能·服务端绝对路径会换成 runner 本机目录",
        len(skill_ctx["skills"]) == 1 and os.path.isdir(skill_ctx["skills"][0]["path"]), skill_ctx)
    chk("技能·runner 本机不存在的技能不传给 CLI",
        all(s.get("name") != "server-only" for s in skill_ctx["skills"]))

    mcp_cfg = {"servers": {"演示": {"command": "node", "args": [], "env": {"TOKEN": "只在内存"}}}}
    env = local_base._env_for(local_base._PROFILES["claude"], {"mcpConfig": mcp_cfg})
    chk("MCP·远程配置经环境变量注入、不需要服务端文件路径",
        json.loads(env.get("SODUWORK_MCP_SERVERS_JSON") or "{}").get("servers", {}).get("演示", {}).get("env", {}).get("TOKEN") == "只在内存")

    open_root = tempfile.mkdtemp(prefix="smoke-rjob-open-")
    _TMP.append(open_root)
    open_ref, opened = "smoke-open-ref", []
    with ai_local._LOCK:
        ai_local._RUNS[open_ref] = {"ws": open_root, "state": "done", "cli": "pi"}
    old_open = runner_main._open_dir
    runner_main._open_dir = lambda path: opened.append(path)
    try:
        machine = runner_main.Runner(HUB, "", "", "smoke")
        res = await machine._job({"op": "job.open_dir", "ref": open_ref})
        chk("目录·打开动作发生在 runner 且只用执行单自己的路径",
            res.get("ok") and opened == [open_root], (res, opened))
    finally:
        runner_main._open_dir = old_open
        with ai_local._LOCK:
            ai_local._RUNS.pop(open_ref, None)

    owned = type("Owned", (), {"client_id": "mine", "busy": 0, "connected_at": 1,
                                "tags": [runner_hub.CLIENT_TAG]})()
    other = type("Other", (), {"client_id": "other", "busy": 0, "connected_at": 0,
                                "tags": [runner_hub.CLIENT_TAG]})()
    old_online = runner_hub.online
    runner_hub.online = lambda: [other, owned]
    try:
        chk("助手安装·机器级操作只挑当前桌宠自己的 runner",
            runner_hub.for_client("mine") is owned and runner_hub.for_client("absent") is None)
    finally:
        runner_hub.online = old_online

    old_node, old_detect = agent_setup.node_env, agent_setup.detect_all
    old_install, old_job, old_config = agent_setup.start_install, agent_setup.job, agent_setup.configure
    agent_setup.node_env = lambda: {"ok": True, "host": "桌宠电脑", "node": "v24", "npm": "11"}
    agent_setup.detect_all = lambda **kw: [{"key": "pi", "installed": False,
                                            "hasModel": kw.get("has_model")}]
    agent_setup.start_install = lambda key, action: "local-job"
    agent_setup.job = lambda jid: {"id": jid, "state": "done", "ok": True}
    agent_setup.configure = lambda key, llm: {"ok": True, "detail": "本机配好了"}
    try:
        machine = runner_main.Runner(HUB, "", "", "smoke")
        inventory_updates = []

        async def refresh_agents(force=False):
            inventory_updates.append(("refresh", force))

        async def report_beat():
            inventory_updates.append(("beat", True))

        machine._refresh_agents = refresh_agents
        machine._report_beat = report_beat
        setup = await machine._agent({"op": "agent.setup", "hasModel": True})
        install = await machine._agent({"op": "agent.install", "key": "pi", "action": "install"})
        job = await machine._agent({"op": "agent.job", "jobId": "local-job"})
        await machine._agent({"op": "agent.job", "jobId": "local-job"})
        configured = await machine._agent({"op": "agent.configure", "key": "pi", "llm": {}})
        chk("助手安装·探测/安装/作业/配置都在 runner 进程执行",
            setup.get("data", {}).get("env", {}).get("host") == "桌宠电脑"
            and install.get("data", {}).get("jobId") == "local-job"
            and job.get("data", {}).get("state") == "done"
            and configured.get("data", {}).get("detail") == "本机配好了")
        chk("★★安装完成立即刷新能力并上报，连续轮询不会重复上报",
            inventory_updates == [("refresh", True), ("beat", True)], inventory_updates)
    finally:
        agent_setup.node_env, agent_setup.detect_all = old_node, old_detect
        agent_setup.start_install, agent_setup.job = old_install, old_job
        agent_setup.configure = old_config


# Exercise real APIs against the running backend.
def t_live():
    st, d = http("/ai-agents")
    if st != 200:
        chk("真接口·拿到收件人名单", False, "%s %s" % (st, d))
        return
    agents = d.get("agents") or []
    chk("真接口·拿到收件人名单", True)
    api_local_ids = {a.get("id") for a in agents if str(a.get("id", "")).startswith("local:")}
    chk("真接口·员工清单不回落到 Hub 本机 CLI", not api_local_ids, api_local_ids)
    remote = [a for a in agents if str(a.get("id", "")).startswith("runner:")]
    st2, rs = http("/runners")
    online = [r for r in (rs.get("runners") or []) if r.get("online")]
    own = [r for r in online if r.get("clientId") == CID
           and "soduwork-client" in set(r.get("tags") or []) and r.get("agents")]
    if not own:
        chk("真接口·当前测试设备没有 Runner 时不冒充别人的 Agent", not remote,
            [a.get("id") for a in remote])
        return
    allowed_runner_ids = {r.get("runnerId") for r in own}
    actual_runner_ids = {str(a.get("id") or "").split(":", 2)[1] for a in remote}
    chk("真接口·只列当前设备内置 Runner 的 Agent",
        bool(remote) and actual_runner_ids <= allowed_runner_ids,
        (allowed_runner_ids, actual_runner_ids))
    if not remote:
        return
    a = remote[0]
    chk("真接口·名字带机器名且标为远程执行", "·" in str(a.get("name", ""))
        and a.get("remote") is True and a.get("local") is False, a)
    t0 = time.time()
    http("/ai-agents")
    chk("真接口·列名单不慢（有执行机时也得在 3 秒内）", (time.time() - t0) < 3.0,
        "%.1fs" % (time.time() - t0))


async def main():
    await seed()
    try:
        t_routing()
        t_cfg()
        t_artifact_isolation()
        t_where_cache()
        t_dispatch_receipt()
        t_contract()
        await t_safety_and_inputs()
        t_live()
    finally:
        await purge()
    print("\n".join(log))
    print("\n%d 通过 / %d 失败" % (ok, fail))
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
