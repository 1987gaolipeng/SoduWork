"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "0027_schedule_personal_plugin"
down_revision: Union[str, Sequence[str], None] = "0026_repository_assets"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {item["name"] for item in inspect(bind).get_columns("ai_schedule")}
    with op.batch_alter_table("ai_schedule", schema=None) as batch:
        if "personal_plugin_key" not in columns:
            batch.add_column(sa.Column(
                "personal_plugin_key", sa.String(length=64),
                nullable=False, server_default=""))
    indexes = {item["name"] for item in inspect(bind).get_indexes("ai_schedule")}
    if "ix_ai_schedule_personal_plugin_key" not in indexes:
        op.create_index("ix_ai_schedule_personal_plugin_key", "ai_schedule",
                        ["personal_plugin_key"], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    columns = {item["name"] for item in inspect(bind).get_columns("ai_schedule")}
    indexes = {item["name"] for item in inspect(bind).get_indexes("ai_schedule")}
    if "ix_ai_schedule_personal_plugin_key" in indexes:
        op.drop_index("ix_ai_schedule_personal_plugin_key", table_name="ai_schedule")
    with op.batch_alter_table("ai_schedule", schema=None) as batch:
        if "personal_plugin_key" in columns:
            batch.drop_column("personal_plugin_key")
