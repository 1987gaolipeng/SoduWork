# -*- coding: utf-8 -*-
"""Offline script/tool executor tests: scripts reuse isolated Runner quality transport,
configuration failures do not trigger rework, and tools require trusted registry entries.
Exercise HTTP checks against a real local server.
"""
import asyncio
import http.server
import os
import sys
import threading

DB = os.path.abspath(".smoke-scripttool.db")
for sfx in ("", "-shm", "-wal"):
    try:
        os.remove(DB + sfx)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from app import automation_models as am  # noqa: E402
from app import models  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.services import (runner_hub, workflow_contracts,  # noqa: E402
                          workflow_engine, workflow_runs, workflow_tools)

ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:260] if extra else ""))


class _Srv(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/ok":
            body = "宣传站已就绪 ready".encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *a):
        pass


async def t_tool():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Srv)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % srv.server_address[1]
    async with SessionLocal() as s:
        task = models.Task(id="t-tool", title="工具冒烟", owner_client_id="c-st", status="doing")

        # Reject unregistered tool names as configuration errors.
        try:
            await workflow_tools.execute(s, task, {"config": {"tool": "rm_rf_slash"}})
            chk("tool·未登记的工具被拒", False, "居然执行了")
        except workflow_contracts.WorkflowConfigurationError as e:
            chk("tool·未登记的工具被拒（配置错误，不回卷）", "受信名单" in str(e), str(e)[:80])

        # Perform a real local HTTP check.
        out = await workflow_tools.execute(s, task, {"config": {
            "tool": "http_check", "args": {"url": base + "/ok", "contains": "ready"}}})
        chk("tool·http_check 200+包含断言通过", out["result"]["status"] == 200
            and out["result"]["matched"] == "ready", out)
        try:
            await workflow_tools.execute(s, task, {"config": {
                "tool": "http_check", "args": {"url": base + "/miss"}}})
            chk("tool·http_check 404 判失败", False, "居然过了")
        except ValueError as e:
            chk("tool·http_check 404 判失败（运行失败，可重试）", "404" in str(e), str(e))
        try:
            await workflow_tools.execute(s, task, {"config": {
                "tool": "http_check", "args": {"url": "file:///etc/passwd"}}})
            chk("tool·http_check 只认 http(s)", False)
        except workflow_contracts.WorkflowConfigurationError:
            chk("tool·http_check 只认 http(s)（file:// 之类拒绝）", True)

        # Verify notification fan-out with captured transport calls.
        from app import realtime
        sent = []

        async def fake_pub(cid, msg, *, user_id=None):
            sent.append((cid, msg))
        real_pub = realtime.hub.publish
        realtime.hub.publish = fake_pub
        try:
            out = await workflow_tools.execute(s, task, {"config": {
                "tool": "notify", "args": {"message": "该看一眼了"}}})
            chk("tool·notify 发给任务归属 SoduWork", sent and sent[0][0] == "c-st"
                and "该看一眼" in sent[0][1]["text"], sent)
        finally:
            realtime.hub.publish = real_pub
        try:
            await workflow_tools.execute(s, task, {"config": {"tool": "notify", "args": {}}})
            chk("tool·notify 缺 message 判配置错", False)
        except workflow_contracts.WorkflowConfigurationError:
            chk("tool·notify 缺 message 判配置错", True)
    srv.shutdown()


async def t_script():
    await init_db()
    async with SessionLocal() as s:
        s.add(models.Client(id="c-st", name="机"))
        s.add(models.Project(id="p-st", name="项目", owner_user_id="u1"))
        s.add(models.Repo(id="r-st", project_id="p-st", name="仓", git_url="https://x/r.git",
                          default_branch="main", merge_branch="main",
                          server_dir=r"C:\srv\r"))
        s.add(models.Task(id="t-st", title="脚本冒烟", status="doing",
                          owner_client_id="c-st", project_id="p-st", repo_id="r-st"))
        s.add(models.Task(id="t-st-norepo", title="没仓库", status="doing",
                          owner_client_id="c-st", project_id="p-st"))
        s.add(am.ArtifactVersion(id="av-st", task_id="t-st", seq=1, kind="code",
                                 commit_sha="cafe1234", branch="feat/x", target="main",
                                 checksum="ck", state="merged"))
        run = am.WorkflowRun(id="run-st", task_id="t-st", plugin_id="pl", plugin_version_id="pv",
                             binding_id="b", state="running")
        s.add(run)
        await s.commit()

    node = {"key": "build", "type": "script",
            "config": {"commands": [{"name": "构建", "argv": ["echo", "hi"],
                                     "timeoutSeconds": 60}]}}

    # Configuration failures must not trigger business rework.
    async with SessionLocal() as s:
        run = await s.get(am.WorkflowRun, "run-st")
        task = await s.get(models.Task, "t-st")
        nr = am.NodeRun(id="n-s0", run_id="run-st", node_key="build", node_type="script",
                        attempt=1, state="dispatching", idempotency_key="run-st:build:1")
        s.add(nr)
        try:
            await workflow_engine._start_script(s, run, task, nr,
                                                {"key": "build", "type": "script", "config": {}})
            chk("script·没声明命令判配置错", False)
        except workflow_contracts.WorkflowConfigurationError:
            chk("script·没声明命令判配置错（不回卷）", True)
        t2 = await s.get(models.Task, "t-st-norepo")
        try:
            await workflow_engine._start_script(s, run, t2, nr, node)
            chk("script·没绑仓库判配置错", False)
        except workflow_contracts.WorkflowConfigurationError as e:
            chk("script·没绑仓库判配置错（提示用 tool 节点）", "tool 节点" in str(e), str(e))

    # Verify dispatch specs and waiting_external state.
    calls = []
    pick_requirements = []

    class _R:
        id, host = "runner-st", "ST-PC"

        def alive(self):
            return True

    real_pick, real_call = runner_hub.pick_for, runner_hub.call_sync
    def _pick(owner, cli="", allowed_client_ids=None, required_capabilities=None,
              **kwargs):
        # Selection fixtures accept evolving optional scope arguments.
        # Keep assertions focused on capability routing while preserving the real call shape.
        pick_requirements.append(list(required_capabilities or []))
        return _R()

    runner_hub.pick_for = _pick
    runner_hub.call_sync = lambda r, op, data, timeout=60: (
        calls.append((op, data)) or {"ok": True, "state": "running"})
    try:
        async with SessionLocal() as s:
            run = await s.get(am.WorkflowRun, "run-st")
            task = await s.get(models.Task, "t-st")
            nr = am.NodeRun(id="n-s1", run_id="run-st", node_key="build", node_type="script",
                            attempt=1, state="dispatching", idempotency_key="run-st:build:2")
            s.add(nr)
            await workflow_engine._start_script(s, run, task, nr, node)
            chk("script capability contract", pick_requirements == [["repository", "terminal"]],
                pick_requirements)
            spec = calls[0][1]["spec"]
            chk("script·走 quality 通道（Runner 零改动）", calls[0][0] == "quality.start", calls)
            chk("script·spec 钉住获批提交与命令原文",
                spec["repository"]["commit"] == "cafe1234"
                and spec["commands"][0]["argv"] == ["echo", "hi"], spec)
            chk("script·派发后 waiting_external + executor.kind=script",
                nr.state == "waiting_external"
                and (nr.executor or {}).get("kind") == "script", (nr.state, nr.executor))
            await s.commit()

        # Use the shared polling path to settle script waiting_external state.
        runner_hub.get = lambda rid: _R() if rid == "runner-st" else None
        runner_hub.call_sync = lambda r, op, data, timeout=60: {
            "ok": True, "state": "succeeded",
            "result": {"checks": [{"name": "构建", "ok": True, "output": "hi"}]},
            "log": "hi"}
        async with SessionLocal() as s:
            run = await s.get(am.WorkflowRun, "run-st")
            nr = await s.get(am.NodeRun, "n-s1")
            await workflow_engine._poll_node(s, run, nr)
            chk("script·核对分支收口 succeeded + 逐条证据",
                nr.state == "succeeded"
                and (nr.output or {}).get("checks") == [
                    {"name": "构建", "ok": True, "output": "hi"}], (nr.state, nr.output))
    finally:
        runner_hub.pick_for, runner_hub.call_sync = real_pick, real_call

    chk("script/tool 都在「重试这一关」白名单里",
        {"script", "tool"} <= workflow_runs.RETRYABLE_GATE_TYPES)


async def main():
    await t_script()
    await t_tool()
    print(f"\n{ok} PASS / {fail} FAIL")
    return fail


if __name__ == "__main__":
    sys.exit(1 if asyncio.run(main()) else 0)
