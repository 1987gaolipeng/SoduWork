"""Store account-owned cross-device conversation projections."""
from alembic import op
import sqlalchemy as sa


revision = "0072_account_conversations"
down_revision = "0071_schedule_source_app"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "account_conversation_cursor",
        sa.Column("owner_user_id", sa.String(36), primary_key=True),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_table(
        "account_conversation",
        sa.Column("id", sa.String(180), primary_key=True),
        sa.Column("owner_user_id", sa.String(36), nullable=False),
        sa.Column("source_client_id", sa.String(64), nullable=False),
        sa.Column("source_session_id", sa.String(180), nullable=False),
        sa.Column("source_device_name", sa.String(120), nullable=False, server_default=""),
        sa.Column("source_epoch", sa.String(180), nullable=False, server_default=""),
        sa.Column("source_revision", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("source_digest", sa.String(64), nullable=False, server_default=""),
        sa.Column("title", sa.String(200), nullable=False, server_default=""),
        sa.Column("state", sa.String(24), nullable=False, server_default="idle"),
        sa.Column("archived", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("deleted", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("owner_user_id", "source_client_id", "source_session_id",
                            name="uq_account_conversation_source"),
    )
    op.create_index("ix_account_conversation_owner_revision", "account_conversation",
                    ["owner_user_id", "revision", "id"])
    op.create_index("ix_account_conversation_owner_updated", "account_conversation",
                    ["owner_user_id", "updated_at"])
    op.create_index("ix_account_conversation_owner_user_id", "account_conversation", ["owner_user_id"])
    op.create_index("ix_account_conversation_source_client_id", "account_conversation", ["source_client_id"])
    op.create_table(
        "account_conversation_message",
        sa.Column("id", sa.String(240), primary_key=True),
        sa.Column("conversation_id", sa.String(180), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("role", sa.String(16), nullable=False),
        sa.Column("text", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("done", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("deleted", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="0"),
        sa.ForeignKeyConstraint(["conversation_id"], ["account_conversation.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_account_conversation_message_conversation_id", "account_conversation_message",
                    ["conversation_id"])
    op.create_index("ix_account_conversation_message_conversation_revision", "account_conversation_message",
                    ["conversation_id", "revision"])
    op.create_index("ix_account_conversation_message_conversation_position", "account_conversation_message",
                    ["conversation_id", "position"])


def downgrade() -> None:
    op.drop_index("ix_account_conversation_message_conversation_position", table_name="account_conversation_message")
    op.drop_index("ix_account_conversation_message_conversation_revision", table_name="account_conversation_message")
    op.drop_index("ix_account_conversation_message_conversation_id", table_name="account_conversation_message")
    op.drop_table("account_conversation_message")
    op.drop_index("ix_account_conversation_source_client_id", table_name="account_conversation")
    op.drop_index("ix_account_conversation_owner_user_id", table_name="account_conversation")
    op.drop_index("ix_account_conversation_owner_updated", table_name="account_conversation")
    op.drop_index("ix_account_conversation_owner_revision", table_name="account_conversation")
    op.drop_table("account_conversation")
    op.drop_table("account_conversation_cursor")
