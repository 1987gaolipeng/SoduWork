"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0036_project_context"
down_revision: Union[str, Sequence[str], None] = "0035_plugin_identity"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "project_context_snapshot",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("org_id", sa.String(36), nullable=False),
        sa.Column("project_id", sa.String(36), nullable=False),
        sa.Column("repo_id", sa.String(36), nullable=False),
        sa.Column("branch", sa.String(180), nullable=False),
        sa.Column("baseline_commit", sa.String(64), nullable=False),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("state", sa.String(20), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("sources", sa.JSON(), nullable=False),
        sa.Column("conventions", sa.JSON(), nullable=False),
        sa.Column("commands", sa.JSON(), nullable=False),
        sa.Column("error", sa.String(500), nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("fingerprint", name="uq_project_context_fingerprint"),
    )
    op.create_index(
        "ix_project_context_scope", "project_context_snapshot",
        ["org_id", "project_id", "repo_id"])
    for column in (
            "org_id", "project_id", "repo_id", "branch",
            "baseline_commit", "fingerprint", "state"):
        op.create_index(
            "ix_project_context_snapshot_" + column,
            "project_context_snapshot", [column])

    op.create_table(
        "task_context_envelope",
        sa.Column("task_id", sa.String(36), primary_key=True),
        sa.Column("snapshot_id", sa.String(36), nullable=False),
        sa.Column("project_id", sa.String(36), nullable=False),
        sa.Column("repo_id", sa.String(36), nullable=False),
        sa.Column("execution_ref", sa.String(180), nullable=False),
        sa.Column("branch", sa.String(180), nullable=False),
        sa.Column("baseline_commit", sa.String(64), nullable=False),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("state", sa.String(20), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    for column in (
            "snapshot_id", "project_id", "repo_id",
            "execution_ref", "fingerprint", "state"):
        op.create_index(
            "ix_task_context_envelope_" + column,
            "task_context_envelope", [column])

    op.create_table(
        "project_memory_capsule",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("org_id", sa.String(36), nullable=False),
        sa.Column("project_id", sa.String(36), nullable=False),
        sa.Column("repo_id", sa.String(36), nullable=False),
        sa.Column("task_id", sa.String(36), nullable=False),
        sa.Column("execution_ref", sa.String(180), nullable=False),
        sa.Column("branch", sa.String(180), nullable=False),
        sa.Column("commit_sha", sa.String(64), nullable=False),
        sa.Column("title", sa.String(240), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("decisions", sa.JSON(), nullable=False),
        sa.Column("files", sa.JSON(), nullable=False),
        sa.Column("checks", sa.JSON(), nullable=False),
        sa.Column("risks", sa.JSON(), nullable=False),
        sa.Column("evidence", sa.JSON(), nullable=False),
        sa.Column("state", sa.String(20), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reviewed_by", sa.String(36), nullable=False),
        sa.UniqueConstraint(
            "task_id", "execution_ref",
            name="uq_project_memory_task_execution"),
    )
    op.create_index(
        "ix_project_memory_scope_state", "project_memory_capsule",
        ["project_id", "repo_id", "state"])
    for column in (
            "org_id", "project_id", "repo_id", "task_id",
            "execution_ref", "commit_sha", "state"):
        op.create_index(
            "ix_project_memory_capsule_" + column,
            "project_memory_capsule", [column])


def downgrade() -> None:
    op.drop_table("project_memory_capsule")
    op.drop_table("task_context_envelope")
    op.drop_table("project_context_snapshot")
