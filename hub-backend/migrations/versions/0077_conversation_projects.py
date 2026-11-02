"""Synchronize account conversation organization."""
from alembic import op
import sqlalchemy as sa
revision = "0077_conversation_projects"
down_revision = "0076_merge_model_runtime"
branch_labels = None
depends_on = None

def upgrade():
    op.create_table("account_conversation_project",
        sa.Column("owner_user_id", sa.String(64), primary_key=True),
        sa.Column("id", sa.String(120), primary_key=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("deleted", sa.Boolean(), nullable=False),
        sa.Column("members", sa.Text(), nullable=False))

def downgrade():
    op.drop_table("account_conversation_project")
