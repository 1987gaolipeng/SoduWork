"""Persist optional app/character attribution on schedules; old rows stay empty."""
from alembic import op
import sqlalchemy as sa
revision = "0071_schedule_source_app"
down_revision = "0070_merge_notes_schedule"
branch_labels = None
depends_on = None

def upgrade():
    op.add_column("ai_schedule", sa.Column("source_app", sa.JSON(), nullable=False, server_default="{}"))

def downgrade():
    op.drop_column("ai_schedule", "source_app")
