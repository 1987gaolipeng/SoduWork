"""Unify requirements on Task without duplicating existing deliveries.

Every original row is preserved verbatim (including timestamps) in the Task's
immutable legacy_requirements JSON. Original files and attachment IDs stay put.
Downgrade after users have edited unified tasks is intentionally refused: restore
the pre-upgrade database backup with the matching application version instead.
"""
from collections import defaultdict
from datetime import datetime, timezone
import uuid

from alembic import op
import sqlalchemy as sa

revision = "0053_unified_requirements"
down_revision = "0052_org_memory_singleton"
branch_labels = None
depends_on = None

COLUMNS = (
    sa.Column("kind", sa.String(24), nullable=False, server_default="requirement"),
    sa.Column("acceptance_criteria", sa.JSON(), nullable=False, server_default="[]"),
    sa.Column("triage_stage", sa.String(24), nullable=False, server_default="ready"),
    sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
    sa.Column("shared_org_id", sa.String(36), nullable=True),
    sa.Column("automation_schedule_id", sa.String(36), nullable=True),
    sa.Column("requirement_version", sa.Integer(), nullable=False, server_default="1"),
    sa.Column("requirement_content", sa.JSON(), nullable=False, server_default="{}"),
    sa.Column("legacy_requirements", sa.JSON(), nullable=False, server_default="[]"),
)


def _json(row):
    return {key: value.isoformat() if isinstance(value, datetime) else value for key, value in dict(row).items()}


def _new_task(table, row, tid, clients):
    now = row.get("created_at") or datetime.now(timezone.utc)
    values = {}
    # Legacy Task tables have many mandatory columns without server defaults.
    # Fill their type-appropriate neutral values, never rely on today's ORM.
    for col in table.columns:
        if col.nullable or col.server_default is not None:
            continue
        if isinstance(col.type, sa.JSON):
            values[col.name] = {} if col.name in {"work_routing", "requirement_content"} else []
        elif isinstance(col.type, sa.Boolean):
            values[col.name] = False
        elif isinstance(col.type, sa.Integer):
            values[col.name] = 0
        elif isinstance(col.type, sa.DateTime):
            values[col.name] = now
        else:
            values[col.name] = ""
    status = {"delivering": "todo", "delivered": "done", "closed": "cancel"}.get(row["status"], "todo")
    if row["status"] == "closed" and row.get("delivered_at"):
        status = "done"
    values.update(id=tid, owner_client_id=row.get("created_by_client_id") if row.get("created_by_client_id") in clients else None,
                  title=row["title"], note=row.get("description") or "", status=status, origin="local", handler="me",
                  source=row.get("source") or "", created_by=row.get("created_by_user_id"),
                  created_by_name=row.get("created_by_name") or "", assignee_user_id=row.get("assignee_user_id"),
                  requester_user_id=row.get("requester_user_id"), requester_name=row.get("requester_name") or "",
                  requester_contact=row.get("requester_contact") or "", project_id=row.get("project_id"),
                  repo_id=row.get("repo_id") or "", priority=row.get("priority") or "normal", tags=row.get("tags") or [],
                  created_at=now, updated_at=row.get("updated_at") or now,
                  actual_end_at=row.get("delivered_at"), actual_start_at=row.get("delivered_at"))
    return {key: value for key, value in values.items() if key in table.c}


def migrate_data(connection):
    inspector = sa.inspect(connection)
    if not inspector.has_table("work_item"):
        return
    if connection.dialect.name == "postgresql":
        connection.execute(sa.text("LOCK TABLE work_item, task IN SHARE ROW EXCLUSIVE MODE"))
    meta = sa.MetaData()
    old = sa.Table("work_item", meta, autoload_with=connection)
    task = sa.Table("task", meta, autoload_with=connection)
    access = sa.Table("task_requirement_access", meta, autoload_with=connection)
    rows = [dict(row) for row in connection.execute(sa.select(old)).mappings()]
    existing = {row["id"]: dict(row) for row in connection.execute(sa.select(task)).mappings()}
    clients = set(connection.execute(sa.text("SELECT id FROM client")).scalars())
    grouped = defaultdict(list)
    mapping = {}
    for row in rows:
        target = row.get("delivery_task_id")
        if target not in existing:
            target = row["id"]
            if target in existing:
                # Idempotent retry uses provenance, unrelated collisions get a stable ID.
                if not any(item.get("id") == row["id"] for item in existing[target].get("legacy_requirements") or []):
                    target = str(uuid.uuid5(uuid.NAMESPACE_URL, "soduwork:requirement:" + row["id"]))
            if target not in existing:
                values = _new_task(task, row, target, clients)
                connection.execute(task.insert().values(**values))
                existing[target] = values
        mapping[row["id"]] = target
        grouped[target].append(row)
        for principal_kind, principal_id, role in (
            ("client", row.get("created_by_client_id"), "creator"),
            ("user", row.get("created_by_user_id"), "creator"),
            ("user", row.get("requester_user_id"), "requester"),
            ("user", row.get("assignee_user_id"), "assignee"),
        ):
            if not principal_id:
                continue
            aid = str(uuid.uuid5(uuid.NAMESPACE_URL, ":".join(("soduwork:requirement-access", target,
                row["id"], principal_kind, principal_id, role))))
            if not connection.scalar(sa.select(access.c.id).where(access.c.id == aid)):
                connection.execute(access.insert().values(id=aid, task_id=target, source_id=row["id"],
                    principal_kind=principal_kind, principal_id=principal_id, role=role))
    for target, items in grouped.items():
        if len({item.get("org_id") for item in items}) != 1:
            raise RuntimeError("Merged requirements have different visibility scopes; resolve before upgrading: " + target)
        current = existing[target]
        snapshots = {row["id"]: row for row in current.get("legacy_requirements") or []}
        snapshots.update({row["id"]: _json(row) for row in items})
        ordered = sorted(items, key=lambda item: (str(item.get("created_at") or ""), item["id"]))
        primary = ordered[0]
        criteria = list(dict.fromkeys(value for item in ordered for value in item.get("acceptance_criteria") or []))
        notes = "\n\n".join(item["title"] + "\n" + (item.get("description") or "") for item in ordered)
        values = dict(
            kind=primary.get("kind") or "requirement", acceptance_criteria=criteria,
            triage_stage=primary["status"] if primary["status"] in {"intake", "clarifying", "ready"} else "ready",
            shared_org_id=primary.get("org_id"), automation_schedule_id=primary.get("automation_schedule_id"),
            requirement_version=max(int(item.get("version") or 1) for item in items),
            archived_at=(primary.get("updated_at") or primary.get("created_at")) if all(item["status"] == "closed" for item in items) else None,
            requirement_content={"title": primary["title"] if len(items) == 1 else " / ".join(item["title"] for item in ordered),
                                 "note": notes}, legacy_requirements=list(snapshots.values()))
        connection.execute(task.update().where(task.c.id == target).values(**values))
    if inspector.has_table("attachment"):
        attachments = sa.Table("attachment", meta, autoload_with=connection)
        for attachment in connection.execute(sa.select(attachments)).mappings():
            ref = str(attachment.get("source_ref") or "")
            if not ref.startswith("work-item:"):
                continue
            source = ref.split(":", 1)[1]
            if source not in mapping:
                # Refuse to orphan an existing file when retiring its old ACL.
                raise RuntimeError("Requirement attachment has no source row: " + attachment["id"])
            evidence = dict(attachment.get("evidence_meta") or {})
            evidence.update(kind="requirement_input", migratedRequirementId=source,
                            legacySourceRef=ref, legacyTaskId=attachment.get("task_id"))
            connection.execute(attachments.update().where(attachments.c.id == attachment["id"]).values(
                task_id=mapping[source], source_ref="requirement:" + source, evidence_meta=evidence))
    old.drop(connection)


def upgrade():
    connection = op.get_bind()
    if not sa.inspect(connection).has_table("task_requirement_access"):
        op.create_table("task_requirement_access",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("task_id", sa.String(36), nullable=False),
            sa.Column("source_id", sa.String(36), nullable=False),
            sa.Column("principal_kind", sa.String(12), nullable=False),
            sa.Column("principal_id", sa.String(64), nullable=False),
            sa.Column("role", sa.String(16), nullable=False))
        op.create_index("ix_task_requirement_access_task_id", "task_requirement_access", ["task_id"])
        op.create_index("ix_requirement_access_principal", "task_requirement_access", ["principal_kind", "principal_id"])
    existing = {col["name"] for col in sa.inspect(connection).get_columns("task")}
    for column in COLUMNS:
        if column.name not in existing:
            op.add_column("task", column)
    indexes = {index["name"] for index in sa.inspect(connection).get_indexes("task")}
    if "ix_task_shared_org_id" not in indexes:
        op.create_index("ix_task_shared_org_id", "task", ["shared_org_id"])
    migrate_data(connection)


def downgrade():
    raise RuntimeError("Unified requirements contain user data. Restore the verified pre-upgrade database backup and matching application; automatic destructive downgrade is disabled.")


def adopt(connection):
    """Run the identical migration during one-time pre-Alembic adoption."""
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    with Operations.context(MigrationContext.configure(connection)):
        upgrade()
