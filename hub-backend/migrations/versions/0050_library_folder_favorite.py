"""Allow users to favorite library folders independently from their contents."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0050_library_folder_favorite"
down_revision: Union[str, Sequence[str], None] = "0049_library_storage_backend"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "library_folder",
        sa.Column("favorite", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_index("ix_library_folder_favorite", "library_folder", ["favorite"])


def downgrade() -> None:
    op.drop_index("ix_library_folder_favorite", table_name="library_folder")
    op.drop_column("library_folder", "favorite")
