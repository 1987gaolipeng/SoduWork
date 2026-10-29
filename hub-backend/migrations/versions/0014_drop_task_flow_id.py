"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
from sqlalchemy import inspect


revision: str = "0014_drop_task_flow_id"
down_revision: Union[str, Sequence[str], None] = "0013_client_full_updates"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {item["name"] for item in inspect(bind).get_columns("task")}
    if "flow_id" not in columns:
        return
    if bind.dialect.name == "sqlite":
        with op.batch_alter_table("task", schema=None) as batch_op:
            batch_op.drop_column("flow_id")
    else:
        op.drop_column("task", "flow_id")


def downgrade() -> None:
    # flow_id belonged to the retired FlowTemplate engine. Reintroducing a required
    # column would make every current task insert fail, including at revision 0013.
    pass
