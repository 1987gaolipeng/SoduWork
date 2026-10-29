"""Persist the wall-clock timezone for every automation schedule.

Revision ID: 0025_schedule_timezone
Revises: 0024_schedule_run_ledger
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "0025_schedule_timezone"
down_revision: Union[str, Sequence[str], None] = "0024_schedule_run_ledger"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


TABLE = "ai_schedule"
COLUMN = "time_zone"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if TABLE not in inspector.get_table_names():
        return
    existing = {item["name"] for item in inspector.get_columns(TABLE)}
    if COLUMN not in existing:
        with op.batch_alter_table(TABLE, schema=None) as batch_op:
            batch_op.add_column(sa.Column(
                COLUMN, sa.String(length=64), nullable=False,
                server_default="Asia/Shanghai"))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if TABLE not in inspector.get_table_names():
        return
    existing = {item["name"] for item in inspector.get_columns(TABLE)}
    if COLUMN in existing:
        with op.batch_alter_table(TABLE, schema=None) as batch_op:
            batch_op.drop_column(COLUMN)
