"""Preserve daily increments separately from cumulative usage totals."""
from datetime import datetime, timedelta, timezone
import uuid

from alembic import op
import sqlalchemy as sa

revision = "0042_usage_daily_deltas"
down_revision = "0041_usage_calendar_stability"
branch_labels = None
depends_on = None

COUNTERS = (
    "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
    "reasoning_tokens", "total_tokens", "requests", "turns", "steps",
    "duration_ms", "cost_microusd",
)


def backfill_daily(bind) -> None:
    """Freeze legacy totals at their existing chart date, in bounded batches.

    Older rows contain no per-day history. Retain revision 0041's created_at
    attribution and mark it as a baseline, without inventing a historical split.
    Also used by the one-time pre-Alembic adoption path. Existing daily records
    are never rewritten, so interrupted/adopted databases can be retried safely.
    """
    metadata = sa.MetaData()
    events = sa.Table("ai_usage_event", metadata, autoload_with=bind)
    daily = sa.Table("ai_usage_daily", metadata, autoload_with=bind)
    cursor = ""
    while True:
        rows = bind.execute(sa.select(events).where(
            events.c.id > cursor,
            ~sa.exists(sa.select(daily.c.id).where(
                daily.c.usage_event_id == events.c.id)),
        ).order_by(events.c.id).limit(500)).mappings().all()
        if not rows:
            break
        payload = []
        for row in rows:
            stamp = row["created_at"] or row["occurred_at"] or datetime.now(timezone.utc)
            if stamp.tzinfo is None:
                stamp = stamp.replace(tzinfo=timezone.utc)
            payload.append({
                "id": str(uuid.uuid4()), "usage_event_id": row["id"],
                "day_key": stamp.astimezone(timezone(timedelta(hours=8))).date().isoformat(),
                **{key: max(0, int(row[key] or 0)) for key in COUNTERS},
                "currency": row["currency"] or "USD", "is_baseline": True,
                "occurred_at": stamp.astimezone(timezone.utc),
            })
        bind.execute(daily.insert(), payload)
        cursor = rows[-1]["id"]


def upgrade() -> None:
    op.create_table(
        "ai_usage_daily",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("usage_event_id", sa.String(36),
                  sa.ForeignKey("ai_usage_event.id", ondelete="CASCADE"), nullable=False),
        sa.Column("day_key", sa.String(10), nullable=False),
        *[sa.Column(key, sa.Integer() if key in {"requests", "turns", "steps"}
                    else sa.BigInteger(), nullable=False, server_default="0")
          for key in COUNTERS],
        sa.Column("currency", sa.String(8), nullable=False, server_default="USD"),
        sa.Column("is_baseline", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("usage_event_id", "day_key", name="uq_ai_usage_daily_event_day"),
    )
    op.create_index("ix_ai_usage_daily_day", "ai_usage_daily", ["day_key"])
    backfill_daily(op.get_bind())


def downgrade() -> None:
    op.drop_table("ai_usage_daily")
