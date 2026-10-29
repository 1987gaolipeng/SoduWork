"""Full Alembic upgrade using a disposable PostgreSQL cluster or SQLite file."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

BACKEND = Path(__file__).resolve().parents[1]


def check():
    sys.path.insert(0, str(BACKEND))
    from alembic import command
    from alembic.config import Config
    import sqlalchemy as sa
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.engine import make_url
    url = os.environ["DATABASE_URL"]
    parsed = make_url(url)
    if parsed.get_backend_name() == "postgresql":
        assert parsed.host == "127.0.0.1" and parsed.database.startswith("soduwork_orgmemory_test_")
    else:
        assert "soduwork-requirement-upgrade-" in parsed.database
    config = Config(str(BACKEND / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND / "migrations"))
    command.upgrade(config, "0052_org_memory_singleton")

    async def seed():
        engine = create_async_engine(url)
        try:
            async with engine.begin() as conn:
                def insert(connection):
                    meta = sa.MetaData()
                    meta.reflect(connection, only=["client", "task", "work_item", "attachment"])
                    client = meta.tables["client"]
                    values = {}
                    for col in client.c:
                        if col.nullable or col.server_default is not None:
                            continue
                        values[col.name] = ([] if isinstance(col.type, sa.JSON) else False if isinstance(col.type, sa.Boolean)
                                            else 0 if isinstance(col.type, sa.Integer) else "")
                    values.update(id="upgrade-owner")
                    connection.execute(client.insert().values(**values))
                    original = dict(id="old-requirement", title="Public request", description="Public source material",
                                    status="delivering", created_by_client_id="upgrade-owner", org_id="shared-org",
                                    created_by_name="Owner", kind="requirement", priority="medium", source="manual",
                                    requester_name="", requester_contact="", repo_id="",
                                    acceptance_criteria=["Verified acceptance"], version=7, tags=["original"])
                    from importlib import import_module
                    migration = import_module("migrations.versions.0053_unified_requirements")
                    values = migration._new_task(meta.tables["task"], original, "delivery", {"upgrade-owner"})
                    values.update(status="doing", note="Private execution prompt")
                    connection.execute(meta.tables["task"].insert().values(**values))
                    original["delivery_task_id"] = "delivery"
                    connection.execute(meta.tables["work_item"].insert().values(**original))
                    connection.execute(meta.tables["work_item"].insert().values(**{
                        **original, "id": "new-task", "status": "intake", "delivery_task_id": None}))
                await conn.run_sync(insert)
        finally:
            await engine.dispose()
    asyncio.run(seed())
    command.upgrade(config, "head")
    command.upgrade(config, "head")

    async def verify():
        engine = create_async_engine(url)
        try:
            async with engine.connect() as conn:
                def inspect(connection):
                    assert not sa.inspect(connection).has_table("work_item")
                    meta = sa.MetaData()
                    task = sa.Table("task", meta, autoload_with=connection)
                    rows = {row["id"]: row for row in connection.execute(sa.select(task)).mappings()}
                    assert set(rows) == {"delivery", "new-task"}
                    assert rows["delivery"]["note"] == "Private execution prompt"
                    assert rows["delivery"]["requirement_content"]["note"].endswith("Public source material")
                    assert rows["delivery"]["requirement_version"] == 7
                    assert rows["new-task"]["triage_stage"] == "intake"
                    assert rows["delivery"]["legacy_requirements"][0]["id"] == "old-requirement"
                    access = sa.Table("task_requirement_access", meta, autoload_with=connection)
                    grants = list(connection.execute(sa.select(access)).mappings())
                    assert len(grants) == 2
                    assert {row["source_id"] for row in grants} == {"old-requirement", "new-task"}
                    assert all(row["principal_kind"] == "client" and row["principal_id"] == "upgrade-owner" for row in grants)
                    assert len(connection.execute(sa.select(task.c.id).where(sa.func.json_array_length(task.c.legacy_requirements) > 0)).all()) == 2
                    assert connection.scalar(sa.text("SELECT version_num FROM alembic_version")) == "0053_unified_requirements"
                await conn.run_sync(inspect)
        finally:
            await engine.dispose()
    asyncio.run(verify())
    print("PASS: complete Alembic chain, old data, private context, persistent source ACL, replay, unified single Task identity")


def launch():
    if sys.argv[1:] == ["--sqlite"]:
        with tempfile.TemporaryDirectory(prefix="soduwork-requirement-upgrade-") as folder:
            env = {**os.environ, "DATABASE_URL": "sqlite+aiosqlite:///" + (Path(folder) / "fixture.db").as_posix()}
            return subprocess.call([sys.executable, "-B", __file__, "--check"], cwd=BACKEND, env=env)
    spec = importlib.util.spec_from_file_location("isolated_pg", BACKEND / "tests" / "org_memory_postgres.py")
    harness = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(harness)
    def run(_backend, database_url, database, port, isolated_cluster):
        env = {**os.environ, "DATABASE_URL": database_url, "PYTHONDONTWRITEBYTECODE": "1"}
        result = subprocess.run([sys.executable, "-B", __file__, "--check"], cwd=BACKEND, env=env,
                                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=240,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        output = BACKEND.parent / "outputs" / "unified-requirements-postgres.json"
        output.parent.mkdir(exist_ok=True)
        output.write_text(json.dumps({"isolatedCluster": isolated_cluster, "database": database, "port": port,
            "exitCode": result.returncode, "stdout": result.stdout, "stderr": result.stderr}, indent=2), encoding="utf-8")
        print(result.stdout + result.stderr)
        return result.returncode
    harness.run_checks = run
    return harness.main()


if __name__ == "__main__":
    if sys.argv[1:] == ["--check"]:
        check()
    else:
        sys.exit(launch())
