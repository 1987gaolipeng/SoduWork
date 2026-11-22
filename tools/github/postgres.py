"""Migration/backup/restore against an explicitly supplied disposable database."""
from __future__ import annotations

import os
import secrets
from pathlib import Path
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]


def main():
    url = os.environ["DATABASE_URL"]
    parsed = urlsplit(url)
    if parsed.hostname not in {"127.0.0.1", "localhost"} or parsed.path != "/soduwork_ci":
        raise ValueError("Only the local disposable soduwork_ci database is accepted")
    env = {**os.environ, "SMOKE_ALLOW_LIVE_DB": "1", "SODUWORK_ENV": "development",
           "AUTH_SECRET": secrets.token_hex(32), "ADMIN_PASS": secrets.token_hex(24)}

    def run(*args, extra=None, check=True):
        """Run the backend CLI and capture diagnostics for the expected restore failure."""
        return subprocess.run([sys.executable, *args], cwd=ROOT / "hub-backend",
                              env={**env, **(extra or {})}, check=check, text=True, capture_output=not check)

    def psql(database, statement):
        """Run one fixture statement against the disposable cluster."""
        return subprocess.run(
            ["psql", "-XAt", "-h", parsed.hostname, "-p", str(parsed.port or 5432), "-U", parsed.username,
             "-d", database, "-v", "ON_ERROR_STOP=1", "-c", statement],
            env={**env, "PGPASSWORD": parsed.password}, check=True, text=True, stdout=subprocess.PIPE,
        ).stdout.strip()

    with tempfile.TemporaryDirectory(prefix="soduwork-ci-backup-") as temporary:
        env["SODUWORK_DATA_ROOT"] = str(Path(temporary) / "runtime")
        run("db_admin.py", "migrate")
        run("-m", "alembic", "check")
        run("db_admin.py", "migrate", extra={"DB_MIGRATION_MODE": "check"})
        run("db_admin.py", "backup", "--output-dir", temporary)
        dumps = list(Path(temporary).glob("*.dump"))
        if len(dumps) != 1:
            raise ValueError("Expected one disposable backup")
        run("db_admin.py", "verify", str(dumps[0]))
        psql("postgres", "CREATE DATABASE soduwork_restore")
        target = url.rsplit("/", 1)[0] + "/soduwork_restore"
        restore = ("db_admin.py", "restore", str(dumps[0]), "--target-url", target,
                   "--confirm-target", "soduwork_restore", "--force")
        run(*restore)
        run("db_admin.py", "migrate", extra={"DATABASE_URL": target, "DB_MIGRATION_MODE": "check"})

        # A reporting view blocks DROP TABLE, but does not block the earlier DROP CONSTRAINT.
        psql("soduwork_restore", "CREATE VIEW restore_version_report AS SELECT version_num FROM public.alembic_version")
        snapshot = ("SELECT version_num, conname FROM restore_version_report CROSS JOIN pg_constraint "
                    "WHERE conrelid = 'public.alembic_version'::regclass AND contype = 'p' ORDER BY 1, 2")
        before = psql("soduwork_restore", snapshot)
        if not before:
            raise AssertionError("Restore fixture lacks a migration version or its primary key")
        failed = run(*restore, check=False)
        if failed.returncode == 0 or "restore_version_report" not in failed.stderr:
            raise AssertionError(f"Expected the reporting view to prevent restore: {failed.stderr}")
        if psql("soduwork_restore", snapshot) != before:
            raise AssertionError("Failed restore changed the migration version or removed its primary key")


if __name__ == "__main__":
    main()
