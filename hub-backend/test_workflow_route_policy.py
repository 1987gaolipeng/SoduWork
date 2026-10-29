"""Execution override compatibility without starting an Agent or opening a database."""
import copy
import os
import unittest

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from app.services import workflow_route_policy as policy, workflow_runs


class WorkflowRoutePolicyTests(unittest.TestCase):
    def test_route_precedence_and_model_switch_preserve_callers(self):
        context = {"execution": {"agentKind": "local:codex", "model": "runtime"},
                   "executionOverrides": {"build": {"model": "manual"}}}
        binding = {"model": "binding", "runnerTags": ["company"],
                   "nodeOverrides": {"build": {"execution": {
                       "agentKind": "local:pi", "model": "project"}}}}
        node = {"agentKind": "local:codex", "model": "plugin", "reasoningEffort": "high"}
        original = copy.deepcopy((context, binding, node))
        expected = {"agentKind": "local:pi", "model": "manual",
                    "reasoningEffort": "", "fallbackMode": "best-effort",
                    "runnerTags": ["company"], "manual": True}
        self.assertEqual(policy.execution_route(context, binding, node, "build"), expected)
        self.assertEqual(workflow_runs.execution_route(context, binding, node, "build"), expected)
        self.assertEqual((context, binding, node), original)
        del context["executionOverrides"]
        self.assertEqual(policy.execution_route(context, binding, node, "build")["model"], "project")
        del binding["nodeOverrides"]
        self.assertEqual(policy.execution_route(context, binding, node, "build")["model"], "plugin")
        self.assertEqual(policy.execution_route(context, binding, {}, "build")["model"], "runtime")

    def test_binding_normalization_keeps_unrelated_config_and_canonical_overrides(self):
        raw = {"execution": {"agentKind": "local:codex", "reasoningEffort": "high"},
               "model": "legacy-default", "custom": {"keep": True},
               "nodeOverrides": {"build": {"model": "node-model"}}}
        original = copy.deepcopy(raw)
        workflow = {"nodes": [{"key": "build", "type": "ai"},
                              {"key": "gate", "type": "approval"}]}
        expected = {"agentKind": "local:codex", "reasoningEffort": "high",
                    "model": "legacy-default", "custom": {"keep": True},
                    "nodeOverrides": {"build": {"execution": {"model": "node-model"}}}}
        self.assertEqual(policy.normalize_binding_execution(raw, workflow), expected)
        self.assertEqual(workflow_runs.normalize_binding_execution(raw, workflow), expected)
        self.assertEqual(raw, original)
        for key in ("missing", "gate"):
            with self.subTest(key=key), self.assertRaises(ValueError):
                policy.normalize_binding_execution({"nodeOverrides": {key: {"model": "x"}}}, workflow)

    def test_invalid_preferences_still_fail_and_only_portable_fields_survive(self):
        self.assertEqual(policy.execution_preferences({"agentKind": "local:pi", "runnerId": "private"}),
                         {"agentKind": "local:pi"})
        for raw in ([], {"agentKind": "runner:private:pi"},
                    {"reasoningEffort": "unsupported"}, {"fallbackMode": "any"},
                    {"runnerTags": "company"}):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                policy.execution_preferences(raw)


if __name__ == "__main__":
    unittest.main()
