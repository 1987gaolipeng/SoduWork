'use strict';

/* Process-local maintenance gate for work that is owned by Electron itself.

   Runner work is drained by the Hub because dispatch is a control-plane
   decision. Direct Pi conversations and their execution service are owned by
   the desktop, so their execution and resource cleanup need a local gate.
   The updater closes this gate before its first
   safety probe; the IPC boundary consults the same object before accepting new
   work, which removes the check-then-start race. */

const DRAIN_REASON =
  'SoduWork 正在等待安全升级，暂不接受新的本机工作；正在执行的内容不会被中断。';

let draining = false;

function setDraining(value) {
  draining = Boolean(value);
  return draining;
}

function guard() {
  return draining
    ? { ok: false, reason: DRAIN_REASON, maintenance: true }
    : { ok: true };
}

function maintenanceBlockers(sessions) {
  if (!sessions || typeof sessions.maintenanceWorkloads !== 'function') return [];
  try {
    const rows = sessions.maintenanceWorkloads();
    if (!Array.isArray(rows) || rows.some(row => !row || row.kind !== 'runtime-cleanup' ||
        typeof row.ref !== 'string' || !row.ref.startsWith('runtime-cleanup:') ||
        !['cleaning', 'cleanup-failed'].includes(row.status))) throw Error('Invalid runtime cleanup state');
    return rows.map(row => ({
      kind: 'runtime-cleanup', id: row.ref, ref: row.ref,
      title: row.status === 'cleanup-failed' ? '执行服务资源尚未确认回收' : '执行服务正在回收资源',
      status: row.status, state: row.status,
      reason: String(row.reason || '正在确认执行服务及工具进程已经退出，请稍后重试'),
      resumable: false, canStop: false,
    }));
  } catch (_) {
    // A crashed runtime no longer has an active conversation, but an unknown
    // cleanup state is never evidence that its tools have actually exited.
    return [{ kind: 'runtime-cleanup', id: 'runtime-cleanup:unknown', ref: 'runtime-cleanup:unknown',
      title: '无法确认执行服务资源回收状态', status: 'cleanup-failed', state: 'cleanup-failed',
      reason: '无法确认执行服务及工具进程已经退出，请稍后重试', resumable: false, canStop: false }];
  }
}

function snapshot(sessions) {
  const handles = sessions && typeof sessions.list === 'function'
    ? sessions.list() : [];
  const blockers = [];
  for (const handle of handles) {
    let active = false;
    try { active = Boolean(handle && handle.inFlight && handle.inFlight()); }
    catch (_) { active = true; }
    if (!active) continue;
    let row = null;
    try { row = handle.historyRow && handle.historyRow(); } catch (_) { row = null; }
    blockers.push({
      kind: 'conversation',
      id: String(handle.sessionId || handle.ref || ''),
      ref: String(handle.ref || ''),
      title: String(row && row.title || '正在执行的对话'),
      state: String(row && row.state || 'running'),
      resumable: false,
    });
  }
  blockers.push(...maintenanceBlockers(sessions));
  return {
    safe: blockers.length === 0,
    draining,
    activeCount: blockers.length,
    blockers,
  };
}

async function stop(sessions, ref) {
  const wanted = String(ref || '');
  const maintenance = maintenanceBlockers(sessions).find(row => row.ref === wanted ||
    row.ref === 'runtime-cleanup:unknown' && wanted.startsWith('runtime-cleanup:'));
  if (maintenance) {
    throw Object.assign(Error(maintenance.reason), {
      code: maintenance.status === 'cleanup-failed' ? 'RUNTIME_CLEANUP_FAILED' : 'RUNTIME_CLEANUP_PENDING',
      maintenance: true, canStop: false,
    });
  }
  const handle = sessions && typeof sessions.get === 'function' ? sessions.get(wanted) : null;
  if (!handle) return { ok: true, alreadyStopped: true };
  if (typeof handle.cancel !== 'function') throw Error('当前会话无法直接停止，请打开会话处理');
  const result = await handle.cancel();
  if (result && result.ok === false) throw Error(result.reason || '停止请求未成功');
  // Never remove the handle or declare the workload safe here. The runtime
  // must acknowledge completion before the next installation safety probe.
  return { ok: true, stopping: true };
}

module.exports = {
  DRAIN_REASON,
  guard,
  setDraining,
  snapshot,
  stop,
};
