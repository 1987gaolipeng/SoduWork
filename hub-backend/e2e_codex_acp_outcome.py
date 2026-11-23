"""Verify an installed Codex ACP adapter through the production Python entry.

Model responses and the approval broker are synthetic loopback servers. Homes,
credentials, workspaces and files are disposable; installed adapter code is read
only. The fixture parent must be outside OS temporary roots, which Codex may
automatically allow writing. No real model or account is used.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

BACKEND = Path(__file__).resolve().parent
SCENARIOS = ("provider-error", "success-stop", "command-deny", "command-once", "file-deny", "file-once")
MODEL = "gpt-5.4"
TOKEN = "synthetic-approval-token"
COMMAND_OUTPUT = "SYNTHETIC_COMMAND_OUTPUT"
FILE_OUTPUT = "SYNTHETIC_FILE_WRITE\n"


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def shell_quote(value):
    return "'" + value.replace("'", "''") + "'" if os.name == "nt" else shlex.quote(value)


def tool_item(scenario, available, outside):
    """Use only native advertised tools; the shell also recognizes apply_patch."""
    tools = {item.get("name"): item for item in available}
    name = next((item for item in ("exec_command", "shell_command") if item in tools), None)
    require(name, "Native adapter did not advertise a supported command tool")
    key = "cmd" if name == "exec_command" else "command"
    if scenario.startswith("command"):
        code = ("from pathlib import Path; print(" + repr(COMMAND_OUTPUT) + "); "
                "Path(" + repr(str(outside)) + ").write_text('approved', encoding='utf-8')")
        command = ("& " if os.name == "nt" else "") + shell_quote(sys.executable) + " -c " + shell_quote(code)
        arguments = {key: command, "sandbox_permissions": "require_escalated",
                     "justification": "Fixture: approve writing this disposable file outside the workspace."}
        call_id = "fixture-command"
    else:
        patch_text = "*** Begin Patch\n*** Add File: " + str(outside) + "\n+" + FILE_OUTPUT + "*** End Patch"
        if tools.get("apply_patch", {}).get("type") == "custom":
            return {"id": "ct_fixture", "type": "custom_tool_call", "call_id": "fixture-patch",
                    "name": "apply_patch", "input": patch_text, "status": "completed"}
        command = ("apply_patch @'\n" + patch_text + "\n'@" if os.name == "nt" else
                   "apply_patch <<'SODUWORK_FIXTURE_PATCH'\n" + patch_text + "\nSODUWORK_FIXTURE_PATCH")
        arguments, call_id = {key: command}, "fixture-patch"
    return {"id": "fc_fixture", "type": "function_call", "call_id": call_id,
            "name": name, "arguments": json.dumps(arguments), "status": "completed"}


class Fixture:
    def __init__(self, scenario, outside):
        self.scenario, self.outside = scenario, outside
        self.calls, self.approvals, self.failures = [], [], []
        self.blocked_connections = []

    def handler(self):
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def reply(self, status, body):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(data)

            def do_CONNECT(self):
                # Native background discovery/telemetry may try external hosts.
                # Record and reject them locally; never tunnel the connection.
                fixture.blocked_connections.append(self.path)
                self.reply(403, {"error": "Only the fixture loopback endpoint is allowed"})

            def do_GET(self):
                fixture.failures.append("Unexpected GET: " + self.path)
                self.reply(404, {})

            def do_POST(self):
                try:
                    size = int(self.headers.get("Content-Length", "0"))
                    require(0 < size <= 4_000_000, "Invalid fixture request size")
                    payload = json.loads(self.rfile.read(size))
                    if self.path in ("/request", "/control", "/applied"):
                        require(self.headers.get("Authorization") == "Bearer " + TOKEN, "Invalid broker token")
                        if self.path == "/request":
                            fixture.approvals.append(payload)
                            require(len(fixture.approvals) == 1, "Repeated approval for one operation")
                            require(not fixture.outside.exists(), "Operation ran before broker approval")
                            result = {"decision": "once" if fixture.scenario.endswith("once") else "deny"}
                        elif self.path == "/control":
                            result = {"requested": False}
                        else:
                            result = {"ok": True}
                        self.reply(200, result)
                        return
                    require(self.path == "/v1/responses", "Unexpected model/proxy endpoint: " + self.path)
                    fixture.calls.append({"path": self.path, "model": payload.get("model")})
                    maximum = 2 if fixture.scenario.endswith("once") else 1
                    require(len(fixture.calls) <= maximum, "Unexpected replay/retry of the original model work")
                    require(payload.get("model") == MODEL, "Unexpected model")
                    if fixture.scenario == "provider-error":
                        self.reply(400, {"error": {"message": "Synthetic provider bad request",
                            "type": "invalid_request_error", "code": "bad_request"}})
                        return
                    if len(fixture.calls) == 1 and fixture.scenario not in ("provider-error", "success-stop"):
                        item = tool_item(fixture.scenario, payload.get("tools", []), fixture.outside)
                    else:
                        item = {"id": "msg_fixture", "type": "message", "role": "assistant", "status": "completed",
                                "content": [{"type": "output_text", "text": "SYNTHETIC_FINAL", "annotations": []}]}
                    response = {"id": "resp_fixture_" + str(len(fixture.calls)), "object": "response",
                        "created_at": 1, "model": MODEL, "status": "completed", "output": [item],
                        "usage": {"input_tokens": 5, "output_tokens": 3, "total_tokens": 8}}
                    events = [
                        {"type": "response.created", "response": {**response, "status": "in_progress", "output": []}},
                        {"type": "response.output_item.added", "output_index": 0, "item": {**item, "status": "in_progress"}},
                        {"type": "response.output_item.done", "output_index": 0, "item": item},
                        {"type": "response.completed", "response": response},
                    ]
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    for event in events:
                        self.wfile.write(("event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n").encode())
                    self.wfile.flush()
                except Exception as exc:
                    fixture.failures.append(str(exc))
                    self.reply(400, {"error": {"message": "Fixture failed: " + str(exc)}})

        return Handler


def isolated_env(root, node):
    for directory in ("home", "tmp", "data", "appdata", "localappdata"):
        (root / directory).mkdir()
    env = {key: os.environ[key] for key in ("SystemRoot", "WINDIR", "COMSPEC", "PATHEXT") if key in os.environ}
    env.update({"PATH": os.pathsep.join((str(node.parent), str(Path(sys.executable).parent), os.defpath)),
        "HOME": str(root / "home"), "USERPROFILE": str(root / "home"),
        "APPDATA": str(root / "appdata"), "LOCALAPPDATA": str(root / "localappdata"),
        "TMPDIR": str(root / "tmp"), "TMP": str(root / "tmp"), "TEMP": str(root / "tmp"),
        "LANG": "en_US.UTF-8", "CI": "1", "DATABASE_URL": "sqlite+aiosqlite:///:memory:",
        "AUTH_SECRET": "isolated-codex-fixture-secret", "ADMIN_PASS": "isolated-fixture-password",
        "SODUWORK_DATA_ROOT": str(root / "data"), "NO_PROXY": "127.0.0.1,localhost,::1"})
    return env


def install_guard(root, env):
    guard, receipts = root / "loopback-only.cjs", root / "node-receipts.jsonl"
    guard.write_text("""'use strict';
const fs = require('node:fs'), net = require('node:net');
fs.appendFileSync(process.env.SODUWORK_CODEX_FIXTURE_PIDS, JSON.stringify({pid: process.pid, parent: process.ppid}) + '\\n');
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
    env["SODUWORK_CODEX_FIXTURE_PIDS"] = str(receipts)
    env["NODE_OPTIONS"] = (env.get("NODE_OPTIONS", "") + " --require=" + json.dumps(str(guard))).strip()
    return receipts


def stop_owned_adapter(receipts, bridge_pid):
    if not receipts.exists():
        return
    for line in receipts.read_text(encoding="utf-8").splitlines():
        receipt = json.loads(line)
        pid = receipt["pid"]
        # Only the Node process spawned directly by this Python bridge owns
        # the separate adapter group. Do not discover unrelated groups.
        if receipt["parent"] != bridge_pid:
            continue
        require(isinstance(pid, int) and pid > 1 and pid != os.getpid(), "Invalid process receipt")
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], timeout=5, check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            try:
                require(os.getpgid(pid) == pid, "Adapter no longer owns its recorded process group")
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


def verify(report, outside):
    scenario = report["scenario"]
    require(not report["fixtureFailures"], "Synthetic server failed")
    require(not report["stderr"], "Bridge wrote unexpected stderr")
    require(len(report["requests"]) == (2 if scenario.endswith("once") else 1), "Wrong model request count")
    errors = [event["error"] for event in report["events"] if event.get("error")]
    failed = scenario == "provider-error" or scenario.endswith("deny")
    require(report["bridgeExit"] == (2 if failed else 0), "Wrong bridge exit")
    require(report["localState"] == ("failed" if failed else "done"), "Wrong stored runner state")
    require(len(errors) == (1 if failed else 0), "Wrong terminal error count")
    if scenario == "provider-error":
        require("Synthetic provider bad request" in errors[0]["message"], "Original provider diagnostic was lost")
    if failed:
        require(not outside.exists(), "Rejected operation wrote a file")
    else:
        text = "".join(str(event.get("part", {}).get("text") or "") for event in report["events"] if event.get("type") == "text")
        require(text == "SYNTHETIC_FINAL", "Missing final assistant text")
    if scenario in ("provider-error", "success-stop"):
        require(not report["approvals"], "Unexpected tool approval")
        return
    require(len(report["approvals"]) == 1, "Native operation never reached the broker")
    approval = report["approvals"][0]
    is_command = scenario.startswith("command")
    require(approval["kind"] == ("execute" if is_command else "edit"), "AIR approval lost its live tool kind")
    if is_command:
        require(str(outside) in approval["arguments"].get("command", ""), "Approval lost the executable command")
    else:
        changes = approval["arguments"].get("changes", [])
        require(len(changes) == 1 and changes[0].get("path") == str(outside), "Approval lost the file target")
        require(changes[0].get("oldText") is None and changes[0].get("newText") == FILE_OUTPUT, "Approval lost the proposed diff")
        require(approval.get("allowSession") is False, "Partial file inputs must not allow a reusable grant")
    ends = [event for event in report["events"] if event.get("type") == "tool_execution_end"]
    if scenario.endswith("once"):
        require(outside.read_text(encoding="utf-8") == ("approved" if is_command else FILE_OUTPUT), "Approved file contents differ")
        require(len(ends) == 1 and ends[0].get("isError") is False, "Approved tool did not finish successfully")
        if is_command:
            require(COMMAND_OUTPUT in ends[0].get("result", ""), "AIR stdout was lost before the UI event")
    else:
        require(not any(event.get("isError") is False for event in ends), "Denied tool was shown as successful")


def run_case(args, scenario, root):
    # Import after replacing the process environment: config initialization may
    # otherwise create/read the real user's application directories.
    from app.services import access_policy, local_base, local_stream

    case = root / scenario
    work = case / "work"
    work.mkdir(parents=True)
    outside = case / "outside.txt"
    fixture = Fixture(scenario, outside)
    server = ThreadingHTTPServer(("127.0.0.1", 0), fixture.handler())
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = "http://127.0.0.1:" + str(server.server_port)
    policy = access_policy.normalize({"schema": access_policy.SCHEMA, "revision": 1,
                                    "mode": "standard", "workspaceRoot": str(work)})
    cfg = {"llm": {"base": origin + "/v1", "key": "loopback-only", "model": MODEL},
           "_soduwork_agent_mode": "work"}
    with patch.object(local_base, "_data_root", return_value=str(root / "data" / scenario)):
        env = local_base._env_for(local_base._PROFILES["codex-harness"], cfg, scenario)
    env["SODUWORK_APPROVAL_CHANNEL"] = json.dumps({"url": origin, "token": TOKEN, "policy": policy})
    # Native Codex respects these proxies; any attempted external URL is rejected
    # by the fixture. Node connections are additionally guarded by a preload.
    env.update({key: origin for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")})
    env["no_proxy"] = env["NO_PROXY"]
    receipts = install_guard(case, env)
    argv = [sys.executable, "-B", str(BACKEND / "app/services/acp_bridge.py"),
            "--cwd", str(work), "--agent-name", "codex-harness", "--permission", "workspace",
            "--", str(args.node), str(args.adapter_entry)]
    report = {"scenario": scenario, "ok": False, "events": [], "stderr": ""}
    proc = None
    started = time.monotonic()
    try:
        proc = subprocess.Popen(argv, env=env, text=True, encoding="utf-8", stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=os.name != "nt")
        try:
            stdout, stderr = proc.communicate("Perform only the synthetic fixture task, respecting approvals.", timeout=args.timeout)
        except subprocess.TimeoutExpired:
            stop_owned_adapter(receipts, proc.pid)
            try:
                proc.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate(timeout=5)
            raise AssertionError("Production bridge exceeded the fixture timeout")
        report.update({"bridgeExit": proc.returncode, "stderr": stderr,
                       "events": [json.loads(line) for line in stdout.splitlines()]})
        ref = "fixture-" + scenario
        run = {"state": "running", "cli": "codex-harness", "ws": str(work), "seq": 0,
               "lines": [], "cfg": {}, "conversationMode": "adaptive", "turnStartSeq": 0}
        local_base._RUNS[ref] = run
        terminal = {}
        try:
            with patch.object(local_base, "_STORE", str(case / "store")), patch.object(local_stream, "_resume"):
                for event in report["events"]:
                    local_stream._on_line(ref, json.dumps(event), terminal)
                local_stream._finish(ref, proc.returncode, terminal, "")
            report["localState"] = run["state"]
        finally:
            local_base._RUNS.pop(ref, None)
        report.update({"requests": fixture.calls, "approvals": fixture.approvals,
                       "fixtureFailures": fixture.failures})
        verify(report, outside)
        report["ok"] = True
    except Exception as exc:
        report["error"] = str(exc)
    finally:
        if proc is not None:
            if proc.poll() is None:
                stop_owned_adapter(receipts, proc.pid)
                proc.kill()
                proc.wait(timeout=5)
            report["processReaped"] = proc.poll() is not None
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        report.update({"requests": fixture.calls, "approvals": fixture.approvals,
                       "fixtureFailures": fixture.failures, "seconds": round(time.monotonic() - started, 3),
                       "fileExists": outside.exists(), "blockedConnections": fixture.blocked_connections})
        if fixture.failures:
            report["ok"] = False
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adapter-entry", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--fixture-parent", type=Path, default=BACKEND.parent,
                        help="Writable directory outside OS temporary roots (default: repository root)")
    parser.add_argument("--timeout", type=float, default=45)
    args = parser.parse_args()
    args.adapter_entry, args.node = args.adapter_entry.resolve(), args.node.resolve()
    require(args.adapter_entry.is_file() and args.node.is_file(), "Explicit adapter entry and Node executable must exist")
    require(1 <= args.timeout <= 120, "Timeout must be between 1 and 120 seconds")
    package = args.adapter_entry.parent.parent / "package.json"
    package_data = json.loads(package.read_text(encoding="utf-8"))
    require(package_data.get("name") == "@agentclientprotocol/codex-acp", "Selected entry is not the official Codex ACP package")
    native_package = package.parent / "node_modules/@openai/codex/package.json"
    native_data = json.loads(native_package.read_text(encoding="utf-8")) if native_package.is_file() else {}
    tracked = (args.adapter_entry, package, *((native_package,) if native_package.is_file() else ()))
    before = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in tracked}
    results = []
    with tempfile.TemporaryDirectory(prefix="soduwork-codex-e2e-", dir=args.fixture_parent.resolve()) as temporary:
        root = Path(temporary)
        env = isolated_env(root, args.node)
        with patch.dict(os.environ, env, clear=True):
            for scenario in SCENARIOS:
                report = run_case(args, scenario, root)
                results.append(report)
                print(json.dumps({key: report[key] for key in ("scenario", "ok", "seconds")}, ensure_ascii=False), flush=True)
    after = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in tracked}
    report = {"ok": all(item["ok"] for item in results) and before == after,
        "adapterVersion": package_data.get("version"), "nativeVersion": native_data.get("version"), "platform": sys.platform,
        "nodeVersion": subprocess.check_output([str(args.node), "--version"], text=True,
            env={key: os.environ[key] for key in ("SystemRoot", "WINDIR") if key in os.environ}).strip(),
        "installationUnchanged": before == after, "fingerprints": before, "scenarios": results,
        "boundary": "Production Python entry, environment builder, installed adapter/native host, runner state and synthetic loopback provider/broker. No Electron UI, real account/model or user workspace."}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
