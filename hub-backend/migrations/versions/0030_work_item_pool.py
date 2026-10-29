"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "0030_work_item_pool"
down_revision: Union[str, Sequence[str], None] = "0029_scheduler_idempotency"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_INDEXES = (
    ("ix_work_item_org_status", ("org_id", "status")),
    ("ix_work_item_creator_status", ("created_by_user_id", "status")),
    ("ix_work_item_org_id", ("org_id",)),
    ("ix_work_item_created_by_user_id", ("created_by_user_id",)),
    ("ix_work_item_created_by_client_id", ("created_by_client_id",)),
    ("ix_work_item_kind", ("kind",)),
    ("ix_work_item_status", ("status",)),
    ("ix_work_item_project_id", ("project_id",)),
    ("ix_work_item_delivery_task_id", ("delivery_task_id",)),
)


def upgrade() -> None:
    bind = op.get_bind()
    tables = set(inspect(bind).get_table_names())
    if "work_item" not in tables:
        op.create_table(
            "work_item",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("org_id", sa.String(length=36), nullable=True),
            sa.Column("created_by_user_id", sa.String(length=36), nullable=True),
            sa.Column("created_by_client_id", sa.String(length=64), nullable=False),
            sa.Column("created_by_name", sa.String(length=64), nullable=False),
            sa.Column("title", sa.String(length=200), nullable=False),
            sa.Column("kind", sa.String(length=24), nullable=False),
            sa.Column("description", sa.Text(), nullable=False),
            sa.Column("acceptance_criteria", sa.JSON(), nullable=False),
            sa.Column("status", sa.String(length=24), nullable=False),
            sa.Column("priority", sa.String(length=16), nullable=False),
            sa.Column("source", sa.String(length=120), nullable=False),
            sa.Column("requester_name", sa.String(length=64), nullable=False),
            sa.Column("requester_contact", sa.String(length=200), nullable=False),
            sa.Column("project_id", sa.String(length=36), nullable=True),
            sa.Column("repo_id", sa.String(length=36), nullable=False),
            sa.Column("tags", sa.JSON(), nullable=False),
            sa.Column("delivery_task_id", sa.String(length=36), nullable=True),
            sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("version", sa.Integer(), nullable=False),
            sa.Column(
                "created_at", sa.DateTime(timezone=True), nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.Column(
                "updated_at", sa.DateTime(timezone=True), nullable=False,
                server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.PrimaryKeyConstraint("id"),
        )

    existing = {item["name"] for item in inspect(bind).get_indexes("work_item")}
    for name, columns in _INDEXES:
        if name not in existing:
            op.create_index(name, "work_item", list(columns), unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    if "work_item" in set(inspect(bind).get_table_names()):
        op.drop_table("work_item")
