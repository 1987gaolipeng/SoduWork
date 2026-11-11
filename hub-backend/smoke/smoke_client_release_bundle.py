"""Offline client release bundle: sign, verify, import and reject tampering/replay."""
from __future__ import annotations

import base64
from contextlib import closing
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


ROOT = Path(__file__).resolve().parent.parent
_TEMP = tempfile.TemporaryDirectory(prefix="soduwork-smoke-client-release-bundle-")
TEMP = Path(_TEMP.name)
DB = TEMP / "release.db"
ARTIFACTS = TEMP / "artifacts"
INSTALLER = TEMP / "SoduWork-9.8.7-Setup.exe"
BUNDLE = TEMP / "SoduWork-9.8.7.release.json"
TAMPERED = TEMP / "tampered.release.json"
KEY_FILE = TEMP / "release.key"
KEY_ID = "smoke-offline-key"


def run(*args: str, env: dict[str, str], ok: bool = True) -> subprocess.CompletedProcess:
    proc = subprocess.run(
        [sys.executable, *args],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=90,
    )
    if ok and proc.returncode != 0:
        raise AssertionError(proc.stdout + proc.stderr)
    if not ok and proc.returncode == 0:
        raise AssertionError("command unexpectedly succeeded: " + " ".join(args))
    return proc


def main() -> None:
    shutil.rmtree(TEMP, ignore_errors=True)
    TEMP.mkdir(parents=True)
    try:
        key = Ed25519PrivateKey.generate()
        private = base64.b64encode(key.private_bytes(
            serialization.Encoding.Raw,
            serialization.PrivateFormat.Raw,
            serialization.NoEncryption(),
        )).decode("ascii")
        public = base64.b64encode(key.public_key().public_bytes(
            serialization.Encoding.Raw,
            serialization.PublicFormat.Raw,
        )).decode("ascii")
        KEY_FILE.write_text(private, encoding="ascii")
        KEY_FILE.chmod(0o600)  # POSIX signing rejects overly permissive private-key files.
        INSTALLER.write_bytes((b"SODUWORK-OFFLINE-RELEASE\n" * 70000)[:1200000])
        env = {
            **os.environ,
            "DATABASE_URL": "sqlite+aiosqlite:///" + DB.as_posix(),
            "DB_MIGRATION_MODE": "auto",
            "CLIENT_UPDATE_DIR": ARTIFACTS.as_posix(),
            "CLIENT_UPDATE_PUBLIC_KEYS": json.dumps({"keys": {KEY_ID: public}}),
        }

        run(
            "sign_client_release.py", str(INSTALLER),
            "--version", "9.8.7",
            "--output", str(BUNDLE),
            "--key-file", str(KEY_FILE),
            "--key-id", KEY_ID,
            "--notes", "offline release smoke",
            env=env,
        )
        signed = json.loads(BUNDLE.read_text(encoding="utf-8"))
        assert signed["version"] == "9.8.7"
        assert signed["artifact"]["sha256"] == hashlib.sha256(
            INSTALLER.read_bytes()).hexdigest()

        run("db_admin.py", "migrate", env=env)
        imported = run(
            "import_client_release.py", str(BUNDLE), str(INSTALLER), env=env)
        assert "imported 9.8.7" in imported.stdout
        with closing(sqlite3.connect(DB)) as db:
            row = db.execute(
                "select version, signature, key_id, artifact_path "
                "from client_release"
            ).fetchone()
        assert row and row[0] == "9.8.7" and row[1] == signed["signature"]
        assert row[2] == KEY_ID and row[3].endswith(INSTALLER.name)
        stored = ARTIFACTS / row[3]
        assert stored.is_file()
        assert hashlib.sha256(stored.read_bytes()).hexdigest() == signed["artifact"]["sha256"]

        changed = {**signed, "notes": "tampered after signing"}
        TAMPERED.write_text(json.dumps(changed), encoding="utf-8")
        rejected = run(
            "import_client_release.py", str(TAMPERED), str(INSTALLER),
            env=env, ok=False,
        )
        assert "not trusted" in (rejected.stdout + rejected.stderr)
        replayed = run(
            "import_client_release.py", str(BUNDLE), str(INSTALLER),
            env=env, ok=False,
        )
        assert "already exists" in (replayed.stdout + replayed.stderr)
        print("offline client release bundle: 12 assertions green")
    finally:
        shutil.rmtree(TEMP, ignore_errors=True)


if __name__ == "__main__":
    main()
