"""Private probe routing and real child processes with synthetic Agent responses."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from app.agent_catalog import AGENTS
from app.services import agent_setup, dsh_runtime, local_base
from runner_main import Runner


LOCAL = {"localOnly": True, "base": "http://private-probe.invalid/v1", "key": "private-probe-key",
         "model": "private-probe-wire", "authMode": "api-key"}


class ProbeMarkerTests(unittest.TestCase):
    def test_marker_with_platform_line_endings_and_console_formatting(self):
        marker = agent_setup._TOKEN
        for newline in ("\n", "\r\n"):
            with self.subTest(newline=repr(newline)):
                events = [
                    {"type": "text", "part": {"streamId": "answer", "delta": "SODUWORK\u00a0_",
                                               "done": False}},
                    {"type": "text", "part": {"streamId": "answer", "delta": "AG\r\nENT _OK"}},
                ]
                output = "\ufeff" + newline.join(
                    "\x1b[32m" + json.dumps(event, ensure_ascii=False) + "\x1b[0m"
                    for event in events) + newline
                self.assertTrue(agent_setup._probe_succeeded(output, 0, marker))
                self.assertFalse(agent_setup._probe_succeeded(output, 1, marker))

    def test_unicode_whitespace_remains_inside_json_records(self):
        for whitespace in ("\u0085", "\u2028", "\u2029"):
            for newline in ("\n", "\r\n", "\r"):
                with self.subTest(whitespace=repr(whitespace), newline=repr(newline)):
                    event = {"type": "text", "part": {
                        "text": "SODUWORK" + whitespace + "_AGENT_OK", "done": True}}
                    records = [{"type": "step_start"}, event]
                    output = newline.join(json.dumps(record, ensure_ascii=False) for record in records)
                    self.assertTrue(agent_setup._probe_succeeded(output, 0, agent_setup._TOKEN))
                    failure = json.dumps({"error": {"message": "model request failed"}})
                    self.assertFalse(agent_setup._probe_succeeded(
                        output + newline + failure, 0, agent_setup._TOKEN))

    def test_spaced_marker_in_a_single_completed_answer(self):
        marker = agent_setup._TOKEN
        chunks = [
            {"type": "text", "part": {"streamId": "answer", "delta": delta, "done": done}}
            for delta, done in (("SODUWORK _", False), (" AG ENT", False), ("\t_OK", True))
        ]

        def matches(events, code=0):
            return agent_setup._probe_succeeded(
                "\n".join(json.dumps(event) for event in events), code, marker)

        self.assertTrue(matches(chunks))
        self.assertFalse(matches(chunks[:-1]))
        self.assertFalse(matches(chunks, code=1))
        self.assertFalse(matches([*chunks, {"error": {"message": "model request failed"}}]))
        self.assertFalse(matches([{"type": "reasoning", "text": "SODUWORK _ AG ENT _OK"}]))
        self.assertFalse(matches([
            {"type": "text", "part": {"text": value}}
            for value in ("SODUWORK _", "AG ENT _OK")
        ]))
        self.assertFalse(agent_setup._probe_succeeded(agent_setup._PROMPT, 0, marker))

    def test_native_truncation_requires_a_later_successful_turn(self):
        answer = {"type": "text", "part": {"text": "SODUWORK _ AG ENT _OK"}}
        stopped = {"type": "step_finish", "part": {"reason": "stop"}}
        error = {"error": {"message": "model request failed"}}
        for reason in ("length", "max_tokens"):
            truncated = {"type": "step_finish", "part": {"reason": reason}}
            cases = (
                ([answer, truncated], False),
                ([answer, truncated, {**stopped, "contextOnly": True}], False),
                ([answer, truncated, {"type": "step_finish", "part": {"reason": "tool-calls"}}], False),
                ([answer, truncated, stopped], True),
                ([answer, stopped, truncated], False),
                ([answer, truncated, stopped, error], False),
                ([answer, error, truncated, stopped], False),
            )
            for events, expected in cases:
                with self.subTest(reason=reason, events=events):
                    output = "\n".join(json.dumps(event) for event in events)
                    self.assertEqual(agent_setup._probe_succeeded(output, 0, agent_setup._TOKEN), expected)


class ProbePersistenceTests(unittest.TestCase):
    def test_real_child_updates_the_persisted_probe_only_after_a_successful_reply(self):
        for reply, exit_code, expected in (
            ("SODUWORK _ AG ENT _OK", 0, True),
            ("SODUWORK _ AG ENT _OK", 1, False),
            ("SODUWORK _ AG ENT", 0, False),
        ):
            with self.subTest(reply=reply, exit_code=exit_code), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                history = root / "agent-probe.json"
                other = {"ok": True, "detail": "another runtime"}
                history.write_text(json.dumps({"kimi": {"ok": not expected}, "qwen": other}), encoding="utf-8")
                child = root / "fixture.py"
                event = {"type": "text", "part": {"text": reply, "done": True}}
                child.write_text(
                    "import sys\n"
                    "if '--version' in sys.argv:\n"
                    "    print('fixture-version')\n"
                    "    sys.exit(0)\n"
                    "assert sys.stdin.buffer.read().decode('utf-8') == " + repr(agent_setup._PROMPT) + "\n"
                    "sys.stdout.buffer.write(" + repr((json.dumps(event) + "\r\n").encode()) + ")\n"
                    "sys.exit(" + str(exit_code) + ")\n", encoding="utf-8")
                identity = agent_setup._new_job("kimi", "probe")
                try:
                    with patch.object(agent_setup, "_PROBE_FILE", str(history)), \
                            patch.object(agent_setup, "_probe_ws", return_value=folder), \
                            patch.object(agent_setup, "_bin_of", return_value=sys.executable), \
                            patch.dict(agent_setup._PROFILES["kimi"], {"argv_prefix": lambda: [str(child)],
                                                                        "start": lambda *args: []}), \
                            patch.object(agent_setup, "_command_argv", return_value=[sys.executable, str(child)]), \
                            patch.object(local_base, "_env_for", return_value=None):
                        agent_setup._guard(identity, agent_setup._run_probe, "kimi", {
                            "base": "http://fixture.invalid/v1", "model": "fixture", "key": "fixture-key"})
                    saved = json.loads(history.read_text(encoding="utf-8"))
                    self.assertEqual(saved["qwen"], other)
                    self.assertEqual(saved["kimi"]["ok"], expected)
                    self.assertEqual([step["ok"] for step in saved["kimi"]["steps"]], [True, expected])
                    self.assertEqual(agent_setup.job(identity)["ok"], expected)
                finally:
                    agent_setup._JOBS.pop(identity, None)


class PrivateProbeRoutingTests(unittest.IsolatedAsyncioTestCase):
    async def test_only_parent_pipe_can_start_and_poll_private_managed_probes(self):
        machine = Runner.__new__(Runner)
        jobs = []
        try:
            with patch.object(agent_setup, "_spawn"):
                for key, spec in AGENTS.items():
                    if spec["modelMode"] != "managed":
                        continue
                    result = await machine._local_rpc_dispatch({"op": "agent.probe", "key": key, "llm": LOCAL})
                    self.assertTrue(result["ok"], result)
                    identity = result["data"]["jobId"]
                    jobs.append(identity)
                    self.assertTrue(result["data"]["private"])
                    private = await machine._local_rpc_dispatch({"op": "agent.job", "jobId": identity})
                    self.assertTrue(private["data"]["private"])
                    self.assertEqual(private["data"]["lines"], [])
                    remote = await machine._agent({"op": "agent.job", "jobId": identity})
                    self.assertFalse(remote["ok"])
                    self.assertIsNone(agent_setup.job(identity))
                for key in ("codex", "claude"):
                    denied = await machine._local_rpc_dispatch({"op": "agent.probe", "key": key, "llm": LOCAL})
                    self.assertFalse(denied["ok"])
        finally:
            for identity in jobs:
                agent_setup._JOBS.pop(identity, None)

    async def test_network_marker_cannot_authorize_local_probe_or_configuration(self):
        machine = Runner.__new__(Runner)
        machine._send = AsyncMock()
        with patch.object(agent_setup, "start_probe") as start, patch.object(agent_setup, "configure") as configure:
            for operation in ("agent.probe", "agent.configure"):
                await machine._on({"op": operation, "id": "remote", "key": "qwen", "llm": LOCAL,
                                   "_localParent": True})
                result = machine._send.await_args.args[0]
                self.assertFalse(result["ok"])
                self.assertEqual(result["code"], "LOCAL_MODEL_REMOTE_FORBIDDEN")
            start.assert_not_called()
            configure.assert_not_called()


class PrivateProbeProcessTests(unittest.TestCase):
    def test_dsh_private_probe_reuses_installed_code_but_cleans_its_own_home_and_temp(self):
        identity = agent_setup._new_job("dsh", "probe", private=True)
        roots = []
        original = local_base._env_for

        def prepare(*args, **kwargs):
            roots.append(kwargs["runtime_root"])
            return original(*args, **kwargs)

        try:
            with tempfile.TemporaryDirectory(prefix="soduwork-dsh-installed-") as data:
                installed = Path(dsh_runtime.host_root(data))
                package = installed / "node_modules" / "@deepseek-ai" / "dsh" / "package.json"
                package.parent.mkdir(parents=True)
                package.write_text('{"version":"fixture"}', encoding="utf-8")
                before = package.read_bytes()

                def command(_bin, _args, workspace, _cfg, _prof):
                    source = "\n".join([
                        "import json, os",
                        "from pathlib import Path",
                        "installed = Path(" + repr(str(installed)) + ")",
                        "root = Path(" + repr(roots[-1]) + ").resolve()",
                        "workspace = Path(" + repr(workspace) + ").resolve()",
                        "assert Path(os.environ['DSH_PATH']).resolve() == installed.resolve()",
                        "assert (installed / 'node_modules/@deepseek-ai/dsh/package.json').is_file()",
                        "home, temporary = Path(os.environ['DSH_HOME']).resolve(), Path(os.environ['TMPDIR']).resolve()",
                        "assert home.is_relative_to(root) and temporary.is_relative_to(root)",
                        "assert not temporary.is_relative_to(workspace) and not workspace.is_relative_to(temporary)",
                        "assert os.environ['DSH_PERMISSION_MODE'] == 'read-only'",
                        "(home / 'private-probe-state').write_text('isolated')",
                        "print(json.dumps(" + repr({"type": "text", "part": {"text": agent_setup._TOKEN}}) + "), flush=True)",
                    ])
                    return [sys.executable, "-c", source]

                with patch.object(local_base, "_data_root", return_value=data), \
                        patch.object(agent_setup, "_bin_of", return_value=sys.executable), \
                        patch.object(agent_setup, "_short", return_value="fixture-version"), \
                        patch.dict(agent_setup._PROFILES["dsh"], {"start": lambda *args: ["fixture"]}), \
                        patch.object(agent_setup, "_command_argv", side_effect=command), \
                        patch.object(local_base, "_env_for", side_effect=prepare), \
                        patch.object(agent_setup, "_save_probe") as save:
                    agent_setup._guard(identity, agent_setup._run_probe, "dsh", dict(LOCAL))
                result = agent_setup.job(identity, include_private=True)
                self.assertTrue(result["ok"], result)
                self.assertEqual(result["state"], "done")
                self.assertEqual(result["lines"], [])
                self.assertNotIn("private-probe", json.dumps(result))
                save.assert_not_called()
                self.assertEqual(package.read_bytes(), before)
                self.assertEqual([p for p in installed.rglob('*') if p.is_file()], [package])
                self.assertTrue(roots)
                self.assertTrue(all(not Path(root).exists() for root in roots))
        finally:
            agent_setup._JOBS.pop(identity, None)

    def run_process(self, key, *, success=True):
        identity = agent_setup._new_job(key, "probe", private=True)
        roots = []
        original = local_base._env_for
        def prepare(*args, **kwargs):
            roots.append(kwargs["runtime_root"])
            return original(*args, **kwargs)
        output = {"type": "text", "part": {"text": agent_setup._TOK_A + agent_setup._TOK_B}}
        if not success:
            output = {"type": "error", "message": "private-probe-wire private-probe-key http://private-probe.invalid/v1"}
        source = "import json; print(" + repr(json.dumps(output)) + ",flush=True)"
        try:
            with tempfile.TemporaryDirectory() as data:
                history = Path(data) / "agent-probe.json"
                history.write_text(json.dumps({key: {"ok": True, "detail": "previous Hub model result"}}))
                before = history.read_bytes()
                with patch.object(agent_setup, "_PROBE_FILE", str(history)), \
                        patch.object(agent_setup, "_bin_of", return_value=sys.executable), \
                        patch.object(agent_setup, "_short", return_value="fixture-version"), \
                        patch.dict(agent_setup._PROFILES[key], {"start": lambda *args: ["fixture"]}), \
                        patch.object(agent_setup, "_command_argv", return_value=[sys.executable, "-c", source]), \
                        patch.object(local_base, "_env_for", side_effect=prepare):
                    agent_setup._guard(identity, agent_setup._run_probe, key, dict(LOCAL))
                result = agent_setup.job(identity, include_private=True)
                self.assertEqual(result["state"], "done")
                self.assertEqual(result["ok"], success, result)
                self.assertEqual(result["lines"], [])
                self.assertEqual(history.read_bytes(), before)
                self.assertNotIn("private-probe", json.dumps(result))
                self.assertTrue(roots)
                self.assertTrue(all(not Path(root).exists() for root in roots))
                self.assertIsNone(agent_setup.job(identity))
                return roots
        finally:
            agent_setup._JOBS.pop(identity, None)

    def test_every_managed_runtime_executes_a_real_child_without_persisting_private_results(self):
        for key, spec in AGENTS.items():
            if spec["modelMode"] == "managed":
                with self.subTest(key=key):
                    self.run_process(key)

    def test_failure_output_does_not_enter_history_and_temporary_configuration_is_removed(self):
        self.run_process("qwen", success=False)

    def test_private_unhandled_errors_cannot_enter_job_logs_or_public_diagnostics(self):
        identity = agent_setup._new_job("qwen", "probe", private=True)
        try:
            def fail(*args):
                raise RuntimeError("private-probe-wire private-probe-key http://private-probe.invalid/v1")
            with patch.object(agent_setup.log, "exception") as log:
                agent_setup._guard(identity, fail)
                log.assert_not_called()
            result = agent_setup.job(identity, include_private=True)
            self.assertFalse(result["ok"])
            self.assertEqual(result["lines"], [])
            self.assertNotIn("private-probe", json.dumps(result))
        finally:
            agent_setup._JOBS.pop(identity, None)

    def test_concurrent_private_probes_use_separate_roots(self):
        identities = [agent_setup._new_job("pi", "probe", private=True) for _ in range(2)]
        roots = []
        original = local_base._env_for
        def prepare(*args, **kwargs):
            roots.append(kwargs["runtime_root"])
            return original(*args, **kwargs)
        source = "import json,time; time.sleep(.05); print(" + repr(json.dumps({
            "type": "text", "part": {"text": agent_setup._TOKEN}})) + ",flush=True)"
        try:
            with patch.object(agent_setup, "_bin_of", return_value=sys.executable), \
                    patch.object(agent_setup, "_short", return_value="fixture-version"), \
                    patch.dict(agent_setup._PROFILES["pi"], {"start": lambda *args: ["fixture"]}), \
                    patch.object(agent_setup, "_command_argv", return_value=[sys.executable, "-c", source]), \
                    patch.object(local_base, "_env_for", side_effect=prepare), ThreadPoolExecutor(max_workers=2) as pool:
                list(pool.map(lambda identity: agent_setup._guard(identity, agent_setup._run_probe, "pi", dict(LOCAL)), identities))
            self.assertEqual(len(set(roots)), 2)
            self.assertTrue(all(not Path(root).exists() for root in roots))
            self.assertTrue(all(agent_setup.job(identity, include_private=True)["ok"] for identity in identities))
        finally:
            for identity in identities:
                agent_setup._JOBS.pop(identity, None)


if __name__ == "__main__":
    unittest.main()
