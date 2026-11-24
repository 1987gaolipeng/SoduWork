'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const native = require('./device-history-native.cjs');
const { withTranscript } = require('./conversation-body.cjs');
const { mergeNativeEvidence } = require('./history-evidence.cjs');
const { accountId } = require('../device-auth-request');
const SCHEMA = 'soduwork.device-history/v1';
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields = ['id', 'title', 'adapterId', 'modelName', 'taskId', 'taskTitle', 'taskIds', 'taskBindings', 'activeTaskId',
  'createdAt', 'at', 'count', 'state', 'status', 'archived', 'creator', 'usedHarnesses'];
function metadata(row) { return Object.fromEntries(fields.filter(key => row[key] !== undefined).map(key => [key, row[key]])); }
function assertSettled(data) {
  if (data?.coverage?.unresolvedTools?.length || native.unresolvedTools(data?.snapshot).length)
    throw Object.assign(Error('历史中有工具缺少终结回执，结果尚未确认，暂时只能查看，不能恢复执行或迁移'), { code: 'HISTORY_UNRESOLVED_TOOLS' });
}
function create({ app, session, store, resolve, guard, authorize, authorizeContinuation = authorize,
  requiresNativeEvidence = () => false, usesDeviceDialogue = () => false, allowsArtifacts = () => false, workRoot, identityOf, register, runtime }) {
  const pending = new Map(), writers = new Map();
  let background = Promise.resolve();
  const scheduled = new Set();
  function readGuard(row, verify) {
    const check = guard(row); let evidence = row;
    const combined = nativeRow => {
      try {
        evidence = mergeNativeEvidence(evidence, nativeRow);
        check(evidence); verify?.(evidence);
      }
      catch (error) { error.historyAccessFailure = true; throw error; }
    };
    combined.evidence = () => evidence;
    return combined;
  }
  async function refresh(id, { verify, journal } = {}) {
    // A stricter caller must inspect its own native ownership receipt instead
    // of borrowing a background read authorized only for the local desktop.
    const key = verify || journal ? Symbol(id) : id;
    if (pending.has(key)) return pending.get(key);
    const work = (async () => {
      // Preserve per-turn file receipts when an independent strict read overlaps a capture.
      await writers.get(id)?.catch(() => {});
      const row = await resolve(id);
      if (!row || row.deleted || row.cached || row.cloud) return null;
      const check = readGuard(row, verify); check();
      if (row.deviceTransferId) {
        const manifest = require('./runtime-segments').read(app, row.id);
        if (manifest?.deviceTransferId !== row.deviceTransferId) {
          const imported = await store.deviceHistory(row.id); check();
          if (imported?.imported?.transferId === row.deviceTransferId && imported.coverage?.complete) return imported;
          throw Object.assign(Error('交接历史尚未完整接收，请先完成迁移'), { code: 'HISTORY_IMPORT_PENDING' });
        }
      }
      const previous = await store.deviceHistory(row.id); check();
      // Local receipt hashes are stored outside portable snapshots and coverage.
      // An imported transcript cannot certify tools from the receiving desktop.
      const previousToolReceipts = previous?.imported || row.deviceTransferId ? [] : previous?.localToolReceipts ?? previous?.localImageReceipts;
      // A second SQLite client can update the body without changing the catalog
      // or lifecycle revision. Never overwrite a generation we did not verify.
      const expected = { expectedRevision: row.replicaRevision, expectedTransferId: row.deviceTransferId || '',
        expectedHistoryDigest: previous?.digest ?? null };
      check(previous?.historyProtection ? { historyProtection: previous.historyProtection } : undefined);
      let data;
      try {
        data = await native.read({ app, session, row, guard: check, runtime, previousToolReceipts,
          previousSources: previous?.coverage?.complete ? previous.coverage.sources : [], previousSnapshot: previous?.snapshot });
      } catch (error) {
        if (error.code !== 'NATIVE_HISTORY_DIVERGED' || !previous) throw error;
        check();
        // Keep the complete body and its original proof across restart. A
        // subsequent missing file is not evidence that the divergence is gone.
        const { digest, savedAt, ...preserved } = previous;
        preserved.nativeConflict = { code: error.code, reason: error.message };
        if (check.evidence().historyProtection === 'account') preserved.historyProtection = 'account';
        const result = await store.saveDeviceHistory(row.id, preserved, expected); check();
        if (!result.ok) throw Object.assign(Error('历史记录已变化，请重新读取'), { code: 'HISTORY_CONCURRENT_UPDATE' });
        throw error;
      }
      check();
      const workspace = data.localWorkspace;
      delete data.localWorkspace;
      const priorCursors = new Map((previous?.coverage?.sources || []).filter(source => source.adapterId !== 'pi')
        .map(source => [source.id, Number(source.revision)]));
      const lostBody = !data.snapshot.messages.length && (previous?.snapshot?.messages?.length ||
        !data.snapshot.tools.length && (previous?.snapshot?.tools?.length || Number(row.count) > 0));
      const regressed = data.coverage.sources.some(source => source.adapterId !== 'pi' &&
        Number(source.revision) < priorCursors.get(source.id));
      if (lostBody || regressed)
        throw Object.assign(Error('原始历史比现有记录少，已保留本机副本'), { code: 'NATIVE_HISTORY_UNAVAILABLE' });
      if (previous?.imported) data.imported = previous.imported;
      check(previous?.historyProtection ? { historyProtection: previous.historyProtection } : undefined);
      if (check.evidence().historyProtection === 'account') data.historyProtection = 'account';
      if (!data.historyProtection && !data.imported && allowsArtifacts(check.evidence())) {
        const retained = require('./runtime-segments').read(app, row.id)?.artifactHistory;
        const artifacts = await require('./device-history-artifacts.cjs').capture({ row, workspace,
          workRoot: workspace ? workRoot?.() : null, previous: previous?.localArtifactHistory, retained, journal });
        check();
        if (artifacts) data.localArtifactHistory = artifacts;
      }
      const current = await resolve(id); check();
      if (!current || current.deleted || current.replicaRevision !== row.replicaRevision ||
          current.deviceTransferId !== row.deviceTransferId) throw Error('历史记录已变化，请重新读取');
      const saved = await store.saveDeviceHistory(row.id, data, expected); check();
      if (!saved.ok) throw Object.assign(Error('历史记录已变化，请重新读取'), { code: 'HISTORY_CONCURRENT_UPDATE' });
      await register([{ ...row, deviceHistory: true, historyContentState: 'available',
        ...(data.historyProtection ? { historyProtection: data.historyProtection } : {}) }], { expectedRevision: current.revision }); check();
      return { ...data, digest: saved.digest };
    })().finally(() => {
      pending.delete(key);
      if (writers.get(id) === work) writers.delete(id);
    });
    writers.set(id, work); pending.set(key, work); return work;
  }
  async function saved(id, { refresh: update = false, verify, preferRecorded = false } = {}) {
    const row = await resolve(id);
    if (!row || row.deleted || row.cached) return null;
    const check = readGuard(row, verify); check();
    let data = await store.deviceHistory(row.id); check();
    check(data?.historyProtection ? { historyProtection: data.historyProtection } : undefined);
    const shared = requiresNativeEvidence(row);
    if (shared) await native.probe({ app, session, row, guard: check });
    if (row.deviceTransferId && data?.imported?.transferId !== row.deviceTransferId)
      throw Object.assign(Error('交接历史尚未完整接收，请先完成迁移'), { code: 'HISTORY_IMPORT_PENDING' });
    let dialogue = [], transcriptError, inspected = false;
    async function readDialogue() {
      if (inspected || !usesDeviceDialogue(check.evidence())) return;
      inspected = true;
      try { dialogue = await store.conversationTranscript(row.id, { includeDraftState: true }); }
      catch (error) {
        if (error.code !== 'TRANSCRIPT_CHECKSUM_MISMATCH') throw error;
        transcriptError = error;
      }
      check();
    }
    if (preferRecorded && !shared && !verify) await readDialogue();
    // An owner's passive desktop view can paint its committed dialogue without
    // waiting for a model or a Runner RPC. Execution and peer access revalidate.
    const localDisplay = preferRecorded && !shared && !verify && dialogue.length > 0;
    if (!localDisplay && (update || !data || !data.coverage?.complete || transcriptError)) {
      try { data = await refresh(row.id, { verify }); }
      catch (error) {
        if (error.historyAccessFailure || error.code === 'HISTORY_CONCURRENT_UPDATE') throw error;
        if (!data) await readDialogue();
        if (!data && transcriptError && error.code === 'NATIVE_HISTORY_MISSING') throw transcriptError;
        if (!data && !dialogue.length && error.code === 'NATIVE_HISTORY_MISSING') {
          await register([{ ...row, historyContentState: 'missing' }]); check();
        }
        if (!data && (!dialogue.length || !['NATIVE_HISTORY_MISSING', 'NATIVE_HISTORY_UNAVAILABLE',
          'NATIVE_HISTORY_CHANGED'].includes(error.code))) throw error;
        if (error.code === 'NATIVE_HISTORY_DIVERGED') {
          data = await store.deviceHistory(row.id); check();
          if (!data) throw error;
          check(data.historyProtection ? { historyProtection: data.historyProtection } : undefined);
        }
        // Reading an independent copy does not grant permission to resume an
        // unavailable native runtime. Continuation performs its own strict probe.
        data = { ...data, nativeReadError: { code: error.code || 'NATIVE_HISTORY_UNAVAILABLE', reason: error.message } };
      }
    }
    if (localDisplay && update) schedule([row], { includeSaved: true });
    if (data?.nativeConflict) data = { ...data, nativeReadError: data.nativeConflict };
    check(data?.historyProtection ? { historyProtection: data.historyProtection } : undefined);
    await readDialogue();
    if (data && transcriptError) return { ...data, coverage: { ...data.coverage, complete: false },
      nativeReadError: { code: transcriptError.code, reason: '设备对话记录校验失败，已显示可读取的执行记录' } };
    return dialogue.length && usesDeviceDialogue(check.evidence()) ? withTranscript(data, dialogue) : data;
  }
  async function attachments(snapshot) {
    const values = [];
    for (const message of snapshot.messages || []) for (const item of message.attachments || []) {
      const value = { ...item };
      if (typeof item.path === 'string' && item.path) {
        try { const stat = await fs.stat(item.path); value.availability = stat.isFile() ? 'available' : 'unavailable'; }
        catch (error) { value.availability = error.code === 'ENOENT' ? 'missing' : 'unavailable'; }
      } else value.availability = item.availability || 'unrecorded';
      values.push(value);
    }
    return values;
  }
  async function exportPortable(id) {
    const row = await resolve(id);
    if (!row || row.deleted || row.cached) throw Error('没有可迁移的本机会话');
    authorize(row);
    const check = guard(row), data = await saved(row.id, { refresh: true }); check();
    if (!data?.coverage?.complete) throw Error('本机历史尚未完整保存，无法迁移');
    assertSettled(data);
    if (data.nativeReadError && data.nativeReadError.code !== 'NATIVE_HISTORY_MISSING')
      throw Error('无法核验原生历史的最新状态，请稍后再迁移');
    const identity = identityOf();
    const references = await attachments(data.snapshot);
    for (const item of references) if (typeof item.path === 'string' && path.isAbsolute(item.path) && row.cwd) {
      const relative = path.relative(row.cwd, item.path);
      if (relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
        item.relativePath = relative.split(path.sep).join('/');
    }
    const bundle = { schema: SCHEMA, conversation: { ...metadata(row), creator: row.creator || {
      account: accountId(identity), hub: identity?.hub } }, snapshot: native.publicSnapshot(data.snapshot),
      coverage: data.coverage, attachments: references };
    check();
    if (Buffer.byteLength(JSON.stringify(bundle)) > native.MAX_BYTES) throw Error('历史超过完整迁移上限');
    return { ...bundle, sha256: digest(bundle) };
  }
  async function importPortable(bundle, { identity, cwd, transferId, files = [], predecessor, assertCurrent = () => {} } = {}) {
    await assertCurrent();
    if (!bundle || bundle.schema !== SCHEMA || !bundle.coverage?.complete || !bundle.conversation?.id ||
        !Array.isArray(bundle.snapshot?.messages) || !Array.isArray(bundle.snapshot?.tools) ||
        !transferId || typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw Error('设备历史交接内容无效');
    const { sha256, ...body } = bundle;
    if (digest(body) !== sha256 || Buffer.byteLength(JSON.stringify(bundle)) > native.MAX_BYTES) throw Error('设备历史交接校验失败');
    if (bundle.snapshot.messages.some(message => !message || !['user', 'assistant'].includes(message.role)) ||
        !Array.isArray(files) || files.length > 4000) throw Error('设备历史消息或文件清单无效');
    const owner = bundle.conversation.creator;
    if (!owner || owner.account !== accountId(identity) || owner.hub !== identity?.hub) throw Error('交接会话不属于当前账号或服务');
    const workOwner = require('../platform-connections/runtime.cjs').scope(identity);
    const ownerGuard = guard({ ...bundle.conversation, cwd, workOwner });
    const current = async () => { await assertCurrent(); ownerGuard(); };
    await current();
    if (!(await fs.stat(cwd)).isDirectory()) throw Error('交接工作目录不可用');
    await current();
    const indexed = await store.get(bundle.conversation.id); await current();
    const old = indexed || await resolve(bundle.conversation.id); await current();
    if (old && !old.deleted && old.deviceTransferId === transferId && old.deviceTransferDigest === sha256) {
      const saved = await store.deviceHistory(old.id); await current();
      if (saved?.imported?.transferId === transferId && saved.imported.sha256 === sha256)
        return { ok: true, id: old.id, revision: old.revision, unchanged: true };
    }
    let expectedHistoryDigest;
    if (old && (old.deleted || old.deviceTransferId !== transferId || old.deviceTransferDigest !== sha256)) {
      const saved = await store.deviceHistory(old.id); await current();
      if (old.deleted || !predecessor || !predecessor.transferId || old.deviceTransferId && predecessor.transferId !== old.deviceTransferId ||
          !require('./device-transfer-receipt.cjs').matchesHistory(predecessor, old, saved) || session.findBySessionId?.(old.id)?.inFlight?.())
        throw Error('目标设备已存在同名会话或删除记录，不能覆盖');
      expectedHistoryDigest = saved.digest;
    }
    const approved = new Map();
    for (const file of files) {
      require('./portable-workspace').portablePath(file.path);
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > native.MAX_BYTES ||
          !/^[a-f0-9]{64}$/.test(file.sha256)) throw Error('交接文件清单无效');
      const target = path.join(cwd, ...file.path.split('/'));
      require('../plugin-resources').assertNoLinks(cwd, target);
      const bytes = await fs.readFile(target); await current();
      if (bytes.length !== file.size || crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256)
        throw Error('交接文件校验失败');
      approved.set(file.path, target);
    }
    const mapped = new Map((bundle.attachments || []).filter(item => item.relativePath && approved.has(item.relativePath))
      .map(item => [item.path, approved.get(item.relativePath)]));
    const snapshot = native.publicSnapshot(bundle.snapshot);
    const cleanReference = value => {
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (key === 'toolCall' || key === 'historyTools') continue;
        if (['previewRef', 'path', 'filePath', 'file_path', 'sourcePath', 'localPath', 'outputPath'].includes(key) ||
            ['url', 'src', 'href', 'previewUrl'].includes(key) && typeof item === 'string' &&
            (!/^(?:https?:\/\/|data:image\/)/i.test(item) || /^[a-z]:[\\/]/i.test(item) || path.isAbsolute(item))) {
          if (key === 'path' && mapped.has(item)) { value.path = mapped.get(item); value.availability = 'available'; }
          else { delete value[key]; value.availability = 'missing'; }
        } else if (item && typeof item === 'object') cleanReference(item);
      }
      if (typeof value.path === 'string' && [...approved.values()].includes(value.path)) value.availability = 'available';
    };
    // Tool arguments/results remain historical evidence. Only structured
    // message media may acquire a path, through the verified file manifest.
    for (const message of snapshot.messages) cleanReference(message);
    await current();
    const [row] = await register([{ ...metadata(bundle.conversation), cwd, cached: false, cloud: false,
      deviceHistory: true, deviceTransferId: transferId, deviceTransferDigest: sha256,
      workOwner, creator: { account: accountId(identity), hub: identity.hub }, historyAliasIds: [] }],
      { expectedRevision: old?.revision, expectedAbsent: !old, expectedHistoryDigest });
    await current();
    if (!row || row.deleted || row.deviceTransferId !== transferId || row.deviceTransferDigest !== sha256)
      throw Error('目标会话在接收期间已变化，请重新核对');
    const check = guard(row); check();
    const data = { snapshot, coverage: bundle.coverage,
      imported: { transferId, sha256 }, historyRecovery: { mode: 'device-history', nativeArchiveMissing: true } };
    await current();
    const result = await store.saveDeviceHistory(row.id, data, { expectedRevision: row.replicaRevision,
      expectedTransferId: transferId }); check(); await current();
    if (!result.ok) throw Error('目标历史状态已变化');
    return { ok: true, id: row.id, revision: row.revision };
  }
  async function prepareContinuation(id, { refresh = false } = {}) {
    const row = await resolve(id);
    if (!row || row.deleted || row.cached) throw Error('这条历史不能继续执行');
    authorizeContinuation(row);
    const check = guard(row), data = await saved(row.id, { refresh }); check();
    if (!data?.coverage?.complete) throw Object.assign(Error('本机历史不完整，不能恢复执行'), { code: 'HISTORY_INCOMPLETE' });
    if (data.nativeReadError && data.nativeReadError.code !== 'NATIVE_HISTORY_MISSING')
      throw Object.assign(Error(data.nativeReadError.reason), { code: data.nativeReadError.code });
    assertSettled(data);
    const verified = mergeNativeEvidence(row, data.historyProtection ? { historyProtection: data.historyProtection } : undefined);
    const references = await attachments(data.snapshot);
    check();
    authorizeContinuation(verified);
    const nativeArchiveMissing = !refresh || data.nativeReadError?.code === 'NATIVE_HISTORY_MISSING' ||
      Boolean(data.imported && data.historyRecovery?.nativeArchiveMissing);
    return { row: verified, prefix: native.publicSnapshot(data.snapshot),
      ...(data.localArtifactHistory && !data.imported && !data.historyProtection && allowsArtifacts(verified)
        ? { artifactHistory: data.localArtifactHistory } : {}), historyRecovery: { mode: 'device-history',
      nativeArchiveMissing, savedAt: data.savedAt || Date.now(), attachments: references } };
  }
  function schedule(rows, { includeSaved = false } = {}) {
    for (const row of rows) {
      if (row.cached || row.deleted || row.deviceHistory && !includeSaved || scheduled.has(row.id)) continue;
      scheduled.add(row.id);
      background = background.then(async () => {
        await new Promise(resolve => setImmediate(resolve));
        try { await saved(row.id, { refresh: true }); } catch (_) { /* Retain the archive and retry on an explicit read or later discovery. */ }
        finally { scheduled.delete(row.id); }
      });
    }
  }
  return { refresh, saved, schedule, exportPortable, importPortable, prepareContinuation,
    attachments: message => attachments({ messages: [message] }),
    async close() { await background; await Promise.allSettled([...pending.values()]); } };
}
module.exports = { create, SCHEMA };
