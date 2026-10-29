"""Calendar-day analytics over the cumulative usage ledger."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models


SOURCE_LABELS = {
    "chat": "\u5bf9\u8bdd",
    "task": "需求\u6267\u884c",
    "workflow": "\u81ea\u52a8\u5316\u5de5\u4f5c\u6d41",
    "automation": "\u5b9a\u65f6\u81ea\u52a8\u5316",
    "system": "\u5e73\u53f0\u8fd0\u884c",
}


def _empty(key: str = "", label: str = "") -> dict:
    return {
        "key": key, "label": label or key, "tokens": 0, "input": 0,
        "output": 0, "cacheRead": 0, "cacheWrite": 0, "reasoning": 0,
        "costMicrousd": 0, "durationMs": 0, "requests": 0, "sessions": 0,
    }


_METRICS = (
    ("total_tokens", "tokens"),
    ("input_tokens", "input"),
    ("output_tokens", "output"),
    ("cache_read_tokens", "cacheRead"),
    ("cache_write_tokens", "cacheWrite"),
    ("reasoning_tokens", "reasoning"),
    ("cost_microusd", "costMicrousd"),
    ("duration_ms", "durationMs"),
    ("requests", "requests"),
)


def _metric_columns(metric_model, session_model=None) -> list:
    """Build the same metric projection for daily rows and event dimensions.

    A session can have multiple daily rows. Distinct event IDs keep the session
    count stable for a multi-day conversation while every counter is summed from
    the actual daily increments.
    """
    columns = [
        func.coalesce(func.sum(case((metric_model.currency == "USD", metric_model.cost_microusd), else_=0)
            if field == "cost_microusd" else getattr(metric_model, field)), 0).label(label)
        for field, label in _METRICS
    ]
    session_model = session_model or metric_model
    count = (func.count(func.distinct(session_model.id))
             if session_model is not metric_model else func.count(metric_model.id))
    return columns + [count.label("sessions")]


def _bucket(row: dict, key: str = "", label: str = "") -> dict:
    item = _empty(key, label)
    for _field, api_name in _METRICS:
        item[api_name] = int(row.get(api_name) or 0)
    item["sessions"] = int(row.get("sessions") or 0)
    return item


def _daily_source():
    return models.AIUsageDaily, models.AIUsageEvent


def _daily_conditions(
    *, first_day: str, end_day: str, user_ids: set[str] | None,
    user_id: str, client_id: str, source_type: str, agent_key: str,
) -> list:
    daily, event = _daily_source()
    conditions = [daily.day_key >= first_day, daily.day_key < end_day]
    if user_ids is not None:
        conditions.append(daily.billing_user_id.in_(user_ids or {"__none__"}))
    if user_id:
        conditions.append(daily.billing_user_id == user_id)
    elif client_id:
        conditions.append(daily.client_id == client_id)
    if source_type:
        conditions.append(daily.source_type == source_type)
    if agent_key:
        conditions.append(daily.agent_key == agent_key)
    return conditions


async def overview(
    session: AsyncSession,
    *,
    days: int = 30,
    user_ids: set[str] | None = None,
    user_id: str = "",
    client_id: str = "",
    source_type: str = "",
    agent_key: str = "",
) -> dict:
    days = max(1, min(365, int(days or 30)))
    # The UI promises Beijing calendar days. Query the day key written by the
    # ledger, instead of grouping a mutable cumulative event by its first row.
    now_local = datetime.now(timezone.utc).astimezone(timezone(timedelta(hours=8)))
    start_local = now_local.replace(
        hour=0, minute=0, second=0, microsecond=0) - timedelta(days=days - 1)
    end_local = start_local + timedelta(days=days)
    first_day, end_day = start_local.date().isoformat(), end_local.date().isoformat()
    daily, event = _daily_source()
    conditions = _daily_conditions(
        first_day=first_day, end_day=end_day, user_ids=user_ids, user_id=user_id,
        client_id=client_id, source_type=source_type, agent_key=agent_key)
    joined = daily.__table__.join(event.__table__, daily.usage_event_id == event.id)

    summary_row = (await session.execute(select(*_metric_columns(daily, event)).
        select_from(joined).where(*conditions))).mappings().one()
    summary = _bucket(summary_row, "all", "\u5168\u90e8\u7528\u91cf")

    source_rows = (await session.execute(select(
        daily.source_type.label("sourceType"), *_metric_columns(daily, event),
    ).select_from(joined).where(*conditions).group_by(daily.source_type))).mappings().all()
    sources = [
        _bucket(row, str(row["sourceType"] or "system"), SOURCE_LABELS.get(
            str(row["sourceType"] or "system"), str(row["sourceType"] or "system")))
        for row in source_rows
    ]

    agent_rows = (await session.execute(select(
        daily.agent_key.label("agent"), daily.model.label("model"),
        daily.provider.label("provider"), *_metric_columns(daily, event),
    ).select_from(joined).where(*conditions).group_by(
        daily.agent_key, daily.model, daily.provider))).mappings().all()
    agents = []
    for row in agent_rows:
        agent_name = str(row["agent"] or "unknown")
        model_name = str(row["model"] or "")
        item = _bucket(row, agent_name + "|" + model_name, agent_name)
        item.update({"agent": agent_name, "model": model_name,
                     "provider": str(row["provider"] or "")})
        agents.append(item)

    people_rows = (await session.execute(select(
        daily.billing_user_id.label("userId"), *_metric_columns(daily, event),
    ).select_from(joined).where(*conditions).group_by(daily.billing_user_id))).mappings().all()
    linked_users = {str(row["userId"] or "") for row in people_rows if row["userId"]}
    users = {}
    if linked_users:
        users = {item.id: item for item in (await session.execute(
            select(models.User).where(models.User.id.in_(linked_users))
        )).scalars().all()}
    people = []
    for row in people_rows:
        uid = str(row["userId"] or "")
        person = users.get(uid)
        item = _bucket(row, uid or "__unbound__", (
            (person.display_name or person.username) if person
            else "\u672a\u7ed1\u5b9a\u7528\u6237"))
        item.update({"userId": uid, "orgId": str((person.org_id if person else "") or "")})
        people.append(item)

    day_rows = (await session.execute(select(
        daily.day_key.label("day"), *_metric_columns(daily, event),
    ).select_from(joined).where(*conditions).group_by(daily.day_key).
        order_by(daily.day_key))).mappings().all()
    by_day = {str(row["day"]): row for row in day_rows if row["day"]}
    trend = []
    for offset in range(days):
        key = (start_local + timedelta(days=offset)).date().isoformat()
        row = by_day.get(key, {})
        trend.append(_bucket(row, key, key[5:]))

    quality = {"reported": 0, "reconciled": 0, "estimated": 0, "unknown": 0}
    quality_rows = (await session.execute(select(
        event.quality.label("quality"), func.count(daily.id).label("amount"),
    ).select_from(joined).where(*conditions).group_by(event.quality))).mappings().all()
    for row in quality_rows:
        state = str(row["quality"] or "unknown")
        quality[state if state in quality else "unknown"] += int(row["amount"] or 0)

    recent_rows = (await session.execute(select(daily, event).select_from(joined).
        where(*conditions).order_by(daily.day_key.desc(), daily.updated_at.desc()).limit(30))).all()
    task_ids = {str(event_row.task_id or "") for _daily_row, event_row in recent_rows
                if event_row.task_id}
    tasks = {}
    if task_ids:
        tasks = {item.id: item for item in (await session.execute(
            select(models.Task).where(models.Task.id.in_(task_ids))
        )).scalars().all()}

    recent = []
    for daily_row, event_row in recent_rows:
        task = tasks.get(str(event_row.task_id or ""))
        uid = str(daily_row.billing_user_id or "")
        recent.append({
            "id": daily_row.id,
            "taskId": str(event_row.task_id or ""),
            "sourceId": str(event_row.source_id or ""),
            # Display task title first, then the client's conversation title.
            # Fall back to the source label for older records without source_title.
            "title": (task.title if task else "") or str(event_row.source_title or "") or SOURCE_LABELS.get(
                daily_row.source_type, event_row.source_id or "AI \u4f7f\u7528"),
            "sourceType": daily_row.source_type,
            "sourceLabel": SOURCE_LABELS.get(daily_row.source_type, daily_row.source_type),
            "agent": daily_row.agent_key or "unknown",
            "model": daily_row.model or "",
            "user": next((item["label"] for item in people if item["userId"] == uid),
                         "\u672a\u7ed1\u5b9a\u7528\u6237"),
            "tokens": int(daily_row.total_tokens or 0),
            "costMicrousd": int(daily_row.cost_microusd or 0) if daily_row.currency == "USD" else 0,
            "costKnown": daily_row.cost_known, "currency": daily_row.currency,
            "durationMs": int(daily_row.duration_ms or 0),
            "quality": event_row.quality or "unknown",
            "occurredAt": daily_row.occurred_at.isoformat() if daily_row.occurred_at else "",
        })
    cost_rows = (await session.execute(select(
        func.count(daily.id).label('records'),
        func.coalesce(func.sum(case((daily.cost_known.is_(False), 1), else_=0)), 0).label('unknown'),
        func.coalesce(func.sum(case((daily.currency != 'USD', 1), else_=0)), 0).label('otherCurrency'),
    ).select_from(joined).where(*conditions))).mappings().one()
    total_rows = max(1, sum(quality.values()))
    reliable = quality["reported"] + quality["reconciled"]
    return {
        "days": days, "summary": summary, "trend": trend,
        "bySource": sorted(sources, key=lambda item: item["tokens"], reverse=True),
        "byAgent": sorted(agents, key=lambda item: item["tokens"], reverse=True),
        "users": sorted(people, key=lambda item: item["tokens"], reverse=True),
        "recent": recent,
        "costQuality": {"records": int(cost_rows["records"]), "unknown": int(cost_rows["unknown"]),
                        "otherCurrency": int(cost_rows["otherCurrency"]), "currency": "USD"},
        "quality": {**quality, "coveragePct": round(reliable * 100 / total_rows)},
        "filters": {
            "sources": [{"key": key, "label": value} for key, value in SOURCE_LABELS.items()],
            "agents": sorted({str(item["agent"] or "unknown") for item in agents}),
        },
    }


async def consistent_overview(session: AsyncSession, **filters) -> dict:
    """One PostgreSQL snapshot for all totals, dimensions and recent facts.

    Authentication may already have opened a READ COMMITTED transaction on the
    request session. Release that completed read before configuring the next
    transaction, so a report never needs two pooled connections at once.
    """
    if session.bind.dialect.name != 'postgresql':
        return await overview(session, **filters)
    if session.new or session.dirty or session.deleted:
        raise RuntimeError('Usage reports require a read-only request session')
    from sqlalchemy import text
    await session.rollback()
    await session.connection(execution_options={'isolation_level': 'REPEATABLE READ'})
    try:
        await session.execute(text('SET TRANSACTION READ ONLY'))
        return await overview(session, **filters)
    finally:
        await session.rollback()
