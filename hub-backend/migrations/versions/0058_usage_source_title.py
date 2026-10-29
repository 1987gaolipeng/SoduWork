"""Store conversation titles on chat usage events so recent AI work can identify untasked
conversations. Prefer client-renamed or generated titles; historical records retain the
source-label fallback.
"""
from alembic import op
import sqlalchemy as sa

revision = "0058_usage_source_title"
down_revision = "0057_release_multi_artifact"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "ai_usage_event",
        sa.Column("source_title", sa.String(length=200), nullable=False,
                  server_default="",),
    )


def downgrade() -> None:
    op.drop_column("ai_usage_event", "source_title")
