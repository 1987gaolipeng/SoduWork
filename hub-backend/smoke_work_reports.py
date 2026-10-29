# -*- coding: utf-8 -*-
"""Offline temporary-database contracts for shared daily/weekly report periods: normalization,
collection isolation, and idempotent generation.
"""
from __future__ import annotations

import asyncio
from datetime import datetime
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch


BACKEND = Path(__file__).resolve().parent
TEMP_ROOT = tempfile.TemporaryDirectory(prefix="soduwork-work-reports-")
DB = Path(TEMP_ROOT.name) / ".smoke-work-reports.db"
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
from app.realtime import Hub  # noqa: E402
from app.services import llm, work_report  # noqa: E402


passed = failed = 0


def check(name: str, condition: bool, detail="") -> None:
    global passed, failed
    if condition:
        passed += 1
        print("  PASS ", name)
    else:
        failed += 1
        print("  FAIL ", name, "<<", str(detail)[:300])


def at(day: str, hour: int = 10) -> int:
    return int(datetime.fromisoformat(f"{day}T{hour:02d}:00:00").timestamp() * 1000)


async def no_llm(*_args, **_kwargs):
    return None


class ReportSocket:
    def __init__(self):
        self.events = []

    async def send_json(self, event):
        self.events.append(event)


async def main() -> None:
    await init_db()
    llm.chat = no_llm
    async with SessionLocal() as session:
        session.add_all([
            models.OrgUnit(id="org-r", name="研发组"),
            models.User(id="u-r", username="reader", display_name="小苏",
                        org_id="org-r", is_active=True),
            models.Client(id="c-r", name="小苏的 SoduWork", user_ref="u-r"),
            models.Task(id="t-done", title="完成需求梳理", status="done", owner_client_id="c-r",
                        progress=[{"at": at("2026-08-10"), "by": "u-r", "status": "done",
                                   "text": "完成需求基线并确认验收口径"}]),
            models.Task(id="t-live", title="实现工作简报", status="doing", owner_client_id="c-r",
                        progress=[{"at": at("2026-08-11"), "by": "u-r", "status": "doing",
                                   "text": "完成日报和周报统一接口"}]),
        ])
        await session.commit()

        week = work_report.period_info("weekly", "2026-08-12")
        check("周内任意日期稳定归一到周一至周日",
              week["start"] == "2026-08-10" and week["end"] == "2026-08-16", week)
        daily_material = await work_report.collect_period(session, "u-r", "daily", "2026-08-10")
        weekly_material = await work_report.collect_period(session, "u-r", "weekly", "2026-08-12")
        check("日报只采当天事实", [row["taskId"] for row in daily_material["items"]] == ["t-done"],
              daily_material["items"])
        check("周报采集整周事实且不按天割裂", {row["taskId"] for row in weekly_material["items"]}
              == {"t-done", "t-live"}, weekly_material["items"])

        user = await session.get(models.User, "u-r")
        daily = await work_report.generate_for(
            session, user, "2026-08-10", notify=False, period_type="daily")
        weekly = await work_report.generate_for(
            session, user, "2026-08-12", notify=False, period_type="weekly")
        count = await session.scalar(select(func.count()).select_from(models.DailyReport))
        check("同一主体的日报和周报分别持久化", count == 2 and daily.id != weekly.id, count)
        check("模板文案遵守各自周期口径", "今日完成" in daily.content and "本周完成" in weekly.content,
              (daily.content, weekly.content))
        api = work_report.to_api(weekly)
        check("客户端契约返回完整周期边界", api["periodType"] == "weekly"
              and api["periodStart"] == "2026-08-10" and api["periodEnd"] == "2026-08-16", api)

        again = await work_report.generate_for(
            session, user, "2026-08-15", notify=False, period_type="weekly")
        count2 = await session.scalar(select(func.count()).select_from(models.DailyReport))
        check("同一周重复生成覆盖原快照而不新增", again.id == weekly.id and count2 == 2,
              (again.id, weekly.id, count2))

        # The same device logs in as Bob, then Alice again. Historical ownership
        # and explicit progress authorship must survive both transitions.
        device = await session.get(models.Client, "c-r")
        session.add(models.User(id="u-b", username="bob", display_name="小博"))
        device.user_ref = "u-b"
        await session.commit()
        alice_task = await session.get(models.Task, "t-live")
        alice_task.progress = [*alice_task.progress,
                               {"at": at("2026-08-11"), "text": "小苏旧版个人进展"},
                               {"at": at("2026-08-11"), "by": "u-b", "text": "小博协助验收"}]
        session.add(models.Task(
            id="t-b", title="小博私有需求", status="doing", owner_client_id="c-r",
            progress=[{"at": at("2026-08-11"), "text": "小博个人进展"},
                      {"at": at("2026-08-11"), "by": "u-r", "text": "小苏协助评审"}]))
        await session.commit()
        bob_task = await session.get(models.Task, "t-b")
        check("同设备换账号不改写任务的稳定持有人",
              alice_task.owner_user_id == "u-r" and bob_task.owner_user_id == "u-b")
        alice_material = await work_report.collect_period(session, "u-r", "weekly", "2026-08-12")
        bob_material = await work_report.collect_period(session, "u-b", "weekly", "2026-08-12")
        check("切换到小博后只把小博持有的任务列为其待办",
              {row["taskId"] for row in bob_material["open"]} == {"t-b"}, bob_material)
        check("小苏暂未绑定设备仍保留自己的待办和已完成事实",
              {row["taskId"] for row in alice_material["open"]} == {"t-live"}
              and alice_material["done"] == ["完成需求梳理"], alice_material)
        alice_progress = {row["taskId"]: row["progress"] for row in alice_material["items"]}
        bob_progress = {row["taskId"]: row["progress"] for row in bob_material["items"]}
        check("跨任务只保留本人显式署名的贡献",
              alice_progress.get("t-b") == ["小苏协助评审"]
              and bob_progress.get("t-live") == ["小博协助验收"],
              (alice_progress, bob_progress))
        check("无署名旧进展只归稳定持有人",
              "小苏旧版个人进展" in alice_progress.get("t-live", [])
              and "小博个人进展" in bob_progress.get("t-b", [])
              and "小苏旧版个人进展" not in str(bob_progress)
              and "小博个人进展" not in str(alice_progress))

        device.user_ref = "u-r"
        await session.commit()
        alice_again = await work_report.collect_period(session, "u-r", "weekly", "2026-08-12")
        bob_again = await work_report.collect_period(session, "u-b", "weekly", "2026-08-12")
        check("同设备A-B-A后两人的个人事实分别恢复且无互相继承",
              alice_again == alice_material and bob_again == bob_material)

        report_hub = Hub()
        alice_socket, bob_socket = ReportSocket(), ReportSocket()
        await report_hub.connect("c-r", alice_socket, accept=False, user_id="u-r")
        await report_hub.connect("c-r", bob_socket, accept=False, user_id="u-b")
        with patch.object(work_report, "hub", report_hub):
            await work_report.generate_for(session, user, "2026-08-12", period_type="weekly")
        check("简报通知仅投递给同设备上的本人账号连接",
              [event["type"] for event in alice_socket.events] == ["notice", "work.report"]
              and alice_socket.events[1]["report"]["userId"] == "u-r"
              and bob_socket.events == [], (alice_socket.events, bob_socket.events))

    api_source = (BACKEND / "app" / "api" / "reports.py").read_text(encoding="utf-8")
    check("客户端 API 同时保护个人与团队边界",
          'scope == "mine"' in api_source and 'scope != "team"' in api_source
          and "_can_manage" in api_source)
    client_source = (BACKEND.parent / "client" / "components" / "reports" /
                     "work-briefs.js").read_text(encoding="utf-8")
    check("工作简报只渲染接口事实、不带示例员工或伪数据",
          "SAMPLE" not in client_source and "示例员工" not in client_source)
    await engine.dispose()


try:
    asyncio.run(main())
finally:
    for suffix in ("", "-shm", "-wal"):
        try:
            Path(str(DB) + suffix).unlink()
        except FileNotFoundError:
            pass
    TEMP_ROOT.cleanup()

print(f"\n{passed} PASS / {failed} FAIL")
raise SystemExit(1 if failed else 0)
