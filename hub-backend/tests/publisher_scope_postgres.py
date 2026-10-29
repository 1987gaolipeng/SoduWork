"""Real PostgreSQL publisher migration regression in a disposable schema.

Set SODUWORK_PUBLISHER_TEST_POSTGRES_URL explicitly. Its database name must match
soduwork_publisher_test_<12-32 lowercase hex characters>. No .env or application
settings are loaded. The caller creates/removes that disposable database;
this script creates only its own random schema and rolls back every change.

Run: python tests/publisher_scope_postgres.py
Offline URL refusal checks: python tests/publisher_scope_postgres.py --check-guard
This exercises the publisher table's actual 0044-era definition (revision 0019)
and revision 0045. Full Alembic head/idempotency remains a separate restore drill.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import uuid

from alembic.migration import MigrationContext
from alembic.operations import Operations
import sqlalchemy as sa
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool


ENV = "SODUWORK_PUBLISHER_TEST_POSTGRES_URL"
DATABASE = re.compile(r"soduwork_publisher_test_[0-9a-f]{12,32}\Z")
MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations" / "versions"
TABLE = "automation_plugin_publisher_key"
CONSTRAINT = "uq_plugin_publisher_key_id"
LEGACY_INDEX = "ix_plugin_publisher_key_key_id"
PLATFORM_INDEX = "uq_plugin_publisher_platform_key"
ORG_INDEX = "uq_plugin_publisher_org_key"


class UnsafeDatabase(ValueError):
    pass


def checked_url(raw):
    if not raw:
        raise UnsafeDatabase(f"Set {ENV} explicitly; no default database is allowed")
    try:
        url = make_url(raw)
    except Exception:
        raise UnsafeDatabase("Invalid explicit fixture database URL") from None
    if (url.drivername != "postgresql+asyncpg" or not url.host
            or not DATABASE.fullmatch(url.database or "") or url.query):
        raise UnsafeDatabase(
            "Require postgresql+asyncpg, an explicit host, no URL query overrides, "
            "and database soduwork_publisher_test_<12-32 lowercase hex characters>")
    return url


def load_migration(name):
    spec = importlib.util.spec_from_file_location(name, MIGRATIONS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sqlstate(error):
    current = error
    for _ in range(4):
        value = getattr(current, "sqlstate", None)
        if value:
            return str(value)
        current = getattr(current, "orig", None) or getattr(current, "__cause__", None)
        if current is None:
            break
    return None


def exercise(connection):
    checks = []

    def expect(condition, name):
        if not condition:
            raise AssertionError(name)
        checks.append(name)

    old = load_migration("0019_plugin_publisher_keys")
    current = load_migration("0045_plugin_publisher_org_scope")
    with Operations.context(MigrationContext.configure(connection)):
        old.upgrade()
        inspector = sa.inspect(connection)
        indexes = {item["name"]: item for item in inspector.get_indexes(TABLE)}
        constraints = {item["name"] for item in inspector.get_unique_constraints(TABLE)}
        expect(CONSTRAINT in constraints, "legacy named unique constraint exists")
        expect(indexes.get(CONSTRAINT, {}).get("duplicates_constraint") == CONSTRAINT,
               "PostgreSQL exposes the constraint-owned index with its original name")
        expect(indexes.get(LEGACY_INDEX, {}).get("unique") is True,
               "the separate legacy unique index also exists")

        table = sa.Table(TABLE, sa.MetaData(), autoload_with=connection)

        def row(identity, org, key):
            public_key = base64.b64encode(hashlib.sha256(identity.encode()).digest()).decode()
            return {"id": identity, "org_id": org, "key_id": key,
                    "publisher_name": "Isolated regression fixture", "public_key": public_key,
                    "fingerprint": hashlib.sha256(public_key.encode()).hexdigest()}

        def snapshot():
            return {item["id"]: dict(item) for item in connection.execute(
                sa.select(table).order_by(table.c.id)).mappings()}

        def expect_unique_rejection(value, name):
            try:
                # PostgreSQL errors abort a transaction; isolate expected failures.
                with connection.begin_nested():
                    connection.execute(table.insert(), value)
            except IntegrityError as error:
                expect(sqlstate(error) == "23505", name)
            else:
                raise AssertionError(name)

        original = [row("platform-original", None, "platform-key"),
                    row("org-a-original", "org-a", "shared-key"),
                    row("org-c-original", "org-c", "other-key")]
        connection.execute(table.insert(), original)
        before = snapshot()
        current.upgrade()
        expect(snapshot() == before, "upgrade preserves every original field and public-key byte")
        inspector = sa.inspect(connection)
        indexes = {item["name"]: item for item in inspector.get_indexes(TABLE)}
        constraints = {item["name"] for item in inspector.get_unique_constraints(TABLE)}
        expect(CONSTRAINT not in constraints and CONSTRAINT not in indexes,
               "legacy constraint and its owned index are removed together")
        expect(indexes[LEGACY_INDEX]["unique"] is False,
               "legacy lookup index is retained without global uniqueness")
        expect(indexes[PLATFORM_INDEX]["unique"] and indexes[ORG_INDEX]["unique"],
               "both independent scope-specific unique indexes exist")
        expect_unique_rejection(row("platform-duplicate", None, "platform-key"),
                                "duplicate platform identity is rejected")
        expect_unique_rejection(row("org-a-duplicate", "org-a", "shared-key"),
                                "duplicate identity in the same organization is rejected")
        added = [row("org-b-added", "org-b", "shared-key"),
                 row("platform-added", None, "shared-key")]
        connection.execute(table.insert(), added)
        expect(len(snapshot()) == len(before) + len(added),
               "different organizations and the platform can reuse a key ID")

        all_rows = snapshot()
        try:
            with connection.begin_nested():
                current.downgrade()
        except RuntimeError as error:
            expect("multiple scopes" in str(error), "conflicting downgrade is explicitly refused")
        else:
            raise AssertionError("downgrade must reject cross-scope duplicate key IDs")
        expect(snapshot() == all_rows, "refused downgrade preserves every record and public key")
        remaining = {item["name"] for item in sa.inspect(connection).get_indexes(TABLE)}
        expect({PLATFORM_INDEX, ORG_INDEX} <= remaining,
               "refused downgrade retains both scope protections")
        expect_unique_rejection(row("org-a-still-rejected", "org-a", "shared-key"),
                                "scope uniqueness still works after the refused downgrade")

        # Remove only fixture rows introduced after the old schema snapshot.
        connection.execute(table.delete().where(table.c.id.in_([item["id"] for item in added])))
        current.downgrade()
        expect(snapshot() == before, "valid downgrade also preserves original records")
        expect(CONSTRAINT in {item["name"] for item in sa.inspect(connection).get_unique_constraints(TABLE)},
               "valid downgrade restores global uniqueness")
        current.upgrade()
        expect(snapshot() == before, "upgrade after a valid downgrade preserves original records")
    return checks


async def run(url):
    engine = create_async_engine(url, poolclass=NullPool, connect_args={"timeout": 10})
    schema = "publisher_scope_" + uuid.uuid4().hex
    try:
        async with engine.connect() as connection:
            transaction = await connection.begin()
            try:
                actual = await connection.scalar(sa.text("SELECT current_database()"))
                if actual != url.database or not DATABASE.fullmatch(actual):
                    raise UnsafeDatabase("Connected database does not match the explicit disposable database")
                await connection.execute(sa.schema.CreateSchema(schema))
                # The identifier is generated internally; no external SQL/path input.
                await connection.execute(sa.text(f'SET LOCAL search_path TO "{schema}"'))
                checks = await connection.run_sync(exercise)
            finally:
                await transaction.rollback()
            remaining = await connection.scalar(sa.text("SELECT to_regnamespace(:schema)"), {"schema": schema})
            await connection.rollback()
            if remaining is not None:
                raise AssertionError("disposable schema must disappear after rollback")
        return {"ok": True, "dialect": "postgresql", "database": url.database,
                "checks": checks, "schemaRemoved": True,
                "scope": "publisher table 0044 definition -> 0045; full head upgrade tested separately"}
    finally:
        await engine.dispose()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-guard", action="store_true", help="test URL rejection without a database connection")
    args = parser.parse_args()
    try:
        if args.check_guard:
            for raw in ("", "sqlite:///:memory:", "postgresql+asyncpg://localhost/postgres",
                        "postgresql+asyncpg://localhost/soduwork_hub_dev",
                        "postgresql+asyncpg://localhost/soduwork_publisher_test_fixed",
                        "postgresql+asyncpg://localhost/soduwork_publisher_test_0123456789ab?host=other"):
                try:
                    checked_url(raw)
                except UnsafeDatabase:
                    continue
                raise AssertionError("unsafe fixture database URL was accepted")
            checked_url("postgresql+asyncpg://localhost/soduwork_publisher_test_0123456789ab")
            result = {"ok": True, "guardRejections": 6, "databaseConnected": False}
        else:
            result = asyncio.run(run(checked_url(os.environ.get(ENV, ""))))
    except Exception as error:
        # DB driver exceptions can contain addresses/passwords; never print repr,
        # a traceback or an arbitrary exception message from connection setup.
        result = {"ok": False, "errorType": type(error).__name__, "sqlstate": sqlstate(error)}
        if isinstance(error, (UnsafeDatabase, AssertionError)):
            result["detail"] = str(error)
        print(json.dumps(result, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
