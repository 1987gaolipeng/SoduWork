"""Periodic personal work reports sharing source snapshots and generation contracts. date is the
period start: the day for daily reports and Monday for weekly reports. Clients and hierarchical
team reports use the same contract.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import date as _date
from datetime import datetime, timedelta

from sqlalchemy import String, cast, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..db import SessionLocal
from ..realtime import hub

log = logging.getLogger("uvicorn.error")

REPORT_HOUR = int(os.environ.get("SODUWORK_REPORT_HOUR", "18"))
WEEKLY_REPORT_HOUR = int(os.environ.get("SODUWORK_WEEKLY_REPORT_HOUR", str(REPORT_HOUR)))
WEEKLY_REPORT_WEEKDAY = int(os.environ.get("SODUWORK_WEEKLY_REPORT_WEEKDAY", "4"))  # Zero represents Monday.
PERIOD_TYPES = {"daily", "weekly"}
_STATUS_CN = {"todo": "待办", "doing": "进行中", "done": "已完成", "cancel": "搁置"}


def today_str() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def period_info(period_type: str = "daily", anchor: str = "") -> dict:
    """Normalize an anchor into a stable reporting period. Reject unsupported periods and let the
    API translate invalid dates into a client error.
    """
    kind = str(period_type or "daily").strip().lower()
    if kind not in PERIOD_TYPES:
        raise ValueError("period 只支持 daily 或 weekly")
    day = _date.fromisoformat(str(anchor or today_str()).strip())
    start = day - timedelta(days=day.weekday()) if kind == "weekly" else day
    end = start + timedelta(days=6 if kind == "weekly" else 0)
    current = _date.today()
    current_start = current - timedelta(days=current.weekday()) if kind == "weekly" else current
    if kind == "weekly":
        label = (f"{start.month}月{start.day}日—{end.month}月{end.day}日"
                 f" · 第 {start.isocalendar().week} 周")
    else:
        label = f"{start.year}年{start.month}月{start.day}日"
    return {
        "type": kind, "key": start.isoformat(), "start": start.isoformat(),
        "end": end.isoformat(), "label": label, "isCurrent": start == current_start,
    }


def shift_anchor(period_type: str, anchor: str, delta: int) -> str:
    info = period_info(period_type, anchor)
    step = 7 if info["type"] == "weekly" else 1
    return (_date.fromisoformat(info["start"]) + timedelta(days=step * delta)).isoformat()


def _range_bounds(start_day: str, end_day: str) -> tuple[int, int]:
    start = datetime.strptime(start_day, "%Y-%m-%d")
    end = datetime.strptime(end_day, "%Y-%m-%d") + timedelta(days=1)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000)


async def collect_period(session: AsyncSession, user_id: str, period_type: str = "daily",
                         anchor: str = "") -> dict:
    """Collect the person's authored progress, completion facts, and current work for the period."""
    info = period_info(period_type, anchor)
    lo, hi = _range_bounds(info["start"], info["end"])
    if not user_id:
        return {"items": [], "done": [], "open": [], "progressCount": 0, "period": info}

    owned = list((await session.execute(
        select(models.Task).where(models.Task.owner_user_id == user_id)
    )).scalars().all())
    owned_ids = {task.id for task in owned}
    authored = list((await session.execute(select(models.Task).where(
        cast(models.Task.progress, String).like(f"%{user_id}%"),
        models.Task.id.notin_(owned_ids or {"__none__"}),
    ))).scalars().all())

    def mine(entry: dict, owned_here: bool) -> bool:
        author = entry.get("by")
        return author == user_id if author else owned_here

    open_tasks = [{
        "taskId": task.id, "title": task.title or "未命名", "status": task.status,
        "statusCn": _STATUS_CN.get(task.status, task.status),
        "priority": getattr(task, "priority", "") or "normal",
    } for task in owned if task.status in ("todo", "doing")]

    items, done, seen = [], [], set()
    for task, owned_here in [(task, True) for task in owned] + [(task, False) for task in authored]:
        if task.id in seen:
            continue
        seen.add(task.id)
        entries = [entry for entry in (task.progress or [])
                   if isinstance(entry, dict) and isinstance(entry.get("at"), (int, float))
                   and lo <= entry["at"] < hi and mine(entry, owned_here)]
        texts = [str(entry.get("text") or "").strip() for entry in entries
                 if str(entry.get("text") or "").strip()]
        closed = False
        if task.status == "done":
            if entries:
                closed = any(entry.get("status") == "done" for entry in entries)
            elif task.updated_at and owned_here:
                updated = task.updated_at
                if updated.tzinfo:
                    updated = updated.astimezone().replace(tzinfo=None)
                closed = lo <= int(updated.timestamp() * 1000) < hi
        if texts or closed:
            items.append({
                "taskId": task.id, "title": task.title or "未命名",
                "status": task.status, "statusCn": _STATUS_CN.get(task.status, task.status),
                "priority": getattr(task, "priority", "") or "normal",
                "progress": texts, "closedInPeriod": closed,
                # Keep compatibility for older daily-report clients; current consumers read closedInPeriod.
                "closedToday": closed,
            })
        if closed:
            done.append(task.title or "未命名")
    return {"items": items, "done": done, "open": open_tasks,
            "progressCount": sum(len(item["progress"]) for item in items), "period": info}


async def collect(session: AsyncSession, user_id: str, day: str) -> dict:
    """Compatibility entry point for the previous daily-report API."""
    return await collect_period(session, user_id, "daily", day)


def render_template(user_name: str, info: dict, material: dict) -> str:
    weekly = info["type"] == "weekly"
    items, done = material["items"], material["done"]
    lines = [f"{info['label']} 工作进展 · {user_name}", ""]
    if done:
        lines.append(f"【{'本周' if weekly else '今日'}完成】{len(done)} 项")
        closed = [item for item in items if item.get("closedInPeriod")]
        for item in closed:
            lines.append(f"  · {item['title']}")
            lines += [f"      {text}" for text in item["progress"]]
        lines.append("")
    ongoing = [item for item in items if not item.get("closedInPeriod")]
    if ongoing:
        lines.append(f"【{'持续推进' if weekly else '推进中'}】{len(ongoing)} 项")
        for item in ongoing:
            lines.append(f"  · {item['title']}（{item['statusCn']}）")
            lines += [f"      {text}" for text in item["progress"]]
        lines.append("")
    ongoing_ids = {item["taskId"] for item in ongoing}
    backlog = [item for item in material.get("open") or [] if item["taskId"] not in ongoing_ids]
    if backlog:
        lines.append(f"【{'下周关注' if weekly else '待办事项'}】{len(backlog)} 项")
        lines += [f"  · {item['title']}（{item['statusCn']}）" for item in backlog]
        lines.append("")
    if not items and not backlog:
        lines.append("本周期暂无任务动态。" if weekly else "今日暂无任务动态。")
    return "\n".join(lines).strip()


_DAILY_SYSTEM = (
    "你是一位资深职场人，替本人撰写当日工作日报，收件人是直属领导。依据结构化事实归纳今天最重要的成果、"
    "推进、风险与下一步；待办不能包装成成果。事实只能来自输入，禁止编造；同一任务不重复；300字内，"
    "纯文本，用【今日完成】【推进中】【风险与阻塞】【待办】分段，没有事实的段落省略。")
_WEEKLY_SYSTEM = (
    "你是一位资深职场人，替本人撰写本周工作周报，收件人是直属领导。不要按天记流水账，要把同类事项合并成"
    "本周关键成果、持续推进、风险协同和下周关注。事实只能来自输入，禁止编造；待办不能包装成投入或成果；"
    "600字内，纯文本，用【本周成果】【持续推进】【风险与协同】【下周关注】分段，没有事实的段落省略。")


def _llm_material(user_name: str, info: dict, material: dict) -> str:
    closed = [{"任务": item["title"], "周期记录": item["progress"] or None,
               "优先级": item["priority"] if item["priority"] != "normal" else None}
              for item in material["items"] if item.get("closedInPeriod")]
    ongoing = [{"任务": item["title"], "状态": item["statusCn"],
                "周期记录": item["progress"] or None,
                "优先级": item["priority"] if item["priority"] != "normal" else None}
               for item in material["items"] if not item.get("closedInPeriod")]
    ongoing_ids = {item["taskId"] for item in material["items"] if not item.get("closedInPeriod")}
    backlog = [{"任务": item["title"], "状态": item["statusCn"]}
               for item in material.get("open") or [] if item["taskId"] not in ongoing_ids]
    data = {"姓名": user_name, "周期": info["label"], "已完成": closed or None,
            "推进中": ongoing or None, "待关注": backlog or None}
    return json.dumps({key: value for key, value in data.items() if value is not None},
                      ensure_ascii=False, indent=1)


async def find_report(session: AsyncSession, user_id: str, period_type: str = "daily",
                      anchor: str = "") -> models.DailyReport | None:
    info = period_info(period_type, anchor)
    return (await session.execute(select(models.DailyReport).where(
        models.DailyReport.user_id == user_id,
        models.DailyReport.period_type == info["type"],
        models.DailyReport.date == info["start"],
    ).order_by(models.DailyReport.updated_at.desc(), models.DailyReport.created_at.desc()))).scalars().first()


async def generate_for(session: AsyncSession, user: models.User, anchor: str = "",
                       notify: bool = True, period_type: str = "daily") -> models.DailyReport | None:
    """Generate or regenerate a personal period report, skipping people without any task facts."""
    from . import llm

    info = period_info(period_type, anchor)
    name = user.display_name or user.username or "我"
    material = await collect_period(session, user.id, info["type"], info["start"])
    if not material["items"] and not material.get("open"):
        return None
    content, source = render_template(name, info, material), "template"
    system = _WEEKLY_SYSTEM if info["type"] == "weekly" else _DAILY_SYSTEM
    generated = await llm.chat(session, system, _llm_material(name, info, material), temperature=0.35)
    if generated:
        content, source = generated, "llm"

    report = await find_report(session, user.id, info["type"], info["start"])
    existing = report is not None
    report = report or models.DailyReport(
        user_id=user.id, period_type=info["type"], date=info["start"])
    report.user_name, report.org_id = name, getattr(user, "org_id", None)
    report.period_type, report.date = info['type'], info['start']
    report.content, report.source = content, source
    report.done_count = len(material["done"])
    report.progress_count = material["progressCount"]
    report.active_count = len(material["items"])
    report.items = material["items"]
    report.updated_at = datetime.now().astimezone()
    if not existing:
        session.add(report)
    await session.commit()
    await session.refresh(report)

    if notify:
        boxes = list((await session.execute(
            select(models.Client.id).where(models.Client.user_ref == user.id)
        )).scalars().all())
        noun = "周报" if info["type"] == "weekly" else "日报"
        for box in boxes:
            await hub.publish(box, {"type": "notice",
                                    "text": f"{noun}已生成：完成 {report.done_count} 项、记录 {report.progress_count} 条进展"},
                              user_id=user.id)
            await hub.publish(box, {"type": "work.report", "report": to_api(report)},
                              user_id=user.id)
    return report


def to_api(report: models.DailyReport) -> dict:
    info = period_info(report.period_type, report.date)
    return {
        "id": report.id, "userId": report.user_id, "userName": report.user_name,
        "periodType": info["type"], "periodStart": info["start"], "periodEnd": info["end"],
        "periodLabel": info["label"], "date": report.date,
        "content": report.content, "source": report.source,
        "doneCount": report.done_count, "progressCount": report.progress_count,
        "activeCount": report.active_count, "items": list(report.items or []),
        "createdAt": int(report.created_at.timestamp() * 1000) if report.created_at else None,
        "updatedAt": int(report.updated_at.timestamp() * 1000) if report.updated_at else None,
    }


async def run_for_all(anchor: str | None = None, period_type: str = "daily") -> int:
    info = period_info(period_type, anchor or today_str())
    count = 0
    async with SessionLocal() as session:
        users = list((await session.execute(
            select(models.User).where(models.User.is_active.is_(True))
        )).scalars().all())
        for user in users:
            try:
                if await generate_for(session, user, info["start"], period_type=info["type"]):
                    count += 1
            except Exception as error:  # noqa: BLE001 - One person's failure must not abort the batch.
                await session.rollback()
                log.warning("%s简报生成失败 user=%s: %s", info["type"], user.id,
                            type(error).__name__)
        try:
            from . import team_daily_report
            teams = await team_daily_report.generate_scope(
                session, info["start"], None, period_type=info["type"])
        except Exception as error:  # noqa: BLE001
            teams = []
            log.warning("团队%s简报生成失败: %s", info["type"], type(error).__name__)
    log.info("周期简报：%s %s 个人 %d 份、团队 %d 份",
             info["type"], info["start"], count, len(teams))
    return count


async def report_loop() -> None:
    """Generate daily reports and weekly reports on the configured weekday; manual generation
    remains available.
    """
    log.info("简报调度启动：日报 %d:00，周报周%d %d:00",
             REPORT_HOUR, WEEKLY_REPORT_WEEKDAY + 1, WEEKLY_REPORT_HOUR)
    completed: set[str] = set()
    while True:
        try:
            now = datetime.now()
            daily_key = "daily:" + now.strftime("%Y-%m-%d")
            if now.hour >= REPORT_HOUR and daily_key not in completed:
                completed.add(daily_key)
                await run_for_all(now.strftime("%Y-%m-%d"), "daily")
            week = period_info("weekly", now.strftime("%Y-%m-%d"))
            weekly_key = "weekly:" + week["start"]
            if (now.weekday() == WEEKLY_REPORT_WEEKDAY and now.hour >= WEEKLY_REPORT_HOUR
                    and weekly_key not in completed):
                completed.add(weekly_key)
                await run_for_all(week["start"], "weekly")
            if len(completed) > 40:
                completed = {key for key in completed if key.endswith(now.strftime("%Y-%m-%d"))
                             or key.endswith(week["start"])}
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001
            log.warning("简报调度异常：%s", type(error).__name__)
        await asyncio.sleep(300)
