"""Bridge the upstream recommendation identity without replaying its table DDL."""

revision = "0063_plugin_recommendation"
down_revision = "0063_plugin_recommendations"
branch_labels = None
depends_on = None


def upgrade():
    # The published public revision already created this table.
    pass


def downgrade():
    pass
