"""Merge the independent memory and publisher-scope migrations.

Revision ID: 0046_merge_mem_pub_heads
Revises: 0045_memory_records, 0045_plugin_publisher_org_scope

Both feature migrations were authored independently from the same 0044 base.
Keeping them as separate parents preserves upgrade compatibility for databases
that already applied either one; this no-op revision restores a single head.
"""
from typing import Sequence, Union


revision: str = "0046_merge_mem_pub_heads"
down_revision: Union[str, Sequence[str], None] = (
    "0045_memory_records",
    "0045_plugin_publisher_org_scope",
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
