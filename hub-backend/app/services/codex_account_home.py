"""Explicit native Codex login without reading or copying account credentials."""
from __future__ import annotations

import os
import queue
import re
import stat
import subprocess
import threading
import time

from . import durable_file

_MODE = b"native-account-v1\n"
_LOCK = threading.RLock()
_LOGINS: set[str] = set()
_ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def _safe(path: str) -> None:
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_reparse_tag", 0):
        raise RuntimeError("Codex 独立登录目录包含链接，请检查 Runner 数据目录")


def _directory(data_root: str, *parts: str, create: bool = False) -> str:
    path = os.path.abspath(data_root)
    for part in parts:
        path = os.path.join(path, part)
        _safe(path)
        if create:
            os.makedirs(path, mode=0o700, exist_ok=True)
    return path


def _selection_file(data_root: str) -> str:
    return os.path.join(_directory(data_root, "agents"), ".codex-account-mode")


def _read_mode(path: str) -> bool:
    _safe(path)
    _safe(path + ".wal")
    try:
        value = durable_file.read_bytes(path)
    except FileNotFoundError:
        return False
    if value != _MODE:
        raise RuntimeError("Codex 独立登录设置无法读取，请在 Agent 管理中重新登录")
    return True


def account_home(data_root: str, *, create: bool = False) -> str:
    return _directory(data_root, "agents", "codex-account", create=create)


def selected_home(data_root: str) -> str:
    """Only a successful explicit host login can select the account home."""
    with _LOCK:
        return account_home(data_root) if _read_mode(_selection_file(data_root)) else ""


def activate(data_root: str) -> None:
    """Select a private account only after its native login has been verified."""
    with _LOCK:
        marker = _selection_file(data_root)
        _safe(marker)
        _safe(marker + ".wal")
        durable_file.write_bytes(marker, _MODE)


def runtime_home(data_root: str, conversation_home: str) -> str:
    """Bind only new conversations; never relocate an existing native journal."""
    with _LOCK:
        parent = _directory(data_root, "agents", "codex", create=True)
        if os.path.normcase(os.path.dirname(conversation_home)) != os.path.normcase(parent):
            raise RuntimeError("Codex 会话目录不属于当前 Runner")
        _safe(conversation_home)
        binding = os.path.join(conversation_home, ".soduwork-account-home")
        if _read_mode(binding):
            return account_home(data_root, create=True)
        if os.path.lexists(binding) or os.path.lexists(binding + ".wal"):
            raise RuntimeError("Codex 会话登录目录设置尚未完成，请检查数据目录后新建对话")
        if os.path.exists(conversation_home):
            return ""
        chosen = selected_home(data_root)
        os.mkdir(conversation_home, mode=0o700)
        if chosen:
            try:
                durable_file.write_bytes(binding, _MODE)
            except BaseException:
                # Remove only this attempt's new, empty directory. A committed
                # marker, WAL, or native journal keeps its original ownership.
                try:
                    os.rmdir(conversation_home)
                except OSError:
                    pass
                raise
            return account_home(data_root, create=True)
        return ""


def environment(data_root: str, *, create: bool = False) -> dict:
    """Build native account process settings without inspecting any auth file."""
    env = dict(os.environ)
    for key in ("NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "CODEX_CONFIG",
                "DEFAULT_AUTH_REQUEST", "MODEL_PROVIDER", "OPENAI_BASE_URL",
                "OPENAI_MODEL", "SODUWORK_LLM_KEY", "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"):
        env.pop(key, None)
    env["CODEX_HOME"] = account_home(data_root, create=create)
    env["CODEX_SQLITE_HOME"] = env["CODEX_HOME"]
    return env


def status(executable: str, env: dict) -> tuple[str, str]:
    from .cli_account_auth import probe
    return probe("codex", executable, env=env)


def login_progress(line: str, say) -> None:
    """Expose only the official verification URL and bounded one-time code."""
    value = _ANSI.sub("", str(line)).strip()
    if value in {"https://auth.openai.com/codex/device", "https://auth.openai.com/device"}:
        say(value)
    elif re.fullmatch(r"[A-Z0-9]{4,6}-[A-Z0-9]{4,6}", value):
        say(value)


def _execute(argv: list[str], env: dict, emit, timeout: int, *, cancel_event=None) -> int:
    from .acp_process import OwnedProcessGroup, close_process
    flags = ({"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
             if os.name == "nt" else {"start_new_session": True})
    process = subprocess.Popen(argv, env=env, cwd=env["CODEX_HOME"],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", bufsize=1, **flags)
    ownership = OwnedProcessGroup(process.pid) if os.name != "nt" else None
    lines = queue.Queue(maxsize=64)
    stopped = threading.Event()
    def publish(value):
        while not stopped.is_set():
            try:
                lines.put(value, timeout=0.1)
                return
            except queue.Full:
                pass
    def read():
        try:
            while not stopped.is_set():
                line = process.stdout.readline(4096)
                if not line:
                    break
                publish(line)
        finally:
            publish(None)
    reader = threading.Thread(target=read, daemon=True, name="codex-device-login")
    reader.start()
    deadline = time.monotonic() + timeout
    expired, cancelled, eof, exited_at = False, False, False, None
    try:
        while True:
            if cancel_event is not None and cancel_event.is_set():
                cancelled = True
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                expired = True
                break
            try:
                line = lines.get(timeout=min(remaining, 0.1))
                if line is None:
                    eof = True
                else:
                    emit(line)
            except queue.Empty:
                pass
            if process.poll() is not None:
                exited_at = exited_at or time.monotonic()
                if eof or time.monotonic() - exited_at >= 0.5:
                    break
    finally:
        stopped.set()
        # The shared lifecycle helper bounds reader shutdown even if a failed
        # child or inherited pipe outlives the original process.
        close_process(process, [reader], ownership)
    return 130 if cancelled else 124 if expired else int(process.returncode or 0)


def login(executable: str, data_root: str, *, say, execute=None,
          status=None, timeout: int = 300) -> tuple[bool, str, int]:
    """Run an explicitly requested device login; activate only after verification."""
    identity = os.path.normcase(os.path.realpath(data_root))
    with _LOCK:
        if identity in _LOGINS:
            return False, "Codex 登录正在进行，请完成已有授权后重试", 409
        _LOGINS.add(identity)
    try:
        if not executable:
            return False, "请先安装 Codex，再登录账号", 1
        env = environment(data_root, create=True)
        # A device login must be confirmed by its own persisted account, not
        # by an unrelated environment API key already available to the host.
        env.pop("OPENAI_API_KEY", None)
        env.pop("CODEX_API_KEY", None)
        argv = [executable, "login", "--device-auth"]
        say("请在下方官方地址输入设备码，完成 Codex 授权。五分钟内未完成会结束本次登录。")
        code = (execute or _execute)(argv, env,
            lambda line: login_progress(line, say), max(1, min(300, timeout)))
        if code:
            return False, ("Codex 登录超时，尚未切换账号目录；可重新点击登录" if code == 124 else
                           "Codex 官方登录未完成，请确认网络和授权后重试；账号目录未切换"), code
        checker = status or globals()["status"]
        if checker(executable, env)[0] != "authed":
            return False, "Codex 登录尚未通过本机验证，账号目录未切换", 1
        activate(data_root)
        return True, "Codex 独立账号已登录。请新建对话使用；已有对话保留原登录目录。", 0
    except Exception:
        # Never forward a credential decoder context or raw child stderr.
        return False, "Codex 独立登录未完成，请检查本机访问权限与网络后重试；账号目录未切换", 1
    finally:
        with _LOCK:
            _LOGINS.discard(identity)
