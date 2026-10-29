'''Durable stdio sidecar for one local Agent turn.

The worker is intentionally stdlib-only. It outlives a restarted Runner, keeps
the Agent stdout/stderr attached to ordinary files, and records the exact exit
code. Secrets stay in the inherited process environment and are never written
to the manifest or spool files.
'''
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time

try:
    from . import durable_file
except ImportError:  # direct script entry used by source Runner
    import durable_file


def _close(stream) -> None:
    try:
        os.close(stream.fileno())
    except (OSError, ValueError, AttributeError):
        pass


def _copy(source, destination, done: threading.Event) -> None:
    try:
        while True:
            chunk = os.read(source.fileno(), 64 * 1024)
            if not chunk:
                break
            destination.write(chunk)
            destination.flush()
    except (OSError, ValueError):
        pass
    finally:
        done.set()


def _feed(source, destination) -> None:
    try:
        while True:
            chunk = os.read(source.fileno(), 64 * 1024)
            if not chunk:
                break
            destination.write(chunk)
            destination.flush()
    except (BrokenPipeError, OSError, ValueError):
        pass
    finally:
        try:
            destination.close()
        except (OSError, ValueError):
            pass


def _write_status(path: str, code: int) -> None:
    durable_file.write_bytes(path, (str(int(code)) + '\n').encode('ascii'))


def run(manifest_path: str) -> int:
    manifest_path = os.path.abspath(manifest_path)
    with open(manifest_path, encoding='utf-8') as handle:
        manifest = json.load(handle)
    # The launch manifest is needed only for these few milliseconds. Remove it
    # before the Agent starts so non-secret model/runtime arguments do not linger.
    try:
        os.remove(manifest_path)
    except OSError:
        pass
    argv = [str(value) for value in (manifest.get('argv') or [])]
    if not argv:
        raise ValueError('spool manifest has no argv')
    cwd = os.path.abspath(str(manifest.get('cwd') or os.getcwd()))
    stdout_path = os.path.abspath(str(manifest['stdoutPath']))
    stderr_path = os.path.abspath(str(manifest['stderrPath']))
    status_path = os.path.abspath(str(manifest['statusPath']))
    os.makedirs(os.path.dirname(stdout_path), exist_ok=True)

    with open(stdout_path, 'ab', buffering=0) as stdout_file, \
            open(stderr_path, 'ab', buffering=0) as stderr_file:
        proc = subprocess.Popen(
            argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=cwd, env=os.environ.copy(), bufsize=0)
        if manifest.get('startedPath'):
            try:
                durable_file.write_bytes(str(manifest['startedPath']), (str(time.time()) + '\n').encode('ascii'))
            except (OSError, ValueError):
                # An optional acknowledgement must not abandon the launched
                # child before stdout/stderr draining and process cleanup.
                pass
        out_done = threading.Event()
        err_done = threading.Event()
        threads = [
            threading.Thread(target=_copy, args=(proc.stdout, stdout_file, out_done),
                             name='soduwork-spool-stdout', daemon=True),
            threading.Thread(target=_copy, args=(proc.stderr, stderr_file, err_done),
                             name='soduwork-spool-stderr', daemon=True),
            threading.Thread(target=_feed, args=(sys.stdin.buffer, proc.stdin),
                             name='soduwork-spool-stdin', daemon=True),
        ]
        for thread in threads:
            thread.start()
        code = int(proc.wait())
        if not out_done.wait(2.0):
            _close(proc.stdout)
        if not err_done.wait(0.2):
            _close(proc.stderr)
        out_done.wait(0.5)
        err_done.wait(0.5)
    _write_status(status_path, code)
    return code


def main(manifest_path: str | None = None) -> int:
    path = str(manifest_path or (sys.argv[1] if len(sys.argv) > 1 else '')).strip()
    if not path:
        return 2
    try:
        return run(path)
    except Exception as exc:
        try:
            sys.stderr.write('soduwork spool worker failed: ' + type(exc).__name__ + '\n')
        except Exception:
            pass
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
