"""Real Kimi ACP + production Python bridge, with disposable loopback models.

Never uses user credentials, config or sessions. The selected installed entry is
read-only; a Node preload rejects network connections outside localhost.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from app.services import acp_agents
from app.services.acp_process import OwnedProcessGroup, close_process


SCENARIOS = (
    "normal",
    "text-limit",
    "provider-error",
    "context-overflow",
    "tool-recover",
    "tool-repeat",
)


class Fixture:
    def __init__(self, scenario, provider):
        self.scenario = scenario
        self.provider = provider
        self.calls = 0
        self.failures = []

    def respond(self, handler, body):
        self.calls += 1
        if self.calls > 14:
            raise AssertionError("Native repeat protection or host retry budget regressed")
        # Kimi first tries native compaction on a provider context overflow.
        # Let each compaction complete so its bounded recovery, rather than a
        # separate compaction failure, eventually reports context.overflow.
        if self.scenario == "provider-error" or (
            self.scenario == "context-overflow" and self.calls % 2 == 1
        ):
            handler.send_response(400)
            handler.send_header("Content-Type", "application/json")
            handler.end_headers()
            handler.wfile.write(
                json.dumps(
                    {
                        "error": {
                            "message": (
                                "Maximum context length exceeded. SYNTHETIC_PRIVATE_PROVIDER_BODY"
                                if self.scenario == "context-overflow"
                                else "SYNTHETIC_PRIVATE_PROVIDER_BODY"
                            ),
                            "type": "invalid_request_error",
                            "code": (
                                "context_length_exceeded"
                                if self.scenario == "context-overflow"
                                else "invalid_request_error"
                            ),
                        }
                    }
                ).encode()
            )
            return
        partial = self.scenario == "tool-repeat" or (
            self.scenario == "tool-recover" and self.calls == 1
        )
        write = self.scenario == "tool-recover" and self.calls == 2
        limited = partial or self.scenario == "text-limit"
        tool = None
        if partial or write:
            tools = [t if self.provider == "anthropic" else t["function"] for t in body["tools"]]
            tool = next(t["name"] for t in tools if t["name"].lower() == "write")
        arguments = (
            '{"path":"truncated.txt","content":"unfinished'
            if partial
            else json.dumps({"path": "finished.txt", "content": "Completed once.\n"})
        )
        call_id = "fixture_partial" if partial else "fixture_finished_write"
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream")
        handler.end_headers()
        if self.provider == "anthropic":

            def event(kind, value):
                packet = (
                    "event: " + kind + "\ndata: " + json.dumps({"type": kind, **value}) + "\n\n"
                )
                handler.wfile.write(packet.encode())
                handler.wfile.flush()

            event(
                "message_start",
                {
                    "message": {
                        "id": "msg_fixture",
                        "type": "message",
                        "role": "assistant",
                        "model": "fixture-model",
                        "content": [],
                        "stop_reason": None,
                        "stop_sequence": None,
                        "usage": {"input_tokens": 1, "output_tokens": 0},
                    }
                },
            )
            block = (
                {"type": "tool_use", "id": call_id, "name": tool, "input": {}}
                if tool
                else {"type": "text", "text": ""}
            )
            event("content_block_start", {"index": 0, "content_block": block})
            delta = (
                {"type": "input_json_delta", "partial_json": arguments}
                if tool
                else {"type": "text_delta", "text": "PARTIAL" if limited else "FIXTURE_DONE"}
            )
            event("content_block_delta", {"index": 0, "delta": delta})
            event("content_block_stop", {"index": 0})
            event(
                "message_delta",
                {
                    "delta": {
                        "stop_reason": "max_tokens"
                        if limited
                        else "tool_use"
                        if tool
                        else "end_turn",
                        "stop_sequence": None,
                    },
                    "usage": {"output_tokens": 1024 if limited else 10},
                },
            )
            event("message_stop", {})
        else:

            def chunk(delta, reason=None):
                packet = {
                    "id": "chatcmpl-fixture",
                    "object": "chat.completion.chunk",
                    "created": 1,
                    "model": "fixture-model",
                    "choices": [{"index": 0, "delta": delta, "finish_reason": reason}],
                }
                handler.wfile.write(("data: " + json.dumps(packet) + "\n\n").encode())
                handler.wfile.flush()

            chunk({"role": "assistant"})
            if tool:
                chunk(
                    {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": call_id,
                                "type": "function",
                                "function": {"name": tool, "arguments": arguments},
                            }
                        ]
                    }
                )
            else:
                chunk({"content": "PARTIAL" if limited else "FIXTURE_DONE"})
            chunk({}, "length" if limited else "tool_calls" if tool else "stop")
            handler.wfile.write(b"data: [DONE]\n\n")
            handler.wfile.flush()


def run_case(args, scenario, provider):
    report = {"scenario": scenario, "provider": provider, "ok": False}
    fixture = Fixture(scenario, provider)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            try:
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                fixture.respond(self, body)
            except Exception as exc:
                fixture.failures.append(str(exc))

    with tempfile.TemporaryDirectory(prefix="soduwork-kimi-outcome-") as folder:
        root = Path(folder)
        for name in ("home", "work", "data", "tmp"):
            (root / name).mkdir()
        seeds = {"RUN_ID.txt": "kimi-fixture-run\n", "existing.txt": "Keep completed work.\n"}
        for name, content in seeds.items():
            (root / "work" / name).write_text(content, encoding="utf-8")
        snapshots = {
            name: ((root / "work" / name).read_bytes(), (root / "work" / name).stat().st_mtime_ns)
            for name in seeds
        }
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        guard = root / "loopback.cjs"
        receipts = root / "nodes.txt"
        guard.write_text(
            """const fs=require('node:fs');const net=require('node:net');
fs.appendFileSync(process.env.SODUWORK_FIXTURE_PIDS,process.pid+'\\n');
const original=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
 const first=Array.isArray(args[0])?args[0][0]:args[0];
 const o=first&&typeof first==='object'?first:{port:first,host:typeof args[1]==='string'?args[1]:'localhost'};
 if(o.path||!['127.0.0.1','localhost','::1'].includes(String(o.host||'localhost')))throw Error('EXTERNAL_CONNECTION_BLOCKED');
 return original.apply(this,args);
};
""",
            encoding="utf-8",
        )
        env = {
            "PATH": str(args.node.parent) + os.pathsep + os.defpath,
            "HOME": str(root / "home"),
            "TMPDIR": str(root / "tmp"),
            "XDG_CONFIG_HOME": str(root / "home/config"),
            "XDG_DATA_HOME": str(root / "home/data"),
            "XDG_CACHE_HOME": str(root / "home/cache"),
            "SODUWORK_FIXTURE_PIDS": str(receipts),
            "NO_COLOR": "1",
        }
        for name in ("SYSTEMROOT", "WINDIR", "COMSPEC"):
            if os.environ.get(name):
                env[name] = os.environ[name]
        acp_agents.home_env("kimi", env, str(root / "data"))
        acp_agents.inject_llm_env(
            "kimi",
            env,
            {
                "base": f"http://127.0.0.1:{server.server_port}/v1",
                "key": "synthetic-fixture-key",
                "model": "fixture-model",
                "kind": provider,
                "localOnly": True,
            },
        )
        if args.expect_bug:
            env.pop("SODUWORK_KIMI_ACP_OUTCOME", None)
        env["NODE_OPTIONS"] = env.get("NODE_OPTIONS", "") + " --require=" + json.dumps(str(guard))
        proc = None
        server_thread.start()
        try:
            command = [
                sys.executable,
                str(Path(__file__).parent / "app/services/acp_bridge.py"),
                "--cwd",
                str(root / "work"),
                "--agent-name",
                "kimi",
                "--",
                str(args.node),
                str(args.entry),
                "acp",
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
            stdout, stderr = proc.communicate(
                "Keep existing files; perform the synthetic task.", timeout=40
            )
            events = [json.loads(line) for line in stdout.splitlines() if line.strip()]
            report.update(exitCode=proc.returncode, modelCalls=fixture.calls, events=events)
            errors = [event["error"] for event in events if event.get("error")]
            endings = [
                event.get("part", {}).get("reason")
                for event in events
                if event.get("type") == "step_finish"
            ]
            assert not fixture.failures, str(fixture.failures)
            assert fixture.calls > 0, "Native startup failed: " + stderr[-1000:]
            assert all(
                ((root / "work" / name).read_bytes(), (root / "work" / name).stat().st_mtime_ns)
                == value
                for name, value in snapshots.items()
            ), "Existing files or RUN_ID changed"
            assert not (root / "work/truncated.txt").exists(), "Partial tool arguments executed"
            if args.expect_bug:
                assert proc.returncode == 0 and not errors, (
                    "Expected false success was not reproduced"
                )
                assert not endings or endings[-1] != "max_tokens", (
                    "Baseline already preserves truncation"
                )
            elif scenario in {"provider-error", "context-overflow"}:
                assert proc.returncode == 2 and errors, "Provider failure became success"
                assert "SYNTHETIC_PRIVATE_PROVIDER_BODY" not in json.dumps(events), (
                    "Provider body leaked"
                )
                if scenario == "context-overflow":
                    assert "Kimi context length exceeded" in json.dumps(errors), (
                        "Native overflow recovery signal was lost"
                    )
            elif scenario in {"text-limit", "tool-repeat"}:
                assert proc.returncode == 2 and not errors, (
                    "Truncation became success or a protocol error"
                )
                assert endings and endings[-1] == "max_tokens", (
                    "Missing native output-limit outcome"
                )
            else:
                assert proc.returncode == 0 and not errors, "Completed turn was rejected"
                assert endings and endings[-1] == "stop", "Earlier limit hid later success"
                assert "FIXTURE_DONE" in stdout, "Final model response was not delivered"
            if scenario in {"normal", "text-limit", "provider-error"}:
                assert fixture.calls == 1, "Host unexpectedly replayed a model request"
            if scenario == "context-overflow":
                assert fixture.calls <= 7, "Native context recovery exceeded its bounded budget"
            if scenario.startswith("tool-"):
                tool_ends = [e for e in events if e.get("type") == "tool_execution_end"]
                assert tool_ends and all(e.get("state") != "cancelled" for e in tool_ends), (
                    "Real native calls became previews"
                )
                failed = [e for e in tool_ends if e.get("isError") is True]
                assert failed, "Native argument validation failures were hidden"
                if scenario == "tool-recover":
                    assert fixture.calls == 3 and len(failed) == 1, (
                        "Native continuation was duplicated"
                    )
                    successful = [e for e in tool_ends if e.get("isError") is False]
                    assert len(successful) == 1, "Completed write was not executed exactly once"
                    assert (root / "work/finished.txt").read_text() == "Completed once.\n"
                else:
                    assert fixture.calls == 13 and len(failed) == 13, "Native repeat bound changed"
            report["ok"] = True
        except Exception as exc:
            report["error"] = str(exc)
        finally:
            if proc is not None:
                if proc.poll() is None and receipts.exists():
                    for line in receipts.read_text().splitlines():
                        pid = int(line)
                        if os.name == "nt":
                            subprocess.run(
                                ["taskkill", "/PID", str(pid), "/T", "/F"],
                                stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL,
                                timeout=5,
                                check=False,
                            )
                        else:
                            try:
                                if pid > 1 and os.getpgid(pid) == pid:
                                    os.killpg(pid, signal.SIGTERM)
                            except ProcessLookupError:
                                pass
                close_process(proc, [], OwnedProcessGroup(proc.pid) if os.name != "nt" else None)
                report["processReaped"] = proc.poll() is not None
            server.shutdown()
            server.server_close()
            server_thread.join(timeout=2)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--entry", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--scenario", action="append", choices=SCENARIOS)
    parser.add_argument("--provider", action="append", choices=("openai", "anthropic"))
    parser.add_argument("--expect-bug", action="store_true")
    args = parser.parse_args()
    scenarios = args.scenario or SCENARIOS
    if args.expect_bug and not set(scenarios) <= {"text-limit", "provider-error", "tool-repeat"}:
        parser.error("--expect-bug only supports false-success cases")
    before = hashlib.sha256(args.entry.read_bytes()).hexdigest()
    reports = [
        run_case(args, scenario, provider)
        for provider in (args.provider or ("openai", "anthropic"))
        for scenario in scenarios
    ]
    after = hashlib.sha256(args.entry.read_bytes()).hexdigest()
    result = {
        "ok": before == after and all(r["ok"] for r in reports),
        "installedSourceUnchanged": before == after,
        "sourceSHA256": before,
        "cases": reports,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(
        json.dumps(
            {
                "ok": result["ok"],
                "report": str(args.output),
                "cases": [{k: v for k, v in r.items() if k != "events"} for r in reports],
            }
        )
    )
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
