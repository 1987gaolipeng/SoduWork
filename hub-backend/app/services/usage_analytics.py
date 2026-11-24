"""Calendar-day analytics over the cumulative usage ledger."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..account_conversation_models import AccountConversation
from ..timestamps import iso_utc
from .usage_ledger import chat_source_match, source_reference
from .usage_values import MAX_REPORTED_COUNTER

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


_SUM_BASE = 1 << 32
_PAGE_SIZE = 30


def _sum_columns(value, label, sqlite):
    # PostgreSQL sums BIGINT as NUMERIC. SQLite's SUM can overflow on a
    # handful of historic counters. Sum their integer halves independently
    # and combine in Python so neither a float nor a SQL product loses bits.
    if sqlite:
        return [func.sum(value % _SUM_BASE).label(label),
                func.sum(value // _SUM_BASE).label(label + 'High')]
    return [func.sum(value).label(label)]


def _sum_value(row, label):
    return int(row.get(label) or 0) + int(row.get(label + 'High') or 0) * _SUM_BASE


def _metric_columns(daily, event, sqlite) -> list:
    """Build the same metric projection for daily rows and event dimensions.

    A session can have multiple daily rows. Distinct event IDs keep the session
    count stable for a multi-day conversation while every counter is summed from
    the actual daily increments.
    """
    known_usd = daily.cost_known.is_(True) & (daily.currency == "USD")
    columns = []
    for field, label in _METRICS:
        value = getattr(daily, field)
        if field == "cost_microusd":
            value = case((known_usd, value), else_=0)
        columns.extend(_sum_columns(value, label, sqlite))
    return columns + [func.count(func.distinct(event.id)).label("sessions"),
                      func.count(case((known_usd, 1))).label("knownUsd")]


def _bucket(row: dict, key: str = "", label: str = "") -> dict:
    item = _empty(key, label)
    for _field, api_name in _METRICS:
        item[api_name] = _sum_value(row, api_name)
    item["tokensExact"] = str(item["tokens"])
    item["knownUsd"] = int(row.get("knownUsd") or 0)
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
        conditions.append(daily.billing_user_id.in_(user_ids))
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
    detail: str = "all",
    page: int = 1,
    exclude_anomalies: bool = False,
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
    scope_conditions = _daily_conditions(
        first_day=first_day, end_day=end_day, user_ids=user_ids, user_id=user_id,
        client_id=client_id, source_type=source_type, agent_key=agent_key)
    joined = daily.__table__.join(event.__table__, daily.usage_event_id == event.id)
    anomalous = daily.total_tokens > MAX_REPORTED_COUNTER
    conditions = scope_conditions + ([~anomalous] if exclude_anomalies else [])
    sqlite = session.get_bind().dialect.name == 'sqlite'
    metrics = _metric_columns(daily, event, sqlite)

    summary_row = (await session.execute(select(*metrics).
        select_from(joined).where(*conditions))).mappings().one()
    summary = _bucket(summary_row, "all", "\u5168\u90e8\u7528\u91cf")

    source_rows = (await session.execute(select(
        daily.source_type.label("sourceType"), *metrics,
    ).select_from(joined).where(*conditions).group_by(daily.source_type))).mappings().all()
    sources = [
        _bucket(row, str(row["sourceType"] or "system"), SOURCE_LABELS.get(
            str(row["sourceType"] or "system"), str(row["sourceType"] or "system")))
        for row in source_rows
    ]

    agent_rows = (await session.execute(select(
        daily.agent_key.label("agent"), daily.model.label("model"),
        daily.provider.label("provider"), *metrics,
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
        daily.billing_user_id.label("userId"), *metrics,
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
        daily.day_key.label("day"), *metrics,
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

    # Keep risk and cost evidence for the entire visible selection even when
    # charts temporarily omit anomalous increments.
    unpriced = daily.cost_known.is_(False)
    known_usd = daily.cost_known.is_(True) & (daily.currency == "USD")
    estimated_usage_usd = known_usd & (event.quality == "estimated")
    cost_rows = (await session.execute(select(
        func.count(daily.id).label("records"),
        func.count(case((anomalous, 1))).label("anomalous"),
        func.count(case((unpriced, 1))).label("unknown"),
        func.count(case((anomalous & unpriced, 1))).label("unknownAnomalous"),
        func.count(case((daily.currency != "USD", 1))).label("otherCurrency"),
        func.count(case((daily.cost_known.is_(True) & (daily.currency != "USD"), 1))).label("knownOtherCurrency"),
        func.count(case((known_usd, 1))).label("knownUsd"),
        func.count(case((estimated_usage_usd, 1))).label("estimatedUsageUsd"),
        *_sum_columns(case((known_usd, daily.cost_microusd), else_=0), "knownMicrousd", sqlite),
        *_sum_columns(case((estimated_usage_usd, daily.cost_microusd), else_=0), "estimatedUsageMicrousd", sqlite),
        *_sum_columns(case((unpriced, daily.total_tokens), else_=0), "unknownTokens", sqlite),
    ).select_from(joined).where(*scope_conditions))).mappings().one()
    if detail == "anomalous":
        detail_conditions = scope_conditions + [anomalous]
        detail_count = cost_rows["anomalous"]
    elif detail == "unpriced":
        detail_conditions = scope_conditions + [unpriced]
        detail_count = cost_rows["unknown"]
    else:
        detail_conditions = conditions
        detail_count = cost_rows["records"] - (cost_rows["anomalous"] if exclude_anomalies else 0)
    last_page = max(1, (detail_count + _PAGE_SIZE - 1) // _PAGE_SIZE)
    page = max(1, min(page, last_page))
    recent_rows = (await session.execute(select(
        daily, event, models.Task.title, models.User.display_name, models.User.username,
        AccountConversation.source_session_id, AccountConversation.title,
    ).select_from(joined).outerjoin(models.Task, models.Task.id == event.task_id).
        outerjoin(AccountConversation, chat_source_match()
                  & (daily.billing_user_id == event.billing_user_id)
                  & (daily.client_id == event.client_id)
                  & (daily.source_type == "chat")).
        outerjoin(models.User, models.User.id == daily.billing_user_id).
        where(*detail_conditions).order_by(daily.day_key.desc(), daily.updated_at.desc(), daily.id.desc()).
        offset((page - 1) * _PAGE_SIZE).limit(_PAGE_SIZE))).all()

    recent = []
    for daily_row, event_row, task_title, display_name, username, verified_session, chat_title in recent_rows:
        reference = source_reference(event_row, verified_session)
        title = task_title or event_row.source_title
        if event_row.reported_chat_session_id is not None:
            # Only display a chat title when the usage report included one.
            title = chat_title if event_row.source_title else None
        elif daily_row.source_type == "chat" and event_row.source_type != "chat":
            # Before source types were anchored, a later receipt could relabel the event.
            reference = {"sourceId": "", "conversationId": "", "sourceVerification": "unverified"}
            title = None
        recent.append({
            "id": daily_row.id,
            "eventId": event_row.id,
            "taskId": str(event_row.task_id or ""),
            **reference,
            "title": title or SOURCE_LABELS.get(daily_row.source_type, reference["sourceId"] or "AI \u4f7f\u7528"),
            "sourceType": daily_row.source_type,
            "sourceLabel": SOURCE_LABELS.get(daily_row.source_type, daily_row.source_type),
            "agent": daily_row.agent_key or "unknown",
            "model": daily_row.model or "",
            "provider": daily_row.provider or "",
            "user": display_name or username or "\u672a\u7ed1\u5b9a\u7528\u6237",
            "tokens": int(daily_row.total_tokens or 0),
            "tokensExact": str(daily_row.total_tokens or 0),
            "anomalous": daily_row.total_tokens > MAX_REPORTED_COUNTER,
            "costMicrousd": int(daily_row.cost_microusd or 0) if daily_row.cost_known and daily_row.currency == "USD" else 0,
            "costKnown": daily_row.cost_known, "currency": daily_row.currency,
            "durationMs": int(daily_row.duration_ms or 0),
            "quality": event_row.quality or "unknown",
            "occurredAt": iso_utc(daily_row.occurred_at) if daily_row.occurred_at else "",
        })
    total_rows = max(1, sum(quality.values()))
    reliable = quality["reported"] + quality["reconciled"]
    return {
        "days": days, "summary": summary, "trend": trend,
        "bySource": sorted(sources, key=lambda item: item["tokens"], reverse=True),
        "byAgent": sorted(agents, key=lambda item: item["tokens"], reverse=True),
        "users": sorted(people, key=lambda item: item["tokens"], reverse=True),
        "recent": recent,
        "detailPage": {"page": page, "pageSize": _PAGE_SIZE, "total": detail_count},
        "anomalies": {"records": cost_rows["anomalous"], "tokenLimit": MAX_REPORTED_COUNTER},
        "costQuality": {**{key: cost_rows[key] for key in (
            "records", "unknown", "unknownAnomalous", "otherCurrency", "knownOtherCurrency",
            "knownUsd", "estimatedUsageUsd")},
            "knownMicrousd": _sum_value(cost_rows, "knownMicrousd"),
            "estimatedUsageMicrousd": _sum_value(cost_rows, "estimatedUsageMicrousd"),
            "unknownTokens": str(_sum_value(cost_rows, "unknownTokens")), "currency": "USD"},
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
