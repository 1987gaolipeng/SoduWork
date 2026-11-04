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

    def run(*args, extra=None):
        subprocess.run([sys.executable, *args], cwd=ROOT / "hub-backend", env={**env, **(extra or {})}, check=True)

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
        # A local psql process creates only the dedicated restore fixture.
        subprocess.run(["psql", "-h", parsed.hostname, "-p", str(parsed.port or 5432), "-U", parsed.username,
                        "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", "CREATE DATABASE soduwork_restore"],
                       env={**env, "PGPASSWORD": parsed.password}, check=True)
        target = url.rsplit("/", 1)[0] + "/soduwork_restore"
        run("db_admin.py", "restore", str(dumps[0]), "--target-url", target,
            "--confirm-target", "soduwork_restore", "--force")
        run("db_admin.py", "migrate", extra={"DATABASE_URL": target, "DB_MIGRATION_MODE": "check"})


if __name__ == "__main__":
    main()
