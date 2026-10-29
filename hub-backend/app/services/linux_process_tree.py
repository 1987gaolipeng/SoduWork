"""Stop one owned Linux process tree, including children that call setsid()."""
from __future__ import annotations

import os
from pathlib import Path
import signal
import time
from dataclasses import dataclass


@dataclass(frozen=True)
class Process:
    pid: int
    parent: int
    group: int
    session: int
    started: int
    state: str


def read_process(pid: int) -> Process | None:
    try:
        # comm may contain spaces or ')'; the remaining fields start at state.
        fields = (Path('/proc') / str(pid) / 'stat').read_text().rsplit(') ', 1)[1].split()
        return Process(pid, int(fields[1]), int(fields[2]), int(fields[3]),
                       int(fields[19]), fields[0])
    except (FileNotFoundError, ProcessLookupError):
        return None


def alive(process: Process | None) -> bool:
    return bool(process and process.state not in {'Z', 'X', 'x'})


def _current(process: Process) -> Process | None:
    current = read_process(process.pid)
    return current if current and current.started == process.started else None


def _send(process: Process, sig: int) -> bool:
    if not alive(_current(process)):
        return False
    try:
        os.kill(process.pid, sig)
        return True
    except ProcessLookupError:
        return False


def _snapshot() -> dict[int, Process]:
    processes = {}
    for entry in Path('/proc').iterdir():
        if entry.name.isdecimal():
            process = read_process(int(entry.name))
            if process:
                processes[process.pid] = process
    return processes


def kill_owned_tree(pid: int, proc=None) -> None:
    """Freeze, collect and kill a private sidecar tree before acknowledging stop.

    ACP vendors and terminals own separate sessions. Signalling only the outer
    PGID misses them. Keep ancestors paused while collecting descendants so they
    cannot launch a replacement during cancellation. Identity checks prevent a
    stale snapshot from targeting an unrelated process that reused a PID.
    """
    if proc is not None and proc.poll() is not None:
        return
    root = read_process(pid)
    if not alive(root):
        return
    if pid <= 1 or pid == os.getpid() or root.group != pid or root.session != pid:
        raise ValueError('Refusing to stop a process outside its private session')
    owned: dict[int, Process] = {pid: root}
    resumed: list[Process] = []
    deadline = time.monotonic() + 3
    try:
        while True:
            # Snapshot before pausing: a child can have been created immediately
            # before SIGSTOP. Repeat after all known parents actually stop.
            processes = _snapshot()
            changed = True
            while changed:
                changed = False
                for child in processes.values():
                    parent = owned.get(child.parent)
                    if child.pid not in owned and parent and _current(parent):
                        if child.pid <= 1 or child.pid == os.getpid():
                            raise ValueError('Refusing to stop the calling process')
                        owned[child.pid] = child
                        changed = True
            waiting = False
            for process in list(owned.values()):
                current = _current(process)
                if not alive(current) or current.state in {'T', 't'}:
                    continue
                if process not in resumed and _send(process, signal.SIGSTOP):
                    resumed.append(process)
                waiting = True
            if time.monotonic() > deadline:
                raise TimeoutError('Could not pause the complete execution tree')
            if waiting:
                time.sleep(.01)
                continue
            # Every known live parent is stopped. One final scan catches the
            # last child it could have started before its stop was delivered.
            extra = [p for p in _snapshot().values()
                     if p.parent in owned and p.pid not in owned
                     and _current(owned[p.parent])]
            if not extra:
                break
            for process in extra:
                if process.pid <= 1 or process.pid == os.getpid():
                    raise ValueError('Refusing to stop the calling process')
                owned[process.pid] = process

        # The spool root's exit is observed as a terminal by another thread.
        # Keep it paused until all descendants have really exited: delivery of
        # SIGKILL alone does not mean an uninterruptible child has stopped yet.
        descendants = [process for process in owned.values() if process.pid != pid]
        errors = []
        for process in reversed(descendants):
            try:
                _send(process, signal.SIGKILL)
            except OSError as error:
                errors.append(error)
        if errors:
            raise errors[0]
        deadline = time.monotonic() + 3
        while any(alive(_current(process)) for process in descendants):
            if time.monotonic() > deadline:
                raise TimeoutError('Execution descendants did not exit after cancellation')
            time.sleep(.01)
        _send(root, signal.SIGKILL)
        deadline = time.monotonic() + 3
        while alive(_current(root)):
            if time.monotonic() > deadline:
                raise TimeoutError('Execution root did not exit after cancellation')
            time.sleep(.01)
        if proc is not None:
            proc.wait(timeout=1)
    finally:
        # A permission/read failure must not leave a partially paused task stuck.
        for process in resumed:
            try:
                if alive(_current(process)):
                    _send(process, signal.SIGCONT)
            except OSError:
                continue
