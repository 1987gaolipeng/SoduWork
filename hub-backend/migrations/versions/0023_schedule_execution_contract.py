"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "0023_schedule_execution_contract"
down_revision: Union[str, Sequence[str], None] = "0022_runner_org_scope"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


TABLE = "ai_schedule"
COLUMNS = (
    sa.Column("required_capabilities", sa.JSON(), nullable=False,
              server_default=sa.text("'[]'")),
    sa.Column("retry_limit", sa.Integer(), nullable=False, server_default="2"),
    sa.Column("retry_delay_minutes", sa.Integer(), nullable=False, server_default="5"),
    sa.Column("retry_count", sa.Integer(), nullable=False, server_default="0"),
    sa.Column("next_retry_at", sa.DateTime(timezone=True), nullable=True),
)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if TABLE not in inspector.get_table_names():
        return
    existing = {item["name"] for item in inspector.get_columns(TABLE)}
    with op.batch_alter_table(TABLE, schema=None) as batch_op:
        for column in COLUMNS:
            if column.name not in existing:
                batch_op.add_column(column)
    bind.execute(sa.text(
        "UPDATE ai_schedule SET required_capabilities = '[]' "
        "WHERE required_capabilities IS NULL"
    ))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if TABLE not in inspector.get_table_names():
        return
    existing = {item["name"] for item in inspector.get_columns(TABLE)}
    with op.batch_alter_table(TABLE, schema=None) as batch_op:
        for column in reversed(COLUMNS):
            if column.name in existing:
                batch_op.drop_column(column.name)
