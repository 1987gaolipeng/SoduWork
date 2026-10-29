"""Repository issue subscriptions, membership grants and first-start outbox."""
from alembic import op
import sqlalchemy as sa

revision = "0064_repository_issues"
down_revision = "0063_email_accounts"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("repository_issue_sync",
        sa.Column("catalog_id", sa.String(36), sa.ForeignKey("automation_scm_repository.id"), primary_key=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("enabled_at", sa.DateTime(timezone=True)),
        sa.Column("started_label", sa.String(120), nullable=False, server_default="处理中"),
        sa.Column("created_by", sa.String(36)),
        sa.Column("cursor_at", sa.DateTime(timezone=True)),
        sa.Column("next_poll_at", sa.DateTime(timezone=True)),
        sa.Column("last_polled_at", sa.DateTime(timezone=True)),
        sa.Column("last_success_at", sa.DateTime(timezone=True)),
        sa.Column("last_error", sa.String(512), nullable=False, server_default=""),
        sa.Column("imported_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_created_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("skipped_confidential", sa.Integer(), nullable=False, server_default="0"))
    op.create_index("ix_repository_issue_sync_next_poll_at", "repository_issue_sync", ["next_poll_at"])
    op.create_table("repository_issue_member",
        sa.Column("catalog_id", sa.String(36), sa.ForeignKey("automation_scm_repository.id"), primary_key=True),
        sa.Column("external_user_id", sa.String(80), primary_key=True),
        sa.Column("username", sa.String(200), nullable=False, server_default=""),
        sa.Column("display_name", sa.String(200), nullable=False, server_default=""),
        sa.Column("user_id", sa.String(36)),
        sa.Column("mapping_source", sa.String(24), nullable=False, server_default=""),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("synced_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()))
    op.create_index("ix_repository_issue_member_user_id", "repository_issue_member", ["user_id"])
    op.create_table("repository_issue_link",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("catalog_id", sa.String(36), sa.ForeignKey("automation_scm_repository.id"), nullable=False),
        sa.Column("issue_id", sa.String(80), nullable=False),
        sa.Column("issue_iid", sa.Integer(), nullable=False),
        sa.Column("task_id", sa.String(36), sa.ForeignKey("task.id", ondelete="SET NULL")),
        sa.Column("issue_url", sa.String(700), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("writeback_state", sa.String(16), nullable=False, server_default="waiting"),
        sa.Column("writeback_label", sa.String(120), nullable=False, server_default=""),
        sa.Column("writeback_attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("next_retry_at", sa.DateTime(timezone=True)),
        sa.Column("last_error", sa.String(512), nullable=False, server_default=""),
        sa.Column("sent_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("catalog_id", "issue_iid", name="uq_repository_issue_identity"),
        sa.UniqueConstraint("task_id", name="uq_repository_issue_task"))
    op.create_index("ix_repository_issue_link_catalog_id", "repository_issue_link", ["catalog_id"])
    op.create_index("ix_repository_issue_link_task_id", "repository_issue_link", ["task_id"])
    op.create_index("ix_repository_issue_writeback", "repository_issue_link", ["writeback_state", "next_retry_at"])


def downgrade():
    op.drop_table("repository_issue_link")
    op.drop_table("repository_issue_member")
    op.drop_table("repository_issue_sync")
