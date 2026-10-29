"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "0032_work_item_participants"
down_revision: Union[str, Sequence[str], None] = "0031_gate_decision_snapshot"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {item["name"] for item in inspect(bind).get_columns("work_item")}
    additions = []
    if "requester_user_id" not in columns:
        additions.append(sa.Column("requester_user_id", sa.String(length=36), nullable=True))
    if "assignee_user_id" not in columns:
        additions.append(sa.Column("assignee_user_id", sa.String(length=36), nullable=True))
    if "assignee_name" not in columns:
        additions.append(sa.Column(
            "assignee_name", sa.String(length=64), nullable=False,
            server_default=sa.text("''")))
    if "automation_schedule_id" not in columns:
        additions.append(sa.Column("automation_schedule_id", sa.String(length=36), nullable=True))
    if additions:
        with op.batch_alter_table("work_item", schema=None) as batch:
            for column in additions:
                batch.add_column(column)

    # Preserve the creator-as-default-requester business fact for legacy tasks.
    op.execute(sa.text(
        "UPDATE work_item SET requester_user_id = created_by_user_id "
        "WHERE requester_user_id IS NULL AND created_by_user_id IS NOT NULL"))
    op.execute(sa.text(
        "UPDATE work_item SET requester_name = created_by_name "
        "WHERE (requester_name IS NULL OR requester_name = '') "
        "AND created_by_name IS NOT NULL"))

    indexes = {item["name"] for item in inspect(bind).get_indexes("work_item")}
    for name, column in (
        ("ix_work_item_requester_user_id", "requester_user_id"),
        ("ix_work_item_assignee_user_id", "assignee_user_id"),
        ("ix_work_item_automation_schedule_id", "automation_schedule_id"),
    ):
        if name not in indexes:
            op.create_index(name, "work_item", [column], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    indexes = {item["name"] for item in inspect(bind).get_indexes("work_item")}
    columns = {item["name"] for item in inspect(bind).get_columns("work_item")}
    with op.batch_alter_table("work_item", schema=None) as batch:
        for name in ("ix_work_item_automation_schedule_id",
                     "ix_work_item_assignee_user_id", "ix_work_item_requester_user_id"):
            if name in indexes:
                batch.drop_index(name)
        for column in ("automation_schedule_id", "assignee_name",
                       "assignee_user_id", "requester_user_id"):
            if column in columns:
                batch.drop_column(column)
