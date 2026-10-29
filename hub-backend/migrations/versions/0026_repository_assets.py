"""Repository catalog, immutable task code targets and cross-instance leases.

Revision ID: 0026_repository_assets
Revises: 0025_schedule_timezone
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "0026_repository_assets"
down_revision: Union[str, Sequence[str], None] = "0025_schedule_timezone"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _tables() -> set[str]:
    return set(inspect(op.get_bind()).get_table_names())


def upgrade() -> None:
    tables = _tables()
    if "automation_scm_repository" not in tables:
        op.create_table(
            "automation_scm_repository",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("integration_id", sa.String(36), nullable=False),
            sa.Column("org_id", sa.String(36), nullable=True),
            sa.Column("provider", sa.String(24), nullable=False),
            sa.Column("external_id", sa.String(200), nullable=False),
            sa.Column("full_name", sa.String(400), nullable=False),
            sa.Column("display_name", sa.String(200), nullable=False, server_default=""),
            sa.Column("clone_url", sa.String(700), nullable=False, server_default=""),
            sa.Column("ssh_url", sa.String(700), nullable=False, server_default=""),
            sa.Column("web_url", sa.String(700), nullable=False, server_default=""),
            sa.Column("default_branch", sa.String(160), nullable=False, server_default="main"),
            sa.Column("visibility", sa.String(24), nullable=False, server_default=""),
            sa.Column("archived", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("fingerprint", sa.String(64), nullable=False, server_default=""),
            sa.Column("metadata_json", sa.JSON(), nullable=False),
            sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.func.now()),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.func.now()),
            sa.UniqueConstraint("integration_id", "external_id",
                                name="uq_scm_repository_integration_external"),
        )
        op.create_index("ix_automation_scm_repository_integration_id",
                        "automation_scm_repository", ["integration_id"])
        op.create_index("ix_scm_repository_provider_name",
                        "automation_scm_repository", ["provider", "full_name"])
        op.create_index("ix_automation_scm_repository_active",
                        "automation_scm_repository", ["active"])
        for name, columns in (
            ("ix_automation_scm_repository_archived", ["archived"]),
            ("ix_automation_scm_repository_fingerprint", ["fingerprint"]),
            ("ix_automation_scm_repository_full_name", ["full_name"]),
            ("ix_automation_scm_repository_org_id", ["org_id"]),
            ("ix_automation_scm_repository_provider", ["provider"]),
        ):
            op.create_index(name, "automation_scm_repository", columns)

    if "automation_task_code_target" not in tables:
        op.create_table(
            "automation_task_code_target",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("task_id", sa.String(36), nullable=False),
            sa.Column("project_id", sa.String(36), nullable=False, server_default=""),
            sa.Column("repo_id", sa.String(36), nullable=False),
            sa.Column("source_repository_id", sa.String(36), nullable=False, server_default=""),
            sa.Column("repo_name", sa.String(200), nullable=False, server_default=""),
            sa.Column("scm", sa.String(24), nullable=False, server_default="git"),
            sa.Column("git_url", sa.String(700), nullable=False, server_default=""),
            sa.Column("base_branch", sa.String(160), nullable=False, server_default="main"),
            sa.Column("target_branch", sa.String(160), nullable=False, server_default="main"),
            sa.Column("local_dir", sa.String(240), nullable=False, server_default=""),
            sa.Column("config_snapshot", sa.JSON(), nullable=False),
            sa.Column("fingerprint", sa.String(64), nullable=False),
            sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.func.now()),
            sa.UniqueConstraint("task_id", name="uq_task_code_target_task"),
        )
        op.create_index("ix_automation_task_code_target_repo_id",
                        "automation_task_code_target", ["repo_id"])
        op.create_index("ix_automation_task_code_target_source_repository_id",
                        "automation_task_code_target", ["source_repository_id"])
        op.create_index("ix_automation_task_code_target_fingerprint",
                        "automation_task_code_target", ["fingerprint"])
        op.create_index("ix_automation_task_code_target_project_id",
                        "automation_task_code_target", ["project_id"])
        op.create_index("ix_automation_task_code_target_task_id",
                        "automation_task_code_target", ["task_id"])

    if "automation_resource_lease" not in tables:
        op.create_table(
            "automation_resource_lease",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("resource_kind", sa.String(40), nullable=False),
            sa.Column("resource_key", sa.String(300), nullable=False),
            sa.Column("owner_id", sa.String(120), nullable=False, server_default=""),
            sa.Column("token", sa.String(64), nullable=False, server_default=""),
            sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
            sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("acquired_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("released_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("detail", sa.JSON(), nullable=False),
            sa.UniqueConstraint("resource_kind", "resource_key",
                                name="uq_resource_lease_kind_key"),
        )
        op.create_index("ix_resource_lease_until",
                        "automation_resource_lease", ["lease_until"])
        op.create_index("ix_automation_resource_lease_resource_kind",
                        "automation_resource_lease", ["resource_kind"])
        op.create_index("ix_automation_resource_lease_resource_key",
                        "automation_resource_lease", ["resource_key"])

    inspector = inspect(op.get_bind())
    if "integration" in inspector.get_table_names():
        integration_columns = {
            item["name"] for item in inspector.get_columns("integration")}
        additions = [
            ("repository_sync_at", sa.Column(
                "repository_sync_at", sa.DateTime(timezone=True), nullable=True)),
            ("repository_sync_ok", sa.Column(
                "repository_sync_ok", sa.Boolean(), nullable=True)),
            ("repository_sync_error", sa.Column(
                "repository_sync_error", sa.String(512), nullable=True)),
            ("repository_sync_count", sa.Column(
                "repository_sync_count", sa.Integer(), nullable=False,
                server_default="0")),
        ]
        missing = [column for name, column in additions
                   if name not in integration_columns]
        if missing:
            with op.batch_alter_table("integration", schema=None) as batch:
                for column in missing:
                    batch.add_column(column)

    if "repo" in inspector.get_table_names():
        repo_columns = {item["name"] for item in inspector.get_columns("repo")}
        if "source_repository_id" not in repo_columns:
            with op.batch_alter_table("repo", schema=None) as batch:
                batch.add_column(sa.Column(
                    "source_repository_id", sa.String(36),
                    nullable=False, server_default=""))
                batch.create_index("ix_repo_source_repository_id",
                                   ["source_repository_id"])


def downgrade() -> None:
    tables = _tables()
    if "integration" in tables:
        columns = {item["name"] for item in inspect(
            op.get_bind()).get_columns("integration")}
        removable = [
            name for name in ("repository_sync_at", "repository_sync_ok",
                              "repository_sync_error", "repository_sync_count")
            if name in columns]
        if removable:
            with op.batch_alter_table("integration", schema=None) as batch:
                for name in removable:
                    batch.drop_column(name)
    if "repo" in tables:
        columns = {item["name"] for item in inspect(op.get_bind()).get_columns("repo")}
        if "source_repository_id" in columns:
            with op.batch_alter_table("repo", schema=None) as batch:
                batch.drop_column("source_repository_id")
    for table in ("automation_resource_lease", "automation_task_code_target",
                  "automation_scm_repository"):
        if table in _tables():
            op.drop_table(table)