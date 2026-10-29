"""Persist @ teammate notifications and read receipts."""
from alembic import op
import sqlalchemy as sa

revision = "0043_mate_messages"
down_revision = "0042_usage_daily_deltas"
branch_labels = None
depends_on = None

def upgrade() -> None:
    op.create_table(
        "mate_message",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("sender_id", sa.String(36), nullable=False),
        sa.Column("recipient_id", sa.String(36), nullable=False),
        sa.Column("client_message_id", sa.String(64), nullable=False, server_default=""),
        sa.Column("conversation_id", sa.String(180), nullable=False, server_default=""),
        sa.Column("text", sa.Text(), nullable=False, server_default=""),
        sa.Column("status", sa.String(16), nullable=False, server_default="accepted"),
        sa.Column("attachments", sa.JSON(), nullable=False, server_default=sa.text("'[]'")),
        sa.Column("website", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("sender_id", "recipient_id", "client_message_id", name="uq_mate_message_client_id"),
    )
    op.create_index("ix_mate_message_sender", "mate_message", ["sender_id", "created_at"])
    op.create_index("ix_mate_message_recipient", "mate_message", ["recipient_id", "created_at"])

def downgrade() -> None:
    op.drop_index("ix_mate_message_recipient", table_name="mate_message")
    op.drop_index("ix_mate_message_sender", table_name="mate_message")
    op.drop_table("mate_message")
