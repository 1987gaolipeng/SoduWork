"""Test automation capability validation and preflight without real databases or Runners. Allow
offline or capable devices, block only explicit online capability gaps, distinguish
grant/upgrade/install remedies, and include precise failure reasons and next steps.
"""
from __future__ import annotations

import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///.smoke-capability-gate.db")

from app.services import execution_capabilities  # noqa: E402
from app.services import schedules as sch  # noqa: E402


def _verdict(required, items=(), reported_at=1):
    """Build verdicts with the real evaluate function to preserve production structure."""
    return execution_capabilities.evaluate(
        {"reportedAt": reported_at, "items": list(items), "available": []},
        required)


def _runner(host="研发-王工的电脑"):
    return SimpleNamespace(host=host, client_id="client-1")


class CapabilityRemediationTests(unittest.TestCase):
    def test_installed_but_unauthorized_maps_to_grant(self):
        verdict = _verdict(["computer"], items=[
            {"key": "computer", "installed": True, "available": False,
             "authorized": False, "detail": "已检测到"},
        ])
        remedy, message = sch._capability_remediation(_runner(), verdict)
        self.assertEqual(remedy, "grant")
        self.assertIn("尚未获得本机授权", message)

    def test_never_reported_maps_to_upgrade(self):
        verdict = _verdict(["office"], reported_at=0)
        remedy, message = sch._capability_remediation(_runner(), verdict)
        self.assertEqual(remedy, "upgrade")
        self.assertIn("版本过旧", message)

    def test_missing_environment_maps_to_install(self):
        verdict = _verdict(["office"], items=[
            {"key": "office", "installed": False, "available": False,
             "authorized": False, "detail": "尚未安装免费办公文档引擎"},
        ])
        remedy, message = sch._capability_remediation(_runner(), verdict)
        self.assertEqual(remedy, "install")
        self.assertIn("办公文档", message)


class CapabilitySaveBlockerTests(unittest.TestCase):
    def _schedule(self, required):
        return SimpleNamespace(owner_client_id="client-1",
                               required_capabilities=required)

    def test_empty_requirements_pass_without_runner(self):
        self.assertEqual(sch.capability_save_blocker(self._schedule([])), "")

    def test_offline_runner_passes(self):
        with patch("app.services.runner_hub.for_client", return_value=None):
            self.assertEqual(
                sch.capability_save_blocker(self._schedule(["computer"])), "")

    def test_satisfied_runner_passes(self):
        runner = _runner()
        verdict = _verdict([])
        verdict["report"]["items"] = [
            {"key": "computer", "available": True, "installed": True,
             "authorized": True}]
        with patch("app.services.runner_hub.for_client", return_value=runner), \
             patch("app.services.runner_hub.capability_verdict",
                   return_value=verdict):
            self.assertEqual(
                sch.capability_save_blocker(self._schedule(["computer"])), "")

    def test_online_unauthorized_runner_is_blocked(self):
        runner = _runner()
        verdict = _verdict(["computer"], items=[
            {"key": "computer", "installed": True, "available": False,
             "authorized": False, "detail": "已检测到"},
        ])
        with patch("app.services.runner_hub.for_client", return_value=runner), \
             patch("app.services.runner_hub.capability_verdict",
                   return_value=verdict):
            blocker = sch.capability_save_blocker(self._schedule(["computer"]))
        self.assertIn("尚未获得本机授权", blocker)

    def test_old_runner_without_report_is_blocked(self):
        runner = _runner()
        with patch("app.services.runner_hub.for_client", return_value=runner), \
             patch("app.services.runner_hub.capability_verdict",
                   return_value=_verdict(["office"], reported_at=0)):
            blocker = sch.capability_save_blocker(self._schedule(["office"]))
        self.assertIn("版本过旧", blocker)


class FailureHintTests(unittest.TestCase):
    def test_unauthorized_hint(self):
        hint = sch._failure_hint("computer 已检测到，但尚未获得本机授权")
        self.assertIn("管理本机能力", hint)

    def test_old_runner_hint(self):
        self.assertIn("升级", sch._failure_hint("Runner 版本过旧，没有上报本机能力"))

    def test_missing_engine_hint(self):
        self.assertIn("立即执行",
                      sch._failure_hint("执行前能力预检未通过：office 缺少办公文档"))

    def test_unknown_error_has_no_hint(self):
        self.assertEqual(sch._failure_hint("网络抖了一下"), "")


class PreflightDisambiguationTests(unittest.TestCase):
    def _run(self, verdict):
        schedule = SimpleNamespace(
            personal_plugin_key="", plugin_binding_id="",
            personal_plugin_snapshot=None,
            assignee_id="local:pi", assignee_type="agent",
            required_capabilities=["computer"], owner_client_id="client-1")
        runner = _runner()

        async def fake_resolve_named(session, names, client):
            return []

        class FakeSession:
            async def get(self, model, key):
                return SimpleNamespace(id=key)

        ctx = SimpleNamespace(_fixture="ctx")
        from app.services import ai_exec
        with patch.object(ai_exec, "load", return_value=ctx), \
             patch("app.services.skills.resolve_named", fake_resolve_named), \
             patch.object(ai_exec, "resolve_requested_sync", return_value=None), \
             patch("app.services.runner_hub.for_client", return_value=runner), \
             patch("app.services.runner_hub.capability_verdict",
                   return_value=verdict):
            import asyncio
            return asyncio.run(sch.preflight_execution(FakeSession(), schedule))

    def test_online_but_unauthorized_reports_remedy(self):
        result = self._run(_verdict(["computer"], items=[
            {"key": "computer", "installed": True, "available": False,
             "authorized": False, "detail": "已检测到"},
        ]))
        self.assertEqual(result["state"], "waiting")
        self.assertEqual(result["remedy"], "grant")
        self.assertIn("尚未获得本机授权", result["message"])

    def test_offline_runner_keeps_generic_waiting(self):
        # Offline waiting is not a capability error; omit the remedy and preserve the original message.
        schedule = SimpleNamespace(
            personal_plugin_key="", plugin_binding_id="",
            personal_plugin_snapshot=None,
            assignee_id="local:pi", assignee_type="agent",
            required_capabilities=["computer"], owner_client_id="client-1")

        async def fake_resolve_named(session, names, client):
            return []

        class FakeSession:
            async def get(self, model, key):
                return SimpleNamespace(id=key)

        from app.services import ai_exec
        with patch.object(ai_exec, "load", return_value=SimpleNamespace()), \
             patch("app.services.skills.resolve_named", fake_resolve_named), \
             patch.object(ai_exec, "resolve_requested_sync", return_value=None), \
             patch("app.services.runner_hub.for_client", return_value=None):
            import asyncio
            result = asyncio.run(sch.preflight_execution(FakeSession(), schedule))
        self.assertEqual(result["state"], "waiting")
        self.assertNotIn("remedy", result)
        self.assertIn("Runner 在线", result["message"])


if __name__ == "__main__":
    unittest.main()
