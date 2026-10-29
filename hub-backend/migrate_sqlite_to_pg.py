# -*- coding: utf-8 -*-
"""Migrate Hub data from SQLite to PostgreSQL while the backend is stopped. Prepare the target
schema, copy tables in dependency order using SQLAlchemy types, normalize naive timestamps to
UTC, and verify every table's row count. Skip retired workflow-definition tables and leave the
SQLite source unchanged for rollback. Supply --sqlite and --pg explicitly.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from datetime import timezone

from sqlalchemy import create_engine, insert, select
from sqlalchemy.ext.asyncio import create_async_engine

sys.path.insert(0, ".")


def _fallback(col):
    """Fill legacy NULL values rejected by PostgreSQL NOT NULL columns using column defaults or
    compatible type defaults.
    """
    default = getattr(col, "default", None)
    if default is not None and getattr(default, "is_scalar", False):
        return default.arg
    if default is not None and getattr(default, "is_callable", False):
        try:
            return default.arg(None)
        except Exception:  # noqa: BLE001
            pass
    py = None
    try:
        py = col.type.python_type
    except Exception:  # noqa: BLE001
        return ""
    if py is bool:
        return False
    if py in (int, float):
        return 0
    if py is dict:
        return {}
    if py is list:
        return []
    if py is str:
        return ""
    from datetime import datetime
    if py is datetime:
        return datetime.now(timezone.utc)
    return ""


def _read_all(sqlite_path: str, tables) -> tuple[dict[str, list[dict]], list[str]]:
    src = create_engine("sqlite:///" + sqlite_path)
    out: dict[str, list[dict]] = {}
    filled: dict[str, int] = {}
    with src.connect() as sc:
        have = {r[0] for r in sc.exec_driver_sql(
            "select name from sqlite_master where type='table'")}
        for table in tables:
            if table.name not in have:
                print("  跳过（源库没有这张表）:", table.name)
                continue
            not_null = {c.name: c for c in table.columns if not c.nullable}
            rows = []
            for row in sc.execute(select(table)).mappings():
                item = dict(row)
                for key, value in list(item.items()):
                    if hasattr(value, "tzinfo") and value is not None and value.tzinfo is None:
                        item[key] = value.replace(tzinfo=timezone.utc)
                    elif value is None and key in not_null:
                        item[key] = _fallback(not_null[key])
                        tag = f"{table.name}.{key}"
                        filled[tag] = filled.get(tag, 0) + 1
                rows.append(item)
            out[table.name] = rows
    src.dispose()
    notes = ["%s ← 补了 %d 个空值" % (k, v) for k, v in sorted(filled.items())]
    return out, notes


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sqlite", default="soduwork_hub.db")
    ap.add_argument("--pg", required=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    os.environ["DATABASE_URL"] = args.pg
    from app import automation_models  # noqa: F401
    from app import models  # noqa: F401
    from app.db import Base, init_db

    tables = list(Base.metadata.sorted_tables)
    data, notes = _read_all(args.sqlite, tables)
    for line in notes:                       # Report every default applied during migration.
        print("  ", line)
    if args.dry_run:
        for name, rows in sorted(data.items(), key=lambda x: -len(x[1])):
            if rows:
                print("  %-38s %6d" % (name, len(rows)))
        print("（dry-run）合计 %d 行" % sum(len(v) for v in data.values()))
        return 0

    await init_db()
    print("PG 建表完成")
    engine = create_async_engine(args.pg)
    async with engine.begin() as conn:
        # Clear partial target data before copying to avoid duplicate keys or incomplete mixed migrations.
        for table in reversed(tables):
            await conn.execute(table.delete())
        for table in tables:
            rows = data.get(table.name) or []
            if not rows:
                continue
            for i in range(0, len(rows), 500):
                await conn.execute(insert(table), rows[i:i + 500])
    mismatch = []
    async with engine.connect() as conn:
        for table in tables:
            if table.name not in data:
                continue
            got = len((await conn.execute(select(table))).fetchall())
            if got != len(data[table.name]):
                mismatch.append((table.name, len(data[table.name]), got))
    await engine.dispose()

    for name, rows in sorted(data.items(), key=lambda x: -len(x[1])):
        if rows:
            print("  %-38s %6d" % (name, len(rows)))
    print("合计 %d 行 / %d 张表" % (sum(len(v) for v in data.values()),
                                    len([v for v in data.values() if v])))
    if mismatch:
        print("★行数对不上：", mismatch)
        return 2
    print("逐表行数核对通过")
    return 0


sys.exit(asyncio.run(main()))
