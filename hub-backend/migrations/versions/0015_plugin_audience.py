"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "0015_plugin_audience"
down_revision: Union[str, Sequence[str], None] = "0014_drop_task_flow_id"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    columns = {item["name"] for item in inspector.get_columns("automation_plugin_version")}
    if "visibility" not in columns:
        op.add_column(
            "automation_plugin_version",
            sa.Column("visibility", sa.String(length=24), nullable=False,
                      server_default="organization"),
        )
    if "automation_plugin_audience" not in set(inspector.get_table_names()):
        op.create_table(
            "automation_plugin_audience",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("plugin_id", sa.String(length=36), nullable=False),
            sa.Column("version_id", sa.String(length=36), nullable=False),
            sa.Column("org_id", sa.String(length=36), nullable=True),
            sa.Column("principal_type", sa.String(length=24), nullable=False,
                      server_default="user"),
            sa.Column("principal_id", sa.String(length=64), nullable=False),
            sa.Column("created_by", sa.String(length=64), nullable=False,
                      server_default=""),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.func.now()),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("version_id", "principal_type", "principal_id",
                                name="uq_plugin_audience_version_principal"),
        )
        op.create_index("ix_plugin_audience_plugin", "automation_plugin_audience", ["plugin_id"])
        op.create_index("ix_plugin_audience_version", "automation_plugin_audience", ["version_id"])
        op.create_index("ix_plugin_audience_org", "automation_plugin_audience", ["org_id"])
        op.create_index("ix_plugin_audience_principal", "automation_plugin_audience", ["principal_id"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if "automation_plugin_audience" in set(inspector.get_table_names()):
        op.drop_table("automation_plugin_audience")
    columns = {item["name"] for item in inspector.get_columns("automation_plugin_version")}
    if "visibility" in columns:
        if bind.dialect.name == "sqlite":
            with op.batch_alter_table("automation_plugin_version", schema=None) as batch_op:
                batch_op.drop_column("visibility")
        else:
            op.drop_column("automation_plugin_version", "visibility")
