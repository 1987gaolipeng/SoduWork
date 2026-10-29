"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "0016_plugin_evaluation"
down_revision: Union[str, Sequence[str], None] = "0015_plugin_audience"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if "automation_plugin_evaluation_run" in set(inspect(bind).get_table_names()):
        return
    op.create_table(
        "automation_plugin_evaluation_run",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("plugin_id", sa.String(length=36), nullable=False),
        sa.Column("version_id", sa.String(length=36), nullable=False),
        sa.Column("case_key", sa.String(length=64), nullable=False),
        sa.Column("active_key", sa.String(length=140), nullable=True),
        sa.Column("org_id", sa.String(length=36), nullable=True),
        sa.Column("state", sa.String(length=24), nullable=False, server_default="queued"),
        sa.Column("verdict", sa.String(length=24), nullable=False, server_default="pending"),
        sa.Column("external_ref", sa.String(length=180), nullable=False, server_default=""),
        sa.Column("agent_kind", sa.String(length=100), nullable=False, server_default=""),
        sa.Column("model", sa.String(length=160), nullable=False, server_default=""),
        sa.Column("case_snapshot", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("executor", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("result", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("error", sa.String(length=1200), nullable=False, server_default=""),
        sa.Column("created_by", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("reviewed_by", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("review_note", sa.String(length=1200), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_plugin_evaluation_plugin", "automation_plugin_evaluation_run",
                    ["plugin_id"])
    op.create_index("ix_plugin_evaluation_version", "automation_plugin_evaluation_run",
                    ["version_id"])
    op.create_index("ix_plugin_evaluation_case", "automation_plugin_evaluation_run",
                    ["case_key"])
    op.create_index("ix_plugin_evaluation_org", "automation_plugin_evaluation_run",
                    ["org_id"])
    op.create_index("ix_plugin_evaluation_state", "automation_plugin_evaluation_run",
                    ["state"])
    op.create_index("ix_plugin_evaluation_verdict", "automation_plugin_evaluation_run",
                    ["verdict"])
    op.create_index("ix_plugin_evaluation_ref", "automation_plugin_evaluation_run",
                    ["external_ref"])
    op.create_index("ix_plugin_evaluation_latest", "automation_plugin_evaluation_run",
                    ["version_id", "case_key", "created_at", "id"])
    op.create_index("uq_plugin_evaluation_active", "automation_plugin_evaluation_run",
                    ["active_key"], unique=True)


def downgrade() -> None:
    bind = op.get_bind()
    if "automation_plugin_evaluation_run" in set(inspect(bind).get_table_names()):
        op.drop_table("automation_plugin_evaluation_run")
