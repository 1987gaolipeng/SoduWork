"""Encrypted, content-addressed full backup bundles for SoduWork.

The database backup remains the transactional source of truth. File sources are
copied into immutable blobs and deduplicated by SHA-256 before the bundle is
encrypted. The public sidecar contains no paths, credentials or table names.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import secrets
import shutil
import sqlite3
import struct
import tarfile
import tempfile
from typing import Any, Iterable

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

from .data_backup import BackupError, backup_database, verify_backup


MAGIC = b"SODUWORKFB01"
NONCE_SIZE = 12
TAG_SIZE = 16
HEADER_SIZE = len(MAGIC) + NONCE_SIZE + 8
CHUNK_SIZE = 4 * 1024 * 1024
FORMAT_VERSION = 1
SIDECAR_SUFFIX = ".manifest.json"
_SOURCE_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")


class FullBackupError(RuntimeError):
    """Raised when a full backup cannot be proven complete and recoverable."""


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _atomic_json(path: Path, payload: dict[str, Any], mode: int = 0o600) -> None:
    temporary = path.with_name(path.name + ".tmp-" + secrets.token_hex(4))
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if os.name != "nt":
        os.chmod(temporary, mode)
    os.replace(temporary, path)


def generate_key(path: str | Path) -> Path:
    target = Path(path).expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        raise FullBackupError("Key file already exists")
    encoded = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii") + "\n"
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="ascii") as stream:
        stream.write(encoded)
    if os.name != "nt":
        os.chmod(target, 0o600)
    return target


def _read_key(path: str | Path) -> bytes:
    key_path = Path(path).expanduser().resolve()
    try:
        raw = key_path.read_text(encoding="ascii").strip()
    except OSError as exc:
        raise FullBackupError(f"Backup key cannot be read: {exc}") from exc
    try:
        key = bytes.fromhex(raw) if len(raw) == 64 else base64.urlsafe_b64decode(raw)
    except (ValueError, base64.binascii.Error) as exc:
        raise FullBackupError("Backup key must be 32-byte hex or URL-safe base64") from exc
    if len(key) != 32:
        raise FullBackupError("Backup key must decode to exactly 32 bytes")
    return key


def _encrypt_file(source: Path, target: Path, key: bytes) -> None:
    nonce = secrets.token_bytes(NONCE_SIZE)
    size_bytes = struct.pack(">Q", source.stat().st_size)
    header = MAGIC + nonce + size_bytes
    temporary = target.with_name(target.name + ".tmp-" + secrets.token_hex(4))
    encryptor = Cipher(algorithms.AES(key), modes.GCM(nonce)).encryptor()
    encryptor.authenticate_additional_data(header)
    try:
        with source.open("rb") as src, temporary.open("wb") as dst:
            dst.write(header)
            for chunk in iter(lambda: src.read(CHUNK_SIZE), b""):
                dst.write(encryptor.update(chunk))
            dst.write(encryptor.finalize())
            dst.write(encryptor.tag)
            dst.flush()
            os.fsync(dst.fileno())
        if os.name != "nt":
            os.chmod(temporary, 0o600)
        os.replace(temporary, target)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def _decrypt_file(source: Path, target: Path, key: bytes) -> None:
    total = source.stat().st_size
    if total < HEADER_SIZE + TAG_SIZE:
        raise FullBackupError("Encrypted bundle is truncated")
    with source.open("rb") as src:
        header = src.read(HEADER_SIZE)
        if header[: len(MAGIC)] != MAGIC:
            raise FullBackupError("This is not a SoduWork full backup")
        nonce = header[len(MAGIC): len(MAGIC) + NONCE_SIZE]
        expected_size = struct.unpack(">Q", header[-8:])[0]
        cipher_size = total - HEADER_SIZE - TAG_SIZE
        if cipher_size != expected_size:
            raise FullBackupError("Encrypted bundle size does not match its header")
        src.seek(-TAG_SIZE, os.SEEK_END)
        tag = src.read(TAG_SIZE)
        src.seek(HEADER_SIZE)
        decryptor = Cipher(algorithms.AES(key), modes.GCM(nonce, tag)).decryptor()
        decryptor.authenticate_additional_data(header)
        remaining = cipher_size
        try:
            with target.open("wb") as dst:
                while remaining:
                    chunk = src.read(min(CHUNK_SIZE, remaining))
                    if not chunk:
                        raise FullBackupError("Encrypted bundle ended unexpectedly")
                    remaining -= len(chunk)
                    dst.write(decryptor.update(chunk))
                dst.write(decryptor.finalize())
        except InvalidTag as exc:
            target.unlink(missing_ok=True)
            raise FullBackupError("Backup authentication failed: wrong key or damaged bundle") from exc


def _safe_relative(value: str) -> PurePosixPath:
    path = PurePosixPath(value)
    if (not value or "\\" in value or path.is_absolute()
            or any(part in ("", ".", "..") for part in path.parts)):
        raise FullBackupError(f"Unsafe backup path: {value!r}")
    return path


def _parse_sources(values: Iterable[str]) -> list[tuple[str, Path]]:
    result: list[tuple[str, Path]] = []
    seen: set[str] = set()
    for raw in values:
        if "=" not in raw:
            raise FullBackupError("Each source must use NAME=PATH")
        name, value = raw.split("=", 1)
        name = name.strip().lower()
        if not _SOURCE_RE.fullmatch(name) or name in seen or name == "database":
            raise FullBackupError(f"Invalid or duplicate source name: {name!r}")
        path = Path(value).expanduser().resolve()
        if not path.exists():
            raise FullBackupError(f"Backup source does not exist: {path}")
        seen.add(name)
        result.append((name, path))
    return result


def _copy_stable(source: Path, blob_root: Path) -> tuple[str, int, os.stat_result]:
    for _attempt in range(3):
        before = source.stat(follow_symlinks=False)
        if not source.is_file() or source.is_symlink():
            raise FullBackupError(f"Only regular files are supported: {source}")
        temporary = blob_root / (".copy-" + secrets.token_hex(8))
        digest = hashlib.sha256()
        size = 0
        try:
            with source.open("rb") as src, temporary.open("wb") as dst:
                for chunk in iter(lambda: src.read(CHUNK_SIZE), b""):
                    digest.update(chunk)
                    size += len(chunk)
                    dst.write(chunk)
            after = source.stat(follow_symlinks=False)
            if before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns:
                temporary.unlink(missing_ok=True)
                continue
            checksum = digest.hexdigest()
            blob = blob_root / checksum
            if blob.exists():
                if blob.stat().st_size != size:
                    raise FullBackupError("Content-addressed blob collision detected")
                temporary.unlink(missing_ok=True)
            else:
                os.replace(temporary, blob)
            return checksum, size, after
        finally:
            temporary.unlink(missing_ok=True)
    raise FullBackupError(f"Source kept changing while being copied: {source}")


def _safe_symlink_target(relative: str, target: str) -> None:
    link = PurePosixPath(relative)
    wanted = PurePosixPath(target.replace("\\", "/"))
    windows_target = PureWindowsPath(target)
    if not target or wanted.is_absolute() or windows_target.is_absolute() or windows_target.drive:
        raise FullBackupError(f"Symbolic link leaves its source: {relative!r}")
    parts: list[str] = list(link.parent.parts)
    for part in wanted.parts:
        if part in ("", "."):
            continue
        if part == "..":
            if not parts:
                raise FullBackupError(f"Symbolic link leaves its source: {relative!r}")
            parts.pop()
        else:
            parts.append(part)


def _snapshot_source(name: str, root: Path, blob_root: Path,
                     entries: list[dict[str, Any]]) -> dict[str, Any]:
    start = len(entries)
    total = 0
    empty_dirs: list[str] = []
    if root.is_symlink():
        raise FullBackupError(f"Backup source cannot be a symbolic link: {root}")
    if root.is_file():
        files = [(root.name, root)]
    else:
        files: list[tuple[str, Path]] = []
        for current, dirs, names in os.walk(root, followlinks=False):
            dirs.sort()
            names.sort()
            current_path = Path(current)
            for directory in list(dirs):
                link = current_path / directory
                if link.is_symlink():
                    dirs.remove(directory)
                    relative = link.relative_to(root).as_posix()
                    target = os.readlink(link)
                    _safe_relative(relative)
                    _safe_symlink_target(relative, target)
                    entries.append({"source": name, "path": relative,
                                    "kind": "symlink", "target": target})
            if not dirs and not names:
                relative_dir = current_path.relative_to(root).as_posix()
                if relative_dir != ".":
                    empty_dirs.append(relative_dir)
            for filename in names:
                source = current_path / filename
                relative = source.relative_to(root).as_posix()
                if source.is_symlink():
                    target = os.readlink(source)
                    _safe_symlink_target(relative, target)
                    entries.append({"source": name, "path": relative,
                                    "kind": "symlink", "target": target})
                else:
                    files.append((relative, source))
    for relative, source in files:
        _safe_relative(relative)
        checksum, size, stat = _copy_stable(source, blob_root)
        total += size
        entries.append({"source": name, "path": relative, "kind": "file", "blob": checksum,
                        "size": size, "mode": int(stat.st_mode & 0o777),
                        "mtimeNs": int(stat.st_mtime_ns)})
    return {"name": name, "files": len(entries) - start, "bytes": total,
            "emptyDirs": sorted(empty_dirs)}


async def _postgres_snapshot_backup(
    database_url: str,
    output_dir: Path,
) -> tuple[dict[str, str], dict[str, Any]]:
    engine = create_async_engine(database_url)
    try:
        async with engine.connect() as connection:
            async with connection.begin():
                await connection.execute(text(
                    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
                ))
                snapshot = str((await connection.execute(
                    text("SELECT pg_export_snapshot()")
                )).scalar_one())
                revision = (await connection.execute(text(
                    "SELECT version_num FROM alembic_version LIMIT 1"
                ))).scalar_one_or_none() or ""
                rows = (await connection.execute(text(
                    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
                ))).scalars().all()
                counts: dict[str, int] = {}
                for table in rows:
                    quoted = str(table).replace('"', '""')
                    counts[str(table)] = int((await connection.execute(
                        text(f'SELECT count(*) FROM "{quoted}"')
                    )).scalar_one())
                result = await asyncio.to_thread(
                    backup_database, database_url, output_dir, snapshot=snapshot,
                )
                return result, {"schemaRevision": str(revision), "tableCounts": counts}
    finally:
        await engine.dispose()


def _sqlite_inventory(database_url: str) -> dict[str, Any]:
    url = make_url(database_url)
    path = Path(url.database or "")
    with closing(sqlite3.connect(path)) as connection:
        tables = [row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )]
        counts = {name: int(connection.execute(
            'SELECT count(*) FROM "' + name.replace('"', '""') + '"'
        ).fetchone()[0]) for name in tables}
        try:
            revision = str(connection.execute("SELECT version_num FROM alembic_version").fetchone()[0])
        except (sqlite3.Error, TypeError):
            revision = ""
    return {"schemaRevision": revision, "tableCounts": counts}


def _add_bytes(archive: tarfile.TarFile, name: str, data: bytes) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = 0o600
    info.mtime = 0
    archive.addfile(info, io.BytesIO(data))


def create_bundle(*, database_url: str, sources: Iterable[str], output: str | Path,
                  key_file: str | Path, release: str = "",
                  work_dir: str | Path | None = None) -> dict[str, Any]:
    destination = Path(output).expanduser().resolve()
    if destination.exists() or destination.with_name(destination.name + SIDECAR_SUFFIX).exists():
        raise FullBackupError("Backup output already exists")
    destination.parent.mkdir(parents=True, exist_ok=True)
    parsed_sources = _parse_sources(sources)
    key = _read_key(key_file)
    backup_id = "soduwork-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + secrets.token_hex(4)
    temp_parent = Path(work_dir).expanduser().resolve() if work_dir else destination.parent
    temp_parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="soduwork-full-", dir=temp_parent) as temporary_name:
        temporary = Path(temporary_name)
        blob_root = temporary / "blobs"
        blob_root.mkdir()
        database_root = temporary / "database"
        database_backend = make_url(database_url).get_backend_name()
        if database_backend == "postgresql":
            database_result, inventory = asyncio.run(
                _postgres_snapshot_backup(database_url, database_root)
            )
        else:
            database_result = backup_database(database_url, database_root)
            inventory = _sqlite_inventory(
                "sqlite:///" + Path(database_result["backup"]).as_posix()
            )
        entries: list[dict[str, Any]] = []
        source_meta = [_snapshot_source("database", database_root, blob_root, entries)]
        for name, path in parsed_sources:
            source_meta.append(_snapshot_source(name, path, blob_root, entries))
        blob_meta = [{"sha256": path.name, "size": path.stat().st_size}
                     for path in sorted(blob_root.iterdir()) if not path.name.startswith(".")]
        manifest = {
            "formatVersion": FORMAT_VERSION, "product": "SoduWork", "kind": "full-backup",
            "backupId": backup_id, "createdAt": _utc_now(), "release": release.strip(),
            "consistency": {"database": "transactional-logical-backup",
                            "files": "stable-file-snapshot"},
            "database": {"backupName": Path(database_result["backup"]).name,
                         "manifestName": Path(database_result["manifest"]).name, **inventory},
            "sources": source_meta,
            "entries": sorted(entries, key=lambda item: (item["source"], item["path"])),
            "blobs": blob_meta,
            "stats": {"files": len(entries),
                      "logicalBytes": sum(int(item.get("size") or 0) for item in entries),
                      "uniqueBlobs": len(blob_meta),
                      "storedBytes": sum(int(item["size"]) for item in blob_meta)},
        }
        manifest_bytes = json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        plain_tar = temporary / "bundle.tar"
        with tarfile.open(plain_tar, "w", format=tarfile.PAX_FORMAT) as archive:
            _add_bytes(archive, "manifest.json", manifest_bytes)
            for blob in blob_meta:
                archive.add(blob_root / blob["sha256"], arcname="blobs/" + blob["sha256"], recursive=False)
        _encrypt_file(plain_tar, destination, key)
    sidecar = {
        "formatVersion": FORMAT_VERSION, "product": "SoduWork",
        "kind": "full-backup-envelope", "backupId": backup_id,
        "createdAt": manifest["createdAt"], "release": manifest["release"],
        "cipher": "AES-256-GCM", "filename": destination.name,
        "size": destination.stat().st_size, "sha256": _sha256(destination),
        "stats": manifest["stats"],
    }
    sidecar_path = destination.with_name(destination.name + SIDECAR_SUFFIX)
    try:
        _atomic_json(sidecar_path, sidecar)
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    return {"backup": str(destination), "manifest": str(sidecar_path), **sidecar}


def _load_sidecar(bundle: Path) -> dict[str, Any]:
    path = bundle.with_name(bundle.name + SIDECAR_SUFFIX)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise FullBackupError(f"Backup envelope manifest cannot be read: {exc}") from exc
    if payload.get("filename") != bundle.name:
        raise FullBackupError("Backup envelope filename does not match")
    if int(payload.get("size") or -1) != bundle.stat().st_size:
        raise FullBackupError("Backup envelope size does not match")
    if payload.get("sha256") != _sha256(bundle):
        raise FullBackupError("Backup envelope checksum does not match")
    return payload


def _validate_tar(archive: tarfile.TarFile) -> tuple[dict[str, Any], dict[str, tarfile.TarInfo]]:
    members: dict[str, tarfile.TarInfo] = {}
    for member in archive.getmembers():
        _safe_relative(member.name)
        if member.name in members or not member.isfile():
            raise FullBackupError("Bundle contains duplicate or non-file entries")
        if member.name != "manifest.json" and not re.fullmatch(r"blobs/[0-9a-f]{64}", member.name):
            raise FullBackupError(f"Unexpected bundle member: {member.name}")
        members[member.name] = member
    manifest_member = members.get("manifest.json")
    if not manifest_member or manifest_member.size > 32 * 1024 * 1024:
        raise FullBackupError("Bundle manifest is missing or unreasonably large")
    stream = archive.extractfile(manifest_member)
    if not stream:
        raise FullBackupError("Bundle manifest cannot be read")
    try:
        manifest = json.loads(stream.read().decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise FullBackupError("Bundle manifest is invalid") from exc
    if manifest.get("formatVersion") != FORMAT_VERSION or manifest.get("kind") != "full-backup":
        raise FullBackupError("Unsupported full backup format")
    declared = {str(item.get("sha256")): int(item["size"]) if "size" in item else -1
                for item in manifest.get("blobs") or []}
    referenced: set[str] = set()
    logical_paths: set[tuple[str, str]] = set()
    for entry in manifest.get("entries") or []:
        _safe_relative(str(entry.get("path") or ""))
        source_name = str(entry.get("source") or "")
        if not _SOURCE_RE.fullmatch(source_name):
            raise FullBackupError("Bundle contains an invalid source name")
        logical_path = (source_name, str(entry["path"]))
        if logical_path in logical_paths:
            raise FullBackupError("Bundle contains a duplicate logical path")
        logical_paths.add(logical_path)
        kind = str(entry.get("kind") or "file")
        if kind == "symlink":
            _safe_symlink_target(str(entry["path"]), str(entry.get("target") or ""))
        elif kind == "file":
            checksum = str(entry.get("blob") or "")
            entry_size = int(entry["size"]) if "size" in entry else -1
            if checksum not in declared or entry_size != declared[checksum]:
                raise FullBackupError("Bundle entry does not match its declared blob")
            referenced.add(checksum)
        else:
            raise FullBackupError("Bundle entry has an unsupported kind")
    if referenced != set(declared):
        raise FullBackupError("Bundle contains unreferenced or missing blobs")
    source_names: set[str] = set()
    for source in manifest.get("sources") or []:
        name = str(source.get("name") or "")
        if not _SOURCE_RE.fullmatch(name) or name in source_names:
            raise FullBackupError("Bundle contains an invalid or duplicate source")
        source_names.add(name)
        for relative in source.get("emptyDirs") or []:
            _safe_relative(str(relative))
    if {name for name, _path in logical_paths} - source_names:
        raise FullBackupError("Bundle entry refers to an undeclared source")
    for checksum, expected_size in declared.items():
        member = members.get("blobs/" + checksum)
        if not member or member.size != expected_size:
            raise FullBackupError(f"Bundle blob is missing or has the wrong size: {checksum}")
        source = archive.extractfile(member)
        if not source:
            raise FullBackupError("Bundle blob cannot be read")
        digest = hashlib.sha256()
        for chunk in iter(lambda: source.read(CHUNK_SIZE), b""):
            digest.update(chunk)
        if digest.hexdigest() != checksum:
            raise FullBackupError(f"Bundle blob checksum failed: {checksum}")
    return manifest, members


def _materialize(archive: tarfile.TarFile, manifest: dict[str, Any],
                 members: dict[str, tarfile.TarInfo], target: Path) -> None:
    target.mkdir(parents=True, exist_ok=True)
    for source in manifest.get("sources") or []:
        name = str(source.get("name") or "")
        source_root = target / name
        source_root.mkdir(parents=True, exist_ok=True)
        for relative in source.get("emptyDirs") or []:
            safe = _safe_relative(str(relative))
            (source_root.joinpath(*safe.parts)).mkdir(parents=True, exist_ok=True)
    for entry in manifest.get("entries") or []:
        if str(entry.get("kind") or "file") != "file":
            continue
        safe = _safe_relative(str(entry["path"]))
        destination = (target / str(entry["source"])).joinpath(*safe.parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        source = archive.extractfile(members["blobs/" + str(entry["blob"])])
        if not source:
            raise FullBackupError("Bundle blob cannot be materialized")
        with destination.open("wb") as output:
            shutil.copyfileobj(source, output, CHUNK_SIZE)
        if os.name != "nt":
            os.chmod(destination, int(entry.get("mode") or 0o600) & 0o777)
        timestamp = int(entry.get("mtimeNs") or 0)
        os.utime(destination, ns=(timestamp, timestamp))
    for entry in manifest.get("entries") or []:
        if str(entry.get("kind") or "file") != "symlink":
            continue
        safe = _safe_relative(str(entry["path"]))
        destination = (target / str(entry["source"])).joinpath(*safe.parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        os.symlink(str(entry["target"]), destination)
    _atomic_json(target / "manifest.json", manifest)


def _verify_database_member(archive: tarfile.TarFile, manifest: dict[str, Any],
                            members: dict[str, tarfile.TarInfo], temporary: Path) -> None:
    database = manifest.get("database") or {}
    wanted = {str(database.get("backupName") or ""), str(database.get("manifestName") or "")}
    found = {str(item["path"]): item for item in manifest.get("entries") or []
             if item.get("source") == "database" and str(item.get("path") or "") in wanted}
    if len(found) != 2 or "" in wanted:
        raise FullBackupError("Database backup members are incomplete")
    for name, entry in found.items():
        source = archive.extractfile(members["blobs/" + str(entry["blob"])])
        if not source:
            raise FullBackupError("Database backup member cannot be read")
        with (temporary / name).open("wb") as output:
            shutil.copyfileobj(source, output, CHUNK_SIZE)
    try:
        verify_backup(temporary / str(database["backupName"]))
    except BackupError as exc:
        raise FullBackupError(f"Embedded database backup failed verification: {exc}") from exc


def _with_plain_bundle(bundle: Path, key: bytes, callback):
    with tempfile.TemporaryDirectory(prefix="soduwork-verify-", dir=bundle.parent) as temporary_name:
        temporary = Path(temporary_name)
        plain = temporary / "bundle.tar"
        _decrypt_file(bundle, plain, key)
        try:
            with tarfile.open(plain, "r") as archive:
                manifest, members = _validate_tar(archive)
                _verify_database_member(archive, manifest, members, temporary)
                return callback(archive, manifest, members, temporary)
        except tarfile.TarError as exc:
            raise FullBackupError(f"Backup archive is invalid: {exc}") from exc


def verify_bundle(bundle_path: str | Path, key_file: str | Path) -> dict[str, Any]:
    bundle = Path(bundle_path).expanduser().resolve()
    if not bundle.is_file():
        raise FullBackupError("Backup bundle does not exist")
    sidecar = _load_sidecar(bundle)
    key = _read_key(key_file)

    def result(_archive, manifest, _members, _temporary):
        if sidecar.get("backupId") != manifest.get("backupId"):
            raise FullBackupError("Encrypted bundle and envelope manifest do not belong together")
        return {"ok": True, "backupId": manifest.get("backupId"),
                "createdAt": manifest.get("createdAt"), "release": manifest.get("release"),
                "schemaRevision": (manifest.get("database") or {}).get("schemaRevision"),
                "tables": len((manifest.get("database") or {}).get("tableCounts") or {}),
                "sources": len(manifest.get("sources") or []), **(manifest.get("stats") or {})}

    return _with_plain_bundle(bundle, key, result)


def extract_bundle(bundle_path: str | Path, key_file: str | Path, target_path: str | Path,
                   *, confirm_target: str) -> dict[str, Any]:
    bundle = Path(bundle_path).expanduser().resolve()
    target = Path(target_path).expanduser().resolve()
    if str(target) != confirm_target:
        raise FullBackupError("Restore confirmation must exactly match the target directory")
    if target.exists() and any(target.iterdir()):
        raise FullBackupError("Restore target must be empty")
    _load_sidecar(bundle)
    key = _read_key(key_file)

    def materialize(archive, manifest, members, _temporary):
        try:
            _materialize(archive, manifest, members, target)
        except Exception:
            if target.exists():
                shutil.rmtree(target)
            raise
        return {"ok": True, "target": str(target), "backupId": manifest.get("backupId")}

    return _with_plain_bundle(bundle, key, materialize)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="SoduWork encrypted full backup operations")
    commands = root.add_subparsers(dest="command", required=True)
    keygen = commands.add_parser("keygen", help="create a new 256-bit backup key")
    keygen.add_argument("--output", required=True)
    create = commands.add_parser("create", help="create an encrypted, verified full backup")
    create.add_argument("--database-url", default="")
    create.add_argument("--source", action="append", default=[])
    create.add_argument("--output", required=True)
    create.add_argument("--key-file", required=True)
    create.add_argument("--release", default="")
    create.add_argument("--work-dir", default="")
    verify = commands.add_parser("verify", help="verify envelope, encryption, blobs and database")
    verify.add_argument("backup")
    verify.add_argument("--key-file", required=True)
    extract = commands.add_parser("extract", help="restore files into an empty confirmed directory")
    extract.add_argument("backup")
    extract.add_argument("--key-file", required=True)
    extract.add_argument("--target", required=True)
    extract.add_argument("--confirm-target", required=True)
    return root


def main() -> None:
    args = parser().parse_args()
    try:
        if args.command == "keygen":
            print(json.dumps({"ok": True, "key": str(generate_key(args.output))}))
        elif args.command == "create":
            database_url = args.database_url
            if not database_url:
                from .config import get_settings
                database_url = get_settings().database_url
            print(json.dumps(create_bundle(
                database_url=database_url, sources=args.source, output=args.output,
                key_file=args.key_file, release=args.release, work_dir=args.work_dir or None,
            ), ensure_ascii=False))
        elif args.command == "verify":
            print(json.dumps(verify_bundle(args.backup, args.key_file), ensure_ascii=False))
        else:
            print(json.dumps(extract_bundle(
                args.backup, args.key_file, args.target, confirm_target=args.confirm_target,
            ), ensure_ascii=False))
    except (FullBackupError, BackupError) as exc:
        raise SystemExit(str(exc)) from exc


if __name__ == "__main__":
    main()
