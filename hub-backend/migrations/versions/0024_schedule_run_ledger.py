"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "0024_schedule_run_ledger"
down_revision: Union[str, Sequence[str], None] = "0023_schedule_execution_contract"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


TABLE = "ai_schedule_run"


def upgrade() -> None:
    bind = op.get_bind()
    if TABLE in inspect(bind).get_table_names():
        return
    op.create_table(
        TABLE,
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("schedule_id", sa.String(length=36), nullable=False),
        sa.Column("org_id", sa.String(length=36), nullable=True),
        sa.Column("owner_client_id", sa.String(length=64), nullable=False,
                  server_default=""),
        sa.Column("task_id", sa.String(length=36), nullable=False,
                  server_default=""),
        sa.Column("workflow_run_id", sa.String(length=36), nullable=False,
                  server_default=""),
        sa.Column("trigger", sa.String(length=16), nullable=False,
                  server_default="timer"),
        sa.Column("state", sa.String(length=24), nullable=False,
                  server_default="starting"),
        sa.Column("attempt", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("error", sa.String(length=1200), nullable=False,
                  server_default=""),
        sa.Column("receipt", sa.JSON(), nullable=False,
                  server_default=sa.text("'{}'")),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    for column in ("schedule_id", "org_id", "owner_client_id", "task_id",
                   "workflow_run_id", "state"):
        op.create_index(f"ix_{TABLE}_{column}", TABLE, [column], unique=False)
    op.create_index("ix_ai_schedule_run_schedule_started", TABLE,
                    ["schedule_id", "started_at"], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    if TABLE in inspect(bind).get_table_names():
        op.drop_table(TABLE)
