"""Public module behavior and service contracts."""
from __future__ import annotations

import codecs
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid

log = __import__("logging").getLogger("uvicorn.error")

_WIN = os.name == "nt"
_LOCK = threading.Lock()
_TERMS: dict[str, "Term"] = {}          # Index terminals by task and mode so reconnects reuse the same session.
_THREADS: set = set()                   # Keep strong references to terminal reader threads.

_SCROLLBACK = 200_000                   # Character replay buffer for reconnecting clients.
_IDLE_CLOSE_S = 30 * 60                 # Close terminals after this interval without subscribers or activity.
_LOG_MAX = 4_000_000                    # Bound persisted terminal history by removing its oldest portion.
_KEEP = 1_000_000








def _log_dir() -> str:
    # Runner sets SODUWORK_DATA_ROOT before importing services.  Keeping terminal
    # replay beside the runner archive avoids silently writing back to the
    # backend/user profile and also works for locked-down desktop accounts.
    from .local_base import _data_root
    d = os.path.join(_data_root(), "terms")
    os.makedirs(d, exist_ok=True)
    return d


def _cmd_dir() -> str:
    """Writable, normally space-free home for short-lived Windows launchers."""
    d = os.path.join(os.environ.get("SODUWORK_TERM_TMP") or tempfile.gettempdir(),
                     "soduwork-terms")
    os.makedirs(d, exist_ok=True)
    return d


def _log_path(tid: str, mode: str = "shell") -> str:
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in (tid or "x"))[:80]
    return os.path.join(_log_dir(), safe + "." + (mode or "shell") + ".log")


def _log_append(tid: str, data: str, mode: str = "shell") -> None:
    try:
        p = _log_path(tid, mode)
        with open(p, "a", encoding="utf-8", errors="replace") as f:
            f.write(data)
        if os.path.getsize(p) > _LOG_MAX:        # Remove the oldest half when the history exceeds its bound.
            with open(p, encoding="utf-8", errors="replace") as f:
                f.seek(os.path.getsize(p) - _KEEP)
                keep = f.read()
            with open(p, "w", encoding="utf-8", errors="replace") as f:
                f.write(keep)
    except Exception:  # noqa: BLE001
        pass


def _log_tail(tid: str, n: int = _SCROLLBACK, mode: str = "shell") -> str:
    try:
        p = _log_path(tid, mode)
        size = os.path.getsize(p)
        with open(p, encoding="utf-8", errors="replace") as f:
            if size > n:
                f.seek(size - n)
                f.readline()
            return f.read()
    except Exception:  # noqa: BLE001
        return ""


def _cmd_exe() -> str:
    """Return a resolvable command processor even when Electron trims PATH.

    Packaged Electron applications do not always inherit ``System32`` in PATH.
    ``pywinpty`` resolves the executable itself, so using the bare ``cmd.exe``
    then fails before a PTY is created.  Prefer the OS-provided absolute paths;
    keep the short name only as a last-resort compatibility fallback.
    """
    comspec = os.environ.get("ComSpec") or os.environ.get("COMSPEC") or ""
    system_root = (os.environ.get("SystemRoot") or os.environ.get("SYSTEMROOT")
                   or r"C:\Windows")
    found = shutil.which("cmd.exe") or ""
    for path in (comspec, os.path.join(system_root, "System32", "cmd.exe"), found):
        path = os.path.abspath(os.path.expandvars(path)) if path else ""
        if path and os.path.isfile(path):
            return path
    return "cmd.exe"


def default_shell() -> list[str]:
    """Choose an appropriate interactive shell for the host platform."""
    if _WIN:
        ps = shutil.which("powershell.exe") or shutil.which("powershell")
        return [ps, "-NoLogo"] if ps else [_cmd_exe()]
    sh = os.environ.get("SHELL") or shutil.which("bash") or "/bin/sh"
    return [sh, "-l"]


def session_argv(cli_sid: str, ws: str, cli: str = "opencode") -> list[str] | None:
    """Technical contract for session argv."""
    from .local_base import _PROFILES
    prof = _PROFILES.get((cli or "").strip() or "opencode")
    if not (prof and cli_sid):
        return None
    exe = prof["bin"]()
    flag = prof.get("session_flag")
    if not (exe and flag):
        return None
    argv = [exe, *flag, cli_sid]
    # Pi runs through Node, so prepend its cli.js entry point.
    pre = prof.get("argv_prefix")
    if pre:
        argv = [exe, *pre(), *flag, cli_sid]
    return argv


class Term:
    """PTY session with a replay buffer and live output delivery to every subscriber."""

    def __init__(self, tid: str, ws: str, cols: int, rows: int, env: dict | None,
                 argv: list[str] | None = None, mode: str = "shell", cli: str = ""):
        self.id = uuid.uuid4().hex[:8]
        self.tid = tid
        self.ws = ws
        self.mode = mode                 # session attaches to the task's CLI session; shell opens an ordinary command line.
        # Store the CLI identity explicitly.
        # A Node-based invocation alone may not reveal which runtime it starts.
        self.cli = cli
        self.argv = argv or default_shell()
        self.cols, self.rows = cols, rows
        # Load the preceding terminal segment when opening a new terminal.
        # Explain interruptions so replayed history and the new session are distinguishable.
        old = _log_tail(tid, mode=mode)
        self.buf = ((old + "\r\n\x1b[90m─── 上面是上一段终端的记录。"
                     "后端重启/异常退出会让终端里的 shell 一起结束（连同里面正跑的命令）；"
                     "下面是新开的一段，目录不变。要不怕重启的，把活「派」给 AI 跑。"
                     " ───\x1b[0m\r\n\r\n") if old.strip() else "")
        self.subs: set = set()          # Each subscriber accepts text or None, which signals terminal closure.
        self.alive = True
        self.started = time.time()
        self.last = time.time()
        self.exit_code: int | None = None
        self._dec = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self._proc = None               # winpty.PtyProcess
        self._fd = None                 # POSIX master fd
        self._popen = None              # POSIX Popen
        self._cmdfile = ""              # Temporary Windows startup script removed during terminal cleanup.
        self._start(env or {})

    # Process startup.
    def _start(self, env: dict) -> None:
        argv = self.argv
        if _WIN:
            from winpty import PtyProcess
            # ConPTY may inherit a legacy Windows code page.
            # Switch the terminal to UTF-8 before starting the CLI.
            # This preserves non-ASCII filenames throughout nested shell commands.
            #
            # Write the command to a temporary .cmd file instead of passing a composed command-line string to spawn.

            # pywinpty PtyProcess.spawn(str) first applies shlex.split(posix=False),
            # which preserves surrounding quotes, and then list2cmdline() escapes those quotes again.
            # This makes executable paths containing spaces invalid in either form:
            # quoted paths retain quotes in the token, which list2cmdline escapes as literal quotes;
            # unquoted paths are split at spaces by shlex.
            # Both forms give cmd an invalid executable path.
            # Paths under %APPDATA%\npm may avoid spaces, masking this quoting problem,
            # while a Node executable under C:\Program Files\nodejs contains spaces.
            # A temporary .cmd file avoids this double parsing of executable paths.
            self._cmdfile = _win_cmd_file(argv, self.id)
            self._proc = PtyProcess.spawn(_cmd_exe() + " /c " + self._cmdfile,
                                          dimensions=(self.rows, self.cols),
                                          cwd=self.ws, env=env or None)
        else:
            import pty
            master, slave = pty.openpty()
            self._fd = master
            self._popen = subprocess.Popen(
                argv, stdin=slave, stdout=slave, stderr=slave, cwd=self.ws,
                env=env or None, close_fds=True,
                # Create a separate session so the PTY is the controlling terminal and cleanup can address its process group.
                start_new_session=True)
            os.close(slave)
            self._set_winsize_posix()
        th = threading.Thread(target=self._reader, name="pty:" + self.id, daemon=True)
        _THREADS.add(th)
        th.start()

    def _set_winsize_posix(self) -> None:
        import fcntl
        import struct
        import termios
        try:
            fcntl.ioctl(self._fd, termios.TIOCSWINSZ,
                        struct.pack("HHHH", self.rows, self.cols, 0, 0))
        except Exception:  # noqa: BLE001
            pass

    # Terminal reader thread.
    def _reader(self) -> None:
        """Perform blocking PTY reads in a dedicated thread; reading on the event loop would stall
        the whole service while awaiting output.
        """
        while True:
            try:
                if _WIN:
                    chunk = self._proc.read(65536)       # Blocking read; process termination raises EOFError.
                    data = chunk if isinstance(chunk, str) else self._dec.decode(chunk)
                else:
                    raw = os.read(self._fd, 65536)
                    if not raw:
                        break
                    data = self._dec.decode(raw)
            except (EOFError, OSError):
                break
            except Exception as e:  # noqa: BLE001
                log.warning("终端读出错 %s: %s", self.id, type(e).__name__)
                break
            if not data:
                continue
            _log_append(self.tid, data, self.mode)   # Persist output for replay after backend termination.
            with _LOCK:
                self.buf = (self.buf + data)[-_SCROLLBACK:]
                self.last = time.time()
                subs = list(self.subs)
            for fn in subs:
                try:
                    fn(data)
                except Exception:  # noqa: BLE001
                    pass
        self._finish()

    def _finish(self) -> None:
        with _LOCK:
            if not self.alive:
                return
            self.alive = False
            subs = list(self.subs)
        try:
            self.exit_code = (self._popen.wait(timeout=3) if self._popen
                              else (self._proc.exitstatus if self._proc else None))
        except Exception:  # noqa: BLE001
            pass
        for fn in subs:
            try:
                fn(None)                 # None tells subscribers that the terminal has ended.
            except Exception:  # noqa: BLE001
                pass

    # Input, resize, and cleanup.
    def write(self, data: str) -> None:
        if not self.alive or not data:
            return
        self.last = time.time()
        try:
            if _WIN:
                self._proc.write(data)
            else:
                os.write(self._fd, data.encode("utf-8", "replace"))
        except Exception as e:  # noqa: BLE001
            log.warning("终端写失败 %s: %s", self.id, type(e).__name__)

    def resize(self, cols: int, rows: int) -> None:
        cols, rows = max(20, min(500, int(cols))), max(5, min(200, int(rows)))
        if (cols, rows) == (self.cols, self.rows):
            return
        self.cols, self.rows = cols, rows
        try:
            if _WIN:
                self._proc.setwinsize(rows, cols)
            else:
                self._set_winsize_posix()
        except Exception:  # noqa: BLE001
            pass

    def close(self) -> None:
        """Close the entire terminal process tree, including commands started under the shell, to
        avoid orphan processes.
        """
        if self._cmdfile:
            try:
                os.remove(self._cmdfile)     # Remove the temporary startup script during cleanup.
            except Exception:  # noqa: BLE001
                pass
            self._cmdfile = ""
        try:
            if _WIN:
                pid = getattr(self._proc, "pid", None)
                if pid:
                    subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)],
                                   capture_output=True, timeout=20)
                else:
                    self._proc.terminate(force=True)
            elif self._popen is not None:
                import signal
                try:
                    os.killpg(os.getpgid(self._popen.pid), signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    self._popen.kill()
        except Exception as e:  # noqa: BLE001
            log.warning("关终端失败 %s: %s", self.id, type(e).__name__)
        self._finish()
        with _LOCK:
            k = _key(self.tid, self.mode)
            if _TERMS.get(k) is self:
                _TERMS.pop(k, None)

    # Subscriptions.
    def subscribe(self, fn) -> str:
        with _LOCK:
            self.subs.add(fn)
            return self.buf                  # Replay buffered output before delivering new activity.

    def unsubscribe(self, fn) -> None:
        with _LOCK:
            self.subs.discard(fn)

    def info(self) -> dict:
        return {"id": self.id, "taskId": self.tid, "workDir": self.ws,
                "alive": self.alive, "cols": self.cols, "rows": self.rows,
                "started": self.started, "exit": self.exit_code,
                # Display the complete command, shortening only long path components.
                # Truncating the argument list can omit a session ID.
                # That would misleadingly suggest the console is unattached.
                # Keep the displayed command useful for diagnostics.
                "mode": self.mode, "cli": self.cli, "cmd": _cmd_brief(self.argv),
                "shell": " ".join(default_shell()),
                "viewers": len(self.subs)}


def _win_cmd_file(argv: list, term_id: str) -> str:
    """Write the terminal command to a temporary .cmd file in a path without spaces to avoid spawn
    quoting issues. Use the current ANSI encoding before chcp takes effect, with a logged UTF-8
    fallback for unsupported characters.
    """
    # Do not put this launcher in _log_dir(): a configured work/data root may
    # contain spaces.  pywinpty reparses its command string and cannot reliably
    # execute `cmd /c <launcher with spaces>` (the original Pi terminal bug).
    d = _cmd_dir()
    safe = re.sub(r"[^A-Za-z0-9_-]", "", str(term_id))[:24] or "t"
    path = os.path.join(d, "cmd-" + safe + ".cmd")
    line = " ".join(('"%s"' % a) if (" " in a or not a) else a for a in argv)
    body = "@echo off\r\nchcp 65001 >nul\r\n" + line + "\r\n"
    try:
        with open(path, "w", encoding="mbcs") as f:
            f.write(body)
    except (UnicodeEncodeError, LookupError):
        log.warning("终端启动脚本里有非 ANSI 字符，改用 UTF-8 写（路径带中文时可能起不来）")
        with open(path, "w", encoding="utf-8") as f:
            f.write(body)
    return path


def _cmd_brief(argv: list) -> str:
    """Display all command arguments while shortening absolute paths to filenames."""
    out = []
    for a in (argv or []):
        a = str(a)
        out.append(os.path.basename(a) if (os.sep in a and os.path.isabs(a)) else a)
    return " ".join(out)[:300]


def _key(tid: str, mode: str) -> str:
    """Key terminals by task and mode so opening a shell does not replace the session console or
    its running commands.
    """
    return tid + "|" + (mode or "shell")


def get(tid: str, mode: str = "shell") -> Term | None:
    with _LOCK:
        return _TERMS.get(_key(tid, mode))


def open_term(tid: str, ws: str, cols: int = 100, rows: int = 30,
              env: dict | None = None, mode: str = "shell",
              cli_sid: str = "", cli: str = "") -> Term:
    """Get or create one terminal per task and mode. session attaches to the runtime conversation
    when possible; otherwise return a shell and accurately report the effective mode.
    """
    t = get(tid, mode)
    if t and t.alive:
        t.resize(cols, rows)
        return t
    if not ws or not os.path.isdir(ws):
        ws = os.path.expanduser("~")
    argv, real_mode = None, "shell"
    if mode == "session":
        argv = session_argv(cli_sid, ws, cli)
        real_mode = "session" if argv else "shell"
    t = Term(tid, ws, cols, rows, env, argv, real_mode, cli if real_mode == "session" else "")
    with _LOCK:
        _TERMS[_key(tid, real_mode)] = t
    log.info("开终端 %s（任务 %s，形态 %s，目录 %s）", t.id, tid, real_mode, ws)
    return t


def close_term(tid: str, wipe_log: bool = False, mode: str = "") -> bool:
    """Close the task's terminal for one mode, or both modes when unspecified."""
    t = None
    for m in ([mode] if mode else ["session", "shell"]):
        x = get(tid, m)
        if x:
            t = t or x
            x.close()
    if wipe_log:
        for m in ("session", "shell"):
            try:
                os.remove(_log_path(tid, m))
            except OSError:
                pass
    return bool(t)


async def sweep_loop(interval: int = 300) -> None:
    """Periodically close inactive terminals without subscribers to release shells and workspace
    handles.
    """
    import asyncio
    while True:
        try:
            await asyncio.sleep(interval)
            n = await asyncio.to_thread(sweep)
            if n:
                log.info("收掉 %d 个闲置终端", n)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.warning("终端清扫出错: %s", type(e).__name__)


def sweep() -> int:
    """Close inactive, unsubscribed terminals."""
    n = 0
    with _LOCK:
        stale = [t for t in _TERMS.values()
                 if not t.subs and time.time() - t.last > _IDLE_CLOSE_S]
    for t in stale:
        t.close()
        n += 1
    return n


def available() -> tuple[bool, str]:
    """Report whether this host can open a terminal and explain unavailable dependencies before
    WebSocket connection attempts.
    """
    if _WIN:
        try:
            import winpty  # noqa: F401
            cmd = _cmd_exe()
            if not os.path.isfile(cmd):
                return False, "这台电脑找不到 Windows 命令处理器（cmd.exe）"
            return True, ""
        except Exception:  # noqa: BLE001
            return False, ("这台机器上没装 pywinpty（Windows 的 ConPTY 封装），"
                           "后端装一下就能用：pip install pywinpty")
    if sys.platform.startswith(("linux", "darwin")):
        return True, ""
    return False, f"当前系统 {sys.platform} 还没适配终端"
