"""Isolated real Runner dispatch/stop/session/comment chain; synthetic vendor only."""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path

from steering_readiness import read_pid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
agent, work = sys.argv[1], Path(sys.argv[2]).resolve()
os.environ["SODUWORK_DATA_ROOT"] = str(work / "data")
os.environ["PYTHONIOENCODING"] = "utf-8"
os.environ["SODUWORK_LOCAL_STALL_RETRIES"] = "0"
if "--stop-followup" in sys.argv:
    os.environ["SODUWORK_STEER_STOP_FOLLOWUP"] = "1"

from app.services import local_base, local_stream, local_process, acp_agents
import runner_main


async def run():
    workspace = work / "workspace"
    workspace.mkdir(parents=True)
    attachment = work / "note.txt"
    attachment.write_text("attached evidence", encoding="utf-8")
    profile = local_base._PROFILES[agent]
    profile["bin"] = lambda: sys.executable
    profile.pop("runtime_probe", None)
    profile.pop("runtime_issue", None)
    original_argv = local_base._command_argv
    peer = str(Path(__file__).with_name("steering_native_peer.py"))
    commands = []
    if acp_agents.CATALOG.get(agent, {}).get("launch") == "node":
        # The vendor boundary is synthetic; retain production bridge construction
        # without reading an installed adapter or the developer's account files.
        acp_agents.agent_npm_runtime.package_entry = lambda *_args: peer
        acp_agents.agent_npm_runtime.node_env = lambda *_args: {
            "ok": True, "nodePath": sys.executable,
        }

    def argv(exe, args, ws, cfg, prof):
        # Preserve production profile/session arguments and the complete real
        # ACP bridge. Replace only the final model-bearing vendor executable.
        if agent == "opencode":
            sid = args[args.index("--session") + 1] if "--session" in args else ""
            actual = acp_agents.command_argv(agent, exe, acp_agents.run_args(sid, "work", ws, cfg), ws, cfg)
        else:
            actual = original_argv(exe, args, ws, cfg, prof)
        commands.append(actual)
        if agent == "harness2":
            entry = str(Path(__file__).with_name("steering_harness2_entry.py"))
            return [actual[0], entry, *actual[2:]]
        if agent == "opencode" or agent in acp_agents.CATALOG:
            split = actual.index("--")
            return [*actual[:split + 1], sys.executable, peer, agent, "--acp-fixture"]
        return [sys.executable, peer, agent, *args]

    local_process._command_argv = argv
    # Never read/copy account credentials or contact any configured model. The
    # peer's model boundary is synthetic; broker/process/spool are unmodified.
    local_process._env_for = lambda *_args, **_kwargs: dict(os.environ)
    if agent == "harness2":
        from app.services import harness2_runtime

        def harness_environment(*_args, **_kwargs):
            return {**os.environ, harness2_runtime.MODEL_ENV: "{}",
                    harness2_runtime.EXECUTOR_ENV: sys.executable,
                    harness2_runtime.ROOT_ENV: str(work / "harness2")}

        local_process._env_for = harness_environment
    local_stream._llm_gate_check = lambda *_args: ""
    machine = runner_main.Runner("http://127.0.0.1:1", "fixture", "fixture", "fixture", str(workspace))
    # Exercise steering through real admission without depending on host load.
    # Keep the production budget calculation; only machine facts are synthetic.
    machine._resource_budget.sampler = lambda: {
        "cpuCount": 8, "cpuPercent": 20.0,
        "memoryTotalBytes": 16 * 1024**3, "memoryAvailableBytes": 12 * 1024**3,
    }
    refs = set()

    async def until(check, seconds=15):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            value = await check()
            if value:
                return value
            await asyncio.sleep(.05)
        states = {key: {name: value.get(name) for name in ("state", "error", "cliSid", "round")}
                  for key, value in local_base._RUNS.items()}
        raise AssertionError(f"Runner timed out: {states}")

    async def session(ref):
        return (await machine._job({"op": "job.session", "ref": ref, "limit": 1000}))["data"]

    try:
        if "--dialogue" in sys.argv:
            from runner_dialogue_checks import exercise
            await exercise(machine, agent, workspace, until, refs)
            return
        started = await machine._job({"op": "job.dispatch", "cli": agent, "dispatchId": "fixture-" + agent,
            "task": {"id": "fixture-" + agent, "title": "STEER_FIRST", "note": "STEER_FIRST"},
            "ctx": {"workDir": str(workspace), "workRoot": str(workspace), "conversationMode": "adaptive",
                    "conversationUserText": "STEER_FIRST"}, "cfg": {}})
        assert started["ok"], started
        ref = started["data"]["ref"]
        refs.add(ref)

        async def ready():
            data = await session(ref)
            pid = read_pid(workspace / "first-ready")
            return (data, pid) if pid and data.get("cliSid") else None
        first, original_pid = await until(ready)
        sid = first["cliSid"]
        stopped = await machine._job({"op": "job.stop", "ref": ref})
        assert stopped["ok"] and stopped["data"]["ok"], stopped

        async def terminal():
            data = await session(ref)
            return data if data.get("status") == "stopped" else None
        ended = await until(terminal)
        assert ended["error"] == "你把它叫停了", ended
        assert not local_base._pid_alive(original_pid), "vendor process must exit before follow-up"
        for marker in ("STEER_NOW", "STEER_LATER"):
            before = local_base._RUNS[ref]["round"]
            message = {"op": "job.comment", "ref": ref, "text": marker, "recordUser": True,
                       "turnId": marker + agent, "cfg": {}, "_localParent": True}
            if marker == "STEER_NOW":
                message["localFiles"] = [{"path": str(attachment), "filename": "note.txt", "contentType": "text/plain"}]
            replied = await machine._job(message)
            assert replied["ok"], replied
            if marker == "STEER_NOW" and "--stop-followup" in sys.argv:
                async def followup_ready():
                    data = await session(ref)
                    pid = read_pid(workspace / "followup-ready")
                    return (data, pid) if pid and data.get("status") == "running" else None
                _, followup_pid = await until(followup_ready)
                assert (await machine._job({"op": "job.stop", "ref": ref}))["data"]["ok"]
                observed = await session(ref)
                assert observed.get("cliSid") == sid, ("admission cancellation must not hide native session/events", observed)
                assert not (observed["status"] in {"stopped", "cancelled"} and local_base._RUNS[ref]["state"] == "running"), "stop ACK is not a process terminal"
                await until(terminal)
                assert not local_base._pid_alive(followup_pid)
                continue
            async def complete():
                data = await session(ref)
                if data.get("status") == "failed":
                    raise AssertionError(data)
                return data if data.get("status") == "done" and data.get("round", 0) > before else None
            latest = await until(complete)
            assert latest["cliSid"] == sid
            assert not latest["error"], latest
        rows = [json.loads(x) for x in (workspace / "peer.jsonl").read_text(encoding="utf-8").splitlines()]
        prompts = [x for x in rows if x["event"] == "prompt"]
        assert [x["label"] for x in prompts] == ["STEER_FIRST", "STEER_NOW", "STEER_LATER"], prompts
        assert len({x["sid"] for x in prompts}) == 1
        assert (workspace / "once.txt").read_text() == "one operation\n"
        assert len(commands) == 3, commands
        # A later admission failure must still win over the previous native
        # turn's done state. This fails before comment_sync/launch, for real.
        refused = await machine._job({"op": "job.comment", "ref": ref,
            "text": "SHOULD_NOT_START", "turnId": "failed-preflight-" + agent,
            "_localParent": True, "localFiles": [{"path": str(work / "absent.txt"), "filename": "absent.txt"}]})
        assert refused["ok"], refused  # admitted first; then actual preflight fails
        async def preflight_failed():
            value = await session(ref)
            return value if value.get("status") == "failed" else None
        rejected = await until(preflight_failed)
        # Snapshot retrieval succeeded; the refused turn remains failed while
        # earlier accepted messages and its native session stay readable.
        assert rejected["ok"] is True and rejected["error"], rejected
        assert rejected.get("cliSid") == sid, rejected
        retained = [item.get("text") for item in rejected["items"] if item.get("kind") == "user"]
        assert "STEER_FIRST" in retained and "STEER_LATER" in retained, rejected
        assert "SHOULD_NOT_START" not in retained, rejected
        assert len(commands) == 3, "failed preflight must not start another process"
        print(json.dumps({"ok": True, "agent": agent, "prompts": [x["label"] for x in prompts],
                          "terminal": ended["status"], "sameNativeSession": True,
                          "realAttachment": True, "processTreeStopped": True, "followupStopped": "--stop-followup" in sys.argv,
                          "preflightFailureVisible": True,
                          "resumeMethods": [x["method"] for x in rows if x["event"] == "acp" and x["method"] in {"session/load", "session/resume"}]}, ensure_ascii=False))
    finally:
        for ref in refs:
            if local_stream.is_running(ref):
                await asyncio.to_thread(local_stream.stop_sync, {}, ref)
        if machine._admission_task:
            machine._admission_task.cancel()
            await asyncio.gather(machine._admission_task, return_exceptions=True)
        await asyncio.gather(*machine._admission_workers, return_exceptions=True)
        for thread in list(local_base._THREADS):
            await asyncio.to_thread(thread.join, 3)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    asyncio.run(run())
