"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "0045_plugin_publisher_org_scope"
down_revision: Union[str, Sequence[str], None] = "0044_mate_message_indexes"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


TABLE = "automation_plugin_publisher_key"
PLATFORM_INDEX = "uq_plugin_publisher_platform_key"
ORGANIZATION_INDEX = "uq_plugin_publisher_org_key"
LEGACY_INDEX = "ix_plugin_publisher_key_key_id"
LEGACY_CONSTRAINT = "uq_plugin_publisher_key_id"


def _duplicates(bind, columns: tuple[str, ...], predicate=None) -> list[tuple]:
    table = sa.Table(TABLE, sa.MetaData(), autoload_with=bind)
    values = [table.c[name] for name in columns]
    count = sa.func.count()
    statement = sa.select(*values, count.label("duplicates"))
    if predicate is not None:
        statement = statement.where(predicate(table))
    statement = statement.group_by(*values).having(count > 1).limit(5)
    return [tuple(row) for row in bind.execute(statement).all()]


def _assert_clean(bind) -> None:
    checks = (
        ("platform publisher key", _duplicates(
            bind, ("key_id",), lambda table: table.c.org_id.is_(None))),
        ("organization publisher key", _duplicates(
            bind, ("org_id", "key_id"), lambda table: table.c.org_id.is_not(None))),
    )
    dirty = [(label, rows) for label, rows in checks if rows]
    if dirty:
        detail = "; ".join(f"{label}: {rows}" for label, rows in dirty)
        raise RuntimeError(
            "Publisher identity migration stopped because duplicate records exist. "
            "Resolve them explicitly before retrying: " + detail)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if TABLE not in inspector.get_table_names():
        return
    _assert_clean(bind)
    indexes = {item["name"] for item in inspector.get_indexes(TABLE)}
    constraints = {item["name"] for item in inspector.get_unique_constraints(TABLE)}
    with op.batch_alter_table(TABLE, schema=None) as batch:
        for name in (LEGACY_INDEX, LEGACY_CONSTRAINT):
            # PostgreSQL also reports the index owned by a unique constraint.
            # Dropping the constraint below removes that backing index itself.
            if name in indexes and name not in constraints:
                batch.drop_index(name)
        if LEGACY_CONSTRAINT in constraints:
            batch.drop_constraint(LEGACY_CONSTRAINT, type_="unique")
    platform = sa.text("org_id IS NULL")
    organization = sa.text("org_id IS NOT NULL")
    op.create_index(PLATFORM_INDEX, TABLE, ["key_id"], unique=True,
                    sqlite_where=platform, postgresql_where=platform)
    op.create_index(ORGANIZATION_INDEX, TABLE, ["org_id", "key_id"], unique=True,
                    sqlite_where=organization, postgresql_where=organization)
    op.create_index(LEGACY_INDEX, TABLE, ["key_id"], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if TABLE not in inspector.get_table_names():
        return
    if _duplicates(bind, ("key_id",)):
        raise RuntimeError(
            "Cannot restore globally unique publisher key IDs while multiple scopes "
            "use the same key. Resolve those trust records explicitly before downgrade.")
    indexes = {item["name"] for item in inspector.get_indexes(TABLE)}
    if ORGANIZATION_INDEX in indexes:
        op.drop_index(ORGANIZATION_INDEX, table_name=TABLE)
    if PLATFORM_INDEX in indexes:
        op.drop_index(PLATFORM_INDEX, table_name=TABLE)
    if LEGACY_INDEX in indexes:
        op.drop_index(LEGACY_INDEX, table_name=TABLE)
    with op.batch_alter_table(TABLE, schema=None) as batch:
        batch.create_unique_constraint(LEGACY_CONSTRAINT, ["key_id"])
    op.create_index(LEGACY_INDEX, TABLE, ["key_id"], unique=True)
