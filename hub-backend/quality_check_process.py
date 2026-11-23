"""Windows ownership for offline checks, including descendants of exited leaders."""
from __future__ import annotations

import base64
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time


def _created_milliseconds(pid: int) -> int:
    from ctypes import wintypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(ctypes.c_ulonglong)] * 4
    kernel.GetProcessTimes.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        values = [ctypes.c_ulonglong() for _ in range(4)]
        if not kernel.GetProcessTimes(handle, *(ctypes.byref(value) for value in values)):
            raise ctypes.WinError(ctypes.get_last_error())
        return (values[0].value - 116444736000000000) // 10000
    finally:
        kernel.CloseHandle(handle)


class WindowsCheckJob:
    """Reuse the desktop's identity-checked, kill-on-close Job owner."""

    def __init__(self) -> None:
        self.process = None
        self.directory = tempfile.TemporaryDirectory(prefix="soduwork-check-job-")
        self.log_path = Path(self.directory.name) / "owner.log"
        self.log = self.log_path.open("wb", buffering=0)

    def _output(self) -> str:
        # A separate handle avoids moving the helper's shared output offset.
        with self.log_path.open("rb") as source:
            return source.read(os.fstat(source.fileno()).st_size).decode("utf-8", "replace")

    def attach(self, process: subprocess.Popen) -> None:
        script = Path(__file__).resolve().parents[1] / "client/main/agent-runtime/windows-process-job.ps1"
        encoded = base64.b64encode(script.read_text(encoding="utf-8").encode("utf-16le")).decode("ascii")
        env = os.environ.copy()
        env["SODUWORK_JOB_PID"] = str(process.pid)
        env["SODUWORK_JOB_CREATED"] = str(_created_milliseconds(process.pid))
        powershell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
        self.process = subprocess.Popen(
            [str(powershell), "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
            stdin=subprocess.PIPE, stdout=self.log, stderr=subprocess.STDOUT,
            env=env, creationflags=subprocess.CREATE_NO_WINDOW,
        )
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            output = self._output()
            if "ready" in output.splitlines() and self.process.poll() is None:
                return
            if self.process.poll() is not None:
                raise RuntimeError("Quality check Job assignment failed: " + output.strip())
            time.sleep(.02)
        raise TimeoutError("Quality check Job assignment timed out")

    def stop(self) -> None:
        try:
            if self.process is not None:
                # EOF requests TerminateJobObject and waits for ActiveProcesses=0.
                try:
                    self.process.stdin.close()
                    code = self.process.wait(timeout=10)
                    if code != 0 or "stopped" not in self._output().splitlines():
                        raise RuntimeError("Quality check Job cleanup failed: " + self._output().strip())
                finally:
                    if self.process.poll() is None:
                        # Closing its non-inherited Job handle kills only our tree.
                        self.process.kill()
                        self.process.wait(timeout=3)
        finally:
            self.log.close()
            self.directory.cleanup()


def _bootstrap(error_path: Path) -> int:
    # The parent sends the command only after Job ownership is confirmed. Before
    # that handshake this trusted process cannot create any command descendants.
    command = sys.stdin.buffer.readline()
    if not command:
        return 1
    args = json.loads(command.decode("utf-8"))
    try:
        process = subprocess.Popen(args, stdin=subprocess.DEVNULL, shell=False)
    except OSError as exc:
        error_path.write_text(json.dumps({
            "errno": exc.errno, "strerror": exc.strerror,
            "filename": exc.filename, "winerror": getattr(exc, "winerror", None),
        }), encoding="utf-8")
        return 1
    return process.wait()


if __name__ == "__main__":
    raise SystemExit(_bootstrap(Path(sys.argv[1])))
