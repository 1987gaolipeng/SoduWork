"""Dependency-free configuration boundary for managed OpenCode subprocesses."""
from __future__ import annotations

import os
from pathlib import Path
import re
import stat
import sys


class OpenCodeEnvironmentError(OSError):
    """An actionable isolation failure without personal paths or credentials."""


def _validate_storage_paths(paths: list[Path], namespace: Path, database: Path, legacy: str) -> None:
    try:
        history_paths = {database, database.resolve()}
        lock_paths = {path.with_name(path.name + ".soduwork-migrate-lock") for path in history_paths}
        databases = history_paths | lock_paths | {path.resolve() for path in lock_paths}
        files = {path.with_name(path.name + suffix) for path in databases
                 for suffix in ("", "-wal", "-shm", "-journal")}
        for path in set(paths) | files:
            if not path.resolve().is_relative_to(namespace):
                raise ValueError("Managed OpenCode storage leaves its namespace")
        # SQLite can write its companions and migration lock before touching
        # history rows, so every known database file needs the same boundary.
        for path in files:
            if path.exists():
                identity = path.stat()
                if not stat.S_ISREG(identity.st_mode) or identity.st_nlink > 1:
                    raise ValueError("Managed OpenCode storage has another file owner")
        source = Path(legacy).expanduser() if legacy else None
        if source is not None and source.is_absolute():
            for path in files:
                if (source.resolve() == path.resolve() or
                        (source.exists() and path.exists() and os.path.samefile(source, path))):
                    raise ValueError("Managed and personal OpenCode storage alias one file")
    except (OSError, RuntimeError, ValueError) as error:
        raise OpenCodeEnvironmentError(
            "OpenCode 受管数据目录或数据库存在不安全的链接或路径。"
            "请修复 Runner 数据目录后重试；个人 OpenCode 数据未改动。") from error


def runner_data_root() -> str:
    """Match the Runner archive root without importing backend services."""
    explicit = str(os.environ.get("SODUWORK_DATA_ROOT") or "").strip()
    if explicit:
        return os.path.abspath(os.path.expanduser(explicit))
    home = os.path.expanduser("~")
    if os.name == "nt":
        return os.path.join(os.environ.get("LOCALAPPDATA") or os.path.join(home, ".soduwork"),
                            "soduwork")
    if sys.platform == "darwin":
        return os.path.join(home, "Library", "Application Support", "soduwork")
    return os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local", "share"),
                        "soduwork")


def prepare_environment(env: dict, data_root: str | None = None) -> None:
    """Isolate managed state, retaining only a read-only legacy migration source."""
    # Pin the root before replacing XDG_DATA_HOME. The standalone ACP child must
    # use exactly the parent's database, including on Linux with a custom XDG root.
    root = Path(data_root or env.get("SODUWORK_OPENCODE_DATA_ROOT") or runner_data_root()).absolute()
    base = root / "agents" / "opencode"
    database = base / "data" / "opencode" / "opencode.db"
    # Resolve the authorized root first so platform aliases and an explicitly
    # redirected Runner root remain valid, while child paths cannot escape.
    try:
        namespace = root.resolve() / "agents" / "opencode"
    except (OSError, RuntimeError) as error:
        raise OpenCodeEnvironmentError("OpenCode 受管数据根目录无法解析，请修复 Runner 数据目录后重试。") from error
    names = {key.upper(): value for key, value in env.items()}
    previous = str(names.get("OPENCODE_DB") or "").strip()
    same_database = (os.path.isabs(previous) and
                     os.path.normcase(os.path.normpath(previous)) == os.path.normcase(os.path.normpath(database)))
    legacy = str(env.get("SODUWORK_OPENCODE_LEGACY_DB") or "")
    if not same_database:
        home = str((env.get("USERPROFILE") if os.name == "nt" else env.get("HOME")) or "").strip()
        home = home or os.path.expanduser("~")
        legacy = previous or str(Path(names.get("XDG_DATA_HOME") or Path(home) / ".local" / "share")
                                 / "opencode" / "opencode.db")
    directories = {key: base / folder for key, folder in (
        ("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data"),
        ("XDG_STATE_HOME", "state"), ("XDG_CACHE_HOME", "cache"))}
    paths = [base, *directories.values(), *[path / "opencode" for path in directories.values()]]
    # Validate every destination before creating directories or publishing env.
    # New sessions need the same protection as history migration.
    _validate_storage_paths(paths, namespace, database, legacy)
    for path in directories.values():
        path.mkdir(parents=True, exist_ok=True)
    database.parent.mkdir(parents=True, exist_ok=True)
    _validate_storage_paths(paths, namespace, database, legacy)
    if not same_database:
        env["SODUWORK_OPENCODE_LEGACY_DB"] = legacy
    env["SODUWORK_OPENCODE_DATA_ROOT"] = str(root)
    # Explicit native overrides bypass XDG_CONFIG_HOME. Managed turns must not
    # merge personal providers, plugins, or settings into their injected config.
    for key in list(env):
        if key.upper() in {"OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_DB",
                           "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"}:
            del env[key]
    for key, path in directories.items():
        env[key] = str(path)
    env["OPENCODE_DB"] = str(database)


def config_error_message(message: str) -> str:
    """Known config parser diagnostics may contain config contents or credentials."""
    text = message.lower()
    if (any(marker in text for marker in (
            "configjsonerror", "configinvaliderror", "endoffileexpected",
            "--- jsonc input ---"))
            or re.search(r"\bconfig file at\b[^\r\n]*\bis not valid json(?:\(c\)|c)?(?=[:\s]|$)", text)):
        return ("OpenCode 执行组件配置无法解析，本轮尚未完成。"
                "请检查 SoduWork 的模型配置或修复执行组件；个人 OpenCode 配置保持不变。")
    return ""
