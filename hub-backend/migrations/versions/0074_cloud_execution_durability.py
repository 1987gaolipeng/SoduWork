"""Persist authorized cloud submissions and committed Runner delivery cursors."""
from alembic import op
import sqlalchemy as sa


revision = "0074_cloud_execution_durability"
down_revision = "0073_remote_screen_grants"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # NULL is deliberate: upgrading a prepared draft must never authorize it.
    op.add_column("conversation_handoff", sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("conversation_handoff", sa.Column("retry_after", sa.DateTime(timezone=True), nullable=True))
    op.add_column("conversation_handoff", sa.Column("recovery_attempts", sa.Integer(), nullable=False, server_default="0"))
    op.create_index("ix_conversation_handoff_retry_after", "conversation_handoff", ["retry_after"])
    op.create_index("ix_handoff_owner_id", "conversation_handoff", ["owner_user_id", "id"])
    op.add_column("conversation_message_receipt", sa.Column("payload", sa.JSON(), nullable=True))
    op.add_column("conversation_message_receipt", sa.Column("retry_after", sa.DateTime(timezone=True), nullable=True))
    op.add_column("conversation_message_receipt", sa.Column("recovery_attempts", sa.Integer(), nullable=False, server_default="0"))
    op.create_index("ix_conversation_message_receipt_retry_after", "conversation_message_receipt", ["retry_after"])
    for column in (
        sa.Column("delivery_stream_id", sa.String(64), nullable=False, server_default=""),
        sa.Column("delivery_seq", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("delivery_digest", sa.String(64), nullable=False, server_default=""),
        sa.Column("persisted_seq", sa.Integer(), nullable=False, server_default="0"),
    ):
        op.add_column("automation_execution_session", column)


def downgrade() -> None:
    # Operational rollback keeps the expanded schema and compatible workers.
    # This explicit downgrade is only for an operator after draining new work.
    for name in ("persisted_seq", "delivery_digest", "delivery_seq", "delivery_stream_id"):
        op.drop_column("automation_execution_session", name)
    op.drop_index("ix_conversation_message_receipt_retry_after", table_name="conversation_message_receipt")
    for name in ("recovery_attempts", "retry_after", "payload"):
        op.drop_column("conversation_message_receipt", name)
    op.drop_index("ix_handoff_owner_id", table_name="conversation_handoff")
    op.drop_index("ix_conversation_handoff_retry_after", table_name="conversation_handoff")
    for name in ("recovery_attempts", "retry_after", "submitted_at"):
        op.drop_column("conversation_handoff", name)
