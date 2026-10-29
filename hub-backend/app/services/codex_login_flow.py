"""Explicit Codex connection jobs reuse native credentials without reading them."""
from __future__ import annotations

import os
import threading
import time

from . import codex_account_home as account

_LOCK = threading.RLock()
_PENDING: dict[str, tuple[str, threading.Event]] = {}
_SHUTTING_DOWN = threading.Event()


def _identity(data_root: str) -> str:
    return os.path.normcase(os.path.realpath(data_root))


def reserve(jid: str, data_root: str) -> bool:
    """Reserve before spawning so an immediate cancel cannot miss its job."""
    root = _identity(data_root)
    with _LOCK:
        if _SHUTTING_DOWN.is_set() or jid in _PENDING or any(item[0] == root for item in _PENDING.values()):
            return False
        _PENDING[jid] = (root, threading.Event())
    return True


def cancel(jid: str, data_root: str) -> bool:
    with _LOCK:
        current = _PENDING.get(jid)
        if current is None or current[0] != _identity(data_root):
            return False
        current[1].set()
        return True


def shutdown(timeout: float = 8) -> bool:
    """Stop accepting logins and wait briefly for owned authorization cleanup."""
    _SHUTTING_DOWN.set()
    deadline = time.monotonic() + max(0.0, min(8.0, float(timeout)))
    while True:
        # A successful login can hold this lock while committing its account
        # selection. Bound lock acquisition as well as process cleanup waits.
        if not _LOCK.acquire(timeout=max(0.0, deadline - time.monotonic())):
            return False
        try:
            pending = list(_PENDING.values())
            for _, cancelled in pending:
                cancelled.set()
            if not pending:
                return True
        finally:
            _LOCK.release()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        # run() removes its reservation only after the native process cleanup
        # has finished. Do not kill persistent conversation processes here.
        time.sleep(min(remaining, .02))


def environment(data_root: str) -> dict:
    """Match the selected account scope; an ordinary install keeps the user's home."""
    if account.selected_home(data_root):
        return account.environment(data_root, create=True)
    env = dict(os.environ)
    for key in ("NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "CODEX_CONFIG", "DEFAULT_AUTH_REQUEST",
                "MODEL_PROVIDER", "OPENAI_BASE_URL", "OPENAI_MODEL", "SODUWORK_LLM_KEY",
                "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"):
        env.pop(key, None)
    env["CODEX_HOME"] = os.path.abspath(str(os.environ.get("CODEX_HOME") or "").strip()
        or os.path.join(os.path.expanduser("~"), ".codex"))
    env["CODEX_SQLITE_HOME"] = env["CODEX_HOME"]
    return env


def run(jid: str, executable: str, data_root: str, *, publish, execute=None, isolated=False) -> tuple[bool, str, int]:
    """Only explicit missing authentication starts an official device flow."""
    with _LOCK:
        current = _PENDING.get(jid)
    if current is None or current[0] != _identity(data_root):
        return False, "登录任务已结束，请重新检查", 409
    cancelled = current[1]

    def finish(state, detail, code, **extra):
        publish({"state": state, **extra})
        return state == "succeeded", detail, code

    def was_cancelled():
        return finish("cancelled", "已取消 Codex 授权", 130)

    def succeeded(*, reused):
        # Claim the commit point before activating the private account. A cancel
        # acknowledged before this point wins; a later one cannot undo a login.
        with _LOCK:
            aborted = cancelled.is_set()
            if not aborted:
                _PENDING.pop(jid, None)
                if isolated:
                    account.activate(data_root)
        if aborted:
            return was_cancelled()
        return finish("succeeded", "已检测到 Codex 登录，可测试连接；独立授权请新建对话使用" if isolated else
                      "已检测到这台电脑的 Codex 登录，无需重复授权，可测试连接", 0, reused=reused)

    try:
        if cancelled.is_set():
            return was_cancelled()
        publish({"state": "checking"})
        if not executable:
            return finish("failed", "未找到 Codex，请先安装后重新检查", 1)
        env = account.environment(data_root, create=True) if isolated else environment(data_root)
        state, _ = account.status(executable, env)
        if cancelled.is_set():
            return was_cancelled()
        if state == "authed":
            return succeeded(reused=True)
        if state != "unauthed":
            return finish("failed", "暂时无法确认 Codex 登录状态，请重新检查程序和本机访问权限", 1)
        os.makedirs(env["CODEX_HOME"], exist_ok=True)
        expires_at = time.time() + 300
        progress = {"state": "waiting", "expiresAt": expires_at}

        def show(line):
            def accepted(value):
                field = "verificationUrl" if value.startswith("https://") else "userCode"
                progress[field] = value
                if progress.get("verificationUrl") and progress.get("userCode"):
                    publish(dict(progress))
            account.login_progress(line, accepted)

        code = (execute or account._execute)([executable, "login", "--device-auth"],
            env, show, 300, cancel_event=cancelled)
        if cancelled.is_set() or code == 130:
            return was_cancelled()
        if code == 124:
            return finish("expired", "授权等待已超时，请重试获取新的设备码", code)
        if code:
            return finish("failed", "官方授权未完成，请确认网络和授权结果后重试", code)
        state, _ = account.status(executable, env)
        if cancelled.is_set():
            return was_cancelled()
        if state != "authed":
            return finish("failed", "尚未检测到有效登录，请重新检查", 1)
        return succeeded(reused=False)
    except Exception:
        # Credentials and arbitrary native stderr never cross the job boundary.
        return finish("failed", "连接未完成，请检查本机访问权限与网络后重试", 1)
    finally:
        with _LOCK:
            if _PENDING.get(jid) is current:
                _PENDING.pop(jid, None)
