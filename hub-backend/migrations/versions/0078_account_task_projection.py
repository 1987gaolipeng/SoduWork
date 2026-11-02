"""Preserve dedicated task-view identities across device synchronization."""
from alembic import op
import sqlalchemy as sa

revision = "0078_account_task_projection"
down_revision = "0077_conversation_projects"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("account_conversation", sa.Column(
        "task_projection_id", sa.String(120), nullable=False, server_default=""))


def downgrade():
    op.drop_column("account_conversation", "task_projection_id")
