"""Versioned schema migration and one-time adoption of pre-Alembic databases."""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Callable, Literal

from alembic import command
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import inspect
from sqlalchemy.ext.asyncio import AsyncEngine


_BACKEND_ROOT = Path(__file__).resolve().parents[1]
_PROVISIONAL_ADOPTION_REVISIONS = {"0001_commercial_baseline"}


class SchemaMigrationError(RuntimeError):
    """Raised when a database cannot be upgraded without an explicit decision."""


def _config() -> Config:
    cfg = Config(str(_BACKEND_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(_BACKEND_ROOT / "migrations"))
    return cfg


def _head_revision() -> str:
    head = ScriptDirectory.from_config(_config()).get_current_head()
    if not head:
        raise SchemaMigrationError("No Alembic head revision is available")
    return head


def _upgrade_head() -> None:
    command.upgrade(_config(), "head")


def _stamp_adopted_schema() -> None:
    # Pre-v1 databases are reconciled against the current metadata immediately above.  Stamping
    # a frozen old revision would then replay newer ADD/CREATE operations over objects that
    # already exist.  This one-time adapter is intentionally removed after the first release.
    # ``purge`` also repairs databases stamped by the provisional pre-v1 migrator. Its
    # temporary revision is intentionally not part of the permanent Alembic graph.
    command.stamp(_config(), "head", purge=True)


def _database_state(connection) -> tuple[Literal["empty", "legacy", "versioned"], str | None]:
    inspector = inspect(connection)
    tables = set(inspector.get_table_names())
    business_tables = tables - {"alembic_version"}
    if not business_tables:
        return "empty", None
    if "alembic_version" in tables:
        revision = MigrationContext.configure(connection).get_current_revision()
        return "versioned", revision
    if {"task", "client"}.issubset(tables):
        return "legacy", None
    sample = ", ".join(sorted(business_tables)[:8])
    raise SchemaMigrationError(
        "Database has tables but is neither a recognized SoduWork database nor versioned: " + sample
    )


def _validate_legacy_schema(connection, metadata) -> None:
    inspector = inspect(connection)
    actual_tables = set(inspector.get_table_names())
    problems: list[str] = []
    for table in metadata.sorted_tables:
        if table.name not in actual_tables:
            problems.append(f"missing table {table.name}")
            continue
        actual_columns = {item["name"] for item in inspector.get_columns(table.name)}
        missing = [column.name for column in table.columns if column.name not in actual_columns]
        if missing:
            problems.append(f"{table.name} missing columns: {', '.join(missing)}")
    if problems:
        raise SchemaMigrationError("Legacy database adoption failed: " + "; ".join(problems[:20]))


async def migrate_database(
    engine: AsyncEngine,
    metadata,
    legacy_ensure: Callable,
    legacy_backfill: Callable,
    *,
    mode: str = "auto",
) -> str:
    """Upgrade to head, or only verify it when ``mode`` is ``check``.

    The legacy branch is intentionally one-time. Once stamped, startup never runs
    create_all/ALTER reconciliation again; all later changes require revisions.
    """
    normalized_mode = str(mode or "auto").strip().lower()
    if normalized_mode not in {"auto", "check"}:
        raise SchemaMigrationError("DB_MIGRATION_MODE must be 'auto' or 'check'")

    async with engine.begin() as connection:
        state, current = await connection.run_sync(_database_state)

    head = _head_revision()
    if normalized_mode == "check":
        if state != "versioned" or current != head:
            raise SchemaMigrationError(
                f"Database schema is not ready (state={state}, current={current}, expected={head})"
            )
        return head

    # A short-lived pre-v1 migrator reconciled the complete ORM schema and then stamped a
    # provisional revision. Replaying the generated baselines would CREATE tables that already
    # exist. Treat only that explicit marker as the one-time legacy adoption path, validate the
    # complete current metadata, then replace it with the permanent head revision.
    if state == "versioned" and current in _PROVISIONAL_ADOPTION_REVISIONS:
        state = "legacy"

    if state == "legacy":
        async with engine.begin() as connection:
            await connection.run_sync(metadata.create_all)
            await connection.run_sync(legacy_ensure)
            await connection.run_sync(legacy_backfill)
            await connection.run_sync(lambda conn: _validate_legacy_schema(conn, metadata))
        await asyncio.to_thread(_stamp_adopted_schema)

    await asyncio.to_thread(_upgrade_head)

    async with engine.begin() as connection:
        final_state, final_revision = await connection.run_sync(_database_state)
    if final_state != "versioned" or final_revision != head:
        raise SchemaMigrationError(
            f"Database migration did not reach head (current={final_revision}, expected={head})"
        )
    return head
