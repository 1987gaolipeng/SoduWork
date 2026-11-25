"""Provider-neutral, idempotent AI usage ledger."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import and_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from .. import models
from ..account_conversation_models import AccountConversation
from ..timestamps import iso_utc
from .usage_values import (
    _QUALITY_RANK,
    _number,
    normalize_usage,
    validate_reported_usage,
)

_COUNTERS = (
    "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
    "reasoning_tokens", "total_tokens", "requests", "turns", "steps",
    "duration_ms", "cost_microusd",
)


def _dt(value: Any) -> datetime:
    if isinstance(value, datetime):
        parsed = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    try:
        parsed = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
        parsed = parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except (TypeError, ValueError):
        return datetime.now(timezone.utc)


async def upsert_cumulative(
    session: AsyncSession, idempotency_key: str, values: dict,
) -> models.AIUsageEvent:
    row, _ = await record_cumulative(session, idempotency_key, values)
    return row


async def record_cumulative(
    session: AsyncSession, idempotency_key: str, values: dict,
) -> tuple[models.AIUsageEvent, str]:
    """Create once, then accept only monotonic cumulative counters.

    A client reports the running total for one session more than once.  The
    first report remains the event's anchor. Positive increments are recorded
    separately on the report's Beijing calendar day, in the same transaction.
    Lock the cumulative row before reading counters so concurrent PostgreSQL
    workers cannot both account for the same increment.
    """
    key = str(idempotency_key or "")
    if not key:
        raise ValueError("idempotency_key is required")
    if len(key) > 240:
        key = 'sha256:' + hashlib.sha256(key.encode()).hexdigest()
    locked_event = select(models.AIUsageEvent).where(
        models.AIUsageEvent.idempotency_key == key).limit(1).with_for_update()
    locked_event = locked_event.execution_options(populate_existing=True)
    row = await session.scalar(locked_event)
    reported_at = _dt(values.get("occurred_at"))
    created = False
    if row is None:
        # Keep the first insert in the batch transaction, including on SQLite
        # where releasing an outermost SAVEPOINT would commit an empty anchor.
        insert = sqlite_insert if session.get_bind().dialect.name == "sqlite" else pg_insert
        statement = insert(models.AIUsageEvent).values(
            idempotency_key=key, occurred_at=reported_at, quality="unknown",
        ).on_conflict_do_nothing(index_elements=["idempotency_key"]).returning(models.AIUsageEvent)
        row = await session.scalar(statement)
        created = row is not None
        if not created:
            row = (await session.scalars(locked_event)).one()

    if "reported_chat_session_id" in values:
        claim = values["reported_chat_session_id"]
        new_type = values["source_type"]
        if not created and row.source_type != new_type and "chat" in (row.source_type, new_type):
            raise InvalidUsageSource("A chat receipt cannot change its source type")
        if row.reported_chat_session_id is not None and claim and claim != row.reported_chat_session_id:
            raise InvalidUsageSource("A chat receipt cannot change its source session")
        if row.reported_chat_session_id is None:
            row.reported_chat_session_id = claim

    # Old integrations may have cumulative events without daily facts. Preserve
    # their unknown funding before the first new increment makes the legacy
    # fallback query ineligible. Never infer old funding from mutable metadata.
    prior = {field: _number(getattr(row, field, 0)) for field in _COUNTERS}
    if any(prior.values()) and not await session.scalar(select(models.AIUsageDaily.id).where(
            models.AIUsageDaily.usage_event_id == row.id).limit(1)):
        anchored = _dt(row.occurred_at)
        dimensions = {field: str(getattr(row, field) or "") for field in (
            "billing_user_id", "org_id", "client_id", "agent_key", "provider", "model", "source_type")}
        dimensions.update(quota_scope="platform", cost_known=bool(row.cost_microusd))
        dimension_key = hashlib.sha256(json.dumps({**dimensions, "currency": row.currency},
            sort_keys=True, ensure_ascii=True).encode()).hexdigest()
        session.add(models.AIUsageDaily(usage_event_id=row.id,
            day_key=anchored.astimezone(timezone(timedelta(hours=8))).date().isoformat(),
            dimension_key=dimension_key, **dimensions, occurred_at=anchored,
            currency=row.currency, is_baseline=True, **prior))
        await session.flush()

    for field in (
        "org_id", "billing_user_id", "actor_user_id", "client_id", "runner_id",
        "source_type", "source_id", "source_title", "conversation_id", "task_id",
        "workflow_run_id", "node_run_id", "agent_key", "provider", "model",
        "credential_scope", "billing_mode", "currency",
    ):
        value = values.get(field)
        if value not in (None, ""):
            setattr(row, field, str(value)[:240])
    deltas = {}
    for field in _COUNTERS:
        previous = _number(getattr(row, field, 0))
        current = max(previous, _number(values.get(field)))
        setattr(row, field, current)
        deltas[field] = current - previous
    row.input_includes_cache = bool(
        row.input_includes_cache or values.get("input_includes_cache"))
    incoming_quality = str(values.get("quality") or "unknown")
    if _QUALITY_RANK.get(incoming_quality, 0) >= _QUALITY_RANK.get(row.quality, 0):
        row.quality = incoming_quality
    if isinstance(values.get("raw_usage"), dict):
        row.raw_usage = dict(values["raw_usage"])
    # Retain the event anchor for consumers of the cumulative ledger.
    if row.occurred_at is None:
        row.occurred_at = reported_at
    if any(deltas.values()):
        day_key = reported_at.astimezone(timezone(timedelta(hours=8))).date().isoformat()
        dimensions = {field: str(values.get(field, getattr(row, field)) or '') for field in (
            'billing_user_id', 'org_id', 'client_id', 'agent_key', 'provider', 'model', 'source_type')}
        # A missing price is different from a known zero. Keep that distinction
        # on the immutable daily increment so later attribution changes cannot relabel it.
        dimensions['cost_known'] = bool(values.get('cost_known'))
        dimensions['quota_scope'] = "personal" if values.get('quota_scope') == "personal" else "platform"
        dimension_key = hashlib.sha256(json.dumps({**dimensions, 'currency': row.currency},
            sort_keys=True, ensure_ascii=True).encode()).hexdigest()
        daily = (await session.execute(select(models.AIUsageDaily).where(
            models.AIUsageDaily.usage_event_id == row.id,
            models.AIUsageDaily.day_key == day_key,
            models.AIUsageDaily.dimension_key == dimension_key,
        ))).scalar_one_or_none()
        if daily is None:
            daily = models.AIUsageDaily(
                usage_event_id=row.id, day_key=day_key,
                dimension_key=dimension_key, **dimensions,
                occurred_at=reported_at, currency=row.currency, **deltas)
            session.add(daily)
        else:
            for field, delta in deltas.items():
                setattr(daily, field, int(getattr(daily, field) or 0) + delta)
        await session.flush()
    if created:
        return row, "created"
    return row, "updated" if any(deltas.values()) else "duplicate"


def chat_source_match():
    event = models.AIUsageEvent
    return and_(AccountConversation.owner_user_id == event.billing_user_id,
                AccountConversation.source_client_id == event.client_id,
                AccountConversation.source_session_id == event.reported_chat_session_id,
                event.reported_chat_session_id != "", event.billing_user_id != "")


def source_reference(row: models.AIUsageEvent, verified_session_id: str | None) -> dict:
    if row.reported_chat_session_id is None:
        return {"sourceId": row.source_id}
    return {"sourceId": verified_session_id or "", "conversationId": verified_session_id or "",
            "sourceVerification": "verified" if verified_session_id else "unverified"}


async def verify_chat_receipts(session: AsyncSession, receipts: list[dict]) -> None:
    ids = {item["id"] for item in receipts if "sourceVerification" in item}
    if not ids:
        return
    event = models.AIUsageEvent
    query = (select(event.id, AccountConversation.source_session_id).select_from(event)
             .join(AccountConversation, chat_source_match()).where(event.id.in_(ids)))
    matches = dict((await session.execute(query)).all())
    for item in receipts:
        if item["id"] in matches:
            item.update(sourceId=matches[item["id"]], conversationId=matches[item["id"]], sourceVerification="verified")


def to_api(row: models.AIUsageEvent) -> dict:
    return {
        "id": row.id,
        "sourceType": row.source_type,
        "conversationId": row.conversation_id,
        **source_reference(row, None),
        "taskId": row.task_id,
        "agent": row.agent_key,
        "provider": row.provider,
        "model": row.model,
        "usage": {
            "input": int(row.input_tokens or 0),
            "output": int(row.output_tokens or 0),
            "cacheRead": int(row.cache_read_tokens or 0),
            "cacheWrite": int(row.cache_write_tokens or 0),
            "reasoning": int(row.reasoning_tokens or 0),
            "total": int(row.total_tokens or 0),
            "requests": int(row.requests or 0),
            "turns": int(row.turns or 0),
            "steps": int(row.steps or 0),
            "durationMs": int(row.duration_ms or 0),
            "costMicrousd": int(row.cost_microusd or 0),
        },
        "quality": row.quality,
        "occurredAt": iso_utc(row.occurred_at) if row.occurred_at else "",
    }


async def from_execution(
    session: AsyncSession, row: am.ExecutionSession, task: models.Task,
    *, owner_client: models.Client | None = None,
    billing_user: models.User | None = None,
) -> models.AIUsageEvent | None:
    usage = normalize_usage(dict(dict(row.metadata_ or {}).get("usage") or {}))
    if not any(usage.get(key) for key in _COUNTERS):
        return None
    client = owner_client
    if client is None and task.owner_client_id:
        client = await session.get(models.Client, str(task.owner_client_id))
    billing_user_id = str(
        task.assignee_user_id or (client.user_ref if client else "") or "")
    if billing_user is None and billing_user_id:
        billing_user = await session.get(models.User, billing_user_id)
    meta = dict(row.metadata_ or {})
    identity = dict(meta.get("executionIdentity") or {})
    if row.started_at:
        end = row.finished_at or row.last_event_at or datetime.now(timezone.utc)
        start = row.started_at
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
        if end.tzinfo is None:
            end = end.replace(tzinfo=timezone.utc)
        usage["duration_ms"] = max(usage["duration_ms"], int(
            max(0, (end - start).total_seconds()) * 1000))
    source_type = "workflow" if row.workflow_run_id else "task"
    values = {
        **usage,
        "org_id": str((billing_user.org_id if billing_user else "") or ""),
        "billing_user_id": billing_user_id,
        "actor_user_id": str(task.created_by or ""),
        "client_id": str(task.owner_client_id or ""),
        "runner_id": str(row.runner_id or ""),
        "source_type": source_type,
        "source_id": str(row.workflow_run_id or task.id),
        "task_id": str(task.id),
        "workflow_run_id": str(row.workflow_run_id or ""),
        "node_run_id": str(row.node_run_id or ""),
        "agent_key": str(identity.get("agentKey") or identity.get("cli")
                         or row.engine or "unknown"),
        "provider": str(identity.get("provider") or row.engine or ""),
        "model": str(row.model or identity.get("model") or ""),
        "credential_scope": str(identity.get("credentialScope") or "unknown"),
        "billing_mode": str(identity.get("billingMode") or "unknown"),
        "occurred_at": row.last_event_at or row.finished_at or row.started_at,
    }
    return await upsert_cumulative(session, "execution:" + str(row.ref), values)


async def from_client(
    session: AsyncSession, client: models.Client, payload: dict,
) -> models.AIUsageEvent:
    key, values = await prepare_client_event(session, client, payload)
    return await upsert_cumulative(session, key, values)


class InvalidUsageSource(ValueError):
    """The supplied event category cannot be recorded as reported."""


async def prepare_client_event(
    session: AsyncSession, client: models.Client, payload: dict,
) -> tuple[str, dict]:
    allowed_sources = ("chat", "task", "workflow", "automation", "system")
    source_type = payload.get("sourceType", "chat")
    if source_type not in allowed_sources:
        raise InvalidUsageSource("sourceType must be one of: " + ", ".join(allowed_sources))
    source_id = str(payload.get("sourceId") or payload.get("conversationId") or "")[:180]
    claim = None
    if source_type == "chat":
        ids = [payload[field] for field in ("sourceId", "conversationId") if payload.get(field) not in (None, "")]
        if any(not isinstance(value, str) or len(value) > 180 or not value.strip() for value in ids):
            raise InvalidUsageSource("Chat session IDs must be nonempty strings of at most 180 characters")
        if len(set(ids)) > 1:
            raise InvalidUsageSource("sourceId and conversationId must identify the same chat session")
        claim = source_id
    reported_key = str(payload.get("idempotencyKey") or source_id)[:180]
    if not reported_key:
        raise ValueError("sourceId is required")
    user_id = str(client.user_ref or "")
    user = await session.get(models.User, user_id) if user_id else None
    task_id = str(payload.get("taskId") or "")[:36]
    if task_id:
        task = await session.get(models.Task, task_id)
        from . import task_access
        allowed = task is not None and (
            task_access.is_owner(task, client)
            or (user_id and str(task.assignee_user_id or "") == user_id)
        )
        if not allowed:
            task_id = ""
    workflow_run_id = str(payload.get("workflowRunId") or "")[:36]
    node_run_id = str(payload.get("nodeRunId") or "")[:36]
    if source_type in {"task", "workflow"} and not task_id:
        raise InvalidUsageSource(f"sourceType {source_type} requires a visible taskId")
    from .model_quota import reported_scope
    raw_usage = payload.get("usage")
    if raw_usage is None:
        raw_usage = {}
    elif not isinstance(raw_usage, dict):
        raise ValueError("usage 必须是对象")
    validate_reported_usage(raw_usage)
    values = {
        "quota_scope": reported_scope(client, payload),
        **normalize_usage(raw_usage),
        "org_id": str((user.org_id if user else "") or ""),
        "billing_user_id": user_id,
        "actor_user_id": user_id,
        "client_id": client.id,
        "runner_id": str(payload.get("runnerId") or ""),
        "source_type": source_type,
        "reported_chat_session_id": claim,
        "source_id": (source_id or reported_key) if claim is None else "",
        "source_title": str(payload.get("sourceTitle") or "").strip()[:200],
        "conversation_id": str(payload.get("conversationId") or source_id) if claim is None else "",
        "task_id": task_id,
        "workflow_run_id": workflow_run_id,
        "node_run_id": node_run_id,
        "agent_key": str(payload.get("agent") or payload.get("agentKey") or "unknown"),
        "provider": str(payload.get("provider") or ""),
        "model": str(payload.get("model") or ""),
        "credential_scope": str(payload.get("credentialScope") or "personal"),
        "billing_mode": str(payload.get("billingMode") or "unknown"),
        "occurred_at": payload.get("occurredAt"),
    }
    # Old reports used only the device ID. Reuse an old counter only when its
    # stored billing identity proves it belongs to this same account.
    legacy_key = ("client:" + client.id + ":" + reported_key)[:240]
    legacy = await session.scalar(select(models.AIUsageEvent).where(
        models.AIUsageEvent.idempotency_key == legacy_key,
        models.AIUsageEvent.client_id == client.id,
        models.AIUsageEvent.billing_user_id == user_id,
    ).limit(1).with_for_update().execution_options(populate_existing=True))
    if legacy is not None:
        key = legacy_key
    else:
        identity = json.dumps([client.id, user_id, reported_key], separators=(",", ":"))
        key = "client-account:" + hashlib.sha256(identity.encode("utf-8")).hexdigest()
    return key, values
