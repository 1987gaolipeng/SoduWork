"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a4bc7a24e3aa'
down_revision: Union[str, Sequence[str], None] = ('0032_runner_capacity', '0032_work_item_participants')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
