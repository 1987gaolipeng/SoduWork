"""Keep upstream context windows separate from administrator overrides."""
from alembic import op
import sqlalchemy as sa

revision = "0097_model_advertised_window"
down_revision = "0096_usage_chat_source"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("model_def", sa.Column("advertised_ctx_window", sa.Integer(), nullable=True))


def downgrade():
    op.drop_column("model_def", "advertised_ctx_window")
