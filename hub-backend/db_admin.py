"""SoduWork database backup, verification and guarded restore command."""
from __future__ import annotations

import argparse
import asyncio
import json
import os

from app.config import get_settings
from app.data_backup import backup_database, restore_database, verify_backup


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="SoduWork verified database operations")
    commands = root.add_subparsers(dest="command", required=True)

    commands.add_parser("migrate", help="upgrade or verify the configured database schema")

    backup = commands.add_parser("backup", help="create and verify a database backup")
    backup.add_argument("--output-dir", required=True)

    verify = commands.add_parser("verify", help="verify checksum and database integrity")
    verify.add_argument("backup")

    restore = commands.add_parser("restore", help="restore into an explicitly confirmed target")
    restore.add_argument("backup")
    restore.add_argument("--target-url", required=True)
    restore.add_argument("--confirm-target", required=True)
    restore.add_argument("--force", action="store_true")
    return root


def main() -> None:
    args = parser().parse_args()
    if args.command == "migrate":
        from app.db import engine, init_db

        async def migrate() -> None:
            try:
                await init_db()
            finally:
                await engine.dispose()

        asyncio.run(migrate())
        print(json.dumps({"ok": True, "mode": get_settings().db_migration_mode}))
    elif args.command == "backup":
        result = backup_database(get_settings().database_url, args.output_dir)
        print(json.dumps(result, ensure_ascii=False))
    elif args.command == "verify":
        verify_backup(args.backup)
        print(json.dumps({"ok": True, "backup": os.path.abspath(args.backup)}, ensure_ascii=False))
    else:
        restore_database(
            args.backup,
            args.target_url,
            confirm_target=args.confirm_target,
            force=args.force,
        )
        print(json.dumps({"ok": True, "target": args.confirm_target}, ensure_ascii=False))


if __name__ == "__main__":
    main()
