"""Real Alembic round trip in a private SQLite file; PostgreSQL DDL stays offline."""
import importlib
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from alembic.migration import MigrationContext
from alembic.operations import Operations

BACKEND = Path(__file__).resolve().parents[1]
CHECK = r'''
import os
from datetime import datetime
from pathlib import Path
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
import sqlalchemy as sa
filename = Path(os.environ["ONCE_MIGRATION_DB"]).resolve()
assert filename.parent.name.startswith("soduwork-once-migration-") and filename.name == "fixture.db"
cfg = Config("alembic.ini")
command.upgrade(cfg, "0059_identity_key_index")
engine = sa.create_engine("sqlite:///" + filename.as_posix())
meta = sa.MetaData()
meta.reflect(engine, only=["ai_schedule", "automation_runner_node"])
table = meta.tables["ai_schedule"]
original_columns = set(table.c.keys())
values = {}
for column in table.c:
    if column.nullable or column.server_default is not None:
        continue
    values[column.name] = ({} if isinstance(column.type, sa.JSON) else False if isinstance(column.type, sa.Boolean)
                           else 0 if isinstance(column.type, sa.Integer) else "")
values.update(id="kept-periodic", title="Retained title", every="weekly", weekday=3, at_hour=15, at_minute=20)
with engine.begin() as connection:
    connection.execute(table.insert().values(**values))
runner = meta.tables["automation_runner_node"]
runner_columns = set(runner.c.keys())
runner_values = {column.name: ({} if isinstance(column.type, sa.JSON) else 0 if isinstance(column.type, sa.Integer)
                               else "") for column in runner.c
                 if not column.nullable and column.server_default is None}
runner_values.update(id="kept-runner", host="Retained runner", client_id="fixture-client")
with engine.begin() as connection:
    connection.execute(runner.insert().values(**runner_values))
start = os.environ.get("ONCE_START_BRANCH", "0059_identity_key_index")
command.upgrade(cfg, start)
with engine.begin() as connection:
    if start == "0060_schedule_once":
        connection.execute(sa.text("UPDATE ai_schedule SET every='once', run_at='2035-01-01 00:00:00', once_fired=1 WHERE id='kept-periodic'"))
    if start == "0060_runner_management":
        connection.execute(sa.text("UPDATE automation_runner_node SET management_state='disabled' WHERE id='kept-runner'"))
command.upgrade(cfg, "head")
with engine.connect() as connection:
    assert {"run_at", "once_fired"}.issubset({row["name"] for row in sa.inspect(connection).get_columns("ai_schedule")})
    timing = ("2035-01-01 00:00:00", 1, "Retained title", "once") if start == "0060_schedule_once" else (None, 0, "Retained title", "weekly")
    management = "disabled" if start == "0060_runner_management" else ""
    assert connection.execute(sa.text("SELECT run_at, once_fired, title, every FROM ai_schedule WHERE id='kept-periodic' ")).one() == timing
    assert connection.execute(sa.text("SELECT management_state, host FROM automation_runner_node WHERE id='kept-runner'")).one() == (management, "Retained runner")
    assert connection.execute(sa.text("SELECT version_num FROM alembic_version")).scalars().all() == [ScriptDirectory.from_config(cfg).get_current_head()]
with engine.begin() as connection:
    connection.execute(sa.text("UPDATE ai_schedule SET every='weekly' WHERE id='kept-periodic'"))
    connection.execute(sa.text("UPDATE automation_runner_node SET management_state='' WHERE id='kept-runner'"))
command.downgrade(cfg, "0059_identity_key_index")
with engine.connect() as connection:
    assert {row["name"] for row in sa.inspect(connection).get_columns("ai_schedule")} == original_columns
    assert {row["name"] for row in sa.inspect(connection).get_columns("automation_runner_node")} == runner_columns
    assert connection.execute(sa.text("SELECT title, every, weekday, at_hour, at_minute FROM ai_schedule")).one() == ("Retained title", "weekly", 3, 15, 20)
    assert connection.scalar(sa.text("SELECT host FROM automation_runner_node WHERE id='kept-runner'")) == "Retained runner"
command.upgrade(cfg, "head")
with engine.begin() as connection:
    connection.execute(sa.text("UPDATE ai_schedule SET every='once', run_at='2035-01-01 00:00:00' WHERE id='kept-periodic'"))
try:
    command.downgrade(cfg, "0059_identity_key_index")
except RuntimeError as error:
    assert "one-time" in str(error)
else:
    raise AssertionError("Dropping active one-time timing must require explicit conversion")
with engine.connect() as connection:
    assert connection.scalar(sa.text("SELECT every FROM ai_schedule")) == "once"
    assert {"run_at", "once_fired"}.issubset({row["name"] for row in sa.inspect(connection).get_columns("ai_schedule")})
with engine.begin() as connection:
    connection.execute(sa.text("UPDATE ai_schedule SET every='weekly' WHERE id='kept-periodic'"))
command.upgrade(cfg, "head")
with engine.begin() as connection:
    connection.execute(sa.text("UPDATE automation_runner_node SET management_state='disabled' WHERE id='kept-runner'"))
try:
    command.downgrade(cfg, "0059_identity_key_index")
except RuntimeError as error:
    assert "Managed cloud runners" in str(error)
else:
    raise AssertionError("Dropping managed runner security must require explicit resolution")
with engine.connect() as connection:
    assert connection.scalar(sa.text("SELECT management_state FROM automation_runner_node WHERE id='kept-runner'")) == "disabled"
    assert connection.scalar(sa.text("SELECT title FROM ai_schedule WHERE id='kept-periodic'")) == "Retained title"
engine.dispose()
print("merged Alembic head round trip; legacy values kept; both unsafe downgrades rejected")
'''


class OnceMigrationTests(unittest.TestCase):
    def _check_branch(self, start):
        with tempfile.TemporaryDirectory(prefix="soduwork-once-migration-") as folder:
            filename = Path(folder).resolve() / "fixture.db"
            environment = dict(os.environ, DATABASE_URL="sqlite+aiosqlite:///" + filename.as_posix(),
                               AUTH_SECRET="isolated-once-alembic-no-production", ONCE_MIGRATION_DB=str(filename),
                               ONCE_START_BRANCH=start)
            result = subprocess.run([sys.executable, "-B", "-c", CHECK], cwd=BACKEND, env=environment,
                                    capture_output=True, text=True, timeout=600)
            self.assertEqual(result.returncode, 0, (result.stdout + result.stderr)[-7000:])
            self.assertIn("both unsafe downgrades rejected", result.stdout)

    def test_full_alembic_upgrade_and_downgrade_preserve_periodic_data(self):
        self._check_branch("0059_identity_key_index")

    def test_either_existing_branch_upgrades_to_one_head_without_data_loss(self):
        for start in ("0060_schedule_once", "0060_runner_management"):
            with self.subTest(start=start):
                self._check_branch(start)

    def test_postgres_upgrade_compiles_timestamp_timezone_and_boolean_default(self):
        module = importlib.import_module("migrations.versions.0060_schedule_once")
        stream = io.StringIO()
        context = MigrationContext.configure(dialect_name="postgresql", opts={"as_sql": True, "output_buffer": stream})
        with Operations.context(context):
            module.upgrade()
        sql = stream.getvalue()
        self.assertIn("TIMESTAMP WITH TIME ZONE", sql)
        self.assertIn("BOOLEAN DEFAULT false NOT NULL", sql)
        self.assertEqual(module.down_revision, "0059_identity_key_index")


if __name__ == "__main__":
    unittest.main()
