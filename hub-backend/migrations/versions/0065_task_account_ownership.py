"""Freeze task execution ownership across account switches on one device."""
import uuid

from alembic import op
import sqlalchemy as sa

revision = "0065_task_account_ownership"
down_revision = "0064_repository_issues"
branch_labels = None
depends_on = None


def migrate_data(connection):
    """Use persisted account evidence, never the device's current login."""
    inspector = sa.inspect(connection)
    meta = sa.MetaData()
    tasks = sa.Table("task", meta, autoload_with=connection)
    handoffs = {}
    if inspector.has_table("conversation_handoff"):
        table = sa.Table("conversation_handoff", meta, autoload_with=connection)
        handoffs = {(row.task_id, row.owner_client_id): row.owner_user_id for row in
                    connection.execute(sa.select(table.c.task_id, table.c.owner_client_id, table.c.owner_user_id))}
    accounts = set(connection.execute(sa.text("SELECT id FROM app_user")).scalars())
    owners = {}
    access = sa.Table("task_requirement_access", meta, autoload_with=connection)
    for row in connection.execute(sa.select(tasks)).mappings():
        owner = row.get("owner_user_id")
        if row.get("owner_client_id") and not owner:
            # Handoffs explicitly bind the execution device and account. Older
            # tasks use their responsible account before their original author.
            candidates = (handoffs.get((row["id"], row["owner_client_id"])),
                          row.get("assignee_user_id"), row.get("created_by"),
                          row.get("requester_user_id"))
            owner = next((value for value in candidates if value), None)
            if owner:
                connection.execute(tasks.update().where(tasks.c.id == row["id"]).values(owner_user_id=owner))
        owners[row["id"]] = (row.get("owner_client_id"), owner)
        # Historical device ACL rows are retained for audit. Restore the
        # corresponding human grant only when the immutable source proves it.
        for source in row.get("legacy_requirements") or []:
            uid = source.get("created_by_user_id")
            sid = source.get("id")
            if not uid or not sid:
                continue
            existing = connection.scalar(sa.select(access.c.id).where(
                access.c.task_id == row["id"], access.c.source_id == sid,
                access.c.principal_kind == "user", access.c.principal_id == uid,
                access.c.role == "creator"))
            if not existing:
                aid = str(uuid.uuid5(uuid.NAMESPACE_URL, ":".join(("soduwork:requirement-access", row["id"],
                    sid, "user", uid, "creator"))))
                connection.execute(access.insert().values(id=aid, task_id=row["id"], source_id=sid,
                    principal_kind="user", principal_id=uid, role="creator"))
    if not inspector.has_table("attachment"):
        return
    attachments = sa.Table("attachment", meta, autoload_with=connection)
    for row in connection.execute(sa.select(attachments)).mappings():
        evidence = dict(row.get("evidence_meta") or {})
        if evidence.get("ownerUserId"):
            continue
        uploaded = row.get("uploaded_by")
        device, owner = owners.get(row.get("task_id"), (None, None))
        uid = uploaded if uploaded in accounts else owner if device and uploaded == device else None
        if uid:
            evidence["ownerUserId"] = uid
            connection.execute(attachments.update().where(attachments.c.id == row["id"]).values(evidence_meta=evidence))


def upgrade():
    op.add_column("task", sa.Column("owner_user_id", sa.String(36), nullable=True))
    op.create_index("ix_task_owner_user_id", "task", ["owner_user_id"])
    migrate_data(op.get_bind())


def downgrade():
    op.drop_index("ix_task_owner_user_id", table_name="task")
    op.drop_column("task", "owner_user_id")
