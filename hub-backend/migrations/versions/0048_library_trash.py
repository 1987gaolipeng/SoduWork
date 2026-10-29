"""Add reversible recycle-bin state to personal library items."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0048_library_trash"
down_revision: Union[str, Sequence[str], None] = "0047_library"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("library_item", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index("ix_library_item_deleted_at", "library_item", ["deleted_at"])
    op.create_index("ix_library_item_owner_deleted", "library_item", ["owner_key", "deleted_at"])


def downgrade() -> None:
    op.drop_index("ix_library_item_owner_deleted", table_name="library_item")
    op.drop_index("ix_library_item_deleted_at", table_name="library_item")
    op.drop_column("library_item", "deleted_at")
