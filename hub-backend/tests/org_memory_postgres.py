"""Run org-memory checks in a disposable PostgreSQL cluster, never a user DB.

Usage: development-python tests/org_memory_postgres.py
PG_BIN may point to an installed PostgreSQL bin directory; no packages or
services are installed. Both server and database are local test fixtures.
An explicitly authorized --existing-local-server run uses the local settings
only to connect to postgres and create a new random disposable test database.
"""
import asyncio
import getpass
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import uuid


def run_checks(backend, database_url, database, port, isolated_cluster):
    env = os.environ.copy()
    env["ORG_MEMORY_TEST_POSTGRES_URL"] = database_url
    result = subprocess.run([sys.executable, "-m", "unittest", "test_org_memory_singleton", "-v"],
                            cwd=backend, env=env, capture_output=True, text=True,
                            encoding="utf-8", errors="replace", timeout=180,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    output = backend.parent / "outputs" / "org-memory-postgres-results.json"
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps({
        "isolatedCluster": isolated_cluster, "isolatedDatabase": True,
        "host": "127.0.0.1", "port": port, "database": database,
        "exitCode": result.returncode, "stdout": result.stdout, "stderr": result.stderr,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(result.stdout + result.stderr, end="")
    print("Evidence: " + str(output))
    return result.returncode


async def existing_local_server(backend):
    """Explicit opt-in: only postgres maintenance + a newly created random DB."""
    sys.path.insert(0, str(backend))
    from app.config import get_settings
    from sqlalchemy import text
    from sqlalchemy.engine import make_url
    from sqlalchemy.exc import DBAPIError
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool

    configured = make_url(get_settings().database_url)
    if configured.drivername != "postgresql+asyncpg" or configured.host != "127.0.0.1":
        raise RuntimeError("The maintenance connection must be the existing loopback PostgreSQL")
    database = "soduwork_orgmemory_test_" + uuid.uuid4().hex[:24]
    # Do not construct a connection to the configured business database.
    maintenance = create_async_engine(configured.set(database="postgres"),
                                      isolation_level="AUTOCOMMIT", poolclass=NullPool)
    created = False
    try:
        try:
            async with maintenance.connect() as connection:
                await connection.execute(text('CREATE DATABASE "' + database + '"'))
                created = True
        except DBAPIError as exc:
            code = str(getattr(exc.orig, "sqlstate", ""))
            if code != "42501":
                raise
            output = backend.parent / "outputs" / "org-memory-postgres-results.json"
            output.parent.mkdir(exist_ok=True)
            output.write_text(json.dumps({
                "status": "blocked", "reason": "PostgreSQL role cannot CREATE DATABASE",
                "sqlstate": code, "maintenanceDatabase": "postgres", "attemptedDatabase": database,
                "databaseCreated": False, "businessDatabaseConnected": False, "testsRun": 0,
            }, indent=2), encoding="utf-8")
            print("PostgreSQL fixture unavailable: CREATE DATABASE permission denied (42501)")
            print("Evidence: " + str(output))
            return 2
        test_url = configured.set(database=database).render_as_string(hide_password=False)
        return await asyncio.to_thread(run_checks, backend, test_url, database, configured.port or 5432, False)
    finally:
        if created:
            async with maintenance.connect() as connection:
                await connection.execute(text('DROP DATABASE "' + database + '" WITH (FORCE)'))
        await maintenance.dispose()


def main():
    backend = Path(__file__).resolve().parents[1]
    if sys.argv[1:] == ["--existing-local-server"]:
        return asyncio.run(existing_local_server(backend))
    if sys.argv[1:]:
        raise RuntimeError("Only --existing-local-server is supported")
    database = "soduwork_orgmemory_test_" + uuid.uuid4().hex[:24]
    binary = os.environ.get("PG_BIN", "")
    if not binary:
        found = shutil.which("initdb")
        binary = str(Path(found).parent) if found else "C:/Program Files/PostgreSQL/17/bin"
    suffix = ".exe" if os.name == "nt" else ""
    pg = Path(binary)
    initdb = pg / ("initdb" + suffix)
    if not initdb.is_file():
        raise RuntimeError("Set PG_BIN to an existing PostgreSQL installation")
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    evidence_dir = backend.parent / "outputs"
    evidence_dir.mkdir(exist_ok=True)
    directory = tempfile.TemporaryDirectory(prefix="soduwork-org-memory-postgres-", dir=evidence_dir)
    root = Path(directory.name)
    data = root / "cluster"
    log = root / "postgres.log"
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0

    def command(argv, timeout=45):
        # Windows pg_ctl starts postgres via cmd.exe. Captured anonymous pipes
        # can remain inherited by that long-lived child even after pg_ctl exits.
        # A file avoids waiting for EOF on a server-owned pipe.
        with tempfile.TemporaryFile(mode="w+b") as output:
            result = subprocess.run([str(arg) for arg in argv], cwd=backend,
                                    stdout=output, stderr=output, timeout=timeout,
                                    creationflags=flags)
            output.seek(0)
            result.stdout = output.read().decode("utf-8", errors="replace")
            result.stderr = ""
        if result.returncode:
            raise RuntimeError(result.stdout + result.stderr)
        return result

    started = False
    try:
        if os.name == "nt":
            # initdb drops the Administrators group from its process token.
            # A temp directory accessible only via that group looks missing to
            # the child and produces a misleading parent "File exists" error.
            # Grant only the current user, only inside this disposable fixture.
            if root.resolve().parent != evidence_dir.resolve() or not root.name.startswith("soduwork-org-memory-postgres-"):
                raise RuntimeError("Unsafe PostgreSQL fixture directory")
            user = os.environ.get("USERDOMAIN", "") + "\\" + getpass.getuser()
            command(["icacls", root, "/grant", user + ":(OI)(CI)F"])
        command([initdb, "-D", data, "-U", "fixture", "--auth=trust", "--encoding=UTF8", "--locale=C"])
        command([pg / ("pg_ctl" + suffix), "-D", data, "-l", log, "-o",
                 f"-h 127.0.0.1 -p {port} -c fsync=off", "-w", "-t", "30", "start"])
        started = True
        command([pg / ("createdb" + suffix), "-h", "127.0.0.1", "-p", str(port),
                 "-U", "fixture", database])
        return run_checks(backend, f"postgresql+asyncpg://fixture@127.0.0.1:{port}/{database}", database, port, True)
    finally:
        if started or (data / "postmaster.pid").exists():
            command([pg / ("pg_ctl" + suffix), "-D", data, "-m", "fast", "-w", "-t", "30", "stop"])
        directory.cleanup()


if __name__ == "__main__":
    sys.exit(main())
