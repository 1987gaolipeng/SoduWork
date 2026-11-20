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
    _LAUNCH_TREE_UNCONFIRMED,
    _LAUNCH_TREE_UNCONFIRMED_ERROR,
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
_HOST_EXIT_GRACE_S = 3.0
_HOST_CLEANUP_GRACE_S = 30.0
_HOST_EXIT_ERROR = 'Permission-controlled execution host did not exit'


def _task_budget_stop(run: dict, now: float) -> bool:
    """Enforce the same goal budget while a native turn is still streaming."""
    from . import local_task_goal
    reason = local_task_goal.budget_reason(run, now=now)
    if not reason:
        return False
    local_task_goal.control(run, 'pause')
    run['goalState']['reason'] = reason
    run['stopping'] = True
    run['failureKind'] = 'task_goal'
    run['error'] = reason
    return True


def _join_execution_host(ref, spool, code, kill_tree, *, proc=None, pid=None, owner=None,
                         allow_grace=True):
    """Confirm host exit separately from the durable Agent exit receipt.

    A frozen one-file host may still be removing its private extraction after
    the Agent has exited. Only a reliable receipt permits that bounded grace;
    cancellation and permission transitions keep the short stop deadline.
    """
    token = object()
    pid = int(pid or (proc.pid if proc is not None else 0))

    def current():
        run = _RUNS.get(ref)
        return (run if run and run.get('state') == 'running'
                and int(run.get('pid') or 0) == pid
                and (run.get('stream') or {}).get('id') == spool.get('id')
                and (owner is None or run.get('_workerIdentity') is owner) else None)

    with _LOCK:
        run = current()
        if run is None:
            return False, ''
        run['_hostCleanup'] = token
    started = time.monotonic()
    hard_error = ''
    termination_requested = False
    try:
        try:
            reliable = allow_grace and local_spool.status_code(_store_dir(ref), spool) is not None
        except OSError:
            reliable = False
        while True:
            with _LOCK:
                run = current()
                if run is None:
                    return False, ''
                settling = reliable and not (run.get('stopping') or run.get('_accessTransition'))
            if proc is not None:
                try:
                    host_code = proc.poll()
                except (OSError, subprocess.SubprocessError):
                    host_code = None
                exited = host_code is not None
            else:
                from .local_stream import _pid_alive as process_alive
                exited = bool(pid) and not process_alive(pid)
                host_code = None
            if exited:
                with _LOCK:
                    if current() is None:
                        return False, ''
                if not hard_error and host_code not in (None, 0, code):
                    hard_error = 'Permission-controlled execution host exited abnormally'
                return True, hard_error
            budget = _HOST_CLEANUP_GRACE_S if settling else _HOST_EXIT_GRACE_S
            if not termination_requested and time.monotonic() - started >= budget:
                # A kill request is not an exit acknowledgement. Keep the same
                # active PID, admission fence and output until exit is observed.
                with _LOCK:
                    run = current()
                    if run is None:
                        return False, ''
                    run['error'] = hard_error = _HOST_EXIT_ERROR
                    run['failureKind'] = 'execution_host_cleanup'
                    change = run.get('_accessTransition')
                    if change:
                        change['error'] = hard_error
                try:
                    _save_meta(ref)
                except OSError as exc:
                    log.warning('Execution host cleanup state could not be saved: %s', type(exc).__name__)
                try:
                    with _LOCK:
                        if current() is None:
                            return False, ''
                    kill_tree(ref, expected_pid=pid, expected_proc=proc)
                except Exception as exc:  # noqa: BLE001 - Uncertain termination must retain the active host.
                    log.warning('Execution host termination was not confirmed: %s', type(exc).__name__)
                termination_requested = True
                continue
            time.sleep(0.1 if proc is not None else 1.0)
    finally:
        with _LOCK:
            run = _RUNS.get(ref)
            if run is not None and run.get('_hostCleanup') is token:
                run.pop('_hostCleanup', None)


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
        from . import local_task_goal
        current = _RUNS.get(ref) or {}
        goal_guarded = local_task_goal.enabled(current)
        opencode_guarded = current.get('cli') == 'opencode'
        goal_owned_turn = bool(current.get('goalTurnOwned', local_task_goal.active(current)))
        if ref in _RUNS:
            if _RUNS[ref].get('cli') != 'pi':
                _RUNS[ref]['goalTurnOwned'] = goal_owned_turn
            _RUNS[ref]['_workerIdentity'] = owner
            _RUNS[ref]['executionStartedAt'] = 0
            # Persist the process turn's event boundary before any output is
            # consumed, including when a replacement Runner attaches later.
            _RUNS[ref]['turnStartSeq'] = int(_RUNS[ref].get('seq') or 0)
            from . import local_task_goal
            local_task_goal.begin_turn(_RUNS[ref])
            _RUNS[ref]['admissionKey'] = str((cfg or {}).get('_admissionKey') or '')

    def finish(ref, code, term, hard_error):
        with _LOCK:
            if (_RUNS.get(ref) or {}).get('_workerIdentity') is not owner:
                return
        original_finish(ref, code, term, hard_error)

    def launch_cancelled(current) -> bool:
        return bool(current.get('_workerIdentity') is not owner
                    or current.get('state') != 'running' or current.get('stopping')
                    or goal_guarded and goal_owned_turn and not local_task_goal.active(current))

    def preparation_cancelled() -> bool:
        if not opencode_guarded:
            return False
        with _LOCK:
            current = _RUNS.get(ref) or {}
            cancelled = launch_cancelled(current)
            if cancelled and current.get('_workerIdentity') is owner and current.get('state') == 'running':
                current['stopping'] = True
            return cancelled

    def close_broker() -> None:
        from . import access_broker
        with _LOCK:
            owned = (_RUNS.get(ref) or {}).get('_workerIdentity') is owner
        # The broker takes its own condition locks and may publish run state.
        # Never hold the global run lock while shutting its server down.
        if owned:
            access_broker.close(ref)

    def complete_launch(launch_state, *, stopped=False) -> None:
        with _LOCK:
            current = _RUNS.get(ref) or {}
            if current.get('_workerIdentity') is owner and current.get('_launchPending') is launch_state:
                current.pop('_launchPending', None)
                if current.get('_hostCleanup') is launch_state:
                    current.pop('_hostCleanup', None)
            launch_state['stopped'] = stopped
            launch_state['done'].set()

    def cancel_launched_process(proc, launch_state) -> None:
        # Popen may block in the OS. A stop records intent while it is pending,
        # then this worker owns cleanup of the exact process it finally returns.
        from .local_stream import _kill_pid_tree
        with _LOCK:
            current = _RUNS.get(ref) or {}
            owned = current.get('_workerIdentity') is owner
            if owned:
                current['_hostCleanup'] = launch_state
        if owned:
            try:
                _save_meta(ref)
            except Exception as exc:  # noqa: BLE001 - Persistence failure must not bypass process cleanup.
                log.warning('Cancelled launch state could not be saved: %s', type(exc).__name__)
        def terminate():
            try:
                with _LOCK:
                    owned = (_RUNS.get(ref) or {}).get('_workerIdentity') is owner
                if owned:
                    killed = kill_tree(ref, expected_pid=proc.pid, expected_proc=proc)
                    with _LOCK:
                        owned = (_RUNS.get(ref) or {}).get('_workerIdentity') is owner
                    if killed or owned:
                        return bool(killed)
                return _kill_pid_tree(proc.pid, proc)
            except Exception as exc:  # noqa: BLE001 - A failed kill never establishes exit.
                log.warning('Cancelled launch termination was not confirmed: %s', type(exc).__name__)
                return False
        launch_state['retry'].clear()
        tree_stopped = terminate()
        unconfirmed_saved = False
        while True:
            try:
                exited = proc.poll() is not None
                if tree_stopped and exited:
                    break
            except (OSError, subprocess.SubprocessError):
                exited = False
            if not tree_stopped and exited:
                launch_state['unverifiable'] = True
                launch_state['error'] = _LAUNCH_TREE_UNCONFIRMED_ERROR
            with _LOCK:
                current = _RUNS.get(ref) or {}
                if current.get('_workerIdentity') is owner:
                    current['error'] = launch_state.get('error') or 'Cancelled execution launch cleanup is still pending'
                    if launch_state.get('unverifiable'):
                        current['failureKind'] = _LAUNCH_TREE_UNCONFIRMED
                elif launch_state.get('unverifiable'):
                    return False
            if launch_state.get('unverifiable') and not unconfirmed_saved:
                try:
                    _save_meta(ref)
                except Exception as exc:  # noqa: BLE001 - Keep the in-memory fence even if archival fails.
                    log.warning('Unconfirmed launch state could not be saved: %s', type(exc).__name__)
                unconfirmed_saved = True
            if launch_state['retry'].wait(.1):
                launch_state['retry'].clear()
                # Once the host is gone, a new PID-only check cannot reconstruct
                # the subtree whose cleanup failed. Never promote that to exit.
                if not launch_state.get('unverifiable'):
                    tree_stopped = terminate() or tree_stopped
        with _LOCK:
            current = _RUNS.get(ref) or {}
            if current.get('_workerIdentity') is owner and current.get('_hostCleanup') is launch_state:
                current.pop('_hostCleanup', None)
        try:
            proc.stdin.close()
        except (AttributeError, OSError, ValueError):
            pass
        return True

    def worker() -> None:
        gate_error = gate_check(prof or {}, cfg or {})
        if gate_error:
            _append_raw(ref, '\n[预检] ' + gate_error + '\n')
            finish(ref, 1, {}, gate_error)
            return
        try:
            env = _env_for(prof or {}, cfg or {}, runtime_ref=ref)
            with _LOCK:
                execution = dict(_RUNS.get(ref) or {})
            if execution.get('cli') == 'opencode' and execution.get('cliSid'):
                from .opencode_session_migration import migrate_session
                migrate_session(env, execution['cliSid'], ws, exe)
            if preparation_cancelled():
                finish(ref, 0, {}, '')
                return
            # The task controller owns one durable output-recovery budget.
            # Never inherit this host-only switch from a shell or model config.
            with _LOCK:
                current = _RUNS.get(ref) or {}
                if current.get('cli') != 'pi':
                    env.pop('SODUWORK_TASK_OUTPUT_RECOVERY_OWNED', None)
                    from . import local_task_goal
                    if local_task_goal.active(current):
                        env['SODUWORK_TASK_OUTPUT_RECOVERY_OWNED'] = '1'
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
            # Recheck after command preparation without holding the run lock
            # across the broker's own condition locks and server lifecycle.
            if preparation_cancelled():
                finish(ref, 0, {}, '')
                return
            access_broker.attach(ref, cfg or {}, env)
        except Exception as exc:  # noqa: BLE001
            if preparation_cancelled():
                finish(ref, 0, {}, '')
                return
            reason = str(exc).strip() or type(exc).__name__
            _append_raw(ref, '\n[preflight] ' + reason + '\n')
            finish(ref, 1, {}, reason)
            return

        spool: dict = {}
        launch_state = None
        try:
            spool, launch = local_spool.prepare(_store_dir(ref), argv, ws)
            with _LOCK:
                cancelled = preparation_cancelled()
                prepared = _RUNS.get(ref)
                if not cancelled and prepared is not None and prepared.get('_workerIdentity') is owner:
                    prepared['stream'] = spool
                    prepared['terminal'] = {}
            if cancelled:
                close_broker()
                local_spool.cleanup(_store_dir(ref), spool)
                finish(ref, 0, {}, '')
                return
            _save_meta(ref)
            # A durable sidecar outlives this Runner. Give a frozen child its
            # own extraction lifetime instead of sharing the parent's _MEIPASS.
            if getattr(sys, 'frozen', False):
                env['PYINSTALLER_RESET_ENVIRONMENT'] = '1'
            # Register a per-launch fence, not a global lock around an OS call.
            # Stop can record cancellation without blocking unrelated sessions.
            with _LOCK:
                current = _RUNS.get(ref) or {}
                cancelled = launch_cancelled(current)
                if cancelled:
                    if current.get('_workerIdentity') is owner and current.get('state') == 'running':
                        current['stopping'] = True
                else:
                    launch_state = {'owner': owner, 'done': threading.Event(),
                                    'retry': threading.Event(), 'stopped': False}
                    current['_launchPending'] = launch_state
                    current['_hostCleanup'] = launch_state
            proc = None
            if not cancelled:
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
                with _LOCK:
                    current = _RUNS.get(ref) or {}
                    if current.get('_workerIdentity') is owner:
                        current.update(pid=proc.pid, proc=proc)
                    cancelled = launch_cancelled(current)
                    if not cancelled:
                        complete_launch(launch_state)
                if cancelled:
                    if not cancel_launched_process(proc, launch_state):
                        complete_launch(launch_state)
                        return
                    close_broker()
                    local_spool.cleanup(_store_dir(ref), spool)
                    finish(ref, 0, {}, '')
                    complete_launch(launch_state, stopped=True)
                    return
            if proc is None:
                close_broker()
                local_spool.cleanup(_store_dir(ref), spool)
                finish(ref, 0, {}, '')
                return
        except Exception as exc:  # noqa: BLE001
            close_broker()
            if spool:
                local_spool.cleanup(_store_dir(ref), spool)
            with _LOCK:
                cancelled = launch_cancelled(_RUNS.get(ref) or {})
            finish(ref, 0 if cancelled else 1, {}, '' if cancelled else '跑不起来（%s）' % type(exc).__name__)
            if launch_state is not None:
                complete_launch(launch_state, stopped=cancelled)
            return

        with _LOCK:
            run = _RUNS.get(ref)
            if run is not None and run.get('_workerIdentity') is owner:
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
            close_broker()
            return
        close_broker()
        hard_error = '' if code is not None else '执行进程退出了，但没有写回可靠的退出状态'
        if (cfg or {}).get('accessPolicy'):
            # A policy change may follow immediately. Join the trusted sidecar
            # before announcing a completed turn or launching its replacement.
            joined, join_error = _join_execution_host(
                ref, spool, code, kill_tree, proc=proc, owner=owner)
            if not joined:
                return
            hard_error = join_error or hard_error

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
                and int(current.get('pid') or 0) == pid
                and str((current.get('stream') or {}).get('id') or '') == str(spool.get('id') or '')
            )

    def tick() -> None:
        _capture_started(ref, spool)
        should_kill = False
        with _LOCK:
            current = _RUNS.get(ref)
            if (not current or current.get('state') != 'running'
                    or int(current.get('pid') or 0) != pid
                    or (current.get('stream') or {}).get('id') != spool.get('id')):
                return
            observed = current
            if local_spool.status_code(_store_dir(ref), spool) is not None:
                return  # Completed Agent output belongs to the reader/joiner.
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
            if _task_budget_stop(current, now):
                should_kill = True
            elif pi_settlement:
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
            with _LOCK:
                current = _RUNS.get(ref)
                if (current is not observed or int(current.get('pid') or 0) != pid
                        or (current.get('stream') or {}).get('id') != spool.get('id')):
                    return
            if not kill_tree(ref, expected_pid=pid, skip_host_cleanup=True):
                with _LOCK:
                    current = _RUNS.get(ref)
                    if current is observed and int(current.get('pid') or 0) == pid:
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
            with _LOCK:
                protected = bool((_RUNS.get(ref) or {}).get('accessPolicy'))
            if protected:
                joined, join_error = _join_execution_host(ref, spool, code, kill_tree, pid=pid)
                if not joined:
                    outcome = 'cancelled'
                    return
                hard_error = join_error or hard_error
            if not still_current():
                outcome = 'cancelled'
                return
            finish(ref, int(code if code is not None else 1), term, hard_error)
        except Exception as exc:  # noqa: BLE001
            with _LOCK:
                protected = bool((_RUNS.get(ref) or {}).get('accessPolicy'))
            if protected:
                joined, _ = _join_execution_host(
                    ref, spool, None, kill_tree, pid=pid, allow_grace=False)
                if not joined:
                    outcome = 'cancelled'
                    return
            else:
                kill_tree(ref)
            finish(ref, 1, term, '恢复实时输出失败（%s）' % type(exc).__name__)
            outcome = 'failed'
        finally:
            with _LOCK:
                current = _RUNS.get(ref)
                if (current is not None
                        and (current.get('stream') or {}).get('id') == spool.get('id')):
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
                if run.get('_hostCleanup'):
                    continue  # The joiner owns completion and its cleanup deadline.
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
            if durable and local_spool.status_code(_store_dir(ref), stream) is not None:
                continue  # Do not time out a host already publishing its exit receipt.
            gone_since = 0.0
            durable_progress = None
            if run.get("permissionWaiting"):
                continue
            now = time.time()
            with _LOCK:
                current = _RUNS.get(ref)
                if (current is run and not current.get('_hostCleanup')
                        and current.get('proc') is proc and _task_budget_stop(current, now)):
                    target_pid = current.get('pid')
                else:
                    target_pid = None
            if target_pid:
                _save_meta(ref)
                kill_tree(ref, expected_pid=target_pid, expected_proc=proc, skip_host_cleanup=True)
                return
            if _pi_settlement_due(run, now):
                with _LOCK:
                    current = _RUNS.get(ref)
                    if (current is not run or current.get('_hostCleanup')
                            or (current.get('accessPolicy') and current.get('proc') is not proc)):
                        continue
                    current['piSettledByWatchdog'] = True
                    target_pid = current.get('pid')
                if not kill_tree(ref, expected_pid=target_pid, expected_proc=proc,
                                 skip_host_cleanup=True):
                    with _LOCK:
                        if _RUNS.get(ref) is current and current.get('proc') is proc:
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
                    if (current is not run or current.get('_hostCleanup')
                            or (current.get('accessPolicy') and current.get('proc') is not proc)):
                        continue
                    current['timedOut'] = reason
                    target_pid = current.get('pid')
                kill_tree(ref, expected_pid=target_pid, expected_proc=proc, skip_host_cleanup=True)
                return

    thread = threading.Thread(target=watch, name='ai_local:wd:' + ref[:8], daemon=True)
    _THREADS.add(thread)
    thread.start()


__all__ = ['spawn', 'recover']
