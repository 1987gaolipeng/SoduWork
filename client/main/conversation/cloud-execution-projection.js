'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const durable = require('../verified-file-replace.cjs');
const liveOutput = require('./task-live-output');
const { connectionScope } = require('../platform-connections/runtime.cjs');
const { scope } = require('./cloud-execution-sync');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
class CacheRecovery extends Error {}
function validCheckpoint(state) {
  if (!Number.isSafeInteger(state?.cursor) || state.cursor < 0 || !Array.isArray(state.pages) ||
      (state.generation && !/^[a-f0-9-]{36}$/.test(state.generation))) return false;
  let through = 0;
  for (const name of state.pages) {
    const parts = typeof name === 'string' && name.match(/^(\d+)-(\d+)\.json$/);
    if (!parts || Number(parts[1]) !== through || !Number.isSafeInteger(Number(parts[2])) || Number(parts[2]) <= through) return false;
    through = Number(parts[2]);
  }
  return through === state.cursor;
}

function create({ app, root, read, save, materialize, directory }) {
  async function readJson(file) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) {
      if (error instanceof SyntaxError || error.code === 'ENOENT') throw new CacheRecovery('Unreadable projection cache');
      throw error;
    }
  }
  async function recoverCache(sessionId, identity, check) {
    await check();
    const current = read(sessionId), generation = crypto.randomUUID();
    const owner = scope(identity);
    if (!owner || current?.syncOwner !== owner || !current.syncId || !current.taskId)
      throw Error('Cloud projection ownership changed');
    const { transferId, cwd, ref } = current;
    const pageBase = path.join(app.getPath('userData'), 'cloud-execution-sync', owner, hash(current.syncId + '\0' + ref));
    const viewPath = path.join(root, transferId + '.view.json');
    let saved, missingBase = false;
    try { saved = await readJson(viewPath); }
    catch (error) { if (!(error instanceof CacheRecovery)) throw error; missingBase = true; }
    missingBase ||= !Array.isArray(saved?.snapshot?.messages);
    // Preserve original handoff evidence and all raw pages. Recovery writes a
    // new page generation and never executes or resubmits the Hub task.
    const archive = path.join(pageBase, generation);
    await fs.mkdir(archive, { recursive: true, mode: 0o700 });
    await durable.writeFile(path.join(archive, 'previous-state.json'), JSON.stringify(current.syncState), { mode: 0o600, flush: true });
    if (missingBase) {
      await fs.copyFile(viewPath, path.join(archive, 'original-view.json')).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      await check();
      await durable.writeFile(viewPath, JSON.stringify({ cwd, adapterId: current.adapterId,
        snapshot: { messages: [], tools: [], adapterId: current.adapterId, status: 'idle' } }), { mode: 0o600, flush: true });
    }
    await check();
    await save({ ...read(sessionId), syncDetailSaved: false,
      syncState: { ref, cursor: 0, pages: [], generation },
      syncRecovery: { at: Date.now(), generation, historyGap: missingBase || current.syncRecovery?.historyGap === true } });
  }
  async function open(row, identity, check) {
    if (!row?.id || !row.receipt?.taskId || !row.receipt.source || typeof row.title !== 'string')
      throw Error('云端会话记录不完整');
    const owner = scope(identity), receipt = row.receipt;
    const owned = record => record && (record.syncOwner === owner || record.owner === connectionScope(identity));
    const matches = record => {
      if (!owned(record)) return false;
      if (record.taskId) return record.taskId === receipt.taskId;
      const start = record.cloudStart?.options;
      // A create response can be lost after Hub acceptance. Only the frozen
      // original request may claim that task; an empty taskId is not evidence.
      return record.phase === 'committing' && record.entryKind === 'cloud' &&
        receipt.source.entryKind === 'cloud' && /^[a-f0-9-]{36}$/i.test(record.transferId) &&
        record.transferId === receipt.transferId && record.sessionId === 'cloud-' + record.transferId &&
        record.sessionId === receipt.source.sessionId && start?.sessionId === record.sessionId &&
        start.agentId === record.adapterId && start.agentId === receipt.source.adapterId &&
        typeof start.text === 'string' && Array.isArray(record.cloudStart.files) && Array.isArray(record.cloudStart.selection);
    };
    let sessionId = String(receipt.source.sessionId || '');
    let record = sessionId ? read(sessionId) : null;
    if (!matches(record)) {
      sessionId = 'cloud-sync-' + hash(owner + '\0' + row.id).slice(0, 40);
      record = read(sessionId);
      if (record && !matches(record)) throw Error('云端缓存归属不一致');
    }
    const transferId = record?.transferId || hash(owner + '\0' + row.id);
    const cwd = record?.cwd || path.join(app.getPath('userData'), 'cloud-conversations', transferId, 'results');
    const ref = String(row.execution?.ref || receipt.ref || '');
    await check();
    if (!record) {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await durable.writeFile(path.join(root, transferId + '.view.json'), JSON.stringify({ cwd,
        adapterId: receipt.source.adapterId || row.execution?.engine || 'pi', model: row.execution?.model || '',
        snapshot: { messages: [], tools: [], adapterId: receipt.source.adapterId || 'pi',
          displayName: receipt.source.adapterId || 'pi', execution: { cloud: true }, status: 'idle' } }), { mode: 0o600, flush: true });
      await check();
    }
    const previous = record;
    record = { ...record, sessionId, transferId, cwd, entryKind: 'cloud',
      owner: record?.owner || connectionScope(identity), syncOwner: owner, syncId: row.id,
      taskId: receipt.taskId, title: row.title, adapterId: receipt.source.adapterId || 'pi',
      phase: receipt.phase, ref, target: receipt.target,
      accepted: receipt.accepted === true, acceptedAt: receipt.acceptedAt || '', canAbort: receipt.canAbort === true,
      remoteState: row.execution?.status || receipt.status,
      at: Date.parse(row.execution?.updatedAt || row.createdAt) || record?.at || Date.now(),
      ...(receipt.deliveryMode === 'git' ? { codeDelivery: receipt.codeDelivery, deliveryPresentation: 'summary' } : {}),
      ...(row.artifactUrl ? { artifactUrl: row.artifactUrl } : {}),
      ...(!record || record.syncState?.ref !== ref ? { syncDetailSaved: false } : {}),
      syncState: record?.syncState?.ref === ref ? record.syncState : { ref, cursor: 0, pages: [] } };
    if (JSON.stringify(previous) !== JSON.stringify(record)) await save(record);
    await check();
    const pageBase = path.join(app.getPath('userData'), 'cloud-execution-sync', owner, hash(row.id + '\0' + ref));
    const pageDirectory = () => {
      const generation = read(sessionId).syncState.generation;
      if (generation && !/^[a-f0-9-]{36}$/.test(generation)) throw new CacheRecovery('Invalid cache generation');
      return generation ? path.join(pageBase, generation) : pageBase;
    };
    // Validate before using a watermark or deciding that details are reusable.
    // Missing pages use the same archival recovery as malformed checkpoints;
    // recovery generations must never be mistaken for missing legacy pages.
    try {
      if (!validCheckpoint(record.syncState)) throw new CacheRecovery('Invalid projection checkpoint');
      await fs.access(path.join(root, transferId + '.view.json'));
      for (const name of record.syncState.pages) await fs.access(path.join(pageDirectory(), name));
    } catch (error) {
      if (!(error instanceof CacheRecovery) && error.code !== 'ENOENT') throw error;
      await recoverCache(sessionId, identity, check);
      record = read(sessionId);
    }
    let cursor = record.syncState.cursor, handle = null, output = null;
    async function restoreOutput() {
      if (output) return;
      const saved = await readJson(path.join(root, transferId + '.view.json'));
      if (!Array.isArray(saved?.snapshot?.messages)) throw new CacheRecovery('Invalid projection view');
      handle = await require('./cloud-conversation-view').create({ app, ref: 'sync-' + hash(sessionId), record, saved,
        recordOf: () => read(sessionId), artifactDirectory: () => directory(app, read(sessionId)) });
      const restored = liveOutput.create(handle, receipt.taskId, { includeUser: true });
      let replayed = 0;
      // Replay committed raw pages as well as the rendered journal. This restores
      // unfinished streaming fragments without resending any execution command.
      // Unchanged historical executions never load their transcript during a scan.
      for (const name of read(sessionId).syncState.pages || []) {
        await check();
        if (!/^\d+-\d+\.json$/.test(name)) throw new CacheRecovery('Invalid projection page name');
        const page = await readJson(path.join(pageDirectory(), name));
        if (page.from !== replayed || !Number.isSafeInteger(page.through) || page.through <= replayed ||
            !Array.isArray(page.items)) throw new CacheRecovery('Discontinuous projection pages');
        await restored.consume(ref, page.items); replayed = page.through;
      }
      if (replayed !== cursor) throw new CacheRecovery('Projection cursor mismatch');
      output = restored;
    }
    return {
      ref, get cursor() { return cursor; },
      async reusable() {
        const current = read(sessionId);
        if (!current?.syncDetailSaved || current.syncArtifactsPending || current.syncArtifactError ||
            current.syncSnapshot?.historyGap || current.syncRecovery?.historyGap ||
            current.syncState?.ref !== ref) return false;
        return true;
      },
      async apply(details) {
        await check();
        if (details?.conversation?.id !== row.id || details.conversation.receipt?.taskId !== receipt.taskId)
          throw Error('云端同步回执归属不一致');
        const page = details.page;
        if (page && (page.ref !== ref || !Number.isSafeInteger(page.last) || page.last < cursor ||
            !Number.isSafeInteger(page.persistedThrough) || page.last > page.persistedThrough || !Array.isArray(page.items)))
          throw Error('云端执行分页或连续水位无效');
        const through = page?.last ?? cursor;
        const nextPages = [...(read(sessionId).syncState.pages || [])];
        if (through > cursor) {
          try { await restoreOutput(); }
          catch (error) {
            if (!(error instanceof CacheRecovery)) throw error;
            handle?.close(); handle = output = null;
            await recoverCache(sessionId, identity, check);
            cursor = 0;
            return { restarted: true };
          }
          const name = cursor + '-' + through + '.json';
          const pageRoot = pageDirectory();
          await fs.mkdir(pageRoot, { recursive: true, mode: 0o700 });
          await durable.writeFile(path.join(pageRoot, name), JSON.stringify({ from: cursor, through, items: page.items }), { mode: 0o600, flush: true });
          await check();
          await output.consume(ref, page.items);
          nextPages.push(name);
        }
        await check();
        const current = read(sessionId), meta = details.conversation;
        await save({ ...current, phase: meta.receipt.phase,
          accepted: meta.receipt.accepted === true, acceptedAt: meta.receipt.acceptedAt || '', canAbort: meta.receipt.canAbort === true,
          remoteState: page?.status || meta.receipt.status, error: meta.receipt.error || '',
          syncSnapshot: page ? { ...page, items: [] } : null,
          cloudApprovals: Array.isArray(details.approvals) ? details.approvals : [],
          cloudMessages: Array.isArray(details.messages) ? details.messages : [], syncArtifactsPending: true,
          syncState: { ...current.syncState, ref, cursor: through, pages: nextPages },
          ...(page?.activeExecutionSelection ? { activeExecutionSelection: page.activeExecutionSelection } : {}),
          ...(meta.artifactUrl ? { artifactUrl: meta.artifactUrl } : {}),
          at: Date.parse(page?.updatedAt || meta.createdAt) || current.at });
        cursor = through;
        await check();
        // Attachment failure is retryable independently of the transcript cursor.
        try {
          if (Array.isArray(details.attachments)) {
            await materialize(read(sessionId), identity, details.attachments);
            await check();
          }
          await save({ ...read(sessionId), syncArtifactsPending: false, syncArtifactError: '', syncDetailSaved: true });
        } catch (error) {
          await check();
          await save({ ...read(sessionId), syncArtifactsPending: true,
            syncArtifactError: String(error.message || error).slice(0, 2000) });
          throw error;
        }
      },
      presence() { const current = read(sessionId); return { id: sessionId, title: current.title, cwd: '',
        workspaceName: '云端环境', workspaceLabel: '云端环境', location: 'cloud', locationMode: 'remote', cloud: true,
        adapterId: current.adapterId, taskId: current.taskId, taskIds: [current.taskId], at: current.at,
        state: current.cloudApprovals?.length || current.syncSnapshot?.historyGap || current.syncRecovery?.historyGap || current.syncArtifactsPending ? 'waiting' : current.remoteState,
        needsAttention: Boolean(current.cloudApprovals?.length || current.syncSnapshot?.historyGap || current.syncRecovery?.historyGap || current.syncArtifactsPending),
        outputPending: Boolean(current.syncArtifactsPending), outputError: current.syncArtifactError || '',
        historyGap: current.syncSnapshot?.historyGap || (current.syncRecovery?.historyGap ? { reason: 'local-cache-recovery' } : null),
        cloudApprovals: current.cloudApprovals || [] }; },
      close() { handle?.close(); },
    };
  }
  return { open, recoverCache };
}
module.exports = { create };
