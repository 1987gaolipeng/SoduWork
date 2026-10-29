"""Create the independent personal material library tables."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0047_library"
down_revision: Union[str, Sequence[str], None] = "0046_merge_mem_pub_heads"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "library_folder",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("owner_key", sa.String(length=128), nullable=False),
        sa.Column("parent_id", sa.String(length=36), nullable=True),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("owner_key", "parent_id", "name", name="uq_library_folder_owner_parent_name"),
    )
    op.create_index("ix_library_folder_owner_key", "library_folder", ["owner_key"])
    op.create_index("ix_library_folder_parent_id", "library_folder", ["parent_id"])
    op.create_index("ix_library_folder_owner_parent", "library_folder", ["owner_key", "parent_id"])

    op.create_table(
        "library_item",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("owner_key", sa.String(length=128), nullable=False),
        sa.Column("folder_id", sa.String(length=36), nullable=True),
        sa.Column("kind", sa.String(length=24), nullable=False, server_default="document"),
        sa.Column("title", sa.String(length=240), nullable=False, server_default="未命名资料"),
        sa.Column("filename", sa.String(length=260), nullable=False, server_default=""),
        sa.Column("content_type", sa.String(length=160), nullable=False, server_default="application/octet-stream"),
        sa.Column("size", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("storage_key", sa.String(length=600), nullable=False, server_default=""),
        sa.Column("backend", sa.String(length=16), nullable=False, server_default="local"),
        sa.Column("favorite", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("extra", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_opened_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_library_item_owner_key", "library_item", ["owner_key"])
    op.create_index("ix_library_item_folder_id", "library_item", ["folder_id"])
    op.create_index("ix_library_item_favorite", "library_item", ["favorite"])
    op.create_index("ix_library_item_owner_updated", "library_item", ["owner_key", "updated_at"])
    op.create_index("ix_library_item_owner_folder", "library_item", ["owner_key", "folder_id"])
    op.create_index("ix_library_item_owner_kind", "library_item", ["owner_key", "kind"])


def downgrade() -> None:
    op.drop_index("ix_library_item_owner_kind", table_name="library_item")
    op.drop_index("ix_library_item_owner_folder", table_name="library_item")
    op.drop_index("ix_library_item_owner_updated", table_name="library_item")
    op.drop_index("ix_library_item_favorite", table_name="library_item")
    op.drop_index("ix_library_item_folder_id", table_name="library_item")
    op.drop_index("ix_library_item_owner_key", table_name="library_item")
    op.drop_table("library_item")
    op.drop_index("ix_library_folder_owner_parent", table_name="library_folder")
    op.drop_index("ix_library_folder_parent_id", table_name="library_folder")
    op.drop_index("ix_library_folder_owner_key", table_name="library_folder")
    op.drop_table("library_folder")
