# -*- coding: utf-8 -*-
"""Isolated publication-evaluation smoke; never connects to a business database."""
import asyncio
import os
import shutil
import sys
from types import SimpleNamespace


BASE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(BASE, ".smoke-plugin-evaluations.db")
DATA = os.path.join(BASE, ".smoke-plugin-evaluations-data")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
shutil.rmtree(DATA, ignore_errors=True)
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
os.environ["SODUWORK_DATA_ROOT"] = DATA
sys.path.insert(0, BASE)

from app import automation_models as am, models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import ai_exec, plugin_evaluations, workflow_inputs  # noqa: E402


ORG = "o-smoke-plugin-evaluation"
USER = "u-smoke-plugin-evaluation"
CLIENT = "c-smoke-plugin-evaluation"
PLUGIN = "p-smoke-plugin-evaluation"
VERSION = "v-smoke-plugin-evaluation"
passed = failed = 0


def check(name, condition, extra=""):
    global passed, failed
    if condition:
        passed += 1
    else:
        failed += 1
        print("FAIL", name, str(extra)[:500])


async def main():
    await init_db()
    async with SessionLocal() as session:
        session.add(models.OrgUnit(id=ORG, name="Evaluation smoke"))
        session.add(models.User(
            id=USER, username="evaluation-smoke", display_name="Evaluation reviewer",
            org_id=ORG, is_active=True))
        session.add(models.Client(
            id=CLIENT, name="Evaluation runner owner", user_ref=USER,
            auth_state="active"))
        session.add(am.Plugin(
            id=PLUGIN, org_id=None, key="evaluation-smoke", name="Evaluation smoke",
            description="Publication gate", source_kind="soduwork", enabled=False,
            created_by=USER))
        session.add(am.PluginVersion(
            id=VERSION, plugin_id=PLUGIN, version="1.0.0", checksum="e" * 64,
            manifest={"name": "Evaluation smoke", "instructions": "Produce a verified result."},
            workflow={"nodes": [{
                "key": "execute", "type": "ai", "name": "Execute",
                "config": {"prompt": "Produce the result.", "agentKind": "local:pi"},
                "outputs": [{"key": "result", "kind": "evidence",
                             "label": "Result", "required": True}],
            }]},
            capability_report={
                "runtime": [], "skills": [], "mcpServers": [], "secrets": [],
                "network": False,
                "resultContract": [{
                    "id": "execute.result", "nodeKey": "execute", "key": "result",
                    "kind": "evidence", "label": "Result", "required": True,
                }],
                "evaluationCases": [{
                    "key": "representative", "name": "Representative",
                    "instruction": "Create a useful result.",
                    "inputs": {"topic": "quality"}, "criteria": ["Result is clear"],
                    "expectedOutputs": ["execute.result"],
                }],
            },
            trust_state="quarantined", enabled=False, created_by=USER))
        await session.commit()

    original = {
        "load": ai_exec.load,
        "resolve_kind": ai_exec.resolve_kind,
        "dispatch_sync": ai_exec.dispatch_sync,
        "status_sync": ai_exec.status_sync,
        "fetch": ai_exec.fetch_attachment_for_sync,
        "skills": workflow_inputs.plugin_skills,
        "stop": ai_exec.stop_sync,
    }
    state = {"done": False, "dispatches": 0, "stopped": False,
             "preferRunner": ""}

    async def fake_load(_session, force=False):
        return {"name": "local", "cfg": {}}

    def fake_resolve(_ctx, kind, client_id="", prefer_runner="",
                     required_capabilities=None, runner_tags=None):
        state["preferRunner"] = prefer_runner
        return {"id": "runner:runner-smoke:pi", "name": "Smoke Pi",
                "host": "smoke-host", "runnerId": "runner-smoke"}

    def fake_dispatch(_ctx, _task, _files, assignee, extra):
        state["dispatches"] += 1
        check("evaluation keeps organization Runner scope",
              not _ctx.get("_clientRunnerOnly"), _ctx)
        check("evaluation prompt is side-effect bounded",
              "不得执行审批、合并、部署" in extra.get("brief", ""))
        check("evaluation report is a required output",
              any(item.get("path") == "evaluation-result.md"
                  for item in extra.get("expectedOutputs") or []))
        return {"ok": True, "issueId": "eval-ref-" + str(state["dispatches"]),
                "provider": "local", "assigneeId": assignee["id"],
                "assigneeName": assignee["name"], "model": "smoke-model"}

    def fake_status(_ctx, _ref):
        return ({"ok": True, "done": True, "status": "done", "error": "",
                 "attachments": [{"id": "evaluation-result.md",
                                  "filename": "evaluation-result.md"}]}
                if state["done"] else
                {"ok": True, "done": False, "running": True, "status": "running"})

    def fake_fetch(_ctx, _ref, _attachment):
        return b"# Evaluation\nAll criteria have evidence.\n"

    async def fake_skills(_session, _version, names=None):
        return []

    def fake_stop(_ctx, _ref):
        state["stopped"] = True
        return {"ok": True}

    ai_exec.load = fake_load
    ai_exec.resolve_kind = fake_resolve
    ai_exec.dispatch_sync = fake_dispatch
    ai_exec.status_sync = fake_status
    ai_exec.fetch_attachment_for_sync = fake_fetch
    ai_exec.stop_sync = fake_stop
    workflow_inputs.plugin_skills = fake_skills
    actor = SimpleNamespace(
        id=USER, org_id=ORG, display_name="Evaluation reviewer",
        username="evaluation-smoke")
    try:
        async with SessionLocal() as session:
            version = await session.get(am.PluginVersion, VERSION)
            side_effect_contract = plugin_evaluations._contract_check(
                SimpleNamespace(capability_report={"resultContract": [{
                    "id": "publish.commit", "kind": "git",
                    "label": "仓库提交", "required": True,
                }]}),
                {"expectedOutputs": ["publish.commit"]},
                {},
                [{"id": "report", "filename": "evaluation-result.md",
                  "fetched": True}],
            )
            check("required side effects never pass without execution evidence",
                  not side_effect_contract["ok"]
                  and side_effect_contract["items"][0]["status"] == "not-exercised",
                  side_effect_contract)
            gate = await plugin_evaluations.publication_gate(session, version)
            check("declared evaluation blocks publication before execution",
                  not gate["ok"] and gate["cases"][0]["state"] == "not-run", gate)

            run = await plugin_evaluations.start(
                session, version, "representative", actor,
                {"runnerId": "runner-smoke"})
            check("evaluation dispatch is durable",
                  run.state == "running" and run.external_ref == "eval-ref-1"
                  and bool(run.active_key), run.state)
            check("global plugin evaluation inherits reviewer organization",
                  run.org_id == ORG, run.org_id)
            check("explicit evaluation Runner is pinned and recorded",
                  state["preferRunner"] == "runner-smoke"
                  and run.executor.get("runnerId") == "runner-smoke"
                  and run.executor.get("requestedRunnerId") == "runner-smoke",
                  run.executor)
            same = await plugin_evaluations.start(
                session, version, "representative", actor, {})
            check("active evaluation start is idempotent", same.id == run.id)

            active = await plugin_evaluations.list_runs(session, version)
            check("running evaluation remains visible",
                  active["items"][0]["state"] == "running", active)
            state["done"] = True
            completed = await plugin_evaluations.list_runs(session, version)
            current = await session.get(am.PluginEvaluationRun, run.id)
            check("completed artifacts have immutable checksum",
                  completed["items"][0]["result"]["artifacts"][0]["sha256"]
                  and current.result["contract"]["ok"]
                  and current.active_key is None, completed)
            gate = await plugin_evaluations.publication_gate(session, version)
            check("contract-complete evaluation is ready for one-step release review",
                  not gate["ok"] and gate["readyForApproval"]
                  and gate["readyCount"] == 1, gate)
            accepted = await plugin_evaluations.accept_ready_with_release_review(
                session, version, USER)
            gate = await plugin_evaluations.publication_gate(session, version)
            check("version review accepts ready evidence and opens publication gate",
                  accepted == 1 and gate["ok"] and gate["passedCount"] == 1, gate)

            state["done"] = False
            rerun = await plugin_evaluations.start(
                session, version, "representative", actor, {})
            gate = await plugin_evaluations.publication_gate(session, version)
            check("newer rerun supersedes stale pass", not gate["ok"], gate)
            await plugin_evaluations.cancel(session, rerun, "reviewer")
            check("evaluation cancel calls provider stop",
                  state["stopped"] and rerun.state == "cancelled")
            gate = await plugin_evaluations.publication_gate(session, version)
            check("cancelled latest run keeps publication blocked", not gate["ok"], gate)

            state["done"] = True
            rejected = await plugin_evaluations.start(
                session, version, "representative", actor, {})
            await plugin_evaluations.refresh(session, rejected)
            await plugin_evaluations.review(
                session, rejected, "failed", USER, "needs improvement")
            gate = await plugin_evaluations.publication_gate(session, version)
            check("human rejection has a distinct gate state",
                  not gate["ok"] and gate["cases"][0]["state"] == "review-failed", gate)

            no_cases = am.PluginVersion(
                plugin_id=PLUGIN, version="1.0.1", checksum="f" * 64,
                manifest={}, workflow={}, capability_report={},
                trust_state="quarantined", enabled=False, created_by=USER)
            session.add(no_cases)
            await session.flush()
            guarded = await plugin_evaluations.publication_gate(session, no_cases)
            confirmed = await plugin_evaluations.publication_gate(
                session, no_cases, confirm_without_evaluation=True)
            check("undeclared quality needs explicit administrator confirmation",
                  not guarded["ok"] and confirmed["ok"], (guarded, confirmed))
    finally:
        ai_exec.load = original["load"]
        ai_exec.resolve_kind = original["resolve_kind"]
        ai_exec.dispatch_sync = original["dispatch_sync"]
        ai_exec.status_sync = original["status_sync"]
        ai_exec.fetch_attachment_for_sync = original["fetch"]
        ai_exec.stop_sync = original["stop"]
        workflow_inputs.plugin_skills = original["skills"]

    await engine.dispose()
    shutil.rmtree(DATA, ignore_errors=True)
    for suffix in ("", "-shm", "-wal"):
        try:
            os.remove(DB + suffix)
        except FileNotFoundError:
            pass
    print("plugin evaluations:", passed, "passed,", failed, "failed")
    if failed:
        raise SystemExit(1)


asyncio.run(main())
