"""Private imported session memory, explicit confirmation and source evidence."""
from alembic import op
import sqlalchemy as sa

revision = "0039_session_memory"
down_revision = "0038_multimedia_models"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "session_memory",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_user_id", sa.String(36), nullable=False),
        sa.Column("org_id", sa.String(36), nullable=False),
        sa.Column("project_id", sa.String(36), nullable=False),
        sa.Column("repo_id", sa.String(36), nullable=False),
        sa.Column("task_id", sa.String(36), nullable=False),
        sa.Column("source", sa.String(24), nullable=False),
        sa.Column("source_session_id", sa.String(160), nullable=False),
        sa.Column("source_hash", sa.String(64), nullable=False),
        sa.Column("title", sa.String(240), nullable=False),
        sa.Column("fields", sa.JSON(), nullable=False),
        sa.Column("events", sa.JSON(), nullable=False),
        sa.Column("warnings", sa.JSON(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("owner_user_id", "source", "source_hash", name="uq_session_memory_import"),
    )
    op.create_index("ix_session_memory_owner_updated", "session_memory", ["owner_user_id", "updated_at"])


def downgrade():
    op.drop_index("ix_session_memory_owner_updated", table_name="session_memory")
    op.drop_table("session_memory")
