"""Private session storage for synthetic OpenCode protocol peers only."""
from contextlib import closing
import os
from pathlib import Path
import sqlite3

def environment(data_root):
    from app.services.opencode_runtime_config import prepare_environment

    root = Path(data_root).resolve()
    home = root / "home"
    home.mkdir(parents=True, exist_ok=True)
    env = {key: value for key, value in os.environ.items()
           if not key.upper().startswith(("OPENCODE_", "SODUWORK_OPENCODE_", "XDG_"))}
    env.update(HOME=str(home), USERPROFILE=str(home), LOCALAPPDATA=str(home),
               SODUWORK_DATA_ROOT=str(root), OPENCODE_DB=str(root / "legacy" / "opencode.db"))
    prepare_environment(env, str(root))
    return env


def _database(env):
    root = Path(env["SODUWORK_OPENCODE_DATA_ROOT"]).resolve()
    database = Path(env["OPENCODE_DB"]).resolve()
    assert database == root / "agents" / "opencode" / "data" / "opencode" / "opencode.db"
    return database


def create_session(env, session_id, workspace):
    # The peer stores its own returned ID, as the native vendor does. The real
    # migration guard still checks this database before every resumed process.
    with closing(sqlite3.connect(_database(env))) as connection, connection:
        connection.execute("CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, directory TEXT NOT NULL)")
        connection.execute("INSERT INTO session VALUES (?, ?)",
                           (session_id, str(Path(workspace).resolve())))


def require_session(env, session_id, workspace):
    # Never create history while loading: a missing or different session must
    # fail instead of silently turning a resume into a fresh conversation.
    with closing(sqlite3.connect(_database(env).as_uri() + "?mode=ro", uri=True)) as connection:
        row = connection.execute("SELECT directory FROM session WHERE id = ?", (session_id,)).fetchone()
    assert row == (str(Path(workspace).resolve()),), "native session must exist in the same workspace"
