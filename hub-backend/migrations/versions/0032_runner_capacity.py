"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "0032_runner_capacity"
down_revision: Union[str, Sequence[str], None] = "0031_gate_decision_snapshot"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


TABLE = "automation_runner_node"
COLUMN = "max_concurrent"


def upgrade() -> None:
    bind = op.get_bind()
    columns = {item["name"] for item in inspect(bind).get_columns(TABLE)}
    if COLUMN not in columns:
        with op.batch_alter_table(TABLE, schema=None) as batch:
            batch.add_column(sa.Column(
                COLUMN, sa.Integer(), nullable=False,
                server_default=sa.text("'1'")))


def downgrade() -> None:
    bind = op.get_bind()
    columns = {item["name"] for item in inspect(bind).get_columns(TABLE)}
    if COLUMN in columns:
        with op.batch_alter_table(TABLE, schema=None) as batch:
            batch.drop_column(COLUMN)
