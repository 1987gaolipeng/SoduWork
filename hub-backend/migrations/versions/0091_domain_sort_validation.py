"""Repair legacy SQLite domain ranks without discarding their original values."""
from datetime import datetime, timezone
from uuid import uuid4

from alembic import op
import sqlalchemy as sa


revision = "0091_domain_sort_validation"
down_revision = "0090_requirement_creator"
branch_labels = None
depends_on = None

MIN_SORT = -(2 ** 31)
MAX_SORT = 2 ** 31 - 1


def _original(value, storage_type):
    """Use JSON-safe, lossless representations, including nonfinite REALs."""
    if storage_type == "blob":
        encoding, value = "hex", bytes(value).hex()
    elif storage_type == "real":
        encoding, value = "float.hex", value.hex()
    elif storage_type == "integer":
        encoding, value = "decimal", str(value)
    else:
        encoding = "text" if storage_type == "text" else "null"
    return {"storageType": storage_type, "encoding": encoding, "value": value}


def repair_domain_sorts(connection):
    """Repair only invalid SQLite ranks in the caller's migration transaction.

    PostgreSQL already enforces the Integer column's type and range. SQLite's
    historical raw PATCH accepted TEXT, REAL and out-of-range INTEGER values.
    Keep all valid ranks unchanged; append repaired rows in their old order.
    If the upper bound is occupied, ties at that bound are preferable to
    changing valid ranks or preventing the application from upgrading.
    """
    if connection.dialect.name != "sqlite" or not sa.inspect(connection).has_table("domain"):
        return 0
    invalid = "typeof(sort) != 'integer' OR sort < :minimum OR sort > :maximum"
    bounds = {"minimum": MIN_SORT, "maximum": MAX_SORT}
    rows = connection.execute(sa.text(
        "SELECT id, name, sort, typeof(sort) AS storage_type FROM domain "
        f"WHERE {invalid} ORDER BY sort, created_at, id"
    ), bounds).mappings().all()
    if not rows:
        return 0
    # Fail before changing anything if the original values cannot be retained.
    if not sa.inspect(connection).has_table("audit_log"):
        raise RuntimeError("Cannot repair domain sort values without the audit_log table")
    highest = connection.scalar(sa.text(
        "SELECT MAX(sort) FROM domain WHERE typeof(sort) = 'integer' "
        "AND sort BETWEEN :minimum AND :maximum"
    ), bounds)
    rank = max(0, highest if highest is not None else 0)
    audit = sa.table("audit_log", sa.column("id", sa.String),
        sa.column("actor_id", sa.String), sa.column("actor_name", sa.String),
        sa.column("actor_org_id", sa.String), sa.column("action", sa.String),
        sa.column("target_type", sa.String), sa.column("target_id", sa.String),
        sa.column("target_label", sa.String), sa.column("detail", sa.JSON),
        sa.column("at", sa.DateTime(timezone=True)))
    for row in rows:
        capped = rank == MAX_SORT
        rank = min(MAX_SORT, rank + 1)
        connection.execute(audit.insert().values(
            id=str(uuid4()), actor_id=None, actor_name="schema migration", actor_org_id=None,
            action="domain.sort_repair", target_type="domain", target_id=row["id"],
            target_label=(row["name"] or "")[:200], at=datetime.now(timezone.utc),
            detail={"revision": revision, "original": _original(row["sort"], row["storage_type"]),
                    "replacement": rank, "strategy": "upper_bound_tie" if capped else "append"},
        ))
        updated = connection.execute(sa.text(
            "UPDATE domain SET sort = :replacement WHERE id = :id "
            "AND typeof(sort) = :storage_type AND sort IS :original"
        ), {"replacement": rank, "id": row["id"], "storage_type": row["storage_type"],
            "original": row["sort"]})
        if updated.rowcount != 1:
            raise RuntimeError("Domain sort changed during migration; retry with writers stopped")
    return len(rows)


def upgrade():
    repair_domain_sorts(op.get_bind())


def downgrade():
    # Keep valid ranks and their audit history. Reintroducing corrupt values
    # would break clients; an operator can inspect the preserved originals.
    pass
