"""Installed extensions retain behavior; omitted private modules cannot fake success."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace as NS
import unittest
from unittest.mock import AsyncMock, patch

from app.services import optional_internal_features as features


class OptionalServiceTests(unittest.TestCase):
    def test_fixed_module_allowlist_and_internal_quality_defaults(self):
        with self.assertRaises(KeyError):
            features.available("../../module")
        with patch.object(features, "find_spec", return_value=object()):
            self.assertTrue(features.hygiene_requested({}))
            self.assertTrue(features.hygiene_requested({"hygiene": True}))
            self.assertFalse(features.hygiene_requested({"hygiene": False}))
        with patch.object(features, "find_spec", return_value=None):
            self.assertFalse(features.hygiene_requested({}))
            with self.assertRaises(features.InternalFeatureUnavailable):
                features.hygiene_requested({"hygiene": True})

    def test_runner_explicit_internal_check_stops_before_checkout(self):
        from app.services import runner_quality
        states = []
        with patch.object(features, "find_spec", return_value=None), \
                patch.object(runner_quality, "_load", return_value=None), \
                patch.object(runner_quality, "_save", side_effect=lambda state: states.append(dict(state))), \
                patch.object(runner_quality, "_immutable_checkout") as checkout, \
                patch.object(runner_quality, "_drop_checkout"):
            runner_quality._worker({"runId": "fixture", "hygiene": True,
                                    "commands": [{"argv": ["never-execute"]}]}, "unused")
        checkout.assert_not_called()
        self.assertEqual(states[-1]["state"], "failed")
        self.assertEqual(states[-1]["failureKind"], "configuration")
        self.assertEqual(states[-1]["result"]["checks"], [])

    def test_normal_quality_command_really_executes_without_internal_checks(self):
        from app.services import runner_quality
        states = []
        with tempfile.TemporaryDirectory() as folder, \
                patch.object(features, "find_spec", return_value=None), \
                patch.object(runner_quality, "_load", return_value=None), \
                patch.object(runner_quality, "_save", side_effect=lambda state: states.append(dict(state))), \
                patch.object(runner_quality, "_append"), \
                patch.object(runner_quality, "_immutable_checkout", return_value=("", folder, "a" * 40)), \
                patch.object(runner_quality, "_drop_checkout"):
            argv = [sys.executable, "-c", "from pathlib import Path;Path('proof.txt').write_text('executed')"]
            runner_quality._worker({"runId": "fixture", "hygiene": False,
                                    "commands": [{"name": "actual command", "argv": argv}]}, folder)
            self.assertEqual((Path(folder) / "proof.txt").read_text(), "executed")
        self.assertEqual(states[-1]["state"], "succeeded")
        self.assertEqual(len(states[-1]["result"]["checks"]), 1)

    def test_real_source_copy_imports_with_all_private_components_absent(self):
        source = Path(__file__).parent / "app"
        omitted = {"change_hygiene.py", "smart_route.py", "cicd_publish.py"}
        with tempfile.TemporaryDirectory(prefix="soduwork-optional-source-") as folder:
            root = Path(folder)
            for file in source.rglob("*"):
                if not file.is_file() or "__pycache__" in file.parts:
                    continue
                if file.parent.name == "services" and file.name in omitted:
                    continue
                target = root / "app" / file.relative_to(source)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(file.read_bytes())
            env = dict(os.environ, PYTHONPATH=str(root), PYTHONDONTWRITEBYTECODE="1",
                       DATABASE_URL="sqlite+aiosqlite:///" + (root / "test.db").as_posix(),
                       AUTH_SECRET="fixture-optional-source-secret", ADMIN_PASS="fixture-optional-source-password",
                       SODUWORK_DATA_ROOT=str(root / "data"), SODUWORK_ENV="test")
            script = '''import json
from app.main import app
from app.connectors import REGISTRY
from app.services import optional_internal_features as f, release_providers, ai_prompts
assert not any(f.available(x) for x in ('change_hygiene','smart_route','cicd'))
assert 'gitlab' in REGISTRY and 'gerrit' not in REGISTRY
assert [x['key'] for x in release_providers.kinds()]==['runner-command']
assert release_providers.validate('cicd-mcp',{'customer':'fixture'})
assert ai_prompts.dev_flow('main',True,'fixture')
assert len(app.routes)>50
print(json.dumps({'routes':len(app.routes),'providers':[x['key'] for x in release_providers.kinds()]}))
'''
            result = subprocess.run([sys.executable, "-c", script], cwd=root, env=env,
                                    capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertGreater(json.loads(result.stdout.strip())["routes"], 50)
            self.assertFalse((root / "test.db").exists())


class OptionalExecutionTests(unittest.IsolatedAsyncioTestCase):
    async def test_missing_route_uses_unmatched_result_without_reading_projects(self):
        from app.services import aggregation
        session = AsyncMock()
        with patch.object(features, "find_spec", return_value=None):
            self.assertEqual(await aggregation._smart_route(session, "title", "note"), ("", None))
        session.execute.assert_not_awaited()

    async def test_cicd_requests_block_before_target_or_credentials(self):
        from app.services import cicd_workflow, rollback
        with patch.object(features, "find_spec", return_value=None), \
                patch.object(cicd_workflow.task_code_targets, "repo_view", new_callable=AsyncMock) as repo:
            with self.assertRaises(features.InternalFeatureUnavailable):
                await cicd_workflow.publish_cicd(None, None, None, None, {})
            with self.assertRaises(features.InternalFeatureUnavailable):
                await rollback.execute(None, None, {})
        repo.assert_not_awaited()

    async def test_inflight_cicd_receipt_is_retained_without_replay(self):
        from app.services import release_providers
        session = AsyncMock()
        run = NS(state="running", result={"version": "old", "provider": "cicd-mcp"})
        target = NS(provider="cicd-mcp")
        with patch.object(features, "find_spec", return_value=None):
            await release_providers.poll(session, run, None, target, None)
        self.assertEqual(run.state, "failed")
        self.assertEqual(run.result["version"], "old")
        self.assertEqual(run.result["failureKind"], "configuration")
        session.commit.assert_awaited_once()

    async def test_generic_flow_remains_ready_and_explicit_missing_component_is_blocked(self):
        from app.services import plugin_readiness
        with patch.object(features, "find_spec", return_value=None):
            for nodes, ready in [([{"type": "ai"}, {"type": "quality"}], True),
                                 ([{"type": "quality", "config": {"hygiene": True}}], False),
                                 ([{"type": "publish", "config": {"mode": "cicd"}}], False)]:
                result = await plugin_readiness.binding_readiness(
                    AsyncMock(), NS(workflow={"nodes": nodes}, capability_report={}), None, None)
                self.assertEqual(result["ok"], ready, result)


if __name__ == "__main__":
    unittest.main()
