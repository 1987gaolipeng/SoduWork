"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "0018_plugin_provenance"
down_revision: Union[str, Sequence[str], None] = "0017_schedule_plugin"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {item["name"] for item in inspect(bind).get_columns(
        "automation_plugin_version")}
    if "provenance" not in columns:
        with op.batch_alter_table("automation_plugin_version", schema=None) as batch:
            batch.add_column(sa.Column(
                "provenance", sa.JSON(), nullable=False, server_default="{}"))


def downgrade() -> None:
    bind = op.get_bind()
    columns = {item["name"] for item in inspect(bind).get_columns(
        "automation_plugin_version")}
    if "provenance" in columns:
        with op.batch_alter_table("automation_plugin_version", schema=None) as batch:
            batch.drop_column("provenance")
