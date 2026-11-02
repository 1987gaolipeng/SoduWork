'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const durable = require('../verified-file-replace.cjs');
const liveOutput = require('./task-live-output');
const { connectionScope } = require('../platform-connections/runtime.cjs');
const { scope } = require('./cloud-execution-sync');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function create({ app, root, read, save, materialize, directory }) {
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
    await check();
    if (!record) {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await durable.writeFile(path.join(root, transferId + '.view.json'), JSON.stringify({ cwd,
        adapterId: receipt.source.adapterId || row.execution?.engine || 'pi', model: row.execution?.model || '',
        snapshot: { messages: [], tools: [], adapterId: receipt.source.adapterId || 'pi',
          displayName: receipt.source.adapterId || 'pi', execution: { cloud: true }, status: 'idle' } }), { mode: 0o600, flush: true });
      await check();
    }
    const ref = String(row.execution?.ref || receipt.ref || '');
    record = { ...record, sessionId, transferId, cwd, entryKind: 'cloud',
      owner: record?.owner || connectionScope(identity), syncOwner: owner, syncId: row.id,
      taskId: receipt.taskId, title: row.title, adapterId: receipt.source.adapterId || 'pi',
      phase: receipt.phase, ref, target: receipt.target,
      accepted: receipt.accepted === true, acceptedAt: receipt.acceptedAt || '', canAbort: receipt.canAbort === true,
      remoteState: row.execution?.status || receipt.status,
      at: Date.parse(row.execution?.updatedAt || row.createdAt) || record?.at || Date.now(),
      ...(receipt.deliveryMode === 'git' ? { codeDelivery: receipt.codeDelivery, deliveryPresentation: 'summary' } : {}),
      ...(row.artifactUrl ? { artifactUrl: row.artifactUrl } : {}),
      syncState: record?.syncState?.ref === ref ? record.syncState : { ref, cursor: 0, pages: [] } };
    await save(record); await check();
    const pageRoot = path.join(app.getPath('userData'), 'cloud-execution-sync', owner, hash(row.id + '\0' + ref));
    let cursor = record.syncState.cursor, handle = null, output = null;
    async function restoreOutput() {
      if (output) return;
      const saved = JSON.parse(await fs.readFile(path.join(root, transferId + '.view.json'), 'utf8'));
      handle = require('./cloud-conversation-view').create({ app, ref: 'sync-' + hash(sessionId), record, saved,
        recordOf: () => read(sessionId), artifactDirectory: () => directory(app, read(sessionId)) });
      output = liveOutput.create(handle, receipt.taskId, { includeUser: true });
      let replayed = 0;
      // Replay committed raw pages as well as the rendered journal. This restores
      // unfinished streaming fragments without resending any execution command.
      // Unchanged historical executions never load their transcript during a scan.
      for (const name of read(sessionId).syncState.pages || []) {
        await check();
        if (!/^\d+-\d+\.json$/.test(name)) throw Error('云端缓存分页无效');
        const page = JSON.parse(await fs.readFile(path.join(pageRoot, name), 'utf8'));
        if (page.from !== replayed || page.through <= replayed) throw Error('云端缓存分页不连续');
        await output.consume(ref, page.items); replayed = page.through;
      }
      if (replayed !== cursor) throw Error('云端缓存水位不一致');
    }
    return {
      ref, get cursor() { return cursor; },
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
          await restoreOutput();
          const name = cursor + '-' + through + '.json';
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
          syncState: { ref, cursor: through, pages: nextPages },
          ...(page?.activeExecutionSelection ? { activeExecutionSelection: page.activeExecutionSelection } : {}),
          ...(meta.artifactUrl ? { artifactUrl: meta.artifactUrl } : {}),
          at: Date.parse(page?.updatedAt || meta.createdAt) || current.at });
        cursor = through;
        await check();
        // Attachment failure is retryable independently of the transcript cursor.
        try {
          if (Array.isArray(details.attachments) && details.attachments.length) {
            await materialize(read(sessionId), identity, details.attachments);
            await check();
          }
          await save({ ...read(sessionId), syncArtifactsPending: false, syncArtifactError: '' });
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
        state: current.cloudApprovals?.length || current.syncSnapshot?.historyGap || current.syncArtifactsPending ? 'waiting' : current.remoteState,
        needsAttention: Boolean(current.cloudApprovals?.length || current.syncSnapshot?.historyGap || current.syncArtifactsPending),
        outputPending: Boolean(current.syncArtifactsPending), outputError: current.syncArtifactError || '',
        historyGap: current.syncSnapshot?.historyGap || null,
        cloudApprovals: current.cloudApprovals || [] }; },
      close() { handle?.close(); },
    };
  }
  return { open };
}
module.exports = { create };
