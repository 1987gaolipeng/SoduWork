"""Offline contract tests for the bundled Harness² process boundary."""
from __future__ import annotations

import contextlib
import importlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch


class Harness2BridgeTests(unittest.TestCase):
    def bridge(self):
        spec = importlib.util.find_spec("app.services.harness2_bridge")
        self.assertIsNotNone(spec, "The bundled Harness² process bridge must exist")
        return importlib.import_module("app.services.harness2_bridge")

    @contextlib.contextmanager
    def endpoint(self, response, *, status=200):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                requests.append((self.path, self.headers.get("Authorization"),
                                 json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
                encoded = json.dumps(response).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(encoded)

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            yield {"base": f"http://127.0.0.1:{server.server_port}/v1",
                   "key": "private-test-key", "model": "fixture"}, requests
        finally:
            server.shutdown()
            server.server_close()
            worker.join(2)

    def test_completion_uses_managed_model_without_tools(self):
        bridge = self.bridge()
        with self.endpoint({"choices": [{"message": {"content": "draft"}, "finish_reason": "stop"}],
                            "usage": {"prompt_tokens": 12, "completion_tokens": 4}}) as (model, requests):
            usage = []
            answer = bridge.complete(model, [{"role": "user", "content": "Hello"}], usage.append)
        self.assertEqual(answer, "draft")
        self.assertEqual(requests[0][0], "/v1/chat/completions")
        self.assertEqual(requests[0][1], "Bearer private-test-key")
        self.assertEqual(requests[0][2]["model"], "fixture")
        self.assertNotIn("tools", requests[0][2])
        self.assertEqual(usage, [{"input_tokens": 12, "output_tokens": 4}])

    def test_completion_rejects_truncation_and_redacts_server_errors(self):
        bridge = self.bridge()
        with self.endpoint({"choices": [{"message": {"content": "partial"}, "finish_reason": "length"}]}) as (model, _):
            with self.assertRaisesRegex(bridge.Harness2Error, "截断"):
                bridge.complete(model, [{"role": "user", "content": "Hello"}])
        with self.endpoint({"error": {"message": "private-test-key confidential server details"}},
                           status=401) as (model, _):
            with self.assertRaises(bridge.Harness2Error) as caught:
                bridge.complete(model, [{"role": "user", "content": "Hello"}])
        self.assertNotIn("private-test-key", str(caught.exception))
        self.assertNotIn("confidential", str(caught.exception))
        self.assertIn("401", str(caught.exception))

    def test_model_output_limits_and_anthropic_cached_usage_are_preserved(self):
        bridge = self.bridge()
        response = {"content": [{"type": "text", "text": "plan"}], "stop_reason": "end_turn",
                    "usage": {"input_tokens": 10, "output_tokens": 4,
                              "cache_read_input_tokens": 20, "cache_creation_input_tokens": 5}}
        with self.endpoint(response) as (model, requests):
            usage = []
            bridge.complete({**model, "kind": "anthropic", "maxOutputTokens": 2048},
                            [{"role": "system", "content": "Rules"}, {"role": "user", "content": "Task"}],
                            usage.append)
        self.assertEqual(requests[0][2]["max_tokens"], 2048)
        self.assertEqual(usage[0]["input_tokens"], 35)
        self.assertEqual(usage[0]["cacheRead"], 20)
        self.assertEqual(usage[0]["cacheWrite"], 5)
        self.assertTrue(usage[0]["inputIncludesCache"])
        with self.endpoint({"choices": [{"message": {"content": "plan"}, "finish_reason": "stop"}]}) as (model, requests):
            bridge.complete({**model, "maxOutputTokens": 1024}, [{"role": "user", "content": "Task"}])
        self.assertEqual(requests[0][2]["max_tokens"], 1024)

    def test_empty_native_prompt_result_cannot_report_completion(self):
        bridge = self.bridge()
        from app.services import acp_bridge
        with tempfile.TemporaryDirectory() as directory:
            with (patch.dict(os.environ, {"SODUWORK_APPROVAL_CHANNEL": ""}),
                  patch.object(acp_bridge.AcpBridge, "start"),
                  patch.object(acp_bridge.AcpBridge, "close"),
                  patch.object(acp_bridge.AcpBridge, "request", side_effect=[
                      {"protocolVersion": 1}, {"sessionId": "native"}, {}])):
                with self.assertRaisesRegex(bridge.Harness2Error, "完成"):
                    bridge.execute("Task", directory, "", "work", False, sys.executable,
                                   output=lambda _event: None)

    def test_native_failure_keeps_stage_and_safe_cause_even_if_cleanup_fails(self):
        bridge = self.bridge()
        from app.services import acp_bridge
        with tempfile.TemporaryDirectory() as directory:
            with (patch.dict(os.environ, {"SODUWORK_APPROVAL_CHANNEL": ""}),
                  patch.object(acp_bridge.AcpBridge, "start"),
                  patch.object(acp_bridge.AcpBridge, "request", side_effect=[
                      {"protocolVersion": 1}, {"sessionId": "native"},
                      acp_bridge.BridgeError("HTTP 401: private-key confidential-body")]),
                  patch.object(acp_bridge.AcpBridge, "close",
                               side_effect=acp_bridge.BridgeError("cleanup private-key"))):
                with self.assertRaises(bridge.Harness2Error) as raised:
                    bridge.execute("Task", directory, "", "work", False, sys.executable,
                                   output=lambda _event: None)
        self.assertIn("401", str(raised.exception))
        self.assertIn("调用模型", str(raised.exception))
        self.assertNotIn("private-key", str(raised.exception))
        self.assertNotIn("confidential-body", str(raised.exception))
        self.assertNotIn("cleanup", str(raised.exception))

    def test_successful_answer_with_failed_cleanup_is_not_success(self):
        bridge = self.bridge()
        from app.services import acp_bridge
        with tempfile.TemporaryDirectory() as directory:
            with (patch.dict(os.environ, {"SODUWORK_APPROVAL_CHANNEL": ""}),
                  patch.object(acp_bridge.AcpBridge, "run", return_value=0),
                  patch.object(acp_bridge.AcpBridge, "close",
                               side_effect=acp_bridge.BridgeError("ACP cleanup failed: private-key"))):
                with self.assertRaises(bridge.Harness2Error) as raised:
                    bridge.execute("Task", directory, "", "work", False, sys.executable,
                                   output=lambda _event: None)
        self.assertIn("清理", str(raised.exception))
        self.assertNotIn("private-key", str(raised.exception))

    def test_executor_config_ignores_personal_global_config_without_moving_sessions(self):
        from app.services import harness2_runtime as runtime, local_base
        from app.services.opencode_access import Guard
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            personal = root / "personal" / "opencode" / "opencode.json"
            personal.parent.mkdir(parents=True)
            original = b'not valid JSON: personal config must stay untouched'
            personal.write_bytes(original)
            injected = {
                "SODUWORK_DATA_ROOT": str(root / "untrusted-root"),
                "XDG_CONFIG_HOME": str(personal.parent.parent),
                "XDG_DATA_HOME": str(root / "existing-sessions"),
                "OPENCODE_DB": str(root / "existing.db"),
                "HOME": str(root / "existing-home"),
                "OPENCODE_CONFIG_CONTENT": '{"model":"company/fixture","permission":{"edit":"deny"}}',
            }
            cfg = {"llm": {"base": "http://127.0.0.1/v1", "key": "fixture", "model": "fixture"}}
            with (patch.object(local_base, "_env_for", return_value=dict(injected)),
                  patch.object(local_base, "_data_root", return_value=str(root / "runner")),
                  patch.object(local_base, "_opencode_bin", return_value=sys.executable)):
                result = runtime.environment({}, cfg)
            self.assertEqual(result["SODUWORK_DATA_ROOT"], str(root / "runner"))
            config_home = Path(result["XDG_CONFIG_HOME"])
            self.assertTrue(config_home.is_relative_to(root / "runner"))
            self.assertTrue(config_home.is_dir())
            self.assertEqual(list(config_home.iterdir()), [])
            for key in ("XDG_DATA_HOME", "OPENCODE_DB", "HOME"):
                self.assertEqual(result[key], injected[key])
            config = json.loads(result["OPENCODE_CONFIG_CONTENT"])
            self.assertEqual(config.pop("agent"), {"build": {"prompt": runtime.EXECUTOR_PROMPT}})
            self.assertEqual(config, json.loads(injected["OPENCODE_CONFIG_CONTENT"]))
            self.assertEqual(personal.read_bytes(), original)
            guard = Guard({"edit": "deny"}, "readonly")
            try:
                guarded = guard.environment(result)
                config = json.loads(guarded["OPENCODE_CONFIG_CONTENT"])
                self.assertEqual(config["model"], "company/fixture")
                self.assertIn(guard.path.as_uri(), config["plugin"])
                self.assertEqual(guarded["XDG_CONFIG_HOME"], str(config_home))
            finally:
                guard.close()

    def test_bridge_prepares_executor_config_even_for_an_already_running_parent(self):
        bridge = self.bridge()
        from app.services import harness2_runtime as runtime, local_base
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            captured = {}
            def execute(*_args, **_kwargs):
                captured.update(os.environ)
                return 0
            with (patch.dict(os.environ, {
                    runtime.MODEL_ENV: '{"key":"fixture"}',
                    runtime.EXECUTOR_ENV: sys.executable,
                    runtime.ROOT_ENV: str(root / "evidence"),
                    "XDG_CONFIG_HOME": str(root / "personal"),
                    "SODUWORK_DATA_ROOT": str(root / "runner"),
                  }),
                  patch.object(local_base, "_data_root", return_value=str(root / "runner")),
                  patch.object(sys, "stdin", io.StringIO("minimal probe")),
                  patch("app.services.harness2_engine.refine", return_value="Verified fixture instructions."),
                  patch.object(bridge, "execute", side_effect=execute)):
                code = bridge.main(["--cwd", str(root), "--probe"])
            self.assertEqual(code, 0)
            self.assertTrue(Path(captured["XDG_CONFIG_HOME"]).is_relative_to(root / "runner"))
            self.assertTrue(Path(captured["XDG_CONFIG_HOME"]).is_dir())
            self.assertEqual(json.loads(captured["OPENCODE_CONFIG_CONTENT"])["agent"]["build"]["prompt"],
                             runtime.EXECUTOR_PROMPT)

    def test_scratch_directory_is_bound_to_runner_session(self):
        bridge = self.bridge()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = bridge.new_work_dir(root / "session-a")
            second = bridge.new_work_dir(root / "session-a")
            other = bridge.new_work_dir(root / "session-b")
            self.assertNotEqual(first, second)
            self.assertEqual(first.parent, second.parent)
            self.assertNotEqual(first.parent, other.parent)

    def test_protocol_keeps_native_session_identity_and_rejects_errors(self):
        bridge = self.bridge()
        captured = []
        events = bridge.ExecutionEvents(captured.append)
        events.consume(json.dumps({"type": "session", "sessionID": "native-session"}))
        events.consume(json.dumps({"type": "text", "sessionID": "native-session",
                                   "part": {"text": "done", "done": True}}))
        self.assertEqual(events.child_session, "native-session")
        self.assertEqual(captured[0]["sessionID"], "native-session")
        self.assertFalse(events.succeeded(0), "Text alone must not prove a completed run")
        events.mark_completed()
        self.assertTrue(events.succeeded(0))
        self.assertFalse(events.succeeded(2))
        events.consume(json.dumps({"error": {"message": "execution failed"}}))
        self.assertFalse(events.succeeded(0))

    def test_version_probe_runs_the_component_not_its_python_interpreter(self):
        from app.services import harness2_runtime as runtime
        profile = runtime.profile()
        self.assertIn("argv_prefix", profile)
        result = subprocess.run([profile["bin"](), *profile["argv_prefix"](), "--version"],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), runtime.version())
        with patch.object(sys, "frozen", True, create=True):
            self.assertEqual(profile["argv_prefix"](), ["--harness2-bridge"])

    def test_permission_recovery_skips_refinement_only_for_trusted_transition(self):
        from app.services import harness2_runtime as runtime, local_base
        policy = {"policyHash": "new-policy", "mode": "readonly"}
        cfg = {"llm": {"base": "http://127.0.0.1/v1", "key": "fixture", "model": "fixture"},
               "accessPolicy": policy}
        key = "harness2-test-permission-restart"
        with tempfile.TemporaryDirectory() as root:
            with (patch.dict(local_base._RUNS, {key: {"_accessTransition": {
                    "phase": "applying", "targetPolicy": policy}}}),
                  patch.object(local_base, "_env_for", return_value={"SODUWORK_HARNESS2_CONTINUE": "inherited"}),
                  patch.object(local_base, "_store_dir", return_value=root),
                  patch.object(local_base, "_opencode_bin", return_value=sys.executable)):
                env = runtime.environment({}, cfg, key)
                self.assertEqual(env.get("SODUWORK_HARNESS2_CONTINUE"), "1")
                local_base._RUNS[key]["_accessTransition"]["phase"] = "waiting"
                self.assertNotIn("SODUWORK_HARNESS2_CONTINUE", runtime.environment({}, cfg, key))
                local_base._RUNS[key]["_accessTransition"]["phase"] = "applying"
                mismatch = {**cfg, "accessPolicy": {"policyHash": "different"}}
                self.assertNotIn("SODUWORK_HARNESS2_CONTINUE", runtime.environment({}, mismatch, key))

    def test_full_process_refines_then_executes_once_and_resumes_native_session(self):
        from app.services import harness2_runtime as runtime
        requests = []

        class Model(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append(body)
                system = body["messages"][0]["content"]
                content = (json.dumps({"files": {"systemprompt.md": "Verify fixture result precisely."},
                                       "notes": "Check the real result."})
                           if "SODUWORK_HARNESS2_EDIT" in system
                           else "Inspect the request, produce the output, and verify it.")
                payload = json.dumps({"choices": [{"message": {"content": content},
                                                   "finish_reason": "stop"}]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Model)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                work = root / "中文 workspace"
                work.mkdir()
                (work / "acp").write_bytes(Path(__file__).with_name("harness2_acp_peer.py").read_bytes())
                env = {key: value for key, value in os.environ.items()
                       if key not in {"SODUWORK_APPROVAL_CHANNEL", "SODUWORK_RUNTIME_IMAGES"}}
                env.update({
                    runtime.MODEL_ENV: json.dumps({"base": f"http://127.0.0.1:{server.server_port}/v1",
                                                  "key": "fixture-secret", "model": "fixture"}),
                    runtime.ROOT_ENV: str(root / "private"),
                    runtime.EXECUTOR_ENV: sys.executable,
                    "PYTHONUTF8": "1",
                })
                command = [sys.executable, str(Path(runtime.__file__).with_name("harness2_bridge.py")),
                           "--cwd", str(work), "--refine"]
                first = subprocess.run(command, input="Create the requested fixture result.",
                                       env=env, text=True, encoding="utf-8", capture_output=True, timeout=30)
                self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
                events = [json.loads(line) for line in first.stdout.splitlines()]
                self.assertTrue(any(row.get("sessionID") == "harness2-native-fixture" for row in events))
                self.assertEqual(len(requests), 7)
                self.assertEqual((work / "delivered.txt").read_text(), "actual bridge write")
                self.assertIn("Verify fixture result precisely.", (work / "received.txt").read_text(encoding="utf-8"))
                self.assertNotIn("fixture-secret", first.stdout + first.stderr)
                for path in (root / "private").rglob("*"):
                    if path.is_file():
                        self.assertNotIn("fixture-secret", path.read_text(encoding="utf-8"))
                second = subprocess.run([*command, "--session", "harness2-native-fixture", "--probe"],
                                        input="Continue this same session.", env=env, text=True,
                                        encoding="utf-8", capture_output=True, timeout=30)
                self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
                self.assertEqual(len(requests), 14, "Explicit experimental readiness covers all seven calls")
                second_events = [json.loads(line) for line in second.stdout.splitlines()]
                self.assertIn({"type": "harness2_probe_complete", "coverage": "refine-v1", "stages": 7},
                              second_events)
                readonly_work = root / "readonly"
                readonly_work.mkdir()
                (readonly_work / "acp").write_bytes(Path(__file__).with_name("harness2_acp_peer.py").read_bytes())
                readonly = subprocess.run([sys.executable, command[1], "--cwd", str(readonly_work),
                                           "--mode", "plan", "--probe", "--refine"], input="Read only.",
                                          env={**env, "HARNESS2_FIXTURE_READONLY": "1"},
                                          text=True, encoding="utf-8", capture_output=True, timeout=30)
                self.assertEqual(readonly.returncode, 0, readonly.stdout + readonly.stderr)
                self.assertFalse((readonly_work / "delivered.txt").exists())
                self.assertEqual(len(requests), 21)
        finally:
            server.shutdown()
            server.server_close()
            worker.join(2)


if __name__ == "__main__":
    unittest.main()
