"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "0031_gate_decision_snapshot"
down_revision: Union[str, Sequence[str], None] = "0030_work_item_pool"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {
        item["name"] for item in inspect(bind).get_columns(
            "automation_approval_decision")
    }
    if "gate_snapshot" not in columns:
        with op.batch_alter_table(
                "automation_approval_decision", schema=None) as batch:
            batch.add_column(sa.Column(
                "gate_snapshot", sa.JSON(), nullable=False,
                server_default=sa.text("'{}'")))


def downgrade() -> None:
    bind = op.get_bind()
    columns = {
        item["name"] for item in inspect(bind).get_columns(
            "automation_approval_decision")
    }
    if "gate_snapshot" in columns:
        with op.batch_alter_table(
                "automation_approval_decision", schema=None) as batch:
            batch.drop_column("gate_snapshot")
