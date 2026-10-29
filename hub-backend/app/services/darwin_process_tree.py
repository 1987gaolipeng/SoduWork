"""Stop an owned macOS sidecar tree, including ACP children with private sessions.

Darwin ps exposes pid/ppid/pgid/uid/stat/lstart (Apple adv_cmds/ps/keyword.c).
Use a fixed C locale and start identity, then freeze known parents before taking
the final descendant snapshot. Never signal a discovered/shared process group.
"""
from __future__ import annotations

from dataclasses import dataclass
import os
import signal
import subprocess
import time


@dataclass(frozen=True)
class Process:
    pid: int
    parent: int
    group: int
    uid: int
    started: str
    state: str


def _query(pid: int | None = None) -> dict[int, Process]:
    selector = ["-p", str(int(pid))] if pid is not None else ["-ax"]
    result = subprocess.run(
        ["/bin/ps", *selector, "-o", "pid=,ppid=,pgid=,uid=,stat=,lstart="],
        env={**os.environ, "LC_ALL": "C", "TZ": "UTC"}, capture_output=True,
        text=True, encoding="utf-8", errors="strict", timeout=2, check=False)
    if pid is not None and result.returncode == 1 and not result.stdout.strip():
        return {}
    if result.returncode != 0:
        raise OSError("Cannot inspect the macOS execution process tree")
    if len(result.stdout) > 8 * 1024 * 1024:
        raise ValueError("Process inventory exceeds the cancellation limit")
    rows = {}
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        fields = line.split(maxsplit=5)
        if len(fields) != 6 or len(fields[5].split()) != 5:
            raise ValueError("Unrecognized macOS process inventory")
        process = Process(int(fields[0]), int(fields[1]), int(fields[2]),
                          int(fields[3]), fields[5], fields[4])
        if process.pid < 1 or process.pid in rows or not process.state:
            raise ValueError("Invalid macOS process identity")
        rows[process.pid] = process
    return rows


def _snapshot() -> dict[int, Process]:
    return _query()


def read_process(pid: int) -> Process | None:
    return _query(pid).get(pid)


def alive(process: Process | None) -> bool:
    return bool(process and process.state[0] not in {"Z", "X"})


def _current(process: Process) -> Process | None:
    current = read_process(process.pid)
    return current if (current and current.started == process.started
                       and current.uid == process.uid) else None


def _send(process: Process, sig: int) -> bool:
    if not alive(_current(process)):
        return False
    try:
        os.kill(process.pid, sig)
        return True
    except ProcessLookupError:
        return False


def kill_owned_tree(pid: int, proc=None) -> None:
    """Keep the private sidecar stopped until all recorded descendants exit."""
    if proc is not None and proc.poll() is not None:
        return
    root = read_process(pid)
    if not alive(root):
        return
    if (pid <= 1 or pid == os.getpid() or root.group != pid
            or root.uid != os.getuid()):
        raise ValueError("Refusing to stop a process outside its private session")
    try:
        if os.getsid(pid) != pid:
            raise ValueError("Refusing to stop a process outside its private session")
    except ProcessLookupError:
        return
    owned = {pid: root}
    resumed: list[Process] = []
    deadline = time.monotonic() + 5
    try:
        while True:
            processes = _snapshot()
            changed = True
            while changed:
                changed = False
                for child in processes.values():
                    parent = owned.get(child.parent)
                    if child.pid not in owned and parent and _current(parent):
                        if child.pid <= 1 or child.pid == os.getpid():
                            raise ValueError("Refusing to stop the calling process")
                        owned[child.pid] = child
                        changed = True
            waiting = False
            for process in list(owned.values()):
                if time.monotonic() > deadline:
                    raise TimeoutError("Could not pause the complete macOS execution tree")
                current = _current(process)
                if not alive(current) or current.state.startswith("T"):
                    continue
                if process not in resumed and _send(process, signal.SIGSTOP):
                    resumed.append(process)
                waiting = True
            if waiting:
                time.sleep(.01)
                continue
            # Every known parent is paused. Catch children created immediately
            # before its stop; a separate ACP session is still a descendant.
            extra = [child for child in _snapshot().values()
                     if child.pid not in owned and child.parent in owned
                     and _current(owned[child.parent])]
            if not extra:
                break
            for child in extra:
                if child.pid <= 1 or child.pid == os.getpid():
                    raise ValueError("Refusing to stop the calling process")
                owned[child.pid] = child

        descendants = [process for process in owned.values() if process.pid != pid]
        for process in reversed(descendants):
            _send(process, signal.SIGKILL)
        deadline = time.monotonic() + 5
        while any(alive(_current(process)) for process in descendants):
            if time.monotonic() > deadline:
                raise TimeoutError("macOS execution descendants did not exit")
            time.sleep(.02)
        _send(root, signal.SIGKILL)
        while alive(_current(root)):
            if time.monotonic() > deadline:
                raise TimeoutError("macOS execution root did not exit")
            time.sleep(.02)
        if proc is not None:
            proc.wait(timeout=1)
    finally:
        # A failed read/permission check must leave neither an unconfirmed stop
        # nor a frozen task. Original stopped processes were never added here.
        for process in resumed:
            try:
                if alive(_current(process)):
                    _send(process, signal.SIGCONT)
            except OSError:
                continue
