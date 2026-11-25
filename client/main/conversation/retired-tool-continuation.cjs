'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const segments = require('./runtime-segments');
const { unresolvedTools } = require('./tool-terminal-receipts.cjs');
const { confirmedAbsent, historyPage, admissionStatus } = require('../agent-runtime/runner-dispatch-absence.cjs');

// Only the local desktop can distinguish a lost historical tool receipt from
// an execution that still owns the workspace. Historical results stay unknown.
function sourcesFor(record, data) {
  const unresolved = unresolvedTools(data.snapshot);
  if (!unresolved.length || JSON.stringify(unresolved) !== JSON.stringify(data.coverage.unresolvedTools)) return null;
  const parts = [...record.segments, record.active];
  if (!unresolved.every(tool => typeof tool.id === 'string' && record.segments.some(part => part.adapterId !== 'pi' &&
      tool.id.startsWith(part.sessionId + ':' + part.sessionId + ':')))) return null;
  const sources = new Map([...(record.historyRecovery?.retiredRunnerSources || []),
    ...data.coverage.sources].map(source => [source.id, source]));
  const result = [];
  for (const part of parts) {
    if (part.adapterId === 'pi') continue;
    const source = sources.get(part.sessionId);
    if (!source || source.adapterId !== part.adapterId || !/^\d+$/.test(source.revision)) return null;
    result.push({ id: part.sessionId, adapterId: part.adapterId, revision: source.revision,
      ...(source.dormant ? { dormant: true } : {}) });
  }
  return result;
}

async function idle(app, runtime, session, record, sources, guard) {
  if (!Array.isArray(sources) || !sources.length || !path.isAbsolute(record.cwd || '')) return false;
  const ids = [record.id, ...record.segments.map(part => part.sessionId), record.active.sessionId];
  if (!session.historyExecutionsIdle?.(ids)) return false;
  const cwd = await fs.realpath(record.cwd).catch(() => '');
  if (!cwd || !(await fs.stat(cwd).catch(() => null))?.isDirectory()) return false;
  runtime ||= require('../runner-runtime');
  let boot;
  for (const source of sources) {
    guard();
    let history, admission;
    try {
      if (source.dormant) {
        if (!await confirmedAbsent(runtime, source.id, undefined, { reportBusy: true })) return false;
        continue;
      }
      history = await historyPage(runtime, { ref: source.id, since: Number(source.revision), limit: 1 }, 5000);
      admission = await admissionStatus(runtime, { ref: source.id }, 5000);
    } catch (error) {
      guard();
      if (error.code === 'RUNNER_HISTORY_BUSY') throw error;
      return false;
    }
    guard();
    const run = history?.data, queue = admission?.data;
    const workspace = path.isAbsolute(run?.workDir || '') && await fs.realpath(run.workDir).catch(() => '');
    if (!history?.ok || run?.ok !== true || run.ref !== source.id || run.cli !== source.adapterId ||
        run.seq !== Number(source.revision) || !Array.isArray(run.items) || run.items.length ||
        run.deviceTransfer?.schemaVersion !== 1 || run.deviceTransfer.quiescent !== true ||
        !['done', 'failed', 'stopped', 'interrupted'].includes(run.status) || !(run.ended > 0) ||
        !workspace || path.relative(cwd, workspace) ||
        !admission?.ok || queue?.inflight !== false || queue.localWorkPending !== false ||
        queue.localAdmissionsPending !== false || queue.admissionDurable !== true || !queue.bootId ||
        boot && queue.bootId !== boot) return false;
    boot = queue.bootId;
  }
  guard();
  return segments.read(app, record.id) === record && session.historyExecutionsIdle(ids);
}

module.exports = { sourcesFor, idle };
