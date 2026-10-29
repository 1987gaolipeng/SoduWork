"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "0021_plugin_catalog_policy"
down_revision: Union[str, Sequence[str], None] = "0020_plugin_installations"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


TABLE = "automation_plugin_catalog_policy"


def upgrade() -> None:
    bind = op.get_bind()
    if TABLE in inspect(bind).get_table_names():
        return
    op.create_table(
        TABLE,
        sa.Column("plugin_id", sa.String(length=36), nullable=False),
        sa.Column("category", sa.String(length=32), nullable=False,
                  server_default="general"),
        sa.Column("installation", sa.String(length=32), nullable=False,
                  server_default="available"),
        sa.Column("authentication", sa.String(length=24), nullable=False,
                  server_default="on_use"),
        sa.Column("featured", sa.Boolean(), nullable=False,
                  server_default=sa.false()),
        sa.Column("sort", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("updated_by", sa.String(length=64), nullable=False,
                  server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.PrimaryKeyConstraint("plugin_id"),
    )
    op.create_index("ix_plugin_catalog_policy_category", TABLE,
                    ["category"], unique=False)
    op.create_index("ix_plugin_catalog_policy_installation", TABLE,
                    ["installation"], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    if TABLE in inspect(bind).get_table_names():
        op.drop_table(TABLE)
