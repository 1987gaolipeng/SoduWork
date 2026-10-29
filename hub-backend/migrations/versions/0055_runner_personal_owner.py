"""Allow one personal cloud Runner environment per user.

Legacy operations/shared RunnerNode rows keep a NULL owner and remain intact.
"""
from alembic import op
import sqlalchemy as sa


revision = "0055_runner_personal_owner"
down_revision = "0054_conversation_handoffs"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("automation_runner_node",
                  sa.Column("owner_user_id", sa.String(length=36), nullable=True))
    op.create_index("ix_automation_runner_node_owner_user_id",
                    "automation_runner_node", ["owner_user_id"], unique=False)
    # A unique index allows multiple NULL values on PostgreSQL/SQLite while
    # enforcing one non-NULL personal environment per user.
    op.create_index("uq_automation_runner_node_owner_user",
                    "automation_runner_node", ["owner_user_id"], unique=True)


def downgrade():
    op.drop_index("uq_automation_runner_node_owner_user", table_name="automation_runner_node")
    op.drop_index("ix_automation_runner_node_owner_user_id", table_name="automation_runner_node")
    op.drop_column("automation_runner_node", "owner_user_id")
