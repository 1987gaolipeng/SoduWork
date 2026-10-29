"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0010_schedule_creator"
down_revision: Union[str, Sequence[str], None] = "0009_runner_capabilities"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("ai_schedule", schema=None) as batch_op:
        batch_op.add_column(sa.Column(
            "created_by", sa.String(length=36), nullable=True))

    op.get_bind().execute(sa.text(
        "UPDATE ai_schedule "
        "SET created_by = (SELECT client.user_ref FROM client "
        "WHERE client.id = ai_schedule.owner_client_id) "
        "WHERE created_by IS NULL OR created_by = ''"
    ))


def downgrade() -> None:
    with op.batch_alter_table("ai_schedule", schema=None) as batch_op:
        batch_op.drop_column("created_by")
