"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "0033_plugin_install_setup"
down_revision: Union[str, Sequence[str], None] = "a4bc7a24e3aa"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "automation_plugin_installation"


def upgrade() -> None:
    bind = op.get_bind()
    columns = {
        item["name"] for item in inspect(bind).get_columns(TABLE)}
    if "config" not in columns:
        op.add_column(TABLE, sa.Column(
            "config", sa.JSON(), nullable=False, server_default=sa.text("'{}'")))
    if "setup_state" not in columns:
        op.add_column(TABLE, sa.Column(
            "setup_state", sa.String(length=24), nullable=False,
            server_default="ready"))
    if "verified_at" not in columns:
        op.add_column(TABLE, sa.Column(
            "verified_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    columns = {
        item["name"] for item in inspect(bind).get_columns(TABLE)}
    for name in ("verified_at", "setup_state", "config"):
        if name in columns:
            op.drop_column(TABLE, name)
