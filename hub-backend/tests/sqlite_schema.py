"""Create fresh test databases without one async round trip per DDL statement."""

from sqlalchemy import MetaData, create_mock_engine
from sqlalchemy.ext.asyncio import AsyncConnection


def _has_create_hooks(metadata: MetaData) -> bool:
    targets = [metadata]
    for table in metadata.tables.values():
        targets.extend((table, *table.columns, *table.constraints, *table.indexes))
    return any(
        getattr(getattr(target, "dispatch", None), event, None)
        for target in targets
        for event in ("before_create", "after_create")
    )


def _schema_script(metadata: MetaData) -> str:
    statements = []

    def collect(statement, *args, **kwargs):
        statements.append(str(statement.compile(dialect=engine.dialect)).rstrip() + ";")

    engine = create_mock_engine("sqlite+aiosqlite:///:memory:", collect)
    metadata.create_all(engine, checkfirst=False)
    return "\n".join(statements)


async def create_fresh_sqlite_schema(connection: AsyncConnection, metadata: MetaData) -> None:
    """Batch DDL for an empty memory database without sharing connections or row data."""
    url = connection.engine.url
    if url.drivername != "sqlite+aiosqlite" or url.database != ":memory:":
        raise ValueError("This fixture helper requires a new aiosqlite memory database")
    raw = await connection.get_raw_connection()
    driver = raw.driver_connection
    # executescript may commit a pending transaction; never run it after fixture writes.
    if driver.in_transaction:
        raise ValueError("Create the fixture schema before starting a database transaction")
    existing = await connection.exec_driver_sql(
        "SELECT name FROM sqlite_master UNION ALL SELECT name FROM sqlite_temp_master LIMIT 1"
    )
    if existing.first() is not None:
        raise ValueError("Create the fixture schema only in an empty database")

    if _has_create_hooks(metadata):
        # Hooks can depend on a real connection or run once for each database.
        await connection.run_sync(metadata.create_all, checkfirst=False)
        return
    script = _schema_script(metadata)
    async with driver.executescript(script):
        pass
