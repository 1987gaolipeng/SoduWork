"""Offline Kimi outcome contracts; no installed agent or model is required."""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from app.services import acp_agents, kimi_runtime, runner_sources


class KimiModelBudgetTests(unittest.TestCase):
    def test_selected_model_limits_replace_inherited_limits_without_mutating_inputs(self):
        inherited = {
            "KIMI_MODEL_MAX_CONTEXT_SIZE": "262144",
            "KIMI_MODEL_MAX_OUTPUT_SIZE": "65536",
            "KIMI_MODEL_MAX_COMPLETION_TOKENS": "65536",
            "KIMI_MODEL_API_KEY": "stale-synthetic-key",
        }
        llm = {"base": "http://127.0.0.1:1/v1", "model": "synthetic-small-model",
               "key": "fresh-synthetic-key", "contextWindow": 32768, "maxOutputTokens": 4096}
        original = dict(llm)
        with patch.dict(os.environ, inherited):
            env = dict(os.environ)
            acp_agents.inject_llm_env("kimi", env, llm)
            self.assertEqual(env["KIMI_MODEL_MAX_CONTEXT_SIZE"], "32768")
            self.assertEqual(env["KIMI_MODEL_MAX_OUTPUT_SIZE"], "4096")
            self.assertEqual(env["KIMI_MODEL_MAX_COMPLETION_TOKENS"], "4096")
            self.assertEqual(env["KIMI_MODEL_API_KEY"], "fresh-synthetic-key")
            for name, value in inherited.items():
                self.assertEqual(os.environ[name], value)
        self.assertEqual(llm, original)

    def test_context_uses_shared_catalog_and_safe_default_without_an_output_override(self):
        for model, expected in (("deepseek-chat", 64000), ("synthetic-model", 128000)):
            with self.subTest(model=model):
                env = {"KIMI_MODEL_MAX_OUTPUT_SIZE": "1024",
                       "KIMI_MODEL_MAX_COMPLETION_TOKENS": "1024"}
                acp_agents.inject_llm_env("kimi", env, {
                    "base": "http://127.0.0.1:1/v1", "model": model,
                    "localOnly": True,
                })
                self.assertEqual(env["KIMI_MODEL_MAX_CONTEXT_SIZE"], str(expected))
                self.assertNotIn("KIMI_MODEL_MAX_OUTPUT_SIZE", env)
                self.assertNotIn("KIMI_MODEL_MAX_COMPLETION_TOKENS", env)
                self.assertEqual(env["KIMI_MODEL_API_KEY"], "soduwork-anonymous-local")

    def test_output_cap_is_validated_and_never_exceeds_the_model_window(self):
        for limit, expected in ((16384, "8192"), (True, None), (-1, None), ("4096", None)):
            with self.subTest(limit=limit):
                env = {}
                acp_agents.inject_llm_env("kimi", env, {
                    "base": "http://127.0.0.1:1/v1", "model": "synthetic-model",
                    "key": "synthetic-key", "contextWindow": 8192,
                    "maxOutputTokens": limit,
                })
                self.assertEqual(env["KIMI_MODEL_MAX_CONTEXT_SIZE"], "8192")
                self.assertEqual(env.get("KIMI_MODEL_MAX_OUTPUT_SIZE"), expected)
                self.assertEqual(env.get("KIMI_MODEL_MAX_COMPLETION_TOKENS"), expected)


class KimiOutcomeTests(unittest.TestCase):
    def test_environment_is_isolated_and_packaged(self):
        env = {"NODE_OPTIONS": "--require=unrelated.cjs"}
        with tempfile.TemporaryDirectory() as root:
            acp_agents.home_env("kimi", env, root)
            self.assertEqual(env["KIMI_CODE_HOME"], str(Path(root) / ".kimi-code"))
        loader = Path(kimi_runtime.__file__).with_name("kimi_acp_outcome.mjs")
        self.assertEqual(env["NODE_OPTIONS"], "--import=" + loader.resolve().as_uri())
        self.assertEqual(env["SODUWORK_KIMI_ACP_OUTCOME"], "1")
        self.assertIn(loader, runner_sources.runtime_resources(Path(__file__).parent))
        self.assertIn('"kimi_acp_outcome.mjs"', Path(__file__).with_name("runner.spec").read_text())

    def test_native_outcomes_and_strict_source_guard(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("Node is unavailable")
        loader = Path(kimi_runtime.__file__).with_name("kimi_acp_outcome.mjs")
        script = """
import assert from 'node:assert/strict';
const {settleTurnOutcome, transformSource} = await import(process.argv[1]);
const RequestError = {
  authRequired: (_, message) => ({kind:'auth', message}),
  internalError: (_, message) => ({kind:'internal', message}),
};
const map = reason => ({completed:'end_turn', failed:'refusal', cancelled:'cancelled', blocked:'refusal'})[reason];
function outcome(reason, last, error) {
  const driver = {soduworkFinishReason:last, resolve:value=>driver.result=value, reject:value=>driver.error=value};
  settleTurnOutcome(driver, {reason,error}, error=>error?.code==='auth', RequestError, map);
  return driver;
}
assert.equal(outcome('completed','max_tokens').result.stopReason, 'max_tokens');
assert.equal(outcome('completed','end_turn').result.stopReason, 'end_turn');
assert.equal(outcome('completed',undefined).result.stopReason, 'end_turn');
assert.equal(outcome('cancelled','max_tokens').result.stopReason, 'cancelled');
assert.equal(outcome('blocked','max_tokens').result.stopReason, 'refusal');
assert.equal(outcome('failed','max_tokens',{code:'provider.filtered'}).result.stopReason, 'refusal');
const failed = outcome('failed','max_tokens',{code:'provider.error',message:'SECRET_REQUEST_BODY'});
assert.equal(failed.error.kind,'internal');
assert.ok(!failed.error.message.includes('SECRET'));
assert.equal(outcome('failed','max_tokens',{code:'context.overflow',message:'SECRET_CONTEXT_BODY'}).error.message,
  'Kimi context length exceeded; existing progress was preserved.');
assert.equal(outcome('failed','max_tokens',{code:'provider.error',message:'context length exceeded'}).error.message,
  'Kimi model turn failed; existing progress was preserved.');
assert.equal(outcome('failed','end_turn',{code:'auth',message:'auth required'}).error.kind,'auth');
for (const version of ['2.6.2','2.6.3','']) {
  assert.throws(()=>transformSource('unreviewed source',version), /unsupported/);
}
console.log('Kimi outcome contracts passed');
"""
        result = subprocess.run(
            [node, "--input-type=module", "-e", script, loader.as_uri()],
            text=True,
            capture_output=True,
            timeout=15,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_typed_context_overflow_reaches_the_real_recovery_path(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("Node is unavailable")
        loader = Path(kimi_runtime.__file__).with_name("kimi_acp_outcome.mjs")
        script = """
const {settleTurnOutcome} = await import(process.argv[1]);
const driver = {resolve:()=>{throw Error('Unexpected success')},reject:error=>console.log(JSON.stringify({error}))};
settleTurnOutcome(driver, {reason:'failed',error:{code:'context.overflow',message:'PRIVATE_PROVIDER_BODY'}},
  ()=>false, {internalError:(_,message)=>({name:'AcpBridgeError',message})}, ()=> 'end_turn');
"""
        result = subprocess.run(
            [node, "--input-type=module", "-e", script, loader.as_uri()],
            text=True,
            capture_output=True,
            timeout=15,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        event = json.loads(result.stdout)
        self.assertNotIn("PRIVATE_PROVIDER_BODY", result.stdout)
        with (
            tempfile.TemporaryDirectory(prefix="kimi-context-outcome-") as root,
            patch.dict(
                os.environ,
                {"DATABASE_URL": "sqlite+aiosqlite:///:memory:", "SODUWORK_DATA_ROOT": root},
            ),
        ):
            from app.services import local_base, local_ctx, local_stream

            ref = "isolated-kimi-context-overflow"
            run = {
                "state": "running",
                "cli": "kimi",
                "ws": root,
                "seq": 0,
                "lines": [],
                "cfg": {},
                "cliSid": "retained-native-session",
            }
            terminal = {"outputTruncated": True}
            local_base._RUNS[ref] = run
            try:
                with (
                    patch.object(local_base, "_STORE", root),
                    patch.object(local_ctx, "_recover_overflow", return_value=True) as recover,
                ):
                    local_stream._on_line(ref, json.dumps(event), terminal)
                    self.assertTrue(terminal.get("overflow"))
                    self.assertTrue(terminal.get("isError"))
                    self.assertNotIn("outputTruncated", terminal)
                    local_stream._finish(ref, 2, terminal, "")
                recover.assert_called_once_with(ref)
                self.assertEqual(run["cliSid"], "retained-native-session")
                self.assertNotEqual(run["state"], "done")
            finally:
                local_base._RUNS.pop(ref, None)

    def test_preload_is_consumed_before_any_tool_process(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("Node is unavailable")
        with tempfile.TemporaryDirectory(prefix="kimi loader space ") as root:
            copied = Path(root) / "kimi_acp_outcome.mjs"
            shutil.copyfile(Path(kimi_runtime.__file__).with_name(copied.name), copied)
            env = {
                "PATH": os.defpath,
                "SODUWORK_KIMI_ACP_OUTCOME": "1",
                "NODE_OPTIONS": "--import=" + copied.as_uri(),
            }
            if os.name == "nt":
                # Node's Windows crypto initialization needs the system directory.
                env["SystemRoot"] = os.environ["SystemRoot"]
            script = "console.log(JSON.stringify({flag:process.env.SODUWORK_KIMI_ACP_OUTCOME, options:process.env.NODE_OPTIONS}))"
            result = subprocess.run(
                [node, "-e", script],
                env=env,
                text=True,
                capture_output=True,
                timeout=15,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {})


if __name__ == "__main__":
    unittest.main()
