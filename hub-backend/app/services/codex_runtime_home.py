"""Per-conversation Codex CLI state isolation for SoduWork Runner.

The Codex desktop app and Codex CLI normally share ``~/.codex``. Running both
against that directory lets system-skill installation and plugin-cache writes
race each other. Managed Windows filesystem filters then turn some atomic
replaces into ``os error 17``/``4395``. SoduWork gives every conversation a stable
private CODEX_HOME and imports only the user's login file -- never personal
hooks, MCP configuration, caches, or session history.
"""
from __future__ import annotations

import logging
import errno
import hashlib
import json
import os
import re
import stat
import uuid

from . import durable_file

log = logging.getLogger("uvicorn.error")

_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


class CodexLoginError(RuntimeError):
    """Public diagnostics contain categories and system codes, never file bytes."""

    def __init__(self, reason: str, error_type: str, system_code: int | None = None):
        self.reason = reason
        self.code = "CODEX_LOGIN_UNREADABLE"
        diagnostic = error_type if re.fullmatch(r"[A-Za-z]+Error", error_type) else "RuntimeError"
        if isinstance(system_code, int):
            diagnostic += ", system=" + str(system_code)
        detail = ("当前 Runner 无法解析登录文件内容" if reason == "source-format" else
                  "当前 Runner 无权读取或无法访问登录文件")
        super().__init__("Codex 登录文件无法读取（" + detail + "；" + diagnostic +
                         "）。可在 Agent 管理中打开「连接 Codex」并选择「使用独立授权」，完成后新建对话；"
                         "已有对话保留原登录目录，也可检查 Runner 的文件访问/保护策略。")


def _is_reparse(path: str) -> bool:
    try:
        info = os.lstat(path)
    except OSError:
        return False
    return bool(getattr(info, "st_reparse_tag", 0)) or stat.S_ISLNK(info.st_mode)


def _remove_reparse(path: str) -> None:
    # POSIX directory symlinks use unlink; Windows directory junctions use rmdir.
    if os.path.isdir(path) and not os.path.islink(path):
        os.rmdir(path)
    else:
        os.unlink(path)


def clean_skills(env: dict) -> None:
    """Remove reparse points without following them into their targets."""
    home = str(env.get("CODEX_HOME") or "").strip() or \
        os.path.join(os.path.expanduser("~"), ".codex")
    skills_dir = os.path.join(home, "skills")
    try:
        if _is_reparse(skills_dir):
            _remove_reparse(skills_dir)
            return
        if not os.path.isdir(skills_dir):
            return
        for entry in os.scandir(skills_dir):
            if _is_reparse(entry.path):
                _remove_reparse(entry.path)
    except OSError as exc:
        log.warning("codex 技能目录排雷失败（不拦派活）: %s", type(exc).__name__)


def _folder(ref: str) -> str:
    raw = str(ref or "").strip()
    if not raw:
        return "shared"
    readable = _SAFE.sub("-", raw).strip("._-")[:40] or "session"
    digest = uuid.uuid5(uuid.NAMESPACE_URL, "soduwork-codex:" + raw).hex[:10]
    return readable + "-" + digest


def _write_login(path: str, data: bytes, *, exclusive=False) -> None:
    flags = os.O_WRONLY | os.O_CREAT | (os.O_EXCL if exclusive else os.O_TRUNC)
    fd = os.open(path, flags, 0o600)
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        with open(path, "rb") as saved:
            if saved.read() != data:
                raise OSError("Codex login state verification failed")
    except BaseException:
        if exclusive:
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass
        raise


def _replace_login(temporary: str, target: str, data: bytes) -> None:
    try:
        os.replace(temporary, target)
        return
    except OSError as exc:
        # Some managed Windows filesystems reject rename even when both
        # files are on the same drive. WinError 2 is also reported while the
        # source demonstrably still exists. Do not swallow actual missing
        # paths, permission errors, or disk failures.
        compatible = exc.errno == errno.EXDEV or (os.name == "nt" and
            getattr(exc, "winerror", None) in (2, 17))
        if not compatible or not os.path.isfile(temporary) or not os.path.isdir(os.path.dirname(target)):
            raise
    if _is_reparse(target):
        raise OSError("Codex login target must not be a link")
    try:
        with open(target, "rb") as previous:
            before = previous.read()
    except FileNotFoundError:
        before = None
    # This is a private per-conversation home, synchronized BEFORE launching
    # Codex. No native process can observe an incomplete first login. Every
    # subsequent preparation compares bytes, so an interrupted replacement
    # is repaired rather than mistaken for a newer, valid login by mtime.
    try:
        _write_login(target, data, exclusive=before is None)
    except OSError:
        if before is not None:
            _write_login(target, before)
        raise


def _sync_auth(source_home: str, runtime_home: str) -> None:
    """Synchronize only current login state before starting native Codex.

    A hard link is not usable on machines where transparent encryption exposes
    the two user-profile areas as different volumes. The destination inherits
    the same per-user AppData ACL as SoduWork's other private runtime state.
    """
    source = os.path.join(source_home, "auth.json")
    target = os.path.join(runtime_home, "auth.json")
    marker = os.path.join(runtime_home, ".soduwork-auth-source")
    try:
        with open(source, "rb") as handle:
            data = handle.read()
    except FileNotFoundError:
        return
    except OSError as exc:
        raise CodexLoginError("source-access", type(exc).__name__,
                              getattr(exc, "winerror", None) or exc.errno) from None
    try:
        source_login = json.loads(data)
        if not isinstance(source_login, dict) or not source_login:
            raise ValueError("Login state must be an object")
    except (UnicodeError, ValueError) as exc:
        # Decoder exceptions retain source bytes. Suppress their traceback
        # context so Runner logs cannot expose any credential fragments.
        raise CodexLoginError("source-format", type(exc).__name__) from None
    digest = hashlib.sha256(data).hexdigest().encode("ascii")
    try:
        imported = durable_file.read_bytes(marker)
    except FileNotFoundError:
        imported = None
    try:
        if _is_reparse(target):
            raise RuntimeError("Codex 登录文件位置异常，请检查隔离工作目录")
        with open(target, "rb") as existing:
            current = existing.read()
        try:
            parsed = json.loads(current)
            complete = isinstance(parsed, dict) and bool(parsed)
        except (UnicodeError, ValueError):
            complete = False
        # Native Codex may refresh its OAuth token inside the isolated home.
        # Keep that newer token while the source login has not changed. A
        # source fingerprint also detects an explicit re-login even if a
        # restored source file carries an older modification timestamp.
        legacy_newer = imported is None and os.stat(target).st_mtime_ns >= os.stat(source).st_mtime_ns
        if complete and (current == data or imported == digest or legacy_newer):
            if imported != digest:
                durable_file.write_bytes(marker, digest)
            return
    except FileNotFoundError:
        pass
    temporary = os.path.join(runtime_home, ".auth-" + uuid.uuid4().hex[:16] + ".json")
    try:
        _write_login(temporary, data, exclusive=True)
        _replace_login(temporary, target, data)
        durable_file.write_bytes(marker, digest)
    except OSError as exc:
        raise RuntimeError("无法准备 Codex 登录文件，请检查本机文件访问策略和磁盘后重试") from exc
    finally:
        try:
            if os.path.isfile(temporary):
                os.unlink(temporary)
        except OSError:
            pass


def prepare(env: dict, data_root: str, ref: str = "") -> str:
    """Select a stable private home for one SoduWork conversation."""
    from . import codex_account_home
    source_home = str(env.get("CODEX_HOME") or "").strip() or \
        os.path.join(os.path.expanduser("~"), ".codex")
    root = os.path.join(os.path.abspath(data_root), "agents", "codex")
    runtime_home = os.path.join(root, _folder(ref))
    selected = codex_account_home.runtime_home(data_root, runtime_home)
    if not selected:
        _sync_auth(source_home, runtime_home)
    env["CODEX_HOME"] = selected or runtime_home
    if selected:
        env["CODEX_SQLITE_HOME"] = selected
    internal_temp = os.path.join(runtime_home, ".soduwork-tmp")
    os.makedirs(internal_temp, exist_ok=True)
    env["TEMP"] = env["TMP"] = env["TMPDIR"] = internal_temp
    if not selected:
        clean_skills(env)
    return env["CODEX_HOME"]


__all__ = ["CodexLoginError", "clean_skills", "prepare"]
