"""Index immutable usage anchors used by calendar analytics."""
from alembic import op


revision = "0041_usage_calendar_stability"
down_revision = "0040_session_memory_phase2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_ai_usage_user_created", "ai_usage_event",
        ["billing_user_id", "created_at"],
    )
    op.create_index(
        "ix_ai_usage_org_created", "ai_usage_event",
        ["org_id", "created_at"],
    )
    op.create_index("ix_ai_usage_created_at", "ai_usage_event", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_ai_usage_created_at", table_name="ai_usage_event")
    op.drop_index("ix_ai_usage_org_created", table_name="ai_usage_event")
    op.drop_index("ix_ai_usage_user_created", table_name="ai_usage_event")
