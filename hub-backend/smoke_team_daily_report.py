# -*- coding: utf-8 -*-
"""Offline temporary-database tests for hierarchical team reports: bottom-up aggregation, scope,
confirmation, and version invalidation.
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
import sys


BACKEND = Path(__file__).resolve().parent
DB = BACKEND / ".smoke-team-daily-report.db"
for suffix in ("", "-shm", "-wal"):
    try:
        Path(str(DB) + suffix).unlink()
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.as_posix()
sys.path.insert(0, str(BACKEND))

from sqlalchemy import func, select  # noqa: E402

from app import models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import llm, team_daily_report as reports  # noqa: E402


passed = failed = 0


def check(name: str, condition: bool, detail="") -> None:
    global passed, failed
    if condition:
        passed += 1
        print("  PASS ", name)
    else:
        failed += 1
        print("  FAIL ", name, "<<", str(detail)[:300])


async def no_llm(*_args, **_kwargs):
    return None


def personal(report_id: str, user_id: str, user_name: str, org_id: str,
             title: str, progress: str, *, closed: bool = False,
             period_type: str = "daily", day: str = "2026-08-09") -> models.DailyReport:
    return models.DailyReport(
        id=report_id, user_id=user_id, user_name=user_name, org_id=org_id,
        date=day, period_type=period_type, content=f"{title}：{progress}", source="template",
        done_count=1 if closed else 0, active_count=1, progress_count=1,
        items=[{
            "taskId": "task-" + report_id, "title": title,
            "status": "done" if closed else "doing",
            "statusCn": "已完成" if closed else "进行中",
            "progress": [progress], "closedToday": closed,
        }],
    )


async def main() -> None:
    await init_db()
    llm.chat = no_llm

    class LockSession:
        def __init__(self, dialect: str):
            self.bind = type("Bind", (), {
                "dialect": type("Dialect", (), {"name": dialect})(),
            })()
            self.calls = []

        def get_bind(self):
            return self.bind

        async def execute(self, statement, params=None):
            self.calls.append((str(statement), dict(params or {})))

    postgres_lock = LockSession("postgresql")
    await reports._generation_lock(postgres_lock, "2026-08-09", "daily")
    check("PostgreSQL 团队简报生成使用事务级并发锁",
          len(postgres_lock.calls) == 1
          and "pg_advisory_xact_lock" in postgres_lock.calls[0][0]
          and postgres_lock.calls[0][1].get("lock_key")
          == "soduwork:team-report:daily:2026-08-09",
          postgres_lock.calls)
    sqlite_lock = LockSession("sqlite")
    await reports._generation_lock(sqlite_lock, "2026-08-09", "daily")
    check("离线 SQLite 生成不执行 PostgreSQL 专用语句", not sqlite_lock.calls)

    async with SessionLocal() as session:
        session.add_all([
            models.OrgUnit(id="org-root", name="集团", sort=0),
            models.OrgUnit(id="org-dev", name="研发中心", parent_id="org-root", sort=10),
            models.OrgUnit(id="org-front", name="前端组", parent_id="org-dev", sort=10),
            models.OrgUnit(id="org-ops", name="运维组", parent_id="org-root", sort=20),
            models.OrgUnit(id="org-empty", name="创新组", parent_id="org-root", sort=30),
            models.User(id="u-root", username="boss", display_name="集团负责人",
                        org_id="org-root", is_super=True, is_active=True),
            models.User(id="u-dev", username="devlead", display_name="研发负责人",
                        org_id="org-dev", is_active=True),
            models.User(id="u-front", username="frontend", display_name="前端小林",
                        org_id="org-front", is_active=True),
            models.User(id="u-ops", username="ops", display_name="运维小周",
                        org_id="org-ops", is_active=True),
            personal("dr-root", "u-root", "集团负责人", "org-root",
                     "经营目标对齐", "已确认本周优先级"),
            personal("dr-dev", "u-dev", "研发负责人", "org-dev",
                     "发布链路治理", "完成发布门禁配置", closed=True),
            personal("dr-front", "u-front", "前端小林", "org-front",
                     "日报概况页", "联调存在阻塞，等待接口字段确认"),
            personal("dr-ops", "u-ops", "运维小周", "org-ops",
                     "生产巡检", "完成 trial 环境巡检", closed=True),
        ])
        await session.commit()

        first = await reports.generate_scope(session, "2026-08-09", None)
        by_org = {row.org_id: row for row in first}
        check("每个组织节点都有团队日报（含空团队）", len(first) == 5, len(first))
        check("父级统计覆盖完整组织树",
              by_org["org-root"].metrics.get("memberTotal") == 4
              and by_org["org-root"].metrics.get("reportedMembers") == 4,
              by_org["org-root"].metrics)
        check("正在推进口径排除今日已完成事项",
              by_org["org-root"].metrics.get("activeCount") == 2,
              by_org["org-root"].metrics)
        check("每位成员只贡献一份周期事实",
              by_org["org-front"].metrics.get("reportedMembers") == 1,
              by_org["org-front"].metrics)
        check("父级只消费直属成员与直属团队来源",
              len(by_org["org-root"].source_refs) == 4,
              by_org["org-root"].source_refs)
        risks = by_org["org-dev"].summary.get("risks") or []
        check("子团队风险逐级进入上级概况",
              bool(risks) and "前端组" in (risks[0].get("teams") or []), risks)
        check("领导摘要不逐人铺个人姓名", "前端小林" not in by_org["org-dev"].content)

        first_ids = {row.org_id: row.id for row in first}
        second = await reports.generate_scope(session, "2026-08-09", None)
        count = await session.scalar(select(func.count()).select_from(models.TeamDailyReport))
        check("重复生成幂等，不产生同日重复团队日报",
              count == 5 and {row.org_id: row.id for row in second} == first_ids, count)

        leader = await session.get(models.User, "u-dev")
        scoped = await reports.overview(session, leader, "2026-08-09", "org-dev")
        visible = {row["id"] for row in scoped["orgs"]}
        check("研发负责人只看到本团队子树", visible == {"org-dev", "org-front"}, visible)
        try:
            await reports.overview(session, leader, "2026-08-09", "org-ops")
            denied = False
        except PermissionError:
            denied = True
        check("越过组织作用域会被拒绝", denied)

        confirmed = await reports.confirm(
            session, leader, by_org["org-dev"].id, "明早优先解除联调阻塞")
        check("本级负责人可确认当前版本并留下补充",
              confirmed.status == "confirmed"
              and confirmed.confirmed_by == "u-dev"
              and "联调" in confirmed.leader_note)

        async def revised_llm(*_args, **_kwargs):
            return "同一批事实重新归纳后的团队结论。"

        llm.chat = revised_llm
        await reports.generate_scope(
            session, "2026-08-09", {"org-dev", "org-front"}, force=True)
        revised = (await session.execute(select(models.TeamDailyReport).where(
            models.TeamDailyReport.org_id == "org-dev"
        ))).scalars().one()
        check("同事实但正文版本变化会撤销旧确认",
              revised.status == "generated" and not revised.confirmed_by
              and not revised.leader_note, revised.status)

        llm.chat = no_llm
        await reports.generate_scope(
            session, "2026-08-09", {"org-dev", "org-front"}, force=True)
        revised = await reports.confirm(session, leader, revised.id)
        source = await session.get(models.DailyReport, "dr-front")
        source.content = "日报概况页：联调阻塞已升级，需要后端协同"
        source.items = [{
            **source.items[0],
            "progress": ["联调阻塞已升级，需要后端协同"],
        }]
        await session.commit()
        stale = await reports.overview(session, leader, "2026-08-09", "org-dev")
        check("任一下级事实变化会把上级标为待刷新",
              stale["teamReport"]["needsRefresh"] is True)
        try:
            await reports.confirm(session, leader, revised.id)
            rejected = False
        except ValueError:
            rejected = True
        check("过期团队结论不能再次确认", rejected)

        await reports.generate_scope(
            session, "2026-08-09", {"org-dev", "org-front"})
        refreshed = await session.get(models.TeamDailyReport, revised.id)
        check("逐级重算后回到待确认且清空旧签署",
              refreshed.status == "generated" and refreshed.confirmed_at is None,
              refreshed.status)

        session.add_all([
            personal("wr-root", "u-root", "集团负责人", "org-root",
                     "经营目标对齐", "本周优先级已确认", period_type="weekly", day="2026-08-03"),
            personal("wr-dev", "u-dev", "研发负责人", "org-dev",
                     "发布链路治理", "本周完成发布门禁", closed=True,
                     period_type="weekly", day="2026-08-03"),
            personal("wr-front", "u-front", "前端小林", "org-front",
                     "客户端工作简报", "周报页面已联调", period_type="weekly", day="2026-08-03"),
            personal("wr-ops", "u-ops", "运维小周", "org-ops",
                     "环境巡检", "本周完成环境巡检", closed=True,
                     period_type="weekly", day="2026-08-03"),
        ])
        await session.commit()
        weekly = await reports.generate_scope(
            session, "2026-08-05", None, period_type="weekly")
        weekly_by_org = {row.org_id: row for row in weekly}
        check("周报锚点归一到周一并独立形成逐级团队概况",
              len(weekly) == 5 and all(row.date == "2026-08-03" for row in weekly)
              and all(row.period_type == "weekly" for row in weekly),
              [(row.date, row.period_type) for row in weekly])
        check("团队周报使用周口径而不是日报文案",
              "本周" in weekly_by_org["org-root"].content,
              weekly_by_org["org-root"].content)

    page = (BACKEND.parent / "client" / "components" / "reports" / "work-briefs.js").read_text(
        encoding="utf-8")
    check("客户端同时提供个人与团队、日报与周报",
          "工作简报" in page and "团队概况" in page and "周报" in page and "我的" in page)
    check("负责人确认明确绑定当前来源快照", "来源变化后，确认会自动失效" in page)

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
