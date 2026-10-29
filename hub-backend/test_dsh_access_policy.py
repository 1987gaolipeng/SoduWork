"""DSH permission launch defaults and strict ACP application contract."""
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app.services import access_policy, dsh_runtime, local_base
from app.services.acp_access import AccessError, BridgeAccess


class DshAccessPolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-dsh-policy-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.work = self.root / "workspace"
        self.work.mkdir()

    def policy(self, mode="standard"):
        return access_policy.normalize({"schema": access_policy.SCHEMA,
            "mode": mode, "revision": 1, "workspaceRoot": str(self.work)})

    def test_all_declared_modes_are_accepted_without_changing_the_workspace(self):
        self.assertTrue(access_policy.capability("dsh")["supported"])
        for mode in ("standard", "readonly", "full"):
            value = access_policy.prepare("dsh", self.policy(mode), str(self.work))
            self.assertEqual(value["mode"], mode)
            self.assertEqual(value["workspaceRoot"], str(self.work.resolve()))

    def test_inherited_wider_default_is_overridden_before_native_initialization(self):
        for mode, expected in (("standard", "workspace-write"), ("readonly", "read-only"),
                               ("full", "danger-full-access")):
            env = {"DSH_PERMISSION_MODE": "danger-full-access"}
            dsh_runtime.apply_access_env(env, self.policy(mode))
            self.assertEqual(env["DSH_PERMISSION_MODE"], expected)
        env = {"DSH_PERMISSION_MODE": "workspace-write"}
        dsh_runtime.apply_access_env(env, None)
        self.assertEqual(env["DSH_PERMISSION_MODE"], "workspace-write")
        with self.assertRaises(RuntimeError):
            dsh_runtime.apply_access_env(env, {"mode": "unknown"})

    def test_real_runner_environment_passes_policy_before_llm_bootstrap(self):
        with patch.object(local_base, "_data_root", return_value=str(self.root / "data")):
            for mode, expected in (("standard", "workspace-write"), ("readonly", "read-only"),
                                   ("full", "danger-full-access")):
                env = local_base._env_for(local_base._PROFILES["dsh"], {
                    "local_workspace_root": str(self.work), "accessPolicy": self.policy(mode),
                    "llm": {"base": "http://127.0.0.1:9/v1", "key": "fixture", "model": "fixture"},
                }, "dsh-policy-" + mode)
                self.assertEqual(env["DSH_PERMISSION_MODE"], expected)
                self.assertNotEqual(env["TEMP"], str(self.work / "temp"))

    def bridge(self, mode):
        access = BridgeAccess(json.dumps({"url": "http://127.0.0.1:1", "token": "fixture",
                                          "policy": self.policy(mode)}), agent_name="dsh")
        calls = []
        access.call = lambda path, data: calls.append((path, data)) or {"ok": True}
        native = []
        bridge = SimpleNamespace(agent_name="dsh", session_id="fixture",
                                 request=lambda method, params: native.append((method, params)))
        return access, bridge, calls, native

    def test_mode_is_reapplied_on_resumed_session_before_acknowledging_policy(self):
        for mode, expected in (("standard", "workspace-write"), ("readonly", "read-only"),
                               ("full", "danger-full-access")):
            access, bridge, calls, native = self.bridge(mode)
            access.apply(bridge, {"modes": {"currentModeId": "danger-full-access",
                "availableModes": [{"id": v} for v in ("workspace-write", "read-only", "danger-full-access")]}})
            self.assertEqual(native, [("session/set_mode", {"sessionId": "fixture", "modeId": expected})])
            self.assertEqual(calls, [("/applied", {"mode": mode, "nativeMode": expected})])

    def test_missing_mode_or_failed_native_ack_never_reports_policy_applied(self):
        access, bridge, calls, native = self.bridge("readonly")
        with self.assertRaises(AccessError):
            access.apply(bridge, {"modes": {"availableModes": [{"id": "danger-full-access"}]}})
        self.assertEqual(native, [])
        self.assertEqual(calls, [])
        def reject(*args):
            raise RuntimeError("mode rejected")
        bridge.request = reject
        with self.assertRaises(RuntimeError):
            access.apply(bridge, {"modes": {"availableModes": [{"id": "read-only"}]}})
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
