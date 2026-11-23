'use strict';

const runnerRuntime = require('../runner-runtime');
const { _runnerInventory, _dropRunnerInventory } = require('./runner-adapter');
const taskOutputJournal = require('../conversation/task-output-journal');
const harnesses = require('../conversation/used-harnesses');

const RETIRED_RUNTIMES = Object.freeze({ claude: 'Claude Code', harness2: 'Google Harness²' });
const ACTIVE_STATES = new Set(['running', 'queued', 'dispatching', 'starting', 'access-changing', 'waiting-permission']);

function stateOf(value) {
  if (value === 'waiting-permission') return 'waiting-user';
  if (value === 'queued') return 'queued';
  if (ACTIVE_STATES.has(value)) return 'streaming';
  if (value === 'failed') return 'unreachable';
  if (['stopped', 'interrupted', 'cancelled', 'canceled'].includes(value)) return 'aborted';
  return 'idle';
}

// Retired runtimes retain an archive owner, not a registered execution adapter.
// All transcript reads still use the normal account-scoped history boundary.
function createRunnerHistoryProvider({ app, adapterId, runnerRuntime: runtime = runnerRuntime } = {}) {
  if (!Object.hasOwn(RETIRED_RUNTIMES, adapterId)) throw new TypeError('Unsupported retired Runner history provider');
  const eligible = row => row && row.cli === adapterId && typeof row.ref === 'string' && row.ref &&
    typeof row.taskId === 'string' && row.taskId.startsWith('chat-');
  const failure = error => ({ ok: false, chats: [], reason: String(error?.message || error) });
  async function historyRow(row, metadataOnly = false) {
    return { id: row.ref, path: row.ref, adapterId, runtimeRetired: true,
      ...(!metadataOnly ? { usedHarnesses: harnesses.merge([adapterId],
        await taskOutputJournal.usedHarnesses(app, row.ref).catch(() => [])) } : {}),
      cwd: row.workDir || '', title: row.title || RETIRED_RUNTIMES[adapterId] + ' 工作会话',
      createdAt: Math.round(Number(row.started || row.ended || 0) * 1000),
      at: Math.round(Number(row.ended || row.started || 0) * 1000),
      count: Number(row.seq || 0), state: stateOf(row.state) };
  }
  return Object.freeze({
    id: adapterId,
    async historyEntry(id, { strict = false } = {}) {
      try {
        const row = (await _runnerInventory(runtime, { force: strict })).find(row => eligible(row) && row.ref === id);
        return { ok: true, chats: row ? [await historyRow(row)] : [] };
      } catch (error) { return failure(error); }
    },
    async history(limit = 50, { strict = false, metadataOnly = false } = {}) {
      try {
        const rows = (await _runnerInventory(runtime, { force: strict })).filter(eligible)
          .slice(0, Math.max(1, Number(limit) || 50));
        const chats = [];
        for (let start = 0; start < rows.length; start += 16)
          chats.push(...await Promise.all(rows.slice(start, start + 16).map(row => historyRow(row, metadataOnly))));
        return { ok: true, chats };
      } catch (error) { return failure(error); }
    },
    async forgetSession(id) {
      try {
        // Fresh inventory proves the ID belongs to this retired chat provider.
        // The Runner repeats its active-process check under its archive lock.
        const row = (await _runnerInventory(runtime, { force: true })).find(row => row?.ref === id);
        if (!row) return { ok: false, notFound: true, reason: '这条会话不在该底座的历史记录里' };
        if (!eligible(row)) return { ok: false, reason: '会话归属与历史记录不匹配，已拒绝删除' };
        if (ACTIVE_STATES.has(row.state) || row.stopping) return { ok: false, reason: '这条会话还在执行，完成或停止后再删除' };
        const reply = await runtime.rpc('runtime.session.forget', { ref: id }, 15000);
        if (reply?.ok !== true || reply.data?.ok !== true) {
          const reason = String(reply?.error || reply?.data?.error || '底座未确认删除会话');
          const notFound = /不在|不存在|找不到/.test(reason);
          if (notFound) _dropRunnerInventory(runtime, id);
          return { ok: false, ...(notFound ? { notFound: true } : {}), reason };
        }
        _dropRunnerInventory(runtime, id);
        return { ok: true };
      } catch (error) { return { ok: false, reason: String(error?.message || error) }; }
    },
  });
}

module.exports = { createRunnerHistoryProvider };
