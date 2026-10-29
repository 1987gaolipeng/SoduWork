"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "0029_scheduler_idempotency"
down_revision: Union[str, Sequence[str], None] = "0028_personal_plugin_snapshot"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {item["name"] for item in inspect(bind).get_columns("ai_schedule_run")}
    if "idempotency_key" not in columns:
        with op.batch_alter_table("ai_schedule_run", schema=None) as batch:
            batch.add_column(sa.Column(
                "idempotency_key", sa.String(length=180),
                nullable=False, server_default=""))
    # PostgreSQL and SQLite both support ANSI string concatenation. Historical receipts
    # represent distinct attempts, so their immutable ids are safe backfill identities.
    op.execute(sa.text(
        "UPDATE ai_schedule_run "
        "SET idempotency_key = 'legacy:' || id "
        "WHERE idempotency_key IS NULL OR idempotency_key = ''"))
    indexes = {item["name"] for item in inspect(bind).get_indexes("ai_schedule_run")}
    if "uq_ai_schedule_run_idempotency_key" not in indexes:
        op.create_index(
            "uq_ai_schedule_run_idempotency_key", "ai_schedule_run",
            ["idempotency_key"], unique=True)


def downgrade() -> None:
    bind = op.get_bind()
    indexes = {item["name"] for item in inspect(bind).get_indexes("ai_schedule_run")}
    if "uq_ai_schedule_run_idempotency_key" in indexes:
        op.drop_index("uq_ai_schedule_run_idempotency_key", table_name="ai_schedule_run")
    columns = {item["name"] for item in inspect(bind).get_columns("ai_schedule_run")}
    if "idempotency_key" in columns:
        with op.batch_alter_table("ai_schedule_run", schema=None) as batch:
            batch.drop_column("idempotency_key")
