# -*- coding: utf-8 -*-
"""Verify plugin applicability before task creation matches applicability after persistence. Reuse
the same scoped resolution with a lightweight draft and prevent cross-organization visibility.
Run offline with a temporary database.
"""
import asyncio
import os
import sys
from types import SimpleNamespace

DB = os.path.abspath(".smoke-applicable.db")
for sfx in ("", "-shm", "-wal"):
    try:
        os.remove(DB + sfx)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from sqlalchemy import select  # noqa: E402

from app import automation_models as am  # noqa: E402
from app import models  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.services import execution_capabilities, plugin_service  # noqa: E402

ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra) if extra else ""))


def keys(items):
    return sorted((x.get("pluginKey") or x.get("name") or "?") for x in items)


async def main():
    await init_db()
    async with SessionLocal() as s:
        await plugin_service.bootstrap_example(s)
        s.add(models.Client(id="c-app", name="测试机"))
        s.add(models.Project(id="prj-1", name="某项目", org_id="org-a"))
        s.add(models.Repo(
            id="repo-1", project_id="prj-1", name="测试工程",
            git_url="https://example.invalid/example.git", merge_branch="main",
        ))
        await s.commit()

        # Approve one organization binding and one project-specific binding.
        vers = list((await s.execute(select(am.PluginVersion))).scalars().all())
        by_plugin = {}
        for v in vers:
            by_plugin.setdefault(v.plugin_id, v)
        picked = list(by_plugin.items())[:2]
        chk("内置流程装进来了（至少两张）", len(picked) == 2, len(by_plugin))
        org_plugin, org_ver = picked[0]
        prj_plugin, prj_ver = picked[1]
        for pid_, ver in picked:
            await plugin_service.approve_version(s, ver, True, "验证")
        p1 = await s.get(am.Plugin, org_plugin)
        p2 = await s.get(am.Plugin, prj_plugin)
        # Provide standard capability facts to isolate applicability routing from separately tested readiness checks.
        execution_capabilities.runtime_report = lambda *args, **kwargs: {
            "available": ["files", "terminal", "repository", "browser", "office", "computer"],
            "items": [],
        }
        await plugin_service.save_binding(s, p1, {"versionId": org_ver.id, "projectId": ""})
        project_binding = await plugin_service.save_binding(
            s, p2, {
                "versionId": prj_ver.id,
                "projectId": "prj-1",
                "orgId": "org-a",
            })
        project_binding.org_id = "org-stale"
        await s.commit()
        await plugin_service.save_binding(
            s, p2, {"versionId": prj_ver.id, "projectId": "prj-1"},
            project_binding, verify_readiness=False)
        chk("重配项目绑定会按项目归属修复历史组织脏数据",
            project_binding.org_id == "org-a", project_binding.org_id)

        # Query applicability using a draft before creation.
        stand_no_prj = SimpleNamespace(id="", project_id=None, owner_client_id="c-app",
                                       repo_id=None)
        stand_prj = SimpleNamespace(id="", project_id="prj-1", owner_client_id="c-app",
                                    repo_id=None)
        before_no = keys(await plugin_service.available_bindings(s, stand_no_prj))
        before_yes = keys(await plugin_service.available_bindings(s, stand_prj))
        chk("★不挂项目时也问得到流程（组织级绑定）", len(before_no) >= 1, before_no)
        chk("挂了项目能多看到项目专属那张", len(before_yes) > len(before_no),
            (before_no, before_yes))

        # Persist the task and compare the result.
        s.add(models.Task(id="t-no", title="零活", status="todo", owner_client_id="c-app"))
        s.add(models.Task(id="t-yes", title="项目里的活", status="todo",
                          owner_client_id="c-app", project_id="prj-1"))
        await s.commit()
        after_no = keys(await plugin_service.available_bindings(
            s, await s.get(models.Task, "t-no")))
        after_yes = keys(await plugin_service.available_bindings(
            s, await s.get(models.Task, "t-yes")))

        chk("★★建之前和建之后答案一致（不挂项目）", before_no == after_no,
            (before_no, after_no))
        chk("★★建之前和建之后答案一致（挂项目）", before_yes == after_yes,
            (before_yes, after_yes))
        resolved = await plugin_service.resolve_binding(
            s, await s.get(models.Task, "t-yes"), binding_id=project_binding.id,
            org_ids={"org-a"})
        chk("修复后的项目绑定既能展示也能真正启动", resolved.id == project_binding.id)
        chk("替身查询不会顺手建出任何东西",
            (await s.execute(select(models.Task))).scalars().all().__len__() == 2)

        # Draft resolution must not expose another organization's binding.
        s.add(am.PluginBinding(id="b-other", plugin_id=org_plugin, version_id=org_ver.id,
                               org_id="org-别人家", project_id="", enabled=True))
        await s.commit()
        again = keys(await plugin_service.available_bindings(s, stand_no_prj))
        chk("★别的组织的流程不会漏给我", again == before_no, (before_no, again))

    print("\napplicable flows smoke: %d passed, %d failed" % (ok, fail))
    return 1 if fail else 0


sys.exit(asyncio.run(main()))
