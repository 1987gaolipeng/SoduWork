# -*- coding: utf-8 -*-
'''Durable local-Agent output survives a Runner reader restart.'''
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.services import local_base, local_process, local_spool  # noqa: E402
from app.services.local_base import _pid_alive, _restore_stream_checkpoint  # noqa: E402


def _start_then_exit(target: str) -> int:
    os.makedirs(target, exist_ok=True)
    child = (
        'import time;'
        'time.sleep(0.35);'
        'print(\'survived-parent-exit\',flush=True);'
        'time.sleep(0.35);'
        'print(\'durable-tail\',flush=True)'
    )
    spec, launch = local_spool.prepare(
        target, [sys.executable, '-c', child], target)
    proc = subprocess.Popen(
        launch, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, cwd=target, bufsize=0)
    proc.stdin.close()
    with open(os.path.join(target, 'handoff.json'), 'w', encoding='utf-8') as handle:
        json.dump({'spec': spec, 'pid': proc.pid}, handle)
    return 0


if len(sys.argv) > 2 and sys.argv[1] == '--start-then-exit':
    raise SystemExit(_start_then_exit(os.path.abspath(sys.argv[2])))


passed = failed = 0


def check(name: str, condition: bool, detail='') -> None:
    global passed, failed
    if condition:
        passed += 1
        print('  PASS  ' + name)
    else:
        failed += 1
        print('  FAIL  ' + name + ('  << ' + str(detail) if detail else ''))


work = tempfile.mkdtemp(prefix='soduwork-stream-recovery-')
proc = None
spec = {}
try:
    child_code = (
        'import sys,time;'
        'print(\'alpha\',flush=True);'
        'time.sleep(0.7);'
        'print(\'beta\',flush=True);'
        'sys.stderr.write(\'omega\\n\');sys.stderr.flush()'
    )
    spec, launch = local_spool.prepare(
        work, [sys.executable, '-c', child_code], work)
    proc = subprocess.Popen(
        launch, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, cwd=work, bufsize=0)
    proc.stdin.close()
    seen = []

    def collect(stream, line, end):
        seen.append((stream, line.strip()))
        spec.setdefault('offsets', {})[stream] = end

    _, first_outcome = local_spool.follow(
        work, spec, collect, proc=proc,
        should_continue=lambda: ('out', 'alpha') not in seen)
    check('first reader stops without stopping the Agent', first_outcome == 'cancelled')
    check('first line reached the original reader', seen == [('out', 'alpha')], seen)

    restored = json.loads(json.dumps(spec))
    code, second_outcome = local_spool.follow(
        work, restored, collect, pid=proc.pid,
        pid_alive=lambda _pid: proc.poll() is None)
    check('replacement reader sees a durable completion', second_outcome == 'completed')
    check('exact exit code survives reader restart', code == 0, code)
    check('stdout resumes at the saved cursor exactly once',
          [row for row in seen if row[0] == 'out'] ==
          [('out', 'alpha'), ('out', 'beta')], seen)
    check('stderr remains recoverable', ('err', 'omega') in seen, seen)

    checkpoint = {
        'stream': {'version': 1, 'offsets': {'out': 1, 'err': 0}},
        'terminal': {},
        'lines': [
            {'_stream': 'out', '_streamEnd': 14},
            {'_stream': 'err', '_streamEnd': 9,
             '_terminal': {'completed': True}},
        ],
    }
    _restore_stream_checkpoint(checkpoint)
    check('event journal repairs a stale stdout cursor',
          checkpoint['stream']['offsets']['out'] == 14, checkpoint)
    check('event journal repairs a stale stderr cursor',
          checkpoint['stream']['offsets']['err'] == 9, checkpoint)
    check('terminal checkpoint is restored',
          checkpoint['terminal'] == {'completed': True}, checkpoint)

    # The sidecar may have already exited while a healthy reader is still
    # parsing a multi-megabyte Pi/ACP spool.  Progress must reset the bounded
    # drain watchdog instead of inheriting the original 20-second deadline.
    progress, idle_since, stalled = local_process._durable_drain_state(
        None, 0.0, (64, 0), 100.0)
    check('durable drain starts as healthy', not stalled and idle_since == 100.0,
          (progress, idle_since, stalled))
    progress, idle_since, stalled = local_process._durable_drain_state(
        progress, idle_since, (128, 0), 125.0)
    check('durable cursor progress resets the drain deadline',
          not stalled and idle_since == 125.0,
          (progress, idle_since, stalled))
    _, _, stalled = local_process._durable_drain_state(
        progress, idle_since, progress,
        125.0 + local_process._DURABLE_DRAIN_GRACE_S - 0.1)
    check('active durable drain is not killed before its idle deadline', not stalled)
    _, _, stalled = local_process._durable_drain_state(
        progress, idle_since, progress,
        125.0 + local_process._DURABLE_DRAIN_GRACE_S + 0.1)
    check('stalled durable drain still has a bounded failure path', stalled)

    reclaim_root = os.path.join(work, 'reclaim-scan')
    active_ref = 'active-run-must-not-be-replaced'
    os.makedirs(os.path.join(reclaim_root, active_ref), exist_ok=True)
    with open(os.path.join(reclaim_root, active_ref, 'meta.json'),
              'w', encoding='utf-8') as handle:
        json.dump({'state': 'running', 'pid': 999999, 'stream': {}}, handle)
    previous_store = local_base._STORE
    previous_runs = dict(local_base._RUNS)
    live_run = {'state': 'running', 'marker': object()}
    try:
        local_base._STORE = reclaim_root
        with local_base._LOCK:
            local_base._RUNS.clear()
            local_base._RUNS[active_ref] = live_run
        reclaimed = local_base.reclaim()
        with local_base._LOCK:
            after = local_base._RUNS.get(active_ref)
        check('history scan never replaces an active in-memory run',
              after is live_run, (after, live_run))
        check('active run is not converted into restart recovery',
              not after.get('recoveredOutput') and reclaimed == {'live': 0, 'ended': 0},
              (after, reclaimed))
    finally:
        local_base._STORE = previous_store
        with local_base._LOCK:
            local_base._RUNS.clear()
            local_base._RUNS.update(previous_runs)

    detached_dir = os.path.join(work, 'real-parent-exit')
    starter = subprocess.run(
        [sys.executable, os.path.abspath(__file__), '--start-then-exit', detached_dir],
        cwd=os.path.dirname(os.path.abspath(__file__)), timeout=10)
    check('original Runner-like parent exits', starter.returncode == 0, starter.returncode)
    with open(os.path.join(detached_dir, 'handoff.json'), encoding='utf-8') as handle:
        handoff = json.load(handle)
    detached_spec = handoff['spec']
    detached_seen = []

    def collect_detached(stream, line, end):
        detached_seen.append((stream, line.strip()))
        detached_spec.setdefault('offsets', {})[stream] = end

    detached_code, detached_outcome = local_spool.follow(
        detached_dir, detached_spec, collect_detached,
        pid=int(handoff['pid']), pid_alive=_pid_alive)
    check('sidecar survives the original Runner process',
          detached_outcome == 'completed' and detached_code == 0,
          (detached_outcome, detached_code))
    check('new reader receives output produced after the parent exited',
          detached_seen == [
              ('out', 'survived-parent-exit'), ('out', 'durable-tail')],
          detached_seen)
    local_spool.cleanup(detached_dir, detached_spec)
finally:
    if proc is not None and proc.poll() is None:
        proc.kill()
        proc.wait(timeout=5)
    if spec:
        local_spool.cleanup(work, spec)
    shutil.rmtree(work, ignore_errors=True)

print('\nstream recovery: %d passed, %d failed' % (passed, failed))
raise SystemExit(1 if failed else 0)
