"""Add lifecycle, scope metadata and provenance for imported session memory."""
from alembic import op
import sqlalchemy as sa

revision = "0040_session_memory_phase2"
down_revision = "0039_session_memory"
branch_labels = None
depends_on = None

def upgrade() -> None:
    op.add_column("session_memory", sa.Column("scope", sa.String(length=16), nullable=False, server_default="private"))
    op.add_column("session_memory", sa.Column("archived", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    op.add_column("session_memory", sa.Column("source_meta", sa.JSON(), nullable=False, server_default=sa.text("'{}'")))
    op.add_column("session_memory", sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index("ix_session_memory_owner_scope_archived", "session_memory", ["owner_user_id", "scope", "archived"])

def downgrade() -> None:
    op.drop_index("ix_session_memory_owner_scope_archived", table_name="session_memory")
    op.drop_column("session_memory", "last_used_at")
    op.drop_column("session_memory", "source_meta")
    op.drop_column("session_memory", "archived")
    op.drop_column("session_memory", "scope")

