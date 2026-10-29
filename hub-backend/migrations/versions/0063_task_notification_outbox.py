"""Persist single-task notification work in the task transaction."""
from alembic import op
import sqlalchemy as sa

revision = "0063_task_notification_outbox"
down_revision = "0062_plugin_recommendation_cover"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("task_notification_outbox",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("task_id", sa.String(36), nullable=False),
        sa.Column("event_type", sa.String(32), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("available_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("lease_token", sa.String(36), nullable=True),
        sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False))
    op.create_index("ix_task_notification_due", "task_notification_outbox",
                    ["available_at", "lease_until"])
    op.create_index("ix_task_notification_order", "task_notification_outbox",
                    ["task_id", "created_at", "id"])


def downgrade():
    op.drop_index("ix_task_notification_order", table_name="task_notification_outbox")
    op.drop_index("ix_task_notification_due", table_name="task_notification_outbox")
    op.drop_table("task_notification_outbox")
