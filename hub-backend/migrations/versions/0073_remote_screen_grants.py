"""Persist short-lived read-only screen authorization grants."""
from alembic import op
import sqlalchemy as sa


revision = "0073_remote_screen_grants"
down_revision = "0072_account_conversations"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "remote_screen_grant",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("owner_user_id", sa.String(36), nullable=False),
        sa.Column("viewer_client_id", sa.String(64), nullable=False),
        sa.Column("source_client_id", sa.String(64), nullable=False),
        sa.Column("state", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("permission", sa.String(16), nullable=False, server_default="view"),
        sa.Column("can_control", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("activated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("stopped_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ticket_hash", sa.String(64), nullable=False, server_default=""),
    )
    for name, columns in (
        ("ix_remote_screen_grant_viewer_state", ["viewer_client_id", "state"]),
        ("ix_remote_screen_grant_source_state", ["source_client_id", "state"]),
        ("ix_remote_screen_grant_expires", ["expires_at"]),
        ("ix_remote_screen_grant_owner_user_id", ["owner_user_id"]),
        ("ix_remote_screen_grant_viewer_client_id", ["viewer_client_id"]),
        ("ix_remote_screen_grant_source_client_id", ["source_client_id"]),
        ("ix_remote_screen_grant_state", ["state"]),
    ):
        op.create_index(name, "remote_screen_grant", columns)


def downgrade() -> None:
    for name in (
        "ix_remote_screen_grant_state", "ix_remote_screen_grant_source_client_id",
        "ix_remote_screen_grant_viewer_client_id", "ix_remote_screen_grant_owner_user_id",
        "ix_remote_screen_grant_expires", "ix_remote_screen_grant_source_state",
        "ix_remote_screen_grant_viewer_state",
    ):
        op.drop_index(name, table_name="remote_screen_grant")
    op.drop_table("remote_screen_grant")
