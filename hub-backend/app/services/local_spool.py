'''Durable output channel shared by the backend and standalone Runner.'''
from __future__ import annotations

import json
import os
import sys
import time
import uuid
from typing import Callable

from . import durable_file


def prepare(run_dir: str, argv: list[str], cwd: str) -> tuple[dict, list[str]]:
    token = uuid.uuid4().hex[:16]
    names = {
        'stdout': 'stream-%s.stdout' % token,
        'stderr': 'stream-%s.stderr' % token,
        'status': 'stream-%s.status' % token,
        'started': 'stream-%s.started' % token,
        'manifest': 'stream-%s.json' % token,
    }
    paths = {key: os.path.join(run_dir, value) for key, value in names.items()}
    for key in ('stdout', 'stderr'):
        with open(paths[key], 'wb'):
            pass
    manifest = {
        'argv': [str(value) for value in argv],
        'cwd': os.path.abspath(cwd),
        'stdoutPath': paths['stdout'],
        'stderrPath': paths['stderr'],
        'statusPath': paths['status'],
        'startedPath': paths['started'],
    }
    with open(paths['manifest'], 'w', encoding='utf-8') as handle:
        json.dump(manifest, handle, ensure_ascii=False)
    spec = {
        'version': 1, 'id': token, **names,
        'offsets': {'out': 0, 'err': 0},
    }
    if getattr(sys, 'frozen', False):
        launch = [sys.executable, '--soduwork-spool-worker', paths['manifest']]
    else:
        worker = os.path.join(os.path.dirname(__file__), 'local_spool_worker.py')
        launch = [sys.executable, worker, paths['manifest']]
    return spec, launch


def _path(run_dir: str, spec: dict, key: str) -> str:
    name = os.path.basename(str((spec or {}).get(key) or ''))
    return os.path.join(run_dir, name) if name else ''


def recoverable(run_dir: str, spec: dict) -> bool:
    return bool(int((spec or {}).get('version') or 0) >= 1
                and _path(run_dir, spec, 'stdout')
                and os.path.isfile(_path(run_dir, spec, 'stdout'))
                and os.path.isfile(_path(run_dir, spec, 'stderr')))


def status_code(run_dir: str, spec: dict) -> int | None:
    path = _path(run_dir, spec, 'status')
    try:
        return int(durable_file.read_bytes(path).decode('ascii').strip())
    except (FileNotFoundError, OSError, TypeError, ValueError):
        return None


def started_at(run_dir: str, spec: dict) -> float:
    """Written by the sidecar only after the Agent child successfully launches."""
    try:
        value = float(durable_file.read_bytes(_path(run_dir, spec, 'started')).decode('ascii').strip())
        return value if 0 < value <= time.time() + 60 else 0
    except (FileNotFoundError, OSError, TypeError, ValueError):
        return 0


class _Reader:
    def __init__(self, path: str, offset: int, stream: str,
                 callback: Callable[[str, str, int], None]):
        self.handle = open(path, 'rb')
        self.offset = max(0, int(offset or 0))
        try:
            self.offset = min(self.offset, os.path.getsize(path))
        except OSError:
            self.offset = 0
        self.handle.seek(self.offset)
        self.buffer = b''
        self.buffer_start = self.offset
        self.stream = stream
        self.callback = callback

    def pump(self, final: bool = False) -> bool:
        moved = False
        chunk = self.handle.read(64 * 1024)
        if chunk:
            self.buffer += chunk
            moved = True
        while True:
            pos = self.buffer.find(b'\n')
            if pos < 0:
                break
            raw = self.buffer[:pos + 1]
            self.buffer = self.buffer[pos + 1:]
            self.buffer_start += len(raw)
            self.callback(self.stream, raw.decode('utf-8', 'replace'), self.buffer_start)
        if final and self.buffer:
            raw = self.buffer
            self.buffer = b''
            self.buffer_start += len(raw)
            self.callback(self.stream, raw.decode('utf-8', 'replace'), self.buffer_start)
            moved = True
        self.offset = self.buffer_start
        return moved

    def close(self) -> None:
        try:
            self.handle.close()
        except OSError:
            pass


def follow(run_dir: str, spec: dict, callback: Callable[[str, str, int], None], *,
           proc=None, pid: int | None = None,
           pid_alive: Callable[[int | None], bool] | None = None,
           should_continue: Callable[[], bool] | None = None,
           on_tick: Callable[[], None] | None = None,
           grace_seconds: float = 1.0) -> tuple[int | None, str]:
    offsets = dict((spec or {}).get('offsets') or {})
    readers = [
        _Reader(_path(run_dir, spec, 'stdout'), offsets.get('out', 0), 'out', callback),
        _Reader(_path(run_dir, spec, 'stderr'), offsets.get('err', 0), 'err', callback),
    ]
    done_at = 0.0
    last_data = time.monotonic()
    last_tick = 0.0
    code = None
    try:
        while True:
            moved = False
            for reader in readers:
                moved = reader.pump() or moved
            now = time.monotonic()
            if moved:
                last_data = now
            if should_continue is not None and not should_continue():
                return None, 'cancelled'
            disk_code = status_code(run_dir, spec)
            if disk_code is not None:
                code = disk_code
                done_at = done_at or now
            elif proc is not None:
                polled = proc.poll()
                if polled is not None:
                    code = int(polled)
                    done_at = done_at or now
            elif pid_alive is not None and not pid_alive(pid):
                done_at = done_at or now
            if on_tick is not None and now - last_tick >= 1.0:
                last_tick = now
                on_tick()
            if done_at and now - done_at >= 0.1 and now - last_data >= max(0.2, grace_seconds):
                for reader in readers:
                    reader.pump(final=True)
                return code, 'completed' if code is not None else 'status-missing'
            time.sleep(0.05)
    finally:
        for reader in readers:
            reader.close()


def cleanup(run_dir: str, spec: dict) -> None:
    for key in ('stdout', 'stderr', 'status', 'started', 'manifest'):
        path = _path(run_dir, spec, key)
        if key in ('status', 'started') and path:
            try:
                durable_file.remove(path)
            except (OSError, ValueError):
                pass
        candidates = (path + '.tmp',) if key in ('status', 'started') and path else (path, path + '.tmp' if path else '')
        for candidate in candidates:
            if not candidate:
                continue
            try:
                os.remove(candidate)
            except FileNotFoundError:
                pass
            except OSError:
                pass


__all__ = ['prepare', 'recoverable', 'status_code', 'follow', 'cleanup']
