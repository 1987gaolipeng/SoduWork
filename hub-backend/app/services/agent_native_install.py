"""Verified native Agent downloads used by Runner-owned installers.

The Claude Code native installer publishes a version endpoint and a checksum
manifest for every supported platform. This module mirrors that small,
reviewable part of the official installer instead of executing a remote shell
script. The downloaded executable is kept in the current Runner data root so
multiple Runner instances on one computer never replace each other's binary.
"""
from __future__ import annotations

import hashlib
import http.client
import json
import os
import platform
import re
import shutil
import stat
import ssl
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import managed_agent_network


CLAUDE_RELEASES = "https://downloads.claude.ai/claude-code-releases"
_VERSION = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")
_CHECKSUM = re.compile(r"^[0-9a-fA-F]{64}$")
# Current Claude releases are roughly 300 MB; keep headroom without allowing unbounded downloads.
_MAX_BINARY = 512 * 1024 * 1024
_MAX_JSON = 2 * 1024 * 1024


def _platform() -> str:
    """Return the release platform identifier used by Anthropic's manifest."""
    machine = platform.machine().lower()
    arm = machine in {"arm64", "aarch64"} or os.environ.get("PROCESSOR_ARCHITEW6432", "").lower() == "arm64"
    x64 = machine in {"amd64", "x86_64", "x64"} or os.environ.get("PROCESSOR_ARCHITEW6432", "").lower() in {"amd64", "x86_64", "x64"}
    if os.name == "nt":
        if platform.architecture()[0] == "32bit":
            raise RuntimeError("Claude Code native installation requires 64-bit Windows")
        if not (arm or x64):
            raise RuntimeError(f"Unsupported Windows architecture: {machine or 'unknown'}")
        return "win32-arm64" if arm else "win32-x64"
    if os.sys.platform == "darwin":
        if not (arm or x64):
            raise RuntimeError(f"Unsupported macOS architecture: {machine or 'unknown'}")
        return "darwin-arm64" if arm else "darwin-x64"
    if os.sys.platform == "linux":
        if not (arm or x64):
            raise RuntimeError(f"Unsupported Linux architecture: {machine or 'unknown'}")
        arch = "arm64" if arm else "x64"
        libc = ""
        try:
            libc = platform.libc_ver()[0].lower()
            if not libc and any(Path(p).exists() for p in ("/lib/libc.musl-x86_64.so.1", "/lib/libc.musl-aarch64.so.1")):
                libc = "musl"
        except OSError:
            pass
        return f"linux-{arch}-musl" if "musl" in libc else f"linux-{arch}"
    raise RuntimeError(f"Unsupported platform: {os.sys.platform}")


def _read_url(url: str, *, limit: int, timeout: int = 60) -> bytes:
    for attempt in range(3):
        request = urllib.request.Request(url, headers={"User-Agent": "SoduWork-Agent-Installer/1"})
        try:
            # Share live Windows proxy discovery with the other managed Agents.
            # A retry starts a fresh response; partial binaries are never activated.
            with managed_agent_network.open_download(request, timeout=timeout) as response:
                length = response.headers.get("Content-Length")
                if length and int(length) > limit:
                    raise RuntimeError("The vendor download is larger than the safety limit")
                data = bytearray()
                while True:
                    chunk = response.read(min(1024 * 1024, limit - len(data) + 1))
                    if not chunk:
                        break
                    data.extend(chunk)
                    if len(data) > limit:
                        raise RuntimeError("The vendor download is larger than the safety limit")
                if length and len(data) != int(length):
                    raise http.client.IncompleteRead(bytes(data), int(length) - len(data))
                return bytes(data)
        except (OSError, urllib.error.URLError, http.client.IncompleteRead) as exc:
            reason = exc.reason if isinstance(exc, urllib.error.URLError) else exc
            retryable = not isinstance(reason, ssl.SSLError)
            if isinstance(exc, urllib.error.HTTPError):
                retryable = exc.code in {408, 429, 500, 502, 503, 504}
                exc.close()
            if not retryable or attempt == 2:
                raise RuntimeError("Claude Code 下载失败：" + managed_agent_network.error_label(exc)) from exc
            time.sleep(attempt + 1)


def _latest() -> str:
    value = _read_url(f"{CLAUDE_RELEASES}/latest", limit=128).decode("utf-8", "replace").strip()
    if not _VERSION.fullmatch(value):
        raise RuntimeError("The Claude release service returned an invalid version")
    return value


def _manifest(version: str, platform_id: str) -> tuple[str, int | None]:
    raw = _read_url(f"{CLAUDE_RELEASES}/{version}/manifest.json", limit=_MAX_JSON)
    try:
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict) or not isinstance(data.get("platforms"), dict):
            raise ValueError("Expected a release manifest object")
        row = ((data or {}).get("platforms") or {}).get(platform_id) or {}
        if not isinstance(row, dict):
            raise ValueError("Expected a platform manifest object")
    except (ValueError, TypeError) as exc:
        raise RuntimeError("The Claude release manifest is invalid") from exc
    if str((data or {}).get("version") or "") != version:
        raise RuntimeError("The Claude release manifest version does not match the requested release")
    checksum = str(row.get("checksum") or "").lower()
    if not _CHECKSUM.fullmatch(checksum):
        raise RuntimeError(f"Claude has no verified binary for {platform_id}")
    size = row.get("size")
    if size is not None and (not isinstance(size, int) or size <= 0 or size > _MAX_BINARY):
        raise RuntimeError("The Claude release manifest has an invalid binary size")
    return checksum, size


def root(data_root: str) -> Path:
    return Path(data_root).expanduser().resolve() / "agent-runtimes" / "native" / "claude"


def active_binary(data_root: str) -> str:
    name = "claude.exe" if os.name == "nt" else "claude"
    target = root(data_root) / "current" / name
    return str(target) if target.is_file() else ""


def _run_version(path: Path) -> str:
    try:
        result = subprocess.run(
            [str(path), "--version"], stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            encoding="utf-8", errors="replace", timeout=20,
            **({"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)} if os.name == "nt" else {}),
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    if result.returncode != 0:
        return ""
    return result.stdout.strip()[:300]


def _download(data_root: str, version: str, emit) -> tuple[bool, str]:
    platform_id = _platform()
    checksum, expected_size = _manifest(version, platform_id)
    blob = _read_url(f"{CLAUDE_RELEASES}/{version}/{platform_id}/{'claude.exe' if os.name == 'nt' else 'claude'}",
                     limit=_MAX_BINARY, timeout=180)
    if expected_size is not None and len(blob) != expected_size:
        raise RuntimeError("Claude's downloaded binary size does not match its manifest")
    if hashlib.sha256(blob).hexdigest().lower() != checksum:
        raise RuntimeError("Claude's downloaded binary failed SHA-256 verification")
    name = "claude.exe" if os.name == "nt" else "claude"
    version_dir = root(data_root) / "versions" / version
    current_dir = root(data_root) / "current"
    version_dir.mkdir(parents=True, exist_ok=True)
    current_dir.mkdir(parents=True, exist_ok=True)
    target = version_dir / name
    fd, temp_name = tempfile.mkstemp(prefix=".claude-", dir=str(version_dir))
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(blob)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, target)
        if os.name != "nt":
            target.chmod(target.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)
    # Validate the staged executable before replacing the active binary. A
    # failed startup check must leave the previous working version intact.
    probe = _run_version(target)
    if not probe:
        raise RuntimeError("Claude downloaded successfully but failed its startup check")
    current_target = current_dir / name
    fd, current_temp = tempfile.mkstemp(prefix=".claude-current-", dir=str(current_dir))
    os.close(fd)
    try:
        shutil.copyfile(target, current_temp)
        if os.name != "nt":
            Path(current_temp).chmod(Path(current_temp).stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        os.replace(current_temp, current_target)
    finally:
        if os.path.exists(current_temp):
            os.unlink(current_temp)
    if not _run_version(current_target):
        raise RuntimeError("Claude's active binary failed its startup check")
    emit(f"Claude Code {probe} is ready")
    return True, probe


def install(data_root: str, action: str, emit=lambda _line: None) -> tuple[bool, str]:
    """Install, update, check, or remove only this Runner's native Claude binary."""
    if action not in {"install", "update", "check", "uninstall"}:
        raise ValueError("Unsupported Claude Code installation action")
    active = active_binary(data_root)
    binary = Path(active) if active else None
    if action == "uninstall":
        target_root = root(data_root)
        try:
            if target_root.exists():
                shutil.rmtree(target_root)
        except OSError as exc:
            return False, "Claude Code removal failed: " + str(exc)[:240]
        if target_root.exists():
            return False, "Claude Code removal did not remove the Runner-owned files"
        return True, "Claude Code removed from this Runner"
    if action == "check":
        latest = _latest()
        current = _run_version(binary) if binary else ""
        return True, f"Latest Claude Code is {latest}; installed version: {current or 'none'}"
    version = _latest()
    emit(f"Downloading verified Claude Code {version} for {_platform()}")
    return _download(data_root, version, emit)


__all__ = ["active_binary", "install", "root"]
