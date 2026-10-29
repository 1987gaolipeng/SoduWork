"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0009_runner_capabilities"
down_revision: Union[str, Sequence[str], None] = "0008_work_catalog"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("automation_runner_node", schema=None) as batch_op:
        batch_op.add_column(sa.Column(
            "capabilities", sa.JSON(), nullable=False,
            server_default=sa.text("'{}'")))


def downgrade() -> None:
    with op.batch_alter_table("automation_runner_node", schema=None) as batch_op:
        batch_op.drop_column("capabilities")
