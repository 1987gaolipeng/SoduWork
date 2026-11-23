# -*- coding: utf-8 -*-
"""Audit-role tests for read-only subtree scope and super-administrator global governance."""
from __future__ import annotations

import asyncio
import csv
import io
import os
import sys
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import FastAPI


DB = os.path.abspath(".smoke-audit-scope.db")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from app import models  # noqa: E402
from app.api import admin  # noqa: E402
from app.auth import sign_token  # noqa: E402
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

        start = datetime(2026, 1, 1, tzinfo=timezone.utc)
        end = start + timedelta(days=1)
        matching = 405  # Cross both the list cap and a streamed CSV batch.
        label = '=部门,"A"\nB'
        for idx in range(matching):
            row = audit.add(session, child_actor, "org.create", "org", str(idx),
                            label, {"parentId": None})
            row.at, row.id = start, f"fixture-{idx:03}"
        for actor, at in [(child_actor, end), (child_actor, start - timedelta(seconds=1)),
                          (other_actor, start)]:
            row = audit.add(session, actor, "org.create")
            row.at = at
        await session.commit()

    app = FastAPI()
    app.include_router(admin.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                 base_url="http://fixture/api/v1/admin/") as client:
        headers = {"Authorization": "Bearer " + sign_token(viewer.id)}
        params = {"action": "org.create", "since": "2026-01-01T08:00:00+08:00",
                  "until": end.isoformat(), "actor": "管理员"}
        response = await client.get("audit", params={**params, "offset": 400, "limit": 2},
                                    headers=headers)
        listing = response.json()
        check("日期、操作者及范围共同决定总数；同一时间按 ID 稳定排序",
              listing.get("total") == matching and
              [r["id"] for r in listing.get("items", [])] == ["fixture-004", "fixture-003"])
        check("列表注明当前 Hub 环境", listing.get("environment") == admin.settings.soduwork_env.strip().lower())
        for invalid_offset in (-1, 2**63):
            invalid = await client.get("audit", params={**params, "offset": invalid_offset}, headers=headers)
            check(f"The audit list rejects offset {invalid_offset} at the query field",
                  invalid.status_code == 422 and
                  any(error["loc"] == ["query", "offset"] for error in invalid.json()["detail"]))
        response = await client.get("audit", params={**params, "actor": child_actor.id}, headers=headers)
        check("可按操作者 ID 查询", response.json().get("total") == matching)
        response = await client.get("audit", params={**params, "actor": "%"}, headers=headers)
        check("操作者筛选按字面量匹配", response.json().get("total") == 0)
        count_only = await client.get("audit", params={**params, "limit": 0}, headers=headers)
        check("保留只取总数的查询", count_only.json().get("total") == matching and not count_only.json()["items"])
        invalid_offset = await client.get("audit", params={"offset": 2**63}, headers=headers)
        check("拒绝超出数据库范围的偏移量", invalid_offset.status_code == 422)

        response = await client.get("audit/export.csv", params=params, headers=headers)
        check("导出 UTF-8 CSV 附件", response.status_code == 200 and
              response.content.startswith(b"\xef\xbb\xbf") and "attachment" in response.headers.get("content-disposition", ""))
        exported = list(csv.DictReader(io.StringIO(response.content.decode("utf-8-sig"))))
        check("导出全部匹配记录且与列表排序一致",
              [r["id"] for r in exported] == [f"fixture-{i:03}" for i in reversed(range(matching))])
        check("导出保留标点换行并中和表格公式", bool(exported) and
              exported[0]["targetLabel"] == "'" + label)
        response = await client.get("audit/export.csv", params={**params, "actor": "不存在"}, headers=headers)
        empty = csv.DictReader(io.StringIO(response.content.decode("utf-8-sig")))
        check("无匹配时仍返回 CSV 表头", empty.fieldnames and "id" in empty.fieldnames and not list(empty))
        for path in ("audit", "audit/export.csv"):
            unauthorized = await client.get(path)
            forbidden = await client.get(path, headers={"Authorization": "Bearer " + sign_token(root_actor.id)})
            check(f"{path} 校验登录和 audit.view 权限",
                  unauthorized.status_code == 401 and forbidden.status_code == 403)
            invalid = await client.get(path, params={"since": end.isoformat(), "until": start.isoformat()},
                                       headers=headers)
            check(f"{path} 拒绝反向时间区间", invalid.status_code == 422)
            overflow = await client.get(path, params={"since": "0001-01-01T00:00:00+01:00"}, headers=headers)
            check(f"{path} 拒绝无法表示的 UTC 时间", overflow.status_code == 422)


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
