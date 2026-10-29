"""Public module behavior and service contracts."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0035_plugin_identity"
down_revision: Union[str, Sequence[str], None] = "0034_ai_usage_ledger"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _duplicates(bind, table_name: str, columns: tuple[str, ...],
                predicate=None) -> list[tuple]:
    table = sa.Table(table_name, sa.MetaData(), autoload_with=bind)
    values = [table.c[name] for name in columns]
    count = sa.func.count()
    statement = sa.select(*values, count.label("duplicates"))
    if predicate is not None:
        statement = statement.where(predicate(table))
    statement = statement.group_by(*values).having(count > 1).limit(5)
    return [tuple(row) for row in bind.execute(statement).all()]


def _assert_clean(bind) -> None:
    checks = (
        (
            "platform plugin key",
            _duplicates(
                bind, "automation_plugin", ("key",),
                lambda table: table.c.org_id.is_(None)),
        ),
        (
            "organization plugin key",
            _duplicates(
                bind, "automation_plugin", ("org_id", "key"),
                lambda table: table.c.org_id.is_not(None)),
        ),
        (
            "plugin semantic version",
            _duplicates(
                bind, "automation_plugin_version", ("plugin_id", "version")),
        ),
        (
            "plugin package checksum",
            _duplicates(
                bind, "automation_plugin_version", ("plugin_id", "checksum")),
        ),
    )
    dirty = [(label, rows) for label, rows in checks if rows]
    if dirty:
        detail = "; ".join(
            f"{label}: {rows}" for label, rows in dirty)
        raise RuntimeError(
            "Plugin identity migration stopped because duplicate records exist. "
            "Resolve them explicitly before retrying: " + detail)


def upgrade() -> None:
    bind = op.get_bind()
    _assert_clean(bind)
    platform = sa.text("org_id IS NULL")
    organization = sa.text("org_id IS NOT NULL")
    op.create_index(
        "uq_automation_plugin_platform_key", "automation_plugin", ["key"],
        unique=True, sqlite_where=platform, postgresql_where=platform)
    op.create_index(
        "uq_automation_plugin_org_key", "automation_plugin", ["org_id", "key"],
        unique=True, sqlite_where=organization,
        postgresql_where=organization)
    op.create_index(
        "uq_automation_plugin_version_name", "automation_plugin_version",
        ["plugin_id", "version"], unique=True)
    op.create_index(
        "uq_automation_plugin_version_checksum", "automation_plugin_version",
        ["plugin_id", "checksum"], unique=True)


def downgrade() -> None:
    op.drop_index(
        "uq_automation_plugin_version_checksum",
        table_name="automation_plugin_version")
    op.drop_index(
        "uq_automation_plugin_version_name",
        table_name="automation_plugin_version")
    op.drop_index(
        "uq_automation_plugin_org_key", table_name="automation_plugin")
    op.drop_index(
        "uq_automation_plugin_platform_key", table_name="automation_plugin")
