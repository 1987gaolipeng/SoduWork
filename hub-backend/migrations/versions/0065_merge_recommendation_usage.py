"""Merge recommendation placement and deployed usage attribution histories."""

revision = "0065_merge_recommendation_usage"
down_revision = ("0064_usage_attribution", "0063_plugin_recommendation")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
