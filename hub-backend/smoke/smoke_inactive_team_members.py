# -*- coding: utf-8 -*-
"""Offline tests exclude disabled accounts from collaboration directories, handoffs, reassignment,
and dispatch.
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
import sys


BACKEND = Path(__file__).resolve().parent.parent
DB = BACKEND / ".smoke-inactive-team-members.db"
for suffix in ("", "-shm", "-wal"):
    try:
        Path(str(DB) + suffix).unlink()
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.as_posix()
sys.path.insert(0, str(BACKEND))

from app import models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import inbox, team  # noqa: E402


passed = failed = 0


def check(name: str, condition: bool, detail="") -> None:
    global passed, failed
    if condition:
        passed += 1
        print("  PASS ", name)
    else:
        failed += 1
        print("  FAIL ", name, "<<", str(detail)[:300])


async def main() -> None:
    await init_db()
    async with SessionLocal() as session:
        manager = models.User(
            id="u-manager", username="manager", display_name="负责人",
            org_id="org-team", is_super=True, is_active=True,
        )
        active = models.User(
            id="u-active", username="active", display_name="在职成员",
            org_id="org-team", is_active=True,
        )
        inactive = models.User(
            id="u-inactive", username="inactive", display_name="停用成员",
            org_id="org-team", is_active=False,
        )
        manager_box = models.Client(
            id="box-manager", name="负责人电脑", user_ref=manager.id, auth_state="active",
        )
        active_box = models.Client(
            id="box-active", name="在职电脑", user_ref=active.id, auth_state="active",
        )
        inactive_box = models.Client(
            id="box-inactive", name="停用电脑", user_ref=inactive.id, auth_state="revoked",
        )
        other = models.User(
            id="u-other", username="other", display_name="跨部门成员",
            org_id="org-other", is_active=True,
        )
        other_box = models.Client(
            id="box-other", name="跨部门电脑", user_ref=other.id, auth_state="active",
        )
        session.add_all([
            models.OrgUnit(id="org-team", name="测试组", sort=0),
            models.OrgUnit(id="org-other", name="其他部门", sort=1),
            manager, active, inactive, other, manager_box, active_box, inactive_box, other_box,
        ])
        await session.commit()

        members, _colors, _names = await team._team_members(session, manager)
        member_ids = {row.id for row in members}
        check("公共团队成员目录排除停用账户",
              member_ids == {"u-manager", "u-active"}, member_ids)

        overview = await team.team_overview(session, manager_box)
        overview_ids = {row.get("userId") for row in overview.get("members", [])}
        check("团队概览不返回停用账户",
              overview_ids == {"u-manager", "u-active"}, overview_ids)

        task_board = await team.team_tasks(session, manager_box)
        board_ids = {row.get("userId") for row in task_board.get("members", [])}
        check("团队任务看板候选成员不返回停用账户",
              board_ids == {"u-manager", "u-active"}, board_ids)

        mates = await team.my_teammates(session, manager_box)
        mate_ids = {row.get("id") for row in mates.get("mates", [])}
        check("teammate receive contract is explicit",
              all(row.get("canReceive") is True and row.get("deviceCount") == 1
                  for row in mates.get("mates", [])), mates.get("mates", []))
        check("转发成员列表不返回停用账户",
              mate_ids == {"u-active", "u-other"}, mate_ids)

        dispatched = await team.create_team_task(
            session, manager_box,
            {"title": "不能派给停用账户", "assigneeUserId": inactive.id},
        )
        check("直接派活明确拒绝停用账户",
              dispatched.get("ok") is False and dispatched.get("reason") == "inactive",
              dispatched)

        assigned = await inbox.assign_to_user(
            session, "missing-task", inactive, {"org-team"},
            actor_name=manager.display_name, actor_id=manager.id,
        )
        check("收件箱公共分配服务拒绝停用账户",
              assigned == {"ok": False, "reason": "inactive"}, assigned)

        inactive_scope = await inbox.scope_for_user(session, inactive)
        check("停用账户没有团队收件箱作用域", inactive_scope == set(), inactive_scope)
        check("停用管理员不再具有团队管理能力",
              not await team._can_manage(session, inactive))

    await engine.dispose()


try:
    asyncio.run(main())
finally:
    for suffix in ("", "-shm", "-wal"):
        try:
            Path(str(DB) + suffix).unlink()
        except FileNotFoundError:
            pass

print(f"\n{passed} PASS / {failed} FAIL")
raise SystemExit(1 if failed else 0)
