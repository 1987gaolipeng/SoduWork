"""Track the selected storage backend for library folders."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0049_library_storage_backend"
down_revision: Union[str, Sequence[str], None] = "0048_library_trash"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "library_folder",
        sa.Column("backend", sa.String(length=16), nullable=False, server_default="local"),
    )
    # Library items created before backend selection was exposed used MinIO.
    # Keep their folders visible in the MinIO tab after adding the marker.
    op.execute(
        "UPDATE library_folder SET backend='minio' "
        "WHERE id IN (SELECT DISTINCT folder_id FROM library_item "
        "WHERE folder_id IS NOT NULL AND backend='minio')"
    )
    op.create_index("ix_library_folder_backend", "library_folder", ["backend"])


def downgrade() -> None:
    op.drop_index("ix_library_folder_backend", table_name="library_folder")
    op.drop_column("library_folder", "backend")
