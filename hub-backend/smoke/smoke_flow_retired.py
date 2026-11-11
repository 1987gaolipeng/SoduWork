# -*- coding: utf-8 -*-
"""Regression checks for public module contracts."""
import asyncio
import importlib
import os
import sys
from route_test_support import api_routes

DB = os.path.abspath(".smoke-flowretired.db")
for sfx in ("", "-shm", "-wal"):
    try:
        os.remove(DB + sfx)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra) if extra else ""))


def gone(modname):
    try:
        importlib.import_module(modname)
        return False
    except ModuleNotFoundError:
        return True


async def main():
    from app.main import app
    from app import models, schemas

    routes = {(m, r.path) for r in api_routes(app) for m in (r.methods or [])}
    dead = [
        ("GET", "/api/v1/admin/flows"), ("POST", "/api/v1/admin/flows"),
        ("PATCH", "/api/v1/admin/flows/{fid}"), ("DELETE", "/api/v1/admin/flows/{fid}"),
        ("GET", "/api/v1/admin/flow-options"), ("GET", "/api/v1/admin/flow-health"),
        ("GET", "/api/v1/admin/dispatch-rules"), ("PUT", "/api/v1/admin/dispatch-rules"),
        ("POST", "/api/v1/admin/workflow/tasks"), ("POST", "/api/v1/admin/tasks/{tid}/workflow"),
        ("POST", "/api/v1/admin/tasks/{tid}/advance"), ("POST", "/api/v1/admin/tasks/{tid}/reject"),
        ("GET", "/api/v1/tasks/{tid}/flow"),
        ("POST", "/api/v1/tasks/{tid}/advance"), ("POST", "/api/v1/tasks/{tid}/reject"),
        ("POST", "/api/v1/team/tasks/{tid}/advance"), ("POST", "/api/v1/team/tasks/{tid}/reject"),
        ("GET", "/api/v1/tasks/{tid}/ai-suggest"),
    ]
    leftover = [f"{m} {p}" for (m, p) in dead if (m, p) in routes]
    chk("老流程端点全部下线", not leftover, leftover)
    chk("插件引擎端点还在（别把新的误伤了）",
        any(p.endswith("/plugins/applicable") for (_m, p) in routes) and
        any("/plugin-runs" in p for (_m, p) in routes))

    for mod in ("app.services.flows", "app.services.workflow",
                "app.services.flow_health", "app.services.ai_router", "app.workflow"):
        chk(f"模块已删：{mod}", gone(mod))
    chk("boxes.py（搬出来的通用件）可用",
        not gone("app.services.boxes"))

    chk("模型不再有 FlowTemplate/TaskWorkflow",
        not hasattr(models, "FlowTemplate") and not hasattr(models, "TaskWorkflow"))
    chk("Task 不再映射 flow_id", "flow_id" not in models.Task.__table__.columns)
    t = models.Task(id="x", title="t")
    chk("task_to_api 不再吐 flowId", "flowId" not in schemas.task_to_api(t))
    chk("WorkflowCreate 契约已退役", not hasattr(schemas, "WorkflowCreate"))

    src = open("app/services/workflow_engine.py", encoding="utf-8").read()
    chk("publish 结单不再看 TaskWorkflow/组织流程",
        "TaskWorkflow" not in src and "on_ai_delivered" not in src)

    print("\nflow retired smoke: %d passed, %d failed" % (ok, fail))
    return 1 if fail else 0


sys.exit(asyncio.run(main()))
