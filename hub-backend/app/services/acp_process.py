"""Bounded cleanup of ACP-owned processes, private POSIX groups and pipe readers."""
from __future__ import annotations

import os
import signal
import subprocess
import threading
from dataclasses import dataclass


class ProcessCleanupError(RuntimeError):
    pass


@dataclass
class OwnedProcessGroup:
    leader_pid: int
    active: bool = True


def _owned_group(proc: subprocess.Popen, ownership: OwnedProcessGroup | None) -> int | None:
    if os.name == "nt" or ownership is None or not ownership.active:
        return None
    process_group = ownership.leader_pid
    # The caller records this only for Popen(start_new_session=True). Do not
    # discover a group from a PID at shutdown: the leader may have already exited.
    if process_group != proc.pid or process_group <= 1 or process_group == os.getpgrp():
        raise ProcessCleanupError("ACP process group ownership is invalid")
    return process_group


def _signal_group(group: int, sig: int) -> None:
    try:
        os.killpg(group, sig)
    except ProcessLookupError:
        pass  # The entire private group has already exited.


def _finish_group(ownership: OwnedProcessGroup | None, group: int | None) -> None:
    if group is not None:
        _signal_group(group, signal.SIGKILL)
        ownership.active = False  # Repeated close must not signal a recycled PID.


def kill_process_tree(proc: subprocess.Popen, process_group: OwnedProcessGroup | None = None) -> None:
    group = _owned_group(proc, process_group)
    if proc.poll() is not None:
        _finish_group(process_group, group)
        return
    failure = None
    try:
        if os.name == "nt":
            result = subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                timeout=5, check=False)
            if result.returncode != 0 and proc.poll() is None:
                failure = RuntimeError("taskkill exited with " + str(result.returncode))
                proc.kill()
        elif group is not None:
            _signal_group(group, signal.SIGTERM)
        else:
            proc.terminate()
    except (OSError, subprocess.SubprocessError) as exc:
        failure = exc
        try:
            proc.kill()
        except OSError as kill_error:
            failure = kill_error
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        try:
            if group is not None:
                _signal_group(group, signal.SIGKILL)
            else:
                proc.kill()
        except OSError as exc:
            failure = exc
        try:
            proc.wait(timeout=3)
        except (OSError, subprocess.SubprocessError) as exc:
            raise ProcessCleanupError("ACP process cleanup failed: " + str(failure or exc)) from exc
    # A reaped leader does not prove that its children exited. Kill remaining
    # members of the private group before waiting for inherited stdout/stderr.
    _finish_group(process_group, group)


def close_process(proc: subprocess.Popen, readers: list[threading.Thread],
                  process_group: OwnedProcessGroup | None = None) -> None:
    errors = []
    try:
        if proc.stdin:
            proc.stdin.close()
    except BrokenPipeError:
        pass
    except OSError as exc:
        errors.append(exc)
    try:
        kill_process_tree(proc, process_group)
    except (OSError, ProcessCleanupError) as exc:
        errors.append(exc)
    for reader in readers:
        if reader is not threading.current_thread():
            reader.join(timeout=1)
    pending = [reader.name for reader in readers if reader.is_alive()]
    if pending:
        errors.append(ProcessCleanupError("ACP readers still active after process exit: " + ", ".join(pending)))
    else:
        for stream in (proc.stdout, proc.stderr):
            try:
                if stream:
                    stream.close()
            except OSError as exc:
                errors.append(exc)
    if errors:
        raise ProcessCleanupError("ACP process resource cleanup failed: " + str(errors[0])) from errors[0]
