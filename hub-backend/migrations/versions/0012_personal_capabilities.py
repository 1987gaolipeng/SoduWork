"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0012_personal_capabilities"
down_revision: Union[str, Sequence[str], None] = "0011_node_run_idempotency"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("client", schema=None) as batch_op:
        batch_op.add_column(sa.Column(
            "mcp_servers", sa.JSON(), nullable=False, server_default=sa.text("'[]'")))
        batch_op.add_column(sa.Column(
            "mcp_enabled", sa.JSON(), nullable=False, server_default=sa.text("'[]'")))
    # This literal is accepted by SQLite TEXT-backed JSON and PostgreSQL JSON.
    op.execute(sa.text("UPDATE client SET mcp_servers = '[]' WHERE mcp_servers IS NULL"))


def downgrade() -> None:
    with op.batch_alter_table("client", schema=None) as batch_op:
        batch_op.drop_column("mcp_enabled")
        batch_op.drop_column("mcp_servers")
