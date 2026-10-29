"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "0017_schedule_plugin"
down_revision: Union[str, Sequence[str], None] = "0016_plugin_evaluation"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {item["name"] for item in inspect(bind).get_columns("ai_schedule")}
    with op.batch_alter_table("ai_schedule", schema=None) as batch:
        if "plugin_binding_id" not in columns:
            batch.add_column(sa.Column(
                "plugin_binding_id", sa.String(length=36),
                nullable=False, server_default=""))
        if "plugin_inputs" not in columns:
            batch.add_column(sa.Column(
                "plugin_inputs", sa.JSON(), nullable=False, server_default="{}"))
    indexes = {item["name"] for item in inspect(bind).get_indexes("ai_schedule")}
    if "ix_ai_schedule_plugin_binding_id" not in indexes:
        op.create_index("ix_ai_schedule_plugin_binding_id", "ai_schedule",
                        ["plugin_binding_id"], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    columns = {item["name"] for item in inspect(bind).get_columns("ai_schedule")}
    indexes = {item["name"] for item in inspect(bind).get_indexes("ai_schedule")}
    if "ix_ai_schedule_plugin_binding_id" in indexes:
        op.drop_index("ix_ai_schedule_plugin_binding_id", table_name="ai_schedule")
    with op.batch_alter_table("ai_schedule", schema=None) as batch:
        if "plugin_inputs" in columns:
            batch.drop_column("plugin_inputs")
        if "plugin_binding_id" in columns:
            batch.drop_column("plugin_binding_id")
