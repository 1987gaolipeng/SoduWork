"""Durable admission fences for same-account native PC conversation turns."""
from alembic import op
import sqlalchemy as sa

revision = "0074_personal_conversation_relay"
down_revision = "0073_remote_screen_grants"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("personal_conversation_relay",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_user_id", sa.String(64), nullable=False),
        sa.Column("requester_client_id", sa.String(64), nullable=False),
        sa.Column("source_client_id", sa.String(64), nullable=False),
        sa.Column("conversation_id", sa.String(180), nullable=False),
        sa.Column("active_conversation_id", sa.String(180), unique=True),
        sa.Column("request_id", sa.String(80), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("source_epoch", sa.String(180), nullable=False),
        sa.Column("source_revision", sa.Integer(), nullable=False),
        sa.Column("instruction", sa.Text(), nullable=False),
        sa.Column("phase", sa.String(16), nullable=False),
        sa.Column("reason", sa.String(500), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("requester_client_id", "request_id"))
    op.create_index("ix_personal_conversation_relay_owner_user_id", "personal_conversation_relay", ["owner_user_id"])
    op.create_index("ix_personal_conversation_relay_source_client_id", "personal_conversation_relay", ["source_client_id"])


def downgrade():
    op.drop_table("personal_conversation_relay")
