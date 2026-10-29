"""Public module behavior and service contracts."""
from datetime import datetime, timezone
import json
from typing import Any, Sequence, Union
import uuid

from alembic import op
import sqlalchemy as sa


revision: str = "0034_ai_usage_ledger"
down_revision: Union[str, Sequence[str], None] = "0033_plugin_install_setup"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _number(value: Any) -> int:
    try:
        return max(0, int(float(value or 0)))
    except (TypeError, ValueError, OverflowError):
        return 0


def _pick(data: dict, *names: str) -> int:
    for name in names:
        value = data.get(name)
        if isinstance(value, (int, float)) and value:
            return _number(value)
    return 0


def _mapping(value: Any) -> dict:
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str) and value.strip():
        try:
            decoded = json.loads(value)
            return dict(decoded) if isinstance(decoded, dict) else {}
        except (TypeError, ValueError, json.JSONDecodeError):
            return {}
    return {}


def _normalize_usage(value: Any) -> dict | None:
    data = _mapping(value)
    input_tokens = _pick(data, "input_tokens", "input", "prompt_tokens")
    output_tokens = _pick(data, "output_tokens", "output", "completion_tokens")
    cache_read = _pick(
        data, "cache_read_tokens", "cacheRead", "cache_read_input_tokens",
        "cached_input_tokens",
    )
    cache_write = _pick(
        data, "cache_write_tokens", "cacheWrite", "cache_creation_input_tokens",
        "cache_write_input_tokens",
    )
    reasoning = _pick(
        data, "reasoning_tokens", "reasoningTokens", "output_reasoning_tokens",
    )
    includes_cache = bool(
        data.get("input_includes_cache") or data.get("inputIncludesCache")
        or "cached_input_tokens" in data
    )
    total = _pick(data, "total_tokens", "totalTokens", "total")
    calculated = input_tokens + output_tokens
    if not includes_cache:
        calculated += cache_read + cache_write
    total = max(total, calculated)
    cost = _pick(data, "cost_microusd", "costMicrousd")
    if not cost:
        raw_cost = data.get("cost")
        if isinstance(raw_cost, dict):
            raw_cost = raw_cost.get("total")
        try:
            cost = max(0, int(round(float(raw_cost or 0) * 1_000_000)))
        except (TypeError, ValueError, OverflowError):
            cost = 0
    requests = _pick(data, "requests", "requestCount", "api_calls")
    turns = _pick(data, "turns", "rounds")
    steps = _pick(data, "steps", "tool_calls")
    if not (total or cost or turns or steps):
        return None
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_read_tokens": cache_read,
        "cache_write_tokens": cache_write,
        "reasoning_tokens": reasoning,
        "total_tokens": total,
        "input_includes_cache": includes_cache,
        "requests": requests or 1,
        "turns": turns,
        "steps": steps,
        "duration_ms": _pick(data, "duration_ms", "durationMs"),
        "cost_microusd": cost,
        "currency": str(data.get("currency") or "USD").upper()[:8],
    }


def _elapsed_ms(start: Any, end: Any) -> int:
    if not isinstance(start, datetime) or not isinstance(end, datetime):
        return 0
    if start.tzinfo is None and end.tzinfo is not None:
        start = start.replace(tzinfo=end.tzinfo)
    elif start.tzinfo is not None and end.tzinfo is None:
        end = end.replace(tzinfo=start.tzinfo)
    return max(0, int((end - start).total_seconds() * 1000))


def _backfill_reported_executions(bind) -> None:
    """Seed the new ledger from authoritative usage already stored on executions.

    Historical rows without provider-reported counters are intentionally skipped: a
    commercial usage ledger must not invent token counts from transcript length.
    """
    available = set(sa.inspect(bind).get_table_names())
    required = {"automation_execution_session", "task", "client", "app_user"}
    if not required.issubset(available):
        return
    metadata = sa.MetaData()
    executions = sa.Table("automation_execution_session", metadata, autoload_with=bind)
    tasks = sa.Table("task", metadata, autoload_with=bind)
    clients = sa.Table("client", metadata, autoload_with=bind)
    users = sa.Table("app_user", metadata, autoload_with=bind)
    ledger = sa.Table("ai_usage_event", metadata, autoload_with=bind)

    rows = bind.execute(sa.select(
        executions.c.task_id,
        executions.c.workflow_run_id,
        executions.c.node_run_id,
        executions.c.ref,
        executions.c.runner_id,
        executions.c.engine,
        executions.c.model,
        executions.c.metadata.label("execution_metadata"),
        executions.c.started_at,
        executions.c.finished_at,
        executions.c.last_event_at,
        tasks.c.owner_client_id,
        tasks.c.created_by,
        tasks.c.assignee_user_id,
        clients.c.user_ref,
    ).select_from(
        executions.join(tasks, executions.c.task_id == tasks.c.id).outerjoin(
            clients, tasks.c.owner_client_id == clients.c.id)
    )).mappings().all()
    user_ids = {
        str(row["assignee_user_id"] or row["user_ref"] or "")
        for row in rows if row["assignee_user_id"] or row["user_ref"]
    }
    org_by_user: dict[str, str] = {}
    if user_ids:
        org_by_user = {
            str(row["id"]): str(row["org_id"] or "")
            for row in bind.execute(sa.select(users.c.id, users.c.org_id).where(
                users.c.id.in_(user_ids))).mappings()
        }

    now = datetime.now(timezone.utc)
    payload: list[dict] = []
    for row in rows:
        meta = _mapping(row["execution_metadata"])
        normalized = _normalize_usage(meta.get("usage"))
        if normalized is None:
            continue
        identity = _mapping(meta.get("executionIdentity"))
        billing_user_id = str(row["assignee_user_id"] or row["user_ref"] or "")
        ended = row["finished_at"] or row["last_event_at"] or now
        normalized["duration_ms"] = max(
            int(normalized["duration_ms"] or 0),
            _elapsed_ms(row["started_at"], ended),
        )
        workflow_run_id = str(row["workflow_run_id"] or "")
        task_id = str(row["task_id"] or "")
        payload.append({
            "id": str(uuid.uuid4()),
            "idempotency_key": ("execution:" + str(row["ref"] or ""))[:240],
            "org_id": org_by_user.get(billing_user_id, ""),
            "billing_user_id": billing_user_id,
            "actor_user_id": str(row["created_by"] or ""),
            "client_id": str(row["owner_client_id"] or ""),
            "runner_id": str(row["runner_id"] or ""),
            "source_type": "workflow" if workflow_run_id else "task",
            "source_id": workflow_run_id or task_id,
            "conversation_id": "",
            "task_id": task_id,
            "workflow_run_id": workflow_run_id,
            "node_run_id": str(row["node_run_id"] or ""),
            "agent_key": str(identity.get("agentKey") or identity.get("cli")
                             or row["engine"] or "unknown")[:60],
            "provider": str(identity.get("provider") or row["engine"] or "")[:60],
            "model": str(row["model"] or identity.get("model") or "")[:160],
            "credential_scope": str(identity.get("credentialScope") or "unknown")[:32],
            "billing_mode": str(identity.get("billingMode") or "unknown")[:32],
            **normalized,
            "quality": "reported",
            "raw_usage": {},
            "occurred_at": row["last_event_at"] or row["finished_at"]
                           or row["started_at"] or now,
            "created_at": now,
            "updated_at": now,
        })
    for offset in range(0, len(payload), 500):
        bind.execute(ledger.insert(), payload[offset:offset + 500])


def upgrade() -> None:
    op.create_table(
        "ai_usage_event",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("idempotency_key", sa.String(240), nullable=False),
        sa.Column("org_id", sa.String(36), nullable=False, server_default=""),
        sa.Column("billing_user_id", sa.String(36), nullable=False, server_default=""),
        sa.Column("actor_user_id", sa.String(36), nullable=False, server_default=""),
        sa.Column("client_id", sa.String(64), nullable=False, server_default=""),
        sa.Column("runner_id", sa.String(80), nullable=False, server_default=""),
        sa.Column("source_type", sa.String(32), nullable=False, server_default="chat"),
        sa.Column("source_id", sa.String(180), nullable=False, server_default=""),
        sa.Column("conversation_id", sa.String(180), nullable=False, server_default=""),
        sa.Column("task_id", sa.String(36), nullable=False, server_default=""),
        sa.Column("workflow_run_id", sa.String(36), nullable=False, server_default=""),
        sa.Column("node_run_id", sa.String(36), nullable=False, server_default=""),
        sa.Column("agent_key", sa.String(60), nullable=False, server_default=""),
        sa.Column("provider", sa.String(60), nullable=False, server_default=""),
        sa.Column("model", sa.String(160), nullable=False, server_default=""),
        sa.Column("credential_scope", sa.String(32), nullable=False, server_default="unknown"),
        sa.Column("billing_mode", sa.String(32), nullable=False, server_default="unknown"),
        sa.Column("input_tokens", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("output_tokens", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("cache_read_tokens", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("cache_write_tokens", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("reasoning_tokens", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("total_tokens", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("input_includes_cache", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("requests", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("turns", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("steps", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("duration_ms", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("cost_microusd", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("currency", sa.String(8), nullable=False, server_default="USD"),
        sa.Column("quality", sa.String(20), nullable=False, server_default="reported"),
        sa.Column("raw_usage", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("idempotency_key", name="uq_ai_usage_event_idempotency"),
    )
    for name, columns in (
        ("ix_ai_usage_user_time", ["billing_user_id", "occurred_at"]),
        ("ix_ai_usage_org_time", ["org_id", "occurred_at"]),
        ("ix_ai_usage_source", ["source_type", "source_id"]),
        ("ix_ai_usage_agent_time", ["agent_key", "occurred_at"]),
    ):
        op.create_index(name, "ai_usage_event", columns)
    for column in (
        "org_id", "billing_user_id", "actor_user_id", "client_id", "runner_id",
        "source_type", "source_id", "conversation_id", "task_id", "workflow_run_id",
        "node_run_id", "agent_key", "provider", "model", "quality", "occurred_at",
    ):
        op.create_index("ix_ai_usage_event_" + column, "ai_usage_event", [column])
    _backfill_reported_executions(op.get_bind())


def downgrade() -> None:
    op.drop_table("ai_usage_event")
