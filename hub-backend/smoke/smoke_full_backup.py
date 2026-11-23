"""Offline smoke coverage for encrypted full backup and guarded extraction."""
from __future__ import annotations

from contextlib import closing
import io
import json
from pathlib import Path
import shutil
import sqlite3
import tarfile
import tempfile

from app.full_backup import (
    FullBackupError, _safe_symlink_target, _decrypt_file, _encrypt_file,
    _read_key, _validate_tar, create_bundle, extract_bundle, generate_key, verify_bundle,
)


checks = 0


def ok(value: bool, message: str) -> None:
    global checks
    checks += 1
    if not value:
        raise AssertionError(message)


def sqlite_url(path: Path) -> str:
    return "sqlite+aiosqlite:///" + path.resolve().as_posix()


with tempfile.TemporaryDirectory(prefix="soduwork-full-smoke-") as root_name:
    root = Path(root_name)
    database = root / "source.sqlite3"
    with closing(sqlite3.connect(database)) as connection:
        connection.execute("CREATE TABLE alembic_version(version_num TEXT NOT NULL)")
        connection.execute("INSERT INTO alembic_version VALUES ('smoke-001')")
        connection.execute("CREATE TABLE task(id TEXT PRIMARY KEY, title TEXT NOT NULL)")
        connection.executemany("INSERT INTO task VALUES (?, ?)", [("1", "alpha"), ("2", "beta")])
        connection.commit()
    uploads = root / "uploads"
    releases = root / "releases"
    uploads.mkdir()
    releases.mkdir()
    (uploads / "note.txt").write_text("backup payload", encoding="utf-8")
    shutil.copy2(uploads / "note.txt", releases / "same.txt")
    (releases / "zero.bin").write_bytes(b"")
    (releases / "empty").mkdir()
    link_supported = False
    try:
        (releases / "note-link").symlink_to("same.txt")
        link_supported = True
    except OSError:
        pass
    secret = root / "system.env"
    secret.write_text("SECRET_MARKER=must-not-leak\n", encoding="utf-8")
    key = generate_key(root / "backup.key")
    output = root / "full.sfb"
    result = create_bundle(database_url=sqlite_url(database),
                           sources=[f"uploads={uploads}", f"releases={releases}", f"system={secret}"],
                           output=output, key_file=key, release="smoke-release")
    ok(output.is_file(), "encrypted bundle was created")
    sidecar = Path(result["manifest"])
    ok(sidecar.is_file(), "public envelope manifest was created")
    public_text = sidecar.read_text(encoding="utf-8")
    ok("SECRET_MARKER" not in public_text and "system.env" not in public_text,
       "public envelope contains no protected path or secret")
    public = json.loads(public_text)
    ok(public["cipher"] == "AES-256-GCM", "authenticated encryption is declared")
    ok(public["stats"]["uniqueBlobs"] < public["stats"]["files"], "duplicate content is stored once")
    verified = verify_bundle(output, key)
    ok(verified["ok"] and verified["schemaRevision"] == "smoke-001", "bundle verifies")
    ok(verified["tables"] == 2, "database inventory is present")
    for bad_size in ("abc", float("inf"), output.stat().st_size + 0.5):
        sidecar.write_text(json.dumps({**public, "size": bad_size}), encoding="utf-8")
        try:
            verify_bundle(output, key)
        except FullBackupError:
            ok(True, "invalid envelope size reported as a full backup error")
        else:
            raise AssertionError("invalid envelope size passed verification")
    sidecar.write_text(public_text, encoding="utf-8")
    restored = root / "restored"
    try:
        extract_bundle(output, key, restored, confirm_target="wrong")
        ok(False, "wrong confirmation was accepted")
    except FullBackupError:
        ok(True, "wrong restore confirmation is rejected")
    extracted = extract_bundle(output, key, restored, confirm_target=str(restored.resolve()))
    ok(extracted["ok"], "guarded extraction succeeds")
    ok((restored / "uploads" / "note.txt").read_text(encoding="utf-8") == "backup payload",
       "uploaded file is restored")
    ok((restored / "releases" / "empty").is_dir(), "empty directory is restored")
    ok((restored / "releases" / "zero.bin").is_file()
       and (restored / "releases" / "zero.bin").stat().st_size == 0,
       "zero-byte file is verified and restored")
    if link_supported:
        ok((restored / "releases" / "note-link").is_symlink(), "safe symbolic link is restored")
    embedded = next((restored / "database").glob("*.sqlite3"))
    with closing(sqlite3.connect(embedded)) as connection:
        ok(connection.execute("SELECT count(*) FROM task").fetchone()[0] == 2,
           "database rows survive restoration")
    wrong_key = generate_key(root / "wrong.key")
    try:
        verify_bundle(output, wrong_key)
        ok(False, "wrong key was accepted")
    except FullBackupError:
        ok(True, "wrong key is rejected")
    damaged = root / "damaged.sfb"
    shutil.copy2(output, damaged)
    shutil.copy2(sidecar, damaged.with_name(damaged.name + ".manifest.json"))
    with damaged.open("r+b") as stream:
        stream.seek(-32, 2)
        byte = stream.read(1)
        stream.seek(-1, 1)
        stream.write(bytes([byte[0] ^ 0x01]))
    try:
        verify_bundle(damaged, key)
        ok(False, "damaged bundle was accepted")
    except FullBackupError:
        ok(True, "damaged bundle is rejected")
    try:
        create_bundle(database_url=sqlite_url(database), sources=[], output=output, key_file=key)
        ok(False, "existing output was overwritten")
    except FullBackupError:
        ok(True, "existing output is never overwritten")
    for unsafe_target in ("../../escape", "C:\\escape", "C:/escape"):
        try:
            _safe_symlink_target("nested/link", unsafe_target)
            ok(False, "cross-platform escaping symbolic link was accepted")
        except FullBackupError:
            ok(True, "cross-platform escaping symbolic link is rejected")
    rotation_plain = root / "rotation.txt"
    rotation_plain.write_bytes(b"key rotation payload")
    rotation_cipher = root / "rotation.sfb"
    rotation_output = root / "rotation-restored.txt"
    _encrypt_file(rotation_plain, rotation_cipher, _read_key(key))
    _decrypt_file(rotation_cipher, rotation_output, _read_key(key))
    ok(rotation_output.read_bytes() == rotation_plain.read_bytes(),
       "streaming encryption primitives support controlled key rotation")

# Validate the two independent size fields before extraction of any file.
for invalid_section in ("blobs", "entries"):
    manifest = {
        "formatVersion": 1, "kind": "full-backup", "sources": [{"name": "uploads"}],
        "blobs": [{"sha256": "a" * 64, "size": 0}],
        "entries": [{"kind": "file", "path": "sample", "source": "uploads", "blob": "a" * 64, "size": 0}],
    }
    manifest[invalid_section][0]["size"] = "abc"
    raw = json.dumps(manifest).encode("utf-8")
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        member = tarfile.TarInfo("manifest.json")
        member.size = len(raw)
        archive.addfile(member, io.BytesIO(raw))
    buffer.seek(0)
    with tarfile.open(fileobj=buffer) as archive:
        try:
            _validate_tar(archive)
        except FullBackupError as exc:
            ok("size" in str(exc).lower(), f"invalid {invalid_section} size identified")
        else:
            raise AssertionError(f"invalid {invalid_section} size passed verification")

print(f"full backup smoke: {checks} checks passed")
