"""Merge the plugin recommendation surface and usage attribution branches without rewriting either side."""

revision = "0065_merge_usage_notifications"
# Preserve the local revision identity after the upstream branch reconciliation.
down_revision = "0065_merge_recommendation_usage"
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
