"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "0028_personal_plugin_snapshot"
down_revision: Union[str, Sequence[str], None] = "0027_schedule_personal_plugin"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {item["name"] for item in inspect(bind).get_columns("ai_schedule")}
    with op.batch_alter_table("ai_schedule", schema=None) as batch:
        if "personal_plugin_version_policy" not in columns:
            # Preserve the legacy behavior for already-created schedules.
            batch.add_column(sa.Column(
                "personal_plugin_version_policy", sa.String(length=16),
                nullable=False, server_default="latest"))
        if "personal_plugin_version" not in columns:
            batch.add_column(sa.Column(
                "personal_plugin_version", sa.String(length=40),
                nullable=False, server_default=""))
        if "personal_plugin_checksum" not in columns:
            batch.add_column(sa.Column(
                "personal_plugin_checksum", sa.String(length=64),
                nullable=False, server_default=""))


def downgrade() -> None:
    bind = op.get_bind()
    columns = {item["name"] for item in inspect(bind).get_columns("ai_schedule")}
    with op.batch_alter_table("ai_schedule", schema=None) as batch:
        for name in (
                "personal_plugin_checksum", "personal_plugin_version",
                "personal_plugin_version_policy"):
            if name in columns:
                batch.drop_column(name)
