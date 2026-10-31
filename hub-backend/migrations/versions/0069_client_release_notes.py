"""Localized release notes independent of signed installer records."""
from alembic import op
import sqlalchemy as sa

revision = "0069_client_release_notes"
down_revision = "0068_merge_notification_account"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("client_release_note",
        sa.Column("version", sa.String(32), primary_key=True),
        sa.Column("channel", sa.String(16), primary_key=True),
        sa.Column("locales", sa.JSON(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()))


def downgrade():
    op.drop_table("client_release_note")
