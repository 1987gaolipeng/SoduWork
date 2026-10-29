# -*- coding: utf-8 -*-
"""Audit-role tests for read-only subtree scope and super-administrator global governance."""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path


DB = os.path.abspath(".smoke-audit-scope.db")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from app import models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import audit  # noqa: E402


passed = failed = 0


def check(name: str, condition, detail="") -> None:
    global passed, failed
    if condition:
        passed += 1
        print("  PASS  " + name)
    else:
        failed += 1
        print("  FAIL  " + name + ("  << " + str(detail)[:300] if detail else ""))


async def main() -> None:
    await init_db()
    async with SessionLocal() as session:
        root = models.OrgUnit(id="org-audit-root", name="总部")
        child = models.OrgUnit(id="org-audit-child", name="研发部", parent_id=root.id)
        sibling = models.OrgUnit(id="org-audit-other", name="外地事业部")
        audit_role = models.Role(id="role-auditor", name="审计人员",
                                 permissions=["audit.view"])
        viewer = models.User(id="u-auditor", username="auditor", display_name="审计人员",
                             org_id=root.id, role_id=audit_role.id, is_active=True)
        root_actor = models.User(id="u-audit-root", username="root-actor",
                                 display_name="总部管理员", org_id=root.id, is_active=True)
        child_actor = models.User(id="u-audit-child", username="child-actor",
                                  display_name="研发管理员", org_id=child.id, is_active=True)
        other_actor = models.User(id="u-audit-other", username="other-actor",
                                  display_name="外地管理员", org_id=sibling.id, is_active=True)
        super_user = models.User(id="u-audit-super", username="super-auditor",
                                 display_name="超级管理员", org_id=root.id,
                                 is_super=True, is_active=True)
        session.add_all([root, child, sibling, audit_role, viewer, root_actor,
                         child_actor, other_actor, super_user])
        await session.commit()
        await audit.log(session, root_actor, "project.update", "project", "p-root", "总部项目")
        await audit.log(session, child_actor, "task.dispatch", "task", "t-child", "研发任务")
        await audit.log(session, other_actor, "client.assign", "client", "c-other", "外地终端")

        scoped = await audit.list_audit(session, viewer)
        actions = {item["action"] for item in scoped["items"]}
        check("审计人员能看到本组织及子组织流水",
              scoped["total"] == 2 and actions == {"project.update", "task.dispatch"}, scoped)
        check("审计人员看不到兄弟组织流水", "client.assign" not in actions, actions)
        filtered = await audit.list_audit(session, viewer, action="task.dispatch")
        check("审计筛选仍受组织范围约束",
              filtered["total"] == 1 and filtered["items"][0]["targetId"] == "t-child",
              filtered)
        global_rows = await audit.list_audit(session, super_user)
        check("超级管理员仅在全局治理视角看全部流水", global_rows["total"] == 3,
              global_rows)
        check("审计角色保持只读最小权限",
              audit_role.permissions == ["audit.view"], audit_role.permissions)

        source = Path("app/api/admin.py").read_text(encoding="utf-8")
        endpoint = source[source.index('@router.get("/audit")'):]
        check("审计接口强制校验 audit.view 权限",
              'Depends(require_perm("audit.view"))' in endpoint[:500])


async def run() -> None:
    try:
        await main()
    finally:
        await engine.dispose()
        for suffix in ("", "-shm", "-wal"):
            try:
                os.remove(DB + suffix)
            except FileNotFoundError:
                pass


asyncio.run(run())
print(f"\naudit scope: {passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
