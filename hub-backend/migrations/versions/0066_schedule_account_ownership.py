"""Freeze automation execution ownership across device account switches."""
from collections import defaultdict

from alembic import op
import sqlalchemy as sa

revision = "0066_schedule_account_ownership"
down_revision = "0065_task_account_ownership"
branch_labels = None
depends_on = None


def migrate_data(connection):
    """Use recorded execution accounts or creators, never current device login."""
    meta = sa.MetaData()
    schedules = sa.Table("ai_schedule", meta, autoload_with=connection)
    runs = sa.Table("ai_schedule_run", meta, autoload_with=connection)
    tasks = sa.Table("task", meta, autoload_with=connection)
    users = sa.Table("app_user", meta, autoload_with=connection)
    accounts = set(connection.execute(sa.select(users.c.id)).scalars())
    task_owners = {row.id: (row.owner_client_id, row.owner_user_id) for row in connection.execute(
        sa.select(tasks.c.id, tasks.c.owner_client_id, tasks.c.owner_user_id))}
    parents = {row["id"]: row for row in connection.execute(sa.select(schedules)).mappings()}
    evidence = defaultdict(set)
    for row in connection.execute(sa.select(runs)).mappings():
        device, uid = task_owners.get(row["task_id"], (None, None))
        proven = uid if device == row["owner_client_id"] and uid in accounts else None
        parent = parents.get(row["schedule_id"])
        if proven and parent and parent["owner_client_id"] == row["owner_client_id"]:
            evidence[parent["id"]].add(proven)
        owner = proven or (parent["created_by"] if parent and parent["owner_client_id"] == row["owner_client_id"]
                           and parent["created_by"] in accounts else None)
        if owner and not row["owner_user_id"]:
            connection.execute(runs.update().where(runs.c.id == row["id"]).values(owner_user_id=owner))
    for row in parents.values():
        if row["owner_user_id"] or not row["owner_client_id"]:
            continue
        owners = evidence[row["id"]]
        # Conflicting historical execution accounts cannot establish which
        # account owns the current plan. Keep it closed for manual review.
        owner = next(iter(owners)) if len(owners) == 1 else (
            row["created_by"] if not owners and row["created_by"] in accounts else None)
        if owner:
            connection.execute(schedules.update().where(schedules.c.id == row["id"]).values(owner_user_id=owner))


def upgrade():
    for table in ("ai_schedule", "ai_schedule_run"):
        op.add_column(table, sa.Column("owner_user_id", sa.String(36), nullable=True))
        op.create_index("ix_" + table + "_owner_user_id", table, ["owner_user_id"])
    migrate_data(op.get_bind())


def downgrade():
    for table in ("ai_schedule_run", "ai_schedule"):
        op.drop_index("ix_" + table + "_owner_user_id", table_name=table)
        op.drop_column(table, "owner_user_id")
