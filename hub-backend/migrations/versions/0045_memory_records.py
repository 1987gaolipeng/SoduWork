"""Add scoped summary memory records.

Revision ID: 0045_memory_records
Revises: 0044_mate_message_indexes
"""
from alembic import op
import sqlalchemy as sa

revision = "0045_memory_records"
down_revision = "0044_mate_message_indexes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "memory_record",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("scope", sa.String(16), nullable=False),
        sa.Column("owner_user_id", sa.String(36), nullable=False, server_default=""),
        sa.Column("org_id", sa.String(36), nullable=False, server_default=""),
        sa.Column("memory_key", sa.String(240), nullable=False),
        sa.Column("workspace_key", sa.String(240), nullable=False, server_default=""),
        sa.Column("project_key", sa.String(240), nullable=False, server_default=""),
        sa.Column("session_key", sa.String(240), nullable=False, server_default=""),
        sa.Column("title", sa.String(240), nullable=False, server_default=""),
        sa.Column("summary", sa.Text(), nullable=False, server_default=""),
        sa.Column("fields", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("source_meta", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("archived", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint(
            "scope", "owner_user_id", "org_id", "memory_key",
            name="uq_memory_record_scope_owner_org_key",
        ),
    )
    op.create_index("ix_memory_record_scope", "memory_record", ["scope"])
    op.create_index("ix_memory_record_owner_scope_updated", "memory_record", ["owner_user_id", "scope", "updated_at"])
    op.create_index("ix_memory_record_org_scope_updated", "memory_record", ["org_id", "scope", "updated_at"])
    op.create_index("ix_memory_record_workspace", "memory_record", ["owner_user_id", "workspace_key", "updated_at"])
    op.create_index("ix_memory_record_project", "memory_record", ["owner_user_id", "project_key", "updated_at"])


def downgrade() -> None:
    op.drop_index("ix_memory_record_project", table_name="memory_record")
    op.drop_index("ix_memory_record_workspace", table_name="memory_record")
    op.drop_index("ix_memory_record_org_scope_updated", table_name="memory_record")
    op.drop_index("ix_memory_record_owner_scope_updated", table_name="memory_record")
    op.drop_index("ix_memory_record_scope", table_name="memory_record")
    op.drop_table("memory_record")
