"""Verify installed Qwen ACP outcomes using only disposable state and loopback.

Select the installed code with --qwen-package and --node. No model credentials
or personal Qwen settings are read. A Node preload rejects non-loopback sockets.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

SCENARIOS = ("compatibility", "explicit-limit", "recovery-exhausted", "recovery-success",
             "recovery-error", "stop", "truncated-tool", "repeated-truncated-tool")
MODEL = "soduwork-qwen-outcome-fixture"
KEY = "soduwork-loopback-only-fixture"
FINAL = "FIXTURE_COMPLETE"
ERROR = "SYNTHETIC_QWEN_RECOVERY_HTTP_404"


def isolated_environment(root: Path, node: Path) -> dict:
    env = {"PATH": str(node.parent) + os.pathsep + os.defpath,
           "DATABASE_URL": "sqlite+aiosqlite:///:memory:",
           "AUTH_SECRET": "isolated-qwen-outcome-fixture",
           "SODUWORK_DATA_ROOT": str(root / "runner"),
           "QWEN_CODE_MODELS_DEV": "off", "QWEN_CODE_MODELS_DEV_REFRESH": "off",
           "QWEN_CODE_SYSTEM_SETTINGS_PATH": str(root / "operator.json"),
           "QWEN_CODE_SYSTEM_DEFAULTS_PATH": str(root / "defaults.json"),
           "HTTP_PROXY": "", "HTTPS_PROXY": "", "ALL_PROXY": "",
           "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost",
           "LANG": "en_US.UTF-8", "CI": "1", "PYTHONDONTWRITEBYTECODE": "1"}
    for name in ("SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"):
        if os.environ.get(name):
            env[name] = os.environ[name]
    for name in ("HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TMP", "TEMP",
                 "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"):
        folder = root / name
        folder.mkdir()
        env[name] = str(folder)
    (root / "operator.json").write_text(json.dumps({
        "telemetry": {"enabled": False}, "general": {"enableAutoUpdate": False},
        "security": {"auth": {"selectedType": "openai"}},
    }), encoding="utf-8")
    (root / "defaults.json").write_text("{}", encoding="utf-8")
    guard = root / "loopback-only.cjs"
    guard.write_text("""'use strict';
const net = require('node:net');
require('node:fs').writeFileSync(require('node:path').join(__dirname, 'loopback-guard.loaded'), 'ok');
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = first && typeof first === 'object' ? first : {
    port: first, host: typeof args[1] === 'string' ? args[1] : 'localhost'
  };
  if (options.path || !['localhost', '127.0.0.1', '::1'].includes(String(options.host || 'localhost')))
    throw Error('E2E_EXTERNAL_CONNECTION_BLOCKED');
  return original.apply(this, args);
};
""", encoding="utf-8")
    return env


def run_compatibility(args, root: Path) -> dict:
    """Validate native callback compatibility before running any package code."""
    from app.services import qwen_runtime

    root.mkdir()
    env = isolated_environment(root, args.node)
    qwen_runtime.apply_env(env)
    package = root / "Fixture 空间" / "node_modules" / "@qwen-code" / "qwen-code"
    chunks = package / "chunks"
    chunks.mkdir(parents=True)
    shutil.copyfile(args.qwen_package / "package.json", package / "package.json")
    for name in ("acpAgent-DYVOMNZP.js", "chunk-WG5L7ABP.js", "chunk-KXSZYB5L.js"):
        shutil.copyfile(args.qwen_package / "chunks" / name, chunks / name)
    sentinel = "SODUWORK_QWEN_FIXTURE_ENTRY_EXECUTED"
    entry = package / "cli.js"
    entry.write_text("console.log(" + json.dumps(sentinel) + ");\n", encoding="utf-8")
    command = [str(args.node), "--require", str(root / "loopback-only.cjs"), str(entry)]
    callback = chunks / "chunk-KXSZYB5L.js"
    original = callback.read_bytes()
    reports = []
    for case in ("valid", "changed-callback", "renamed-callback"):
        if case == "changed-callback":
            callback.write_bytes(original + b"\n// fixture compatibility mutation\n")
        elif case == "renamed-callback":
            callback.write_bytes(original)
            callback.rename(callback.with_suffix(".renamed"))
        result = subprocess.run(command, cwd=root, env=env, capture_output=True,
                                text=True, encoding="utf-8", errors="replace",
                                timeout=min(args.timeout, 20))
        if case == "valid":
            assert result.returncode == 0 and result.stdout.strip() == sentinel, (
                case, result.returncode, result.stderr[-1200:])
        else:
            assert result.returncode != 0, (case, "Incompatible native callback was accepted")
            assert "Qwen Code ACP outcome interface is unsupported" in result.stderr, (
                case, result.stderr[-1200:])
            assert sentinel not in result.stdout + result.stderr, (case, "Package entrypoint ran before validation")
        reports.append({"case": case, "exit": result.returncode,
                        "entryExecuted": sentinel in result.stdout})
    return {"scenario": "compatibility", "cases": reports,
            "packagePathWithSpacesAndUnicode": True}


class Fixture:
    def __init__(self, scenario: str, work: Path):
        self.scenario = scenario
        self.work = work
        self.calls = []
        self.failures = []
        self.lock = threading.Lock()
        self.abort = None

    def response(self, body: dict):
        assert body.get("model") == MODEL, "Wrong model route"
        assert body.get("stream") is True, "Expected a streaming model request"
        latest = next((message.get("content") for message in reversed(body["messages"])
                       if message.get("role") == "user"), "")
        # The pinned native runtime runs an independent memory-writing query
        # after a foreground turn. Its successful STOP must not clear a main
        # response's output limit. This matching exists only in the fake model.
        memory = "Managed memory has TWO directories" in json.dumps(latest)
        with self.lock:
            number = 1 + sum(not call["memory"] for call in self.calls)
            self.calls.append({"memory": memory, "maxTokens": body.get("max_tokens"),
                               "messageCount": len(body["messages"]),
                               "status": 404 if not memory and self.scenario == "recovery-error"
                               and number >= 3 else 200})
            excessive = len(self.calls) > 20
        if excessive:
            # Do not return another HTTP error to an unexpectedly retrying
            # runtime: stop its owned process immediately after the hard bound.
            self.failures.append("Fixture exceeded its 20-request hard limit")
            if self.abort:
                self.abort()
            return None, "error"
        if memory or self.scenario == "stop" or (
                self.scenario == "recovery-success" and number > 1):
            return {"role": "assistant", "content": FINAL}, "stop"
        if self.scenario == "recovery-error" and number >= 3:
            return None, "error"
        if self.scenario == "repeated-truncated-tool" or (self.scenario == "truncated-tool" and number == 1):
            arguments = json.dumps({"file_path": str(self.work / "never-written.txt"),
                                    "content": "TRUNCATED_ARGUMENT_MUST_NOT_EXECUTE"})[:-2]
            return {"role": "assistant", "tool_calls": [{"index": 0, "id": f"partial-{number}",
                "type": "function", "function": {"name": "write_file", "arguments": arguments}}]}, "length"
        return {"role": "assistant", "content":
                f"Partial fixture response {number}. This sentence remains unfinished"}, "length"


def run_case(args, root: Path, scenario: str) -> dict:
    root.mkdir()
    env = isolated_environment(root, args.node)
    work = root / "work"
    work.mkdir()
    preserved = work / "existing.txt"
    preserved.write_text("Previously completed work.\n", encoding="utf-8")
    before = (preserved.read_bytes(), preserved.stat().st_mtime_ns)
    fixture = Fixture(scenario, work)

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            try:
                assert self.path == "/v1/chat/completions", "Unexpected model API path"
                assert self.headers.get("Authorization") == "Bearer " + KEY, "Wrong fixture credential"
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                delta, finish = fixture.response(body)
                if finish == "error":
                    raw = json.dumps({"error": {"message": ERROR,
                                               "type": "invalid_request_error"}}).encode()
                    self.send_response(404)
                    self.send_header("Content-Type", "application/json")
                else:
                    frames = [{"id": "fixture-response", "object": "chat.completion.chunk",
                               "created": 1, "model": MODEL,
                               "choices": [{"index": 0, "delta": change, "finish_reason": reason}]}
                              for change, reason in ((delta, None), ({}, finish))]
                    raw = ("".join("data: " + json.dumps(frame) + "\n\n" for frame in frames)
                           + "data: [DONE]\n\n").encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(raw)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(raw)
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as exc:
                fixture.failures.append(str(exc))
                self.close_connection = True

    server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    cfg = {"llm": {"base": f"http://127.0.0.1:{server.server_port}/v1", "key": KEY,
                   "model": MODEL, "input": ["text"]}}
    # Import only after the first private environment exists; some local service
    # modules establish their store paths when imported.
    with patch.dict(os.environ, env, clear=True):
        from app.services import acp_agents, acp_bridge, local_base, local_stream, local_turn_outcome
        from app.services.acp_process import kill_process_tree
        with patch.object(local_base, "_data_root", return_value=str(root / "runner")):
            env = local_base._env_for(local_base._PROFILES["qwen"], cfg, scenario)
    if scenario in {"explicit-limit", "truncated-tool", "repeated-truncated-tool"}:
        env["QWEN_CODE_MAX_OUTPUT_TOKENS"] = "1024"
    # _env_for intentionally discards inherited NODE_OPTIONS. The fixture guard
    # is an explicit Node argument, independent of the production loader setup.
    argv = [str(args.node), "--require", str(root / "loopback-only.cjs"),
            str(args.qwen_package / "cli.js"), *acp_agents._agent_args("qwen", cfg)]
    bridge = acp_bridge.AcpBridge(argv, str(work), "qwen",
                                 "workspace" if "truncated-tool" in scenario else "readonly")
    events, replies = [], []
    request = bridge.request

    def observe_request(method, params):
        result = request(method, params)
        if method == "session/prompt":
            replies.append(result)
        return result

    bridge.request = observe_request
    timed_out = threading.Event()
    timeout_errors = []

    def stop_native():
        if bridge.proc is not None:
            try:
                kill_process_tree(bridge.proc, bridge.process_group)
            except Exception as exc:
                timeout_errors.append(str(exc))

    fixture.abort = stop_native

    def expire():
        timed_out.set()
        stop_native()

    timer = threading.Timer(args.timeout, expire)
    timer.daemon = True
    code, failure = 2, ""
    try:
        timer.start()
        with patch.dict(os.environ, env, clear=True), patch.object(acp_bridge, "_emit", side_effect=events.append):
            try:
                code = bridge.run("Reply briefly without tools. Keep existing.txt unchanged.")
            except acp_bridge.BridgeError as exc:
                failure = acp_bridge._friendly_bridge_error("qwen", str(exc))
                # Match the production entry's error event; retain native errors
                # instead of using a subprocess return code as their substitute.
                events.append({"type": "error", "error": {"name": "AcpBridgeError", "message": failure}})
    finally:
        timer.cancel()
        timer.join(timeout=6)
        bridge.close()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
    assert not timed_out.is_set(), (scenario, "Native Qwen exceeded the deadline", timeout_errors)
    assert not fixture.failures, (scenario, fixture.failures)
    assert fixture.calls, (scenario, "Native Qwen made no model requests", failure)
    assert (root / "loopback-guard.loaded").read_text(encoding="utf-8") == "ok", "Network guard did not load"
    assert (preserved.read_bytes(), preserved.stat().st_mtime_ns) == before, "Existing work changed"
    assert not (work / "never-written.txt").exists(), "Truncated tool arguments were executed"
    assert KEY not in json.dumps(events), "Fixture credential leaked into normalized output"
    ref = "qwen-outcome-" + scenario
    run = {"state": "running", "cli": "qwen", "ws": str(work), "seq": 0, "lines": [],
           "cfg": {}, "conversationMode": "adaptive", "turnStartSeq": 0}
    local_base._RUNS[ref] = run
    terminal = {}
    try:
        with patch.object(local_base, "_STORE", str(root / "store")):
            for event in events:
                local_stream._on_line(ref, json.dumps(event), terminal)
            with patch.object(local_stream, "_resume") as resume:
                local_stream._finish(ref, code, terminal, "")
            resume.assert_not_called()
        steps = [event.get("part", {}).get("reason") for event in events
                 if event.get("type") == "step_finish" and not event.get("contextOnly")]
        if scenario in {"explicit-limit", "recovery-exhausted", "truncated-tool"}:
            assert replies and replies[-1].get("stopReason") == "max_tokens", (scenario, replies, failure)
            assert replies[-1].get("_meta", {}).get("soduwork", {}).get("outputLimit") is True
            assert code == 2 and not failure and steps[-1:] == ["max_tokens"], (scenario, code, failure, steps)
            assert run["state"] == "failed" and run.get("failureKind") == "execution_incomplete", (scenario, run)
            assert run["error"] == local_turn_outcome.TRUNCATED
        elif scenario in {"recovery-error", "repeated-truncated-tool"}:
            # Qwen's ACP library deliberately redacts model failures to an
            # internal-error response. Check the actual failure, not its text.
            assert code != 0 and failure, (scenario, replies, failure)
            assert run["state"] == "failed" and run.get("failureKind") != "execution_incomplete", (scenario, run)
            assert run["error"] and run["error"] != local_turn_outcome.TRUNCATED
        else:
            assert replies and replies[-1].get("stopReason") == "end_turn", (scenario, replies, failure)
            assert code == 0 and not failure and run["state"] == "done", (scenario, run, failure)
            assert FINAL in json.dumps(events), "Final response was not delivered"
        main_calls = [call for call in fixture.calls if not call["memory"]]
        if scenario == "recovery-exhausted":
            assert len(main_calls) == 5, (scenario, fixture.calls)
        elif scenario == "recovery-error":
            assert len(main_calls) == 3, (scenario, fixture.calls)
            assert main_calls[-1]["status"] == 404, (scenario, fixture.calls)
        elif scenario == "recovery-success":
            assert len(main_calls) == 2, (scenario, fixture.calls)
        elif scenario in {"explicit-limit", "stop"}:
            assert len(main_calls) == 1, (scenario, fixture.calls)
        elif scenario == "truncated-tool":
            assert len(main_calls) == 2, (scenario, fixture.calls)
            previews = {event["part"]["callId"] for event in events
                        if event.get("type") == "tool_use"}
            completed = {event.get("toolCallId") for event in events
                         if event.get("type") == "tool_execution_end"}
            assert previews == {"partial-1"} and previews <= completed, "Truncated preview remained pending"
            assert not bridge.transition.busy(), "A settled native tool still blocks turn completion"
        elif scenario == "repeated-truncated-tool":
            assert len(main_calls) == 3, (scenario, fixture.calls)
            previews = {event["part"]["callId"] for event in events
                        if event.get("type") == "tool_use"}
            completed = {event.get("toolCallId") for event in events
                         if event.get("type") == "tool_execution_end"}
            assert previews == {"partial-1", "partial-2", "partial-3"} and previews <= completed
            assert not bridge.transition.busy(), "Loop protection left an unsettled tool preview"
        if scenario in {"explicit-limit", "recovery-exhausted"}:
            assert any(call["memory"] for call in fixture.calls), "Background STOP scope was not exercised"
        return {"scenario": scenario, "requests": fixture.calls,
                "stopReason": replies[-1].get("stopReason") if replies else "error",
                "exit": code, "state": run["state"], "failureKind": run.get("failureKind"),
                "existingWorkPreserved": True, "unexpectedFileAbsent": True}
    finally:
        local_base._RUNS.pop(ref, None)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--qwen-package", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--scenario", choices=SCENARIOS, action="append")
    parser.add_argument("--timeout", type=float, default=60)
    args = parser.parse_args()
    args.qwen_package = args.qwen_package.resolve(strict=True)
    args.node = args.node.resolve(strict=True)
    if not 5 <= args.timeout <= 120:
        parser.error("--timeout must be between 5 and 120 seconds")
    version = json.loads((args.qwen_package / "package.json").read_text(encoding="utf-8"))["version"]
    with tempfile.TemporaryDirectory(prefix="soduwork-qwen-outcome-") as scratch:
        root = Path(scratch).resolve()
        reports = [run_compatibility(args, root / scenario) if scenario == "compatibility"
                   else run_case(args, root / scenario, scenario) for scenario in args.scenario or SCENARIOS]
    print(json.dumps({"ok": True, "qwenVersion": version, "cases": reports}, indent=2))


if __name__ == "__main__":
    main()
