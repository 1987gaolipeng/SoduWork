"""Add the per-column indexes declared by the MateMessage ORM model."""
from alembic import op


revision = "0044_mate_message_indexes"
down_revision = "0043_mate_messages"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index("ix_mate_message_sender_id", "mate_message", ["sender_id"])
    op.create_index("ix_mate_message_recipient_id", "mate_message", ["recipient_id"])
    op.create_index("ix_mate_message_status", "mate_message", ["status"])
    op.create_index("ix_mate_message_created_at", "mate_message", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_mate_message_created_at", table_name="mate_message")
    op.drop_index("ix_mate_message_status", table_name="mate_message")
    op.drop_index("ix_mate_message_recipient_id", table_name="mate_message")
    op.drop_index("ix_mate_message_sender_id", table_name="mate_message")
