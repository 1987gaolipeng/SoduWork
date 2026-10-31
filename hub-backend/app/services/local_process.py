'''Durable local Agent process lifecycle.

This module owns process launch, spool following, Runner restart recovery and
the watchdog.  Parsing and semantic turn finalisation remain in
``local_stream`` and are injected as callbacks, which keeps the dependency
direction explicit and avoids a stream/process import cycle.
'''
from __future__ import annotations

import logging
import subprocess
import sys
import threading
import time
from collections.abc import Callable

from . import local_spool
from .local_base import (
    _HARD_LIMIT_S,
    _IDLE_LIMIT_S,
    _LOCK,
    _RUNS,
    _THREADS,
    _WIN,
    _append_raw,
    _command_argv,
    _env_for,
    _pid_alive,
    _save_meta,
    _store_dir,
)

log = logging.getLogger('uvicorn.error')

_DEAD_GRACE_S = 20
# A durable sidecar can exit before the reader has parsed a large spool.  The
# reader is the authoritative finaliser in that path, so a fixed 20-second
# wall-clock deadline can race healthy progress (large Pi/ACP turns regularly
# produce multi-megabyte JSONL).  Keep a bounded safety net, but measure idle
# drain time and reset it whenever either stream cursor advances.
_DURABLE_DRAIN_GRACE_S = 5 * 60
_PI_SETTLE_GRACE_S = 5


def _pi_settlement_due(run: dict, now: float) -> bool:
    """Return true only after a final Pi response stayed quiet for the settlement grace."""
    if str((run or {}).get("cli") or "") != "pi":
        return False
    try:
        at = float((run or {}).get("piFinalResponseAt") or 0)
    except (TypeError, ValueError):
        return False
    return bool(at and now - at >= _PI_SETTLE_GRACE_S)


def _capture_started(ref: str, spool: dict, owner=None) -> None:
    at = local_spool.started_at(_store_dir(ref), spool)
    if not at:
        return
    changed = False
    with _LOCK:
        run = _RUNS.get(ref)
        if (run is not None and not run.get('executionStartedAt')
                and (owner is None or run.get('_workerIdentity') is owner)
                and (run.get('stream') or {}).get('id') == spool.get('id')):
            run['executionStartedAt'] = at
            changed = True
    if changed:
        _save_meta(ref)


def _capture_started(ref: str, spool: dict, owner=None) -> None:
    at = local_spool.started_at(_store_dir(ref), spool)
    if not at:
        return
    changed = False
    with _LOCK:
        run = _RUNS.get(ref)
        if (run is not None and not run.get('executionStartedAt')
                and (owner is None or run.get('_workerIdentity') is owner)
                and (run.get('stream') or {}).get('id') == spool.get('id')):
            run['executionStartedAt'] = at
            changed = True
    if changed:
        _save_meta(ref)


def _durable_drain_state(
    previous: tuple[int, int] | None,
    idle_since: float,
    current: tuple[int, int],
    now: float,
) -> tuple[tuple[int, int], float, bool]:
    '''Track no-progress time after the durable sidecar has exited.'''
    if previous != current:
        return current, now, False
    started = idle_since or now
    return previous or current, started, now - started > _DURABLE_DRAIN_GRACE_S


def _consume_stream(
    ref: str,
    spool: dict,
    term: dict,
    stream: str,
    line: str,
    end: int,
    on_line: Callable,
) -> None:
    with _LOCK:
        current = _RUNS.get(ref)
        if not current or str((current.get('stream') or {}).get('id') or '') != spool['id']:
            return
    before = dict(term)
    on_line(ref, line, term, stream=stream, stream_end=end)
    save_due = before != term
    with _LOCK:
        current = _RUNS.get(ref)
        if not current or str((current.get('stream') or {}).get('id') or '') != spool['id']:
            return
        active = dict(current.get('stream') or {})
        offsets = dict(active.get('offsets') or {})
        offsets[stream] = max(int(offsets.get(stream) or 0), int(end or 0))
        active['offsets'] = offsets
        current['stream'] = active
        current['terminal'] = dict(term)
        if time.time() - float(current.get('streamMetaAt') or 0) > 1:
            current['streamMetaAt'] = time.time()
            save_due = True
    if save_due:
        _save_meta(ref)


def spawn(
    exe: str,
    args: list,
    prompt: str,
    ws: str,
    ref: str,
    cfg: dict | None,
    prof: dict | None,
    *,
    gate_check: Callable,
    on_line: Callable,
    finish: Callable,
    kill_tree: Callable,
) -> None:
    '''Start one turn through the durable output sidecar.'''
    owner = object()
    original_finish = finish
    with _LOCK:
        if ref in _RUNS:
            _RUNS[ref]['_workerIdentity'] = owner
            _RUNS[ref]['executionStartedAt'] = 0
            # Persist the process turn's event boundary before any output is
            # consumed, including when a replacement Runner attaches later.
            _RUNS[ref]['turnStartSeq'] = int(_RUNS[ref].get('seq') or 0)
            _RUNS[ref]['admissionKey'] = str((cfg or {}).get('_admissionKey') or '')

    def finish(ref, code, term, hard_error):
        with _LOCK:
            if (_RUNS.get(ref) or {}).get('_workerIdentity') is not owner:
                return
        original_finish(ref, code, term, hard_error)

    def worker() -> None:
        gate_error = gate_check(prof or {}, cfg or {})
        if gate_error:
            _append_raw(ref, '\n[预检] ' + gate_error + '\n')
            finish(ref, 1, {}, gate_error)
            return
        try:
            env = _env_for(prof or {}, cfg or {}, runtime_ref=ref)
            # Scope belongs to a real submitted turn. Recovery/compaction keeps
            # round unchanged so Escape cannot be bypassed by an internal retry.
            with _LOCK:
                desktop_round = int((_RUNS.get(ref) or {}).get('round') or 1)
            for key in list(env):
                if key.upper() == 'SODUWORK_DESKTOP_CONTROL_SCOPE':
                    del env[key]
            env['SODUWORK_DESKTOP_CONTROL_SCOPE'] = f'runner:{ref}:{desktop_round}'
            argv = _command_argv(exe, args, ws, cfg or {}, prof or {})
            from . import access_broker
            access_broker.attach(ref, cfg or {}, env)
        except Exception as exc:  # noqa: BLE001
            reason = str(exc).strip() or type(exc).__name__
            _append_raw(ref, '\n[preflight] ' + reason + '\n')
            finish(ref, 1, {}, reason)
            return

        spool: dict = {}
        try:
            spool, launch = local_spool.prepare(_store_dir(ref), argv, ws)
            with _LOCK:
                prepared = _RUNS.get(ref)
                if prepared is not None:
                    prepared['stream'] = spool
                    prepared['terminal'] = {}
            _save_meta(ref)
            # A durable sidecar outlives this Runner. Give a frozen child its
            # own extraction lifetime instead of sharing the parent's _MEIPASS.
            if getattr(sys, 'frozen', False):
                env['PYINSTALLER_RESET_ENVIRONMENT'] = '1'
            proc = subprocess.Popen(
                launch,
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                cwd=ws,
                env=env,
                bufsize=0,
                **({} if _WIN else {'start_new_session': True}),
            )
        except Exception as exc:  # noqa: BLE001
            access_broker.close(ref)
            if spool:
                local_spool.cleanup(_store_dir(ref), spool)
            finish(ref, 1, {}, '跑不起来（%s）' % type(exc).__name__)
            return

        with _LOCK:
            run = _RUNS.get(ref)
            if run is not None:
                run['pid'] = proc.pid
                run['proc'] = proc
                run['lastOut'] = time.time()
                run['detached'] = False
                run['lastPrompt'] = prompt
        _save_meta(ref)
        _append_raw(
            ref,
            '\n===== 第 %s 段 · %s · %s =====\n'
            % ((_RUNS.get(ref) or {}).get('segment', 1), time.strftime('%H:%M:%S'), ' '.join(args[:4])),
        )

        def feed() -> None:
            try:
                proc.stdin.write(prompt.encode('utf-8'))
                proc.stdin.close()
            except Exception:  # noqa: BLE001
                pass

        threading.Thread(target=feed, daemon=True).start()
        term: dict = dict((_RUNS.get(ref) or {}).get('terminal') or {})

        def consume(stream: str, line: str, end: int) -> None:
            _consume_stream(ref, spool, term, stream, line, end, on_line)

        _watchdog(ref, proc, finish=finish, kill_tree=kill_tree)
        code, outcome = local_spool.follow(
            _store_dir(ref),
            spool,
            consume,
            proc=proc,
            should_continue=lambda: ((_RUNS.get(ref) or {}).get('state') == 'running'),
            on_tick=lambda: _capture_started(ref, spool, owner),
        )
        _capture_started(ref, spool, owner)
        if outcome == 'cancelled':
            access_broker.close(ref)
            return
        access_broker.close(ref)
        hard_error = '' if code is not None else '执行进程退出了，但没有写回可靠的退出状态'
        if (cfg or {}).get('accessPolicy'):
            # A policy change may follow immediately. Join the trusted sidecar
            # before announcing a completed turn or launching its replacement.
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                kill_tree(ref)
                hard_error = 'Permission-controlled execution host did not exit'

        try:
            finish(ref, int(code if code is not None else 1), term, hard_error)
        finally:
            local_spool.cleanup(_store_dir(ref), spool)

    thread = threading.Thread(target=worker, name='ai_local:' + ref[:8], daemon=True)
    _THREADS.add(thread)
    thread.start()


def recover(
    ref: str,
    *,
    on_line: Callable,
    finish: Callable,
    kill_tree: Callable,
) -> None:
    '''Attach a restarted Runner to one turn's durable output files.'''
    with _LOCK:
        run = _RUNS.get(ref)
        if not run or run.get('streamAttached'):
            return
        run['streamAttached'] = True
        run['recoveredOutput'] = True
        run['detached'] = False
        spool = dict(run.get('stream') or {})
        pid = int(run.get('pid') or 0)
        term = dict(run.get('terminal') or {})

    def still_current() -> bool:
        with _LOCK:
            current = _RUNS.get(ref)
            return bool(
                current
                and current.get('state') == 'running'
                and str((current.get('stream') or {}).get('id') or '') == str(spool.get('id') or '')
            )

    def tick() -> None:
        _capture_started(ref, spool)
        should_kill = False
        with _LOCK:
            current = _RUNS.get(ref)
            if not current or current.get('state') != 'running':
                return
            now = time.time()
            last = float(current.get('lastOut') or current.get('started') or now)
            started = float(current.get('started') or now)
            if current.get("permissionWaiting"):
                return
            if (str(current.get("cli") or "") == "pi"
                    and (current.get("terminal") or {}).get("piFinalResponse")
                    and not current.get("piFinalResponseAt")):
                current["piFinalResponseAt"] = now
            idle, total = now - last, now - started
            pi_settlement = _pi_settlement_due(current, now)
            if pi_settlement:
                current['piSettledByWatchdog'] = True
                should_kill = True
            elif not current.get('timedOut') and (idle > _IDLE_LIMIT_S or total > _HARD_LIMIT_S):
                current['timedOut'] = (
                    '静默 %s 分钟没动静' % int(idle / 60)
                    if idle > _IDLE_LIMIT_S
                    else '总时长超过 %s 小时' % (_HARD_LIMIT_S // 3600)
                )
                should_kill = True
        if should_kill:
            if not kill_tree(ref):
                with _LOCK:
                    current = _RUNS.get(ref)
                    if current is not None:
                        current.pop('piSettledByWatchdog', None)

    def worker() -> None:
        outcome = 'cancelled'
        try:
            code, outcome = local_spool.follow(
                _store_dir(ref),
                spool,
                lambda stream, line, end: _consume_stream(
                    ref, spool, term, stream, line, end, on_line
                ),
                pid=pid,
                pid_alive=_pid_alive,
                should_continue=still_current,
                on_tick=tick,
            )
            if outcome == 'cancelled':
                return
            _capture_started(ref, spool)
            _save_meta(ref)
            hard_error = '' if code is not None else (
                '执行机恢复了过程输出，但执行进程没有留下可靠的退出状态'
            )
            finish(ref, int(code if code is not None else 1), term, hard_error)
        except Exception as exc:  # noqa: BLE001
            kill_tree(ref)
            finish(ref, 1, term, '恢复实时输出失败（%s）' % type(exc).__name__)
            outcome = 'failed'
        finally:
            with _LOCK:
                current = _RUNS.get(ref)
                if current is not None:
                    current['streamAttached'] = False
            if outcome != 'cancelled':
                local_spool.cleanup(_store_dir(ref), spool)

    thread = threading.Thread(target=worker, name='ai_local:recover:' + ref[:8], daemon=True)
    _THREADS.add(thread)
    thread.start()


def _watchdog(ref: str, proc, *, finish: Callable, kill_tree: Callable) -> None:
    '''Guard silent hangs and sidecars that exit without finalisation.'''

    def watch() -> None:
        gone_since = 0.0
        durable_progress: tuple[int, int] | None = None
        while True:
            time.sleep(5)
            with _LOCK:
                run = _RUNS.get(ref)
                if run is None or run.get('state') != 'running':
                    return
                if run.get('accessPolicy') and run.get('proc') is not proc:
                    return  # a previous turn must never time out its replacement
                last = run.get('lastOut') or run.get('started') or time.time()
                started = run.get('started') or time.time()
                completed = bool(run.get('turnCompleted'))
                stream = dict(run.get('stream') or {})
                durable = bool(stream.get('version'))
                offsets = dict(stream.get('offsets') or {})
                current_progress = (
                    int(offsets.get('out') or 0),
                    int(offsets.get('err') or 0),
                )
            code = proc.poll()
            if code is not None:
                if durable:
                    durable_progress, gone_since, stalled = _durable_drain_state(
                        durable_progress, gone_since, current_progress, time.time())
                    if stalled:
                        finish(
                            ref,
                            code,
                            {},
                            '持久输出守护已经退出，且输出游标长时间没有继续推进',
                        )
                        return
                    continue
                if code == 0 and completed:
                    finish(ref, code, {'completed': True}, '')
                    return
                gone_since = gone_since or time.time()
                if time.time() - gone_since > _DEAD_GRACE_S:
                    log.warning(
                        '本地会话 %s：进程已退出(code=%s)但没有收尾，看门狗兜底结算',
                        ref[:8],
                        code,
                    )
                    finish(
                        ref,
                        code,
                        {},
                        '进程已经退出了，但输出管道一直没关（多半是子进程仍占用），由看门狗收尾',
                    )
                    return
                continue
            gone_since = 0.0
            durable_progress = None
            if run.get("permissionWaiting"):
                continue
            now = time.time()
            if _pi_settlement_due(run, now):
                with _LOCK:
                    current = _RUNS.get(ref)
                    if current is not None:
                        current['piSettledByWatchdog'] = True
                if not kill_tree(ref):
                    with _LOCK:
                        current = _RUNS.get(ref)
                        if current is not None:
                            current.pop('piSettledByWatchdog', None)
                return
            idle, total = now - last, now - started
            if idle > _IDLE_LIMIT_S or total > _HARD_LIMIT_S:
                reason = (
                    '静默 %s 分钟没动静' % int(idle / 60)
                    if idle > _IDLE_LIMIT_S
                    else '总时长超过 %s 小时' % (_HARD_LIMIT_S // 3600)
                )
                log.warning('本地会话 %s 判死：%s', ref[:8], reason)
                with _LOCK:
                    current = _RUNS.get(ref)
                    if current is not None:
                        current['timedOut'] = reason
                kill_tree(ref)
                return

    thread = threading.Thread(target=watch, name='ai_local:wd:' + ref[:8], daemon=True)
    _THREADS.add(thread)
    thread.start()


__all__ = ['spawn', 'recover']
