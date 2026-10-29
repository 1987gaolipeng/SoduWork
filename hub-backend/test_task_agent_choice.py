"""Projects and scenarios recommend execution modes but cannot lock the executor to a plugin or
Agent.
"""
import os
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ.setdefault("AUTH_SECRET", "isolated-task-agent-choice-secret")
os.environ.setdefault("ADMIN_PASS", "isolated-task-agent-choice-password")

from app.services import task_execution_options as opts, workflow_runs


class AgentChoiceTests(unittest.IsolatedAsyncioTestCase):
    def test_executor_can_choose_other_authorized_plugins(self):
        rows = [{"key": "recommended", "runnable": True},
                {"key": "another", "runnable": True},
                {"key": "offline", "runnable": False}]
        selected = opts.select_workflows(rows, "", "recommended", for_execution=True)
        self.assertEqual({row["key"] for row in selected}, {"recommended", "another", "offline"})
        self.assertFalse(next(row for row in selected if row["key"] == "another")["recommended"])

    async def test_all_entry_points_keep_available_agent_types(self):
        client = SimpleNamespace(id="owner-device")
        repo = {"id": "repo", "projectId": "project", "name": "General"}
        agents = [{"id": "local:"+cli, "cli": cli, "machineKey": "same-pc",
                   "capabilities": {"available": ["files", "repository", "terminal"]}}
                  for cli in ("pi", "codex", "opencode", "codex-harness", "dsh", "qwen")]
        for existing in (False, True):
            for workflow in (False, True):
                for contract in ("document", "repository-change"):
                    with self.subTest(existing=existing, workflow=workflow, contract=contract), ExitStack() as s:
                        routing = {"scenarioKey": "office", "defaultPluginKey": "custom-flow",
                                   "requiredAgentCapabilities": ["files"], "outputContract": {"kind": contract}}
                        task = SimpleNamespace(id="task", owner_client_id=client.id, project_id="project",
                            repo_id="repo", title="Requirement task", note="All material", tags=[],
                            work_routing=routing, work_scenario_key="office", work_scenario_name="Office")
                        s.enter_context(patch.object(opts, "_visible_repos", new=AsyncMock(return_value=(None, [repo]))))
                        s.enter_context(patch.object(opts.task_access, "view_task", new=AsyncMock(return_value=task)))
                        s.enter_context(patch.object(opts.work_catalog, "recommend", new=AsyncMock(return_value={})))
                        s.enter_context(patch.object(opts.work_catalog, "routing_snapshot", return_value=routing))
                        s.enter_context(patch.object(opts.plugin_service, "available_bindings", new=AsyncMock(return_value=[
                            {"bindingId": "flow", "pluginId": "plugin", "sourceKind": "builtin",
                             "key": "custom-flow", "projectSpecific": True, "isDefault": True, "runnable": True}
                        ] if workflow else [])))
                        s.enter_context(patch.object(opts.ai_exec, "load", new=AsyncMock(return_value={})))
                        s.enter_context(patch.object(opts.ai_exec, "with_client_runner_scope", side_effect=lambda c, _: c))
                        s.enter_context(patch.object(opts.ai_exec, "list_assignees_sync", return_value={"agents": agents}))
                        s.enter_context(patch.object(opts.ai_exec, "model_choices", return_value={}))
                        s.enter_context(patch.object(opts.ai_exec, "default_assignee", return_value={}))
                        s.enter_context(patch.object(opts.model_catalog, "choices", new=AsyncMock(return_value={})))
                        s.enter_context(patch.object(opts.task_assignment, "project_route", new=AsyncMock(return_value={"agentKind": "local:pi"})))
                        out = await opts.build(None, client, {"repoId": "repo", "taskId": "task" if existing else ""})
                        self.assertFalse(out["recommendation"]["workflowRequired"])
                        self.assertEqual({a["cli"] for a in out["substrates"] if a["available"]}, {a["cli"] for a in agents})
                        self.assertEqual(out["recommendation"]["strategy"], "workflow" if workflow else "direct")

    def test_node_routes_remain_independent(self):
        context = {"execution": {"agentKind": "local:qwen", "model": "ordinary-model"}}
        first = workflow_runs.execution_route(context, {}, {"agentKind": "local:codex", "model": "first-model"}, "first")
        second = workflow_runs.execution_route(context, {}, {"agentKind": "local:pi", "model": "second-model"}, "second")
        self.assertEqual((first["agentKind"], first["model"]), ("local:codex", "first-model"))
        self.assertEqual((second["agentKind"], second["model"]), ("local:pi", "second-model"))

    def test_offline_or_unauthorized_capability_cannot_be_dispatched(self):
        row = {"id": "local:pi", "cli": "pi", "capabilities": {"available": ["files"]}}
        self.assertFalse(opts.substrate_options([row], ["repository"])[0]["available"])
        self.assertEqual(opts.substrate_options([{**row, "online": False}], []), [])


if __name__ == "__main__":
    unittest.main()
