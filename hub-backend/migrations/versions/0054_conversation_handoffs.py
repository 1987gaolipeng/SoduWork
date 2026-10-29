"""Persist workspace handoff fences and follow-up delivery receipts."""
from alembic import op
import sqlalchemy as sa

revision = "0054_conversation_handoffs"
down_revision = "0053_unified_requirements"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("conversation_handoff",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_client_id", sa.String(64), nullable=False),
        sa.Column("owner_user_id", sa.String(36), nullable=False),
        sa.Column("transfer_id", sa.String(80), nullable=False),
        sa.Column("task_id", sa.String(36), nullable=False, unique=True),
        sa.Column("phase", sa.String(16), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("storage_key", sa.String(400), nullable=False),
        sa.Column("backend", sa.String(16), nullable=False),
        sa.Column("options", sa.JSON(), nullable=False),
        sa.Column("source", sa.JSON(), nullable=False),
        sa.Column("receipt", sa.JSON(), nullable=False),
        sa.Column("error", sa.Text(), nullable=False),
        sa.Column("commit_started_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("owner_client_id", "transfer_id"))
    op.create_index("ix_conversation_handoff_owner_client_id", "conversation_handoff", ["owner_client_id"])
    op.create_table("conversation_message_receipt",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("task_id", sa.String(36), nullable=False),
        sa.Column("owner_client_id", sa.String(64), nullable=False),
        sa.Column("message_id", sa.String(80), nullable=False),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("phase", sa.String(16), nullable=False),
        sa.Column("receipt", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False))
    op.create_index("ix_conversation_message_receipt_task_id", "conversation_message_receipt", ["task_id"])


def downgrade():
    # Transfer fences must outlive retries from old desktop instances.
    raise RuntimeError("Restore the matching pre-upgrade database backup to downgrade handoffs safely")

