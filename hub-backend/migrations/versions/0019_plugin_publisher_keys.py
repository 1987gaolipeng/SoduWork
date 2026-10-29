"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "0019_plugin_publisher_keys"
down_revision: Union[str, Sequence[str], None] = "0018_plugin_provenance"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


TABLE = "automation_plugin_publisher_key"


def upgrade() -> None:
    bind = op.get_bind()
    if TABLE in inspect(bind).get_table_names():
        return
    op.create_table(
        TABLE,
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("org_id", sa.String(length=36), nullable=True),
        sa.Column("key_id", sa.String(length=64), nullable=False),
        sa.Column("publisher_name", sa.String(length=120), nullable=False),
        sa.Column("description", sa.String(length=400), nullable=False, server_default=""),
        sa.Column("public_key", sa.String(length=64), nullable=False),
        sa.Column("fingerprint", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="active"),
        sa.Column("created_by", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("key_id", name="uq_plugin_publisher_key_id"),
    )
    op.create_index("ix_plugin_publisher_key_org_id", TABLE, ["org_id"], unique=False)
    op.create_index("ix_plugin_publisher_key_key_id", TABLE, ["key_id"], unique=True)
    op.create_index("ix_plugin_publisher_key_fingerprint", TABLE, ["fingerprint"], unique=False)
    op.create_index("ix_plugin_publisher_key_status", TABLE, ["status"], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    if TABLE in inspect(bind).get_table_names():
        op.drop_table(TABLE)
