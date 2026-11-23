"""Exercise installed DSH lifecycle handling with production environment setup.

Only the explicitly selected installed code is read. Model responses, credentials,
workspaces and session state are disposable fixtures. Every model request goes to
the loopback server; an installed Node guard rejects other network connections.
"""

from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from app.services import dsh_gateway, dsh_runtime
from app.services.acp_process import OwnedProcessGroup, close_process

SCENARIOS = (
    "child",
    "nested",
    "cancel",
    "resume-error",
    "resume-limit",
    "no-child",
    "bridge-child",
    "bridge-truncated-tool",
    "bridge-repeated-truncation",
)
KEY = "soduwork-subagent-loopback-fixture"
MODEL = "soduwork-subagent-fixture"


def fingerprint(paths):
    return {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}


def run_bridge_case(proc, fixture, incoming, updates, report, reader):
    """Use the exact Python ACP entry used by the source Runner."""
    proc.stdin.write("FIXTURE:parent: Perform the synthetic lifecycle task.")
    proc.stdin.close()
    assert fixture.parent_wait_sent.wait(15), "Python bridge never reached parent waiting output"
    try:
        proc.wait(timeout=0.35)
        report["returnedWhileLeafPending"] = True
    except subprocess.TimeoutExpired:
        report["returnedWhileLeafPending"] = False
    assert proc.poll() is None, "Python bridge exited before its descendant completed"
    fixture.release_leaf.set()
    proc.wait(timeout=15)
    reader.join(timeout=2)
    assert not reader.is_alive(), "Python bridge output did not close"
    while not incoming.empty():
        updates.append(incoming.get_nowait())
    assert proc.returncode == 0, "Python bridge failed: " + str(proc.returncode)
    assert fixture.calls["parent"] == 3, (
        "Python bridge did not resume parent after child completion"
    )
    assert fixture.leaf_response_sent.is_set(), "Python bridge exited before child response"
    assert not any(item.get("error") for item in updates), "Python bridge emitted an error"
    text = "".join(
        str(item.get("part", {}).get("text") or "")
        for item in updates
        if item.get("type") == "text"
    )
    assert "PARENT_DONE" in text, "Python bridge did not emit the final parent answer"
    report["productionPythonBridge"] = True


def native_session_summary(node, root):
    """Inspect only this fixture's native archive, without runtime/config imports."""
    script = """
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
const root = process.argv[1];
const sessions = [];
for (const relative of fs.readdirSync(root, {recursive: true})) {
  if (!relative.endsWith('session.v4.jsonl.zstd')) continue;
  const data = fs.readFileSync(path.join(root, relative));
  const events = [];
  for (let offset = 0; offset < data.length;) {
    const frame = zlib.zstdDecompressSync(data.subarray(offset), {info: true});
    if (!(frame.engine.bytesWritten > 0)) throw Error('Archive decoder made no progress');
    offset += frame.engine.bytesWritten;
    for (const line of frame.buffer.toString('utf8').split('\\n')) {
      if (line) events.push(JSON.parse(line));
    }
  }
  const pending = new Set();
  const compactions = [];
  for (const event of events) {
    if (event.type === 'tool/call') pending.add(event.data.callId);
    if (event.type === 'tool/result') pending.delete(event.data.message.source.callId);
    if (event.type === 'compaction/start') compactions.push({seq: event.seq, pendingTools: pending.size});
  }
  sessions.push({
    compactions,
    summaries: events.filter(event => event.type === 'compaction/summary').length,
    id: events.find(event => event.type === 'session')?.id,
    toolCalls: events.filter(event => event.type === 'tool/call').map(event => ({
      id: event.data.callId, name: event.data.name
    })),
    toolResults: events.filter(event => event.type === 'tool/result').map(event => ({
      id: event.data.message.source.callId, isError: event.data.message.isError === true
    })),
    turnEnds: events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind)
  });
}
console.log(JSON.stringify(sessions));
"""
    env = {"PATH": str(node.parent) + os.pathsep + os.defpath}
    for name in ("SYSTEMROOT", "WINDIR", "COMSPEC"):
        if os.environ.get(name):
            env[name] = os.environ[name]
    return json.loads(
        subprocess.check_output(
            [str(node), "--input-type=module", "-e", script, str(root / "dsh")],
            env=env,
            text=True,
            encoding="utf-8",
            timeout=10,
        )
    )


def run_truncated_tool_case(args, root, proc, fixture, incoming, updates, report, reader):
    """A dropped model preview must not block the production bridge's recovery."""
    work = root / "work"
    seeds = {
        "RUN_ID.txt": hashlib.sha256(str(root).encode()).hexdigest() + "\n",
        "existing.txt": "Keep this already completed work unchanged.\n",
    }
    for name, value in seeds.items():
        (work / name).write_text(value, encoding="utf-8")
    snapshots = {
        name: ((work / name).read_bytes(), (work / name).stat().st_mtime_ns) for name in seeds
    }
    proc.stdin.write("FIXTURE:parent: Keep RUN_ID.txt and existing.txt; finish the remaining file.")
    proc.stdin.close()
    proc.wait(timeout=25)
    reader.join(timeout=2)
    assert not reader.is_alive(), "Python bridge output did not close"
    while not incoming.empty():
        updates.append(incoming.get_nowait())
    report["productionPythonBridge"] = True
    report["existingFilesPreserved"] = all(
        ((work / name).read_bytes(), (work / name).stat().st_mtime_ns) == before
        for name, before in snapshots.items()
    )
    assert report["existingFilesPreserved"], "Recovery changed an existing file or RUN_ID"
    assert not (work / "truncated.txt").exists(), "Truncated tool arguments were executed"
    sessions = native_session_summary(args.node, root)
    report["nativeSessions"] = sessions
    assert len(sessions) == 1, "Recovery replaced the original native session"
    native = sessions[0]
    assert not any(call["id"].startswith("fixture_truncated_") for call in native["toolCalls"]), (
        "Native runtime dispatched a truncated call"
    )
    preview_ids = [
        event["part"]["callId"]
        for event in updates
        if event.get("type") == "tool_use"
        and str(event.get("part", {}).get("callId", "")).startswith("fixture_truncated_")
    ]
    assert preview_ids, "Fixture did not emit a real streamed tool preview"
    errors = [event["error"] for event in updates if event.get("error")]
    if args.expect_bug:
        assert proc.returncode == 2 and fixture.calls["parent"] == 1, (
            "Expected orphan-preview busy failure was not reproduced"
        )
        assert native["turnEnds"] == ["max-tokens"], "Wrong baseline native outcome"
        report["reproducedTruncatedPreviewBusy"] = True
        return
    cancelled = {
        event.get("toolCallId")
        for event in updates
        if event.get("type") == "tool_execution_end"
        and event.get("state") == "cancelled"
        and event.get("isError") is False
    }
    assert set(preview_ids) <= cancelled, (
        "A discarded preview remained unfinished or became a tool error"
    )
    if fixture.scenario == "bridge-repeated-truncation":
        assert proc.returncode == 2, "Persistent truncation must fail with exit 2"
        assert 2 <= fixture.calls["parent"] <= 3, "Recovery did not obey the bounded retry budget"
        assert not errors, "Output truncation was misreported as an ACP protocol failure"
        endings = [
            event.get("part", {}).get("reason")
            for event in updates
            if event.get("type") == "step_finish" and not event.get("contextOnly")
        ]
        assert endings and endings[-1] == "max_tokens", "Missing semantic truncation outcome"
        assert native["turnEnds"] and all(
            reason == "max-tokens" for reason in native["turnEnds"]
        ), "Persistent truncation was reported as native completion"
        assert not native["toolCalls"] and not (work / "finished.txt").exists(), (
            "Persistent partial calls produced side effects"
        )
        report["semanticStopReason"] = "max_tokens"
        return
    assert proc.returncode == 0 and not errors, "Recovery failed: " + str(errors)
    assert fixture.calls["parent"] == 3, "Expected one continuation, one write and final response"
    assert native["turnEnds"] == ["max-tokens", "completed"], "Unexpected native turn history"
    assert native["toolCalls"] == [{"id": "fixture_finished_write", "name": "write"}], (
        "Final write did not execute exactly once"
    )
    assert native["toolResults"] == [{"id": "fixture_finished_write", "isError": False}], (
        "Final write did not finish successfully exactly once"
    )
    assert (work / "finished.txt").read_text(encoding="utf-8") == "Completed exactly once.\n", (
        "Final file content is wrong"
    )
    text = "".join(
        str(event.get("part", {}).get("text") or "")
        for event in updates
        if event.get("type") == "text"
    )
    assert "PARENT_DONE" in text, "Recovery did not emit the final answer"
    report["truncatedCallNeverExecuted"] = True
    report["finalWriteExecutedOnce"] = True


def stop_recorded_nodes(path):
    """Reap the private Node groups recorded by this fixture's preload.

    The Python bridge starts its native ACP process in a separate POSIX session,
    so killing only the outer test subprocess would not cover a timeout there.
    """
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        pid = int(line)
        if pid <= 1 or pid == os.getpid():
            raise RuntimeError("Invalid fixture process receipt")
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                timeout=5,
                check=False,
            )
        else:
            try:
                if os.getpgid(pid) != pid:
                    raise RuntimeError("Fixture Node process no longer owns its recorded group")
                os.killpg(pid, signal.SIGTERM)
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    os.kill(pid, 0)
                    time.sleep(0.05)
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


class Fixture:
    def __init__(self, scenario):
        self.scenario = scenario
        self.calls = Counter()
        self.lock = threading.Lock()
        self.leaf_started = threading.Event()
        self.release_leaf = threading.Event()
        self.parent_wait_sent = threading.Event()
        self.child_wait_sent = threading.Event()
        self.leaf_response_sent = threading.Event()
        self.observations = []
        self.failures = []

    def observe(self, event, **values):
        with self.lock:
            self.observations.append({"event": event, "at": round(time.monotonic(), 4), **values})

    def response(self, body):
        assert body.get("model") == MODEL, "Wrong model route"
        users = [m.get("content") for m in body["messages"] if m.get("role") == "user"]
        if (
            users
            and isinstance(users[-1], str)
            and users[-1].startswith("You are now acting as a compaction engine")
        ):
            with self.lock:
                self.calls["compaction"] += 1
            self.observe("compaction_request")
            summary = "\n".join(
                [
                    "## Primary Request and Intent",
                    "- FIXTURE:parent: Finish the remaining file; preserve RUN_ID.txt and existing.txt.",
                    "## Key Technical Concepts",
                    "- Local text files.",
                    "## Files and Code",
                    "- Existing files must remain unchanged.",
                    "## Errors and Fixes",
                    "- The previous write arguments were truncated and not executed.",
                    "## Pending Jobs",
                    "- Finish the remaining file.",
                    "## Current Work",
                    "- Retry a smaller complete write.",
                    "## Next Step",
                    "- Issue one small complete write call.",
                    "## Critical Context",
                    "- Preserve the existing run identity and completed work.",
                ]
            )
            return {"role": "assistant", "content": summary}, "stop", None
        if not body.get("tools"):
            self.observe("title_request")
            return {"role": "assistant", "content": "Synthetic lifecycle test"}, "stop", None
        actor = None
        for candidate in ("parent", "child", "grandchild"):
            if any(
                isinstance(v, str) and v.startswith("FIXTURE:" + candidate + ":") for v in users
            ):
                actor = candidate
                break
        if (
            actor is None
            and self.scenario in {"bridge-truncated-tool", "bridge-repeated-truncation"}
            and any(
                isinstance(value, str)
                and "<compacted-summary>" in value
                and "FIXTURE:parent:" in value
                for value in users
            )
        ):
            actor = "parent"
        assert actor, "Unknown synthetic actor"
        with self.lock:
            stage = self.calls[actor]
            self.calls[actor] += 1
        names = {t["function"]["name"] for t in body["tools"]}
        self.observe("model_request", actor=actor, stage=stage, hasSubagent="subagent" in names)
        if stage > 4:
            raise AssertionError("Unexpected continuation loop")

        def spawn(child):
            assert "subagent" in names, "Delegation tool missing for " + actor
            return (
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "fixture_" + actor + "_spawn",
                            "type": "function",
                            "function": {
                                "name": "subagent",
                                "arguments": json.dumps(
                                    {
                                        "description": "Synthetic lifecycle child",
                                        "prompt": "FIXTURE:"
                                        + child
                                        + ": Perform the synthetic lifecycle task.",
                                    }
                                ),
                            },
                        }
                    ],
                },
                "tool_calls",
                None,
            )

        if actor == "parent":
            if self.scenario in {"bridge-truncated-tool", "bridge-repeated-truncation"}:
                assert "write" in names, "Native write tool is unavailable"
                truncated = stage == 0 or self.scenario == "bridge-repeated-truncation"
                if truncated:
                    arguments = '{"file_path":"truncated.txt","content":"UNFINISHED'
                    call_id = "fixture_truncated_" + str(stage)
                elif stage == 1:
                    arguments = json.dumps(
                        {"file_path": "finished.txt", "content": "Completed exactly once.\n"}
                    )
                    call_id = "fixture_finished_write"
                else:
                    return {"role": "assistant", "content": "PARENT_DONE"}, "stop", None
                return (
                    {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": call_id,
                                "type": "function",
                                "function": {
                                    "name": "write",
                                    "arguments": arguments,
                                },
                            }
                        ],
                    },
                    "length" if truncated else "tool_calls",
                    None,
                )
            if self.scenario == "no-child":
                return {"role": "assistant", "content": "PARENT_DONE"}, "stop", None
            if stage == 0:
                return spawn("child")
            if stage == 1:
                assert self.leaf_started.wait(12), "Leaf model request never started"
                return (
                    {"role": "assistant", "content": "PARENT_WAITING_FOR_CHILD"},
                    "stop",
                    self.parent_wait_sent,
                )
            if self.scenario == "resume-error":
                return None, "error", None
            if self.scenario == "resume-limit":
                return {"role": "assistant", "content": "PARENT_OUTPUT_TRUNCATED"}, "length", None
            return {"role": "assistant", "content": "PARENT_DONE"}, "stop", None
        if actor == "child" and self.scenario == "nested":
            if stage == 0:
                return spawn("grandchild")
            if stage == 1:
                assert self.leaf_started.wait(12), "Grandchild model request never started"
                return (
                    {"role": "assistant", "content": "CHILD_WAITING_FOR_GRANDCHILD"},
                    "stop",
                    self.child_wait_sent,
                )
            return {"role": "assistant", "content": "CHILD_DONE"}, "stop", None
        self.leaf_started.set()
        self.observe("leaf_waiting", actor=actor)
        assert self.release_leaf.wait(30), "Leaf fixture was not released"
        return (
            {"role": "assistant", "content": actor.upper() + "_DONE"},
            "stop",
            self.leaf_response_sent,
        )


def run_case(args, scenario, root, output, installation):
    started = time.monotonic()
    for name in ("home", "tmp", "work", "dsh", "bundle"):
        (root / name).mkdir(parents=True)
    fixture = Fixture(scenario)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            try:
                assert self.path == "/v1/chat/completions", "Unexpected HTTP path"
                assert self.headers.get("Authorization") == "Bearer " + KEY, (
                    "Wrong fixture credential"
                )
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                message, finish, sent = fixture.response(body)
                usage_hook = getattr(fixture, "response_usage", None)
                usage = usage_hook(body, message) if callable(usage_hook) else None
                if finish == "error":
                    data = json.dumps(
                        {
                            "error": {
                                "message": "SYNTHETIC_RESUMED_PARENT_FAILURE",
                                "type": "invalid_request_error",
                            }
                        }
                    ).encode()
                    self.send_response(400)
                    typ = "application/json"
                elif body.get("stream"):
                    if message.get("tool_calls"):
                        for i, call in enumerate(message["tool_calls"]):
                            call["index"] = i
                    pieces = []
                    deltas = [(message, None), ({}, finish)]
                    if finish == "length" and message.get("tool_calls"):
                        # Two genuine tool-argument deltas end inside the JSON
                        # string. The native SDK finalizes this preview as {},
                        # but DSH must discard it before tool dispatch.
                        first = json.loads(json.dumps(message))
                        call = first["tool_calls"][0]
                        arguments = call["function"]["arguments"]
                        split = len(arguments) // 2
                        call["function"]["arguments"] = arguments[:split]
                        second = {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "function": {
                                        "arguments": arguments[split:],
                                    },
                                }
                            ]
                        }
                        deltas = [(first, None), (second, None), ({}, finish)]
                    for delta, reason in deltas:
                        pieces.append(
                            "data: "
                            + json.dumps(
                                {
                                    "id": "fixture-response",
                                    "object": "chat.completion.chunk",
                                    "created": 1,
                                    "model": MODEL,
                                    "choices": [
                                        {"index": 0, "delta": delta, "finish_reason": reason}
                                    ],
                                }
                            )
                            + "\n\n"
                        )
                    if usage is not None:
                        pieces.append("data: " + json.dumps({
                            "id": "fixture-response", "object": "chat.completion.chunk",
                            "created": 1, "model": MODEL, "choices": [], "usage": usage,
                        }) + "\n\n")
                    data = ("".join(pieces) + "data: [DONE]\n\n").encode()
                    typ = "text/event-stream"
                    self.send_response(200)
                else:
                    data = json.dumps(
                        {
                            "id": "fixture-response",
                            "object": "chat.completion",
                            "created": 1,
                            "model": MODEL,
                            "choices": [{"index": 0, "message": message, "finish_reason": finish}],
                        }
                    ).encode()
                    typ = "application/json"
                    self.send_response(200)
                self.send_header("Content-Type", typ)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                self.wfile.flush()
                if sent:
                    sent.set()
            except (BrokenPipeError, ConnectionResetError):
                fixture.observe("closed_fixture_connection")
            except Exception as exc:
                fixture.failures.append(str(exc))
                try:
                    self.send_error(500, "Synthetic fixture failure")
                except OSError:
                    pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    env = {
        "PATH": str(args.node.parent) + os.pathsep + os.defpath,
        "HOME": str(root / "home"),
        "USERPROFILE": str(root / "home"),
        "TMPDIR": str(root / "tmp"),
        "TMP": str(root / "tmp"),
        "TEMP": str(root / "tmp"),
        "DSH_HOME": str(root / "dsh"),
        "DSH_TELEMETRY_DISABLED": "1",
        "DSH_PERMISSION_MODE": "workspace-write",
        "DSH_ACP_CACHE_DIR": str(root / "cache"),
        "NO_PROXY": "localhost,127.0.0.1",
        "no_proxy": "localhost,127.0.0.1",
        "SODUWORK_API_KEY": KEY,
        "DSH_PROVIDER": "soduwork",
        "DSH_MODEL": MODEL,
        "DSH_ACP_MODELS": MODEL,
        "DSH_MAX_TOKENS": "1024",
    }
    for name in ("XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "APPDATA", "LOCALAPPDATA"):
        env[name] = str(root / "home" / name)
    for name in ("SYSTEMROOT", "WINDIR", "COMSPEC"):
        if os.environ.get(name):
            env[name] = os.environ[name]
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["SODUWORK_DATA_ROOT"] = str(installation)
    dsh_gateway.inject_env(
        env,
        {
            "base": f"http://127.0.0.1:{server.server_port}/v1",
            "key": KEY,
            "model": MODEL,
            "contextWindow": 32768,
            "maxOutputTokens": 1024,
            "localOnly": True,
        },
    )
    # Exercise the production loader selection, including Windows storage preload.
    dsh_runtime.apply_env(env, str(installation))
    if args.expect_bug:
        env.pop("SODUWORK_DSH_ACP_SETTLEMENT", None)
    (root / "bundle" / "package.json").write_text(
        json.dumps(
            {
                "name": "soduwork-lifecycle-fixture",
                "version": "1.0.0",
                "private": True,
                "dsh": {"bundle": {"patch": "./cordis.patch.yml"}},
            }
        )
    )
    (root / "bundle" / "cordis.patch.yml").write_text(
        "- id: subagent\n  config:\n    maxDepth: 2\n", encoding="utf-8"
    )
    guard = root / "loopback-only.cjs"
    node_receipts = root / "owned-node-pids.txt"
    env["SODUWORK_DSH_FIXTURE_PIDS"] = str(node_receipts)
    guard.write_text(
        """'use strict';
const fs = require('node:fs');
const net = require('node:net');
fs.appendFileSync(process.env.SODUWORK_DSH_FIXTURE_PIDS, process.pid + '\\n');
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
""",
        encoding="utf-8",
    )
    env["NODE_OPTIONS"] = (
        env.get("NODE_OPTIONS", "") + " --require=" + json.dumps(str(guard))
    ).strip()
    proc = None
    readers = []
    report = {"scenario": scenario, "ok": False}
    incoming, updates, stderr = queue.Queue(), [], []
    server_thread.start()
    try:
        command = [
            str(args.node),
            str(args.adapter_entry),
            *dsh_gateway.bundle_args(),
            "--bundle",
            str(root / "bundle"),
        ]
        if scenario.startswith("bridge-"):
            command = [
                sys.executable,
                str(Path(__file__).parent / "app/services/acp_bridge.py"),
                "--cwd",
                str(root / "work"),
                "--agent-name",
                "dsh",
                "--",
                *command,
            ]
        proc = subprocess.Popen(
            command,
            cwd=root / "work",
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            **(
                {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
                if os.name == "nt"
                else {"start_new_session": True}
            ),
        )

        def read_stdout():
            for line in proc.stdout:
                try:
                    incoming.put(json.loads(line))
                except ValueError:
                    fixture.failures.append("Non-JSON stdout: " + line[:100])
            incoming.put({"fixtureEOF": True})

        reader = threading.Thread(target=read_stdout, daemon=True)
        reader.start()
        err_reader = threading.Thread(target=lambda: stderr.extend(proc.stderr), daemon=True)
        err_reader.start()
        readers = [reader, err_reader]
        if scenario.startswith("bridge-"):
            if scenario == "bridge-child":
                run_bridge_case(proc, fixture, incoming, updates, report, reader)
            else:
                run_truncated_tool_case(
                    args, root, proc, fixture, incoming, updates, report, reader
                )
            report["ok"] = True
            return report
        serial = 0

        def send(method, params, notification=False):
            nonlocal serial
            message = {"jsonrpc": "2.0", "method": method, "params": params}
            if not notification:
                serial += 1
                message["id"] = serial
            proc.stdin.write(json.dumps(message) + "\n")
            proc.stdin.flush()
            return message.get("id")

        def receive(rid, timeout):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                try:
                    value = incoming.get(timeout=min(0.1, max(0.001, deadline - time.monotonic())))
                except queue.Empty:
                    continue
                if value.get("id") == rid and ("result" in value or "error" in value):
                    return value
                if value.get("fixtureEOF"):
                    raise RuntimeError("ACP exited before response: " + str(proc.poll()))
                if value.get("method") and "id" in value:
                    raise RuntimeError("Unexpected ACP client request: " + value["method"])
                updates.append(value)
            return None

        def rpc(method, params):
            value = receive(send(method, params), 30)
            assert value is not None, "ACP timeout: " + method
            assert "result" in value, "ACP error: " + str(value.get("error"))
            return value["result"]

        init = rpc(
            "initialize",
            {
                "protocolVersion": 1,
                "clientCapabilities": {},
                "clientInfo": {"name": "isolated-lifecycle-fixture", "version": "1"},
            },
        )
        report["adapterVersion"] = init.get("agentInfo", {}).get("version")
        created = rpc("session/new", {"cwd": str(root / "work"), "mcpServers": []})
        sid = created["sessionId"]
        rid = send(
            "session/prompt",
            {
                "sessionId": sid,
                "prompt": [
                    {
                        "type": "text",
                        "text": "FIXTURE:parent: Perform the synthetic lifecycle task.",
                    }
                ],
            },
        )
        if scenario == "no-child":
            result = receive(rid, 15)
        else:
            assert fixture.parent_wait_sent.wait(15), "Parent waiting response was not sent"
            if scenario == "nested":
                assert fixture.child_wait_sent.wait(5), "Child waiting response was not sent"
            premature = receive(rid, 0.35)
            report["returnedWhileLeafPending"] = premature is not None
            if args.expect_bug:
                assert premature and premature.get("result", {}).get("stopReason") == "end_turn", (
                    "Expected premature end_turn was not reproduced"
                )
                assert fixture.leaf_started.is_set() and not fixture.leaf_response_sent.is_set(), (
                    "Leaf was not pending at early completion"
                )
                result = premature
                report["reproducedPrematureEndTurn"] = True
            else:
                assert premature is None, (
                    "ACP prompt returned while descendant was still running: " + str(premature)
                )
                if scenario == "cancel":
                    cancel_at = time.monotonic()
                    send("session/cancel", {"sessionId": sid}, notification=True)
                    result = receive(rid, 5)
                    report["cancelSeconds"] = round(time.monotonic() - cancel_at, 3)
                else:
                    fixture.release_leaf.set()
                    result = receive(rid, 15)
        assert result is not None, "Prompt did not settle within bounded time"
        report["promptResponse"] = result
        if not args.expect_bug:
            if scenario == "resume-error":
                assert "error" in result, "Resumed parent error was reported as success"
                assert "SYNTHETIC_RESUMED_PARENT_FAILURE" in json.dumps(result), (
                    "Wrong failure surfaced"
                )
            else:
                expected = (
                    "cancelled"
                    if scenario == "cancel"
                    else "max_tokens"
                    if scenario == "resume-limit"
                    else "end_turn"
                )
                assert result.get("result", {}).get("stopReason") == expected, (
                    "Wrong stopReason: " + str(result)
                )
            if scenario in ("child", "nested", "resume-error", "resume-limit"):
                assert fixture.calls["parent"] == 3, "Parent did not resume after child settlement"
                assert fixture.leaf_response_sent.is_set(), "Result preceded descendant response"
            if scenario == "nested":
                assert fixture.calls["child"] == 3, (
                    "Child did not resume after grandchild settlement"
                )
            if scenario in ("child", "nested", "no-child"):
                texts = [
                    u.get("content", {}).get("text", "")
                    for u in (v.get("params", {}).get("update", {}) for v in updates)
                    if u.get("sessionUpdate") == "agent_message_chunk"
                    and isinstance(u.get("content"), dict)
                ]
                assert "PARENT_DONE" in "".join(texts), (
                    "Final parent text was not flushed before prompt returned"
                )
        report["ok"] = True
    except Exception as exc:
        report["error"] = str(exc)
    finally:
        if proc is not None:
            if proc.stdin and not proc.stdin.closed:
                try:
                    proc.stdin.close()
                except OSError:
                    pass
            try:
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    stop_recorded_nodes(node_receipts)
                ownership = OwnedProcessGroup(proc.pid) if os.name != "nt" else None
                close_process(proc, readers, ownership)
            except Exception as exc:
                report["ok"] = False
                report["cleanupError"] = str(exc)
            report["processExit"] = proc.returncode
            report["processReaped"] = proc.poll() is not None
        fixture.release_leaf.set()
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=2)
        report["fixtureFailures"] = fixture.failures
        report["calls"] = dict(fixture.calls)
        report["seconds"] = round(time.monotonic() - started, 3)
        report["observations"] = fixture.observations
        if fixture.failures:
            report["ok"] = False
        report["stderr"] = "".join(stderr)[-4000:].replace(KEY, "<fixture-key>")
        output.mkdir(parents=True, exist_ok=True)
        (output / "acp-updates.json").write_text(json.dumps(updates, indent=2), encoding="utf-8")
        (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adapter-entry", required=True, type=Path)
    parser.add_argument("--runtime-root", required=True, type=Path)
    parser.add_argument("--node", required=True, type=Path)
    parser.add_argument("--scenario", action="append", choices=SCENARIOS, default=[])
    parser.add_argument(
        "--expect-bug",
        action="store_true",
        help="Disable the compatibility hook to reproduce child/preview baseline failures",
    )
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    for key in ("adapter_entry", "runtime_root", "node"):
        if getattr(args, key):
            setattr(args, key, getattr(args, key).resolve(strict=True))
    scenarios = args.scenario or list(SCENARIOS)
    if args.expect_bug and scenarios not in (["child"], ["bridge-truncated-tool"]):
        parser.error("--expect-bug requires --scenario child or --scenario bridge-truncated-tool")
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=True)
    files = [args.adapter_entry.parent.parent / "package.json", args.adapter_entry]
    files += list(args.adapter_entry.parent.glob("*.js"))
    files += [
        args.runtime_root / "node_modules" / "@deepseek-ai" / package / name
        for package, name in [
            ("dsh", "package.json"),
            ("dsh-agent", "lib/index.js"),
            ("dsh-subagent", "lib/index.js"),
            ("dsh-acp", "lib/index.js"),
        ]
    ]
    before = fingerprint(files)
    reports = []
    with tempfile.TemporaryDirectory(prefix="soduwork-dsh-lifecycle-") as temporary:
        temporary_root = Path(temporary).resolve()
        installation = temporary_root / "installation"
        runtime_link = installation / "agent-runtimes/dsh-host"
        runtime_link.parent.mkdir(parents=True)
        if os.name == "nt":
            shutil.copytree(args.runtime_root, runtime_link)
        else:
            runtime_link.symlink_to(args.runtime_root, target_is_directory=True)
        for scenario in scenarios:
            report = run_case(
                args, scenario, temporary_root / scenario, root / scenario, installation
            )
            reports.append(report)
            print(
                json.dumps(
                    {
                        key: report.get(key)
                        for key in (
                            "scenario",
                            "ok",
                            "error",
                            "returnedWhileLeafPending",
                            "calls",
                            "cancelSeconds",
                            "processReaped",
                        )
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
    unchanged = before == fingerprint(files)
    summary = {
        "ok": all(r["ok"] for r in reports) and unchanged,
        "node": subprocess.check_output([str(args.node), "--version"], text=True).strip(),
        "platform": sys.platform,
        "adapter": json.loads(files[0].read_text())["version"],
        "runtime": json.loads(
            (args.runtime_root / "node_modules/@deepseek-ai/dsh/package.json").read_text()
        )["version"],
        "installedInputsUnchanged": unchanged,
        "productionRuntimeEnvironment": True,
        "temporaryStateRemoved": not temporary_root.exists(),
        "root": str(root),
        "cases": reports,
        "boundary": "Real installed adapter/host, production environment and Python ACP entry, synthetic loopback model. Cancellation is followed by host teardown; same-connection reuse after cancellation is outside this check. No Electron UI, production credentials, real model or user workspace.",
    }
    (root / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(
        json.dumps(
            {"ok": summary["ok"], "summary": str(root / "summary.json")}, ensure_ascii=False
        ),
        flush=True,
    )
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
