'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const native = require('./device-history-native.cjs');
const archive = require('./device-artifact-archive.cjs');
const { withTranscript } = require('./conversation-body.cjs');
const { mergeNativeEvidence } = require('./history-evidence.cjs');
const { accountId } = require('../device-auth-request');
const SCHEMA = 'soduwork.device-history/v1';
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields = ['id', 'title', 'adapterId', 'modelName', 'taskId', 'taskTitle', 'taskIds', 'taskBindings', 'activeTaskId',
  'createdAt', 'at', 'count', 'state', 'status', 'archived', 'creator', 'usedHarnesses'];
function metadata(row) { return Object.fromEntries(fields.filter(key => row[key] !== undefined).map(key => [key, row[key]])); }
function replayedUsage(snapshot, row) {
  const usage = require('./used-harnesses');
  const replayed = usage.fromTimeline(snapshot);
  return replayed.length ? { usedHarnesses: usage.merge(replayed, row.usedHarnesses) } : {};
}
function locallyReceivedArtifacts(row, data) {
  return Boolean(row?.deviceTransferId && row.deviceTransferId === data?.imported?.transferId &&
    row.deviceTransferId === data?.localArtifactHistory?.transferId);
}
function currentReceiver(row, data, manifest, identity) {
  return Boolean(identity && row.deviceTransferId && row.deviceTransferId === data?.imported?.transferId &&
    row.deviceTransferDigest === data.imported.sha256 && row.creator?.account === accountId(identity) &&
    row.creator?.hub === identity.hub && manifest?.deviceTransferId === row.deviceTransferId &&
    manifest.owner === row.workOwner && manifest.hub === identity.hub &&
    row.workOwner === require('../platform-connections/runtime.cjs').scope(identity));
}
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
  async function restoreArchiveReceipts(row, data, check) {
    if (!data?.localArtifactHistory?.archive || data.historyProtection || check.evidence().historyProtection) return data;
    const received = locallyReceivedArtifacts(row, data);
    if (!received && (data.imported || !allowsArtifacts(check.evidence()))) return data;
    function current() {
      check();
      if (received) authorize(check.evidence());
    }
    let localArtifactHistory = await archive.rebind(app.getPath('userData'), row.id, data.localArtifactHistory, current);
    if (localArtifactHistory.archive?.pendingFiles?.length) {
      try {
        localArtifactHistory = await archive.preserve(app.getPath('userData'), row.id, localArtifactHistory,
          localArtifactHistory, current, { readWorkspace: false });
      } catch (error) {
        current();
        if (error.historyAccessFailure) throw error;
      }
    }
    current();
    if (localArtifactHistory === data.localArtifactHistory) return data;
    const { digest: oldDigest, savedAt, ...body } = data;
    const updated = { ...body, localArtifactHistory };
    const result = await store.saveDeviceHistory(row.id, updated, { expectedRevision: row.replicaRevision,
      expectedTransferId: row.deviceTransferId || '', expectedHistoryDigest: oldDigest });
    await archive.retire(app.getPath('userData'), row.id, data.localArtifactHistory.archive, localArtifactHistory.archive,
      result.ok).catch(() => {});
    current();
    if (result.ok) return { ...updated, digest: result.digest, savedAt };
    const concurrent = await store.deviceHistory(row.id);
    current();
    if (concurrent?.digest === digest(updated)) return concurrent;
    throw Object.assign(Error('历史记录已变化，请重新读取'), { code: 'HISTORY_CONCURRENT_UPDATE' });
  }
  // Commit the immutable bytes before releasing the runtime's turn queue. A
  // native transcript read can lag that boundary and is refreshed separately.
  function captureTurn(id, { workspace, ref, journal, snapshot, assertCurrent }) {
    const predecessor = writers.get(id);
    const work = (async () => {
      await predecessor?.catch(() => {});
      const row = await resolve(id);
      if (!row || row.deleted || row.cached || row.cloud) return;
      const check = readGuard(row, assertCurrent);
      const priorBody = await store.deviceHistory(row.id);
      check(priorBody?.historyProtection ? { historyProtection: priorBody.historyProtection } : undefined);
      if (row.historyProtection || priorBody?.historyProtection) return;
      if (priorBody?.imported || row.deviceTransferId) {
        const manifest = require('./runtime-segments').read(app, row.id);
        if (!currentReceiver(row, priorBody, manifest, identityOf())) return;
        authorize(row);
      } else if (!allowsArtifacts(row)) return;
      const workspaces = require('./delivery-workspace.cjs');
      let root;
      if (workspace) {
        if (workspace.key !== row.deliveryWorkspaceKey) throw Error('会话成果目录已变化');
        root = workspaces.root(row.cwd, workspace);
      } else {
        // A shared project cannot supply a scratch receipt by using its basename.
        if (!workRoot || row.deliveryWorkspaceKey || !/^chat-(?:[a-z0-9]+-[a-z0-9]{4,6}|[a-f0-9-]{36})$/.test(ref)) return;
        const base = await fs.realpath(workRoot());
        const expected = path.join(base, 'temp', ref);
        if (await fs.realpath(row.cwd).catch(() => '') !== expected) return;
        require('../plugin-resources').assertNoLinks(base, expected);
        root = expected;
      }
      if (journal.cwd !== root || !journal.turnId || !journal.files?.length || journal.truncated) return;
      const prior = !priorBody?.imported || locallyReceivedArtifacts(row, priorBody) ? priorBody?.localArtifactHistory : undefined;
      const collected = await require('./device-history-artifacts.cjs').capture({ row: { ...row, cwd: root },
        previous: prior, journal, verifiedTurn: true });
      if (!collected) return;
      check();
      const profile = app.getPath('userData');
      const history = await archive.preserve(profile, row.id, collected, prior, check);
      if (row.deviceTransferId) history.transferId = row.deviceTransferId;
      const { digest: oldDigest, savedAt, ...body } = priorBody || {
        snapshot: native.publicSnapshot(snapshot), coverage: { complete: false, sources: [] },
      };
      check();
      const saved = await store.saveDeviceHistory(row.id, { ...body, localArtifactHistory: history }, {
        expectedRevision: row.replicaRevision, expectedTransferId: row.deviceTransferId || '', expectedHistoryDigest: oldDigest ?? null,
      });
      await archive.retire(profile, row.id, prior?.archive, history.archive, saved.ok).catch(() => {});
      check();
      if (!saved.ok) throw Error('会话成果保存时历史已变化');
      let publicationError;
      if (workspace && history.archive) {
        try {
          const copies = await require('./artifact-versions.cjs').exportTurn({ profile, id: row.id, archive: history.archive,
            turnId: journal.turnId, workspace: workspace.projectRoot, workspaceKey: workspace.key, guard: check });
          if (copies.some(copy => copy.conflict))
            publicationError = Error('会话成果原件已保存。工作目录已有不同内容的同名副本，可从历史成果卡另存。');
        } catch (error) {
          check();
          if (error.historyAccessFailure) throw error;
          publicationError = Error('已归档的原件可从历史成果卡另存。工作副本未能投递，请检查目录权限和可用空间。', { cause: error });
        }
      }
      if (history.archivePending || history.archive?.omitted) throw Error('部分会话成果未完成归档，请保留工作目录中的文件。');
      if (publicationError) throw publicationError;
    })().finally(() => { if (writers.get(id) === work) writers.delete(id); });
    writers.set(id, work);
    return work;
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
      const manifest = require('./runtime-segments').read(app, row.id);
      if (row.deviceTransferId) {
        if (manifest?.deviceTransferId !== row.deviceTransferId) {
          const imported = await store.deviceHistory(row.id); check();
          if (imported?.imported?.transferId === row.deviceTransferId && imported.coverage?.complete)
            return restoreArchiveReceipts(row, imported, check);
          throw Object.assign(Error('交接历史尚未完整接收，请先完成迁移'), { code: 'HISTORY_IMPORT_PENDING' });
        }
      }
      let previous = await store.deviceHistory(row.id); check();
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
      previous = await restoreArchiveReceipts(row, previous, check);
      expected.expectedHistoryDigest = previous?.digest ?? null;
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
      if (previous?.imported) {
        data.imported = previous.imported;
        if (locallyReceivedArtifacts(row, previous)) data.localArtifactHistory = previous.localArtifactHistory;
      }
      check(previous?.historyProtection ? { historyProtection: previous.historyProtection } : undefined);
      if (check.evidence().historyProtection === 'account') data.historyProtection = 'account';
      const identity = data.imported && journal ? identityOf() : null;
      const receivingTurn = currentReceiver(row, data, manifest, identity);
      if (!data.historyProtection && (receivingTurn || !data.imported && allowsArtifacts(check.evidence()))) {
        if (receivingTurn) authorize(check.evidence());
        const prior = data.imported ? data.localArtifactHistory : previous?.localArtifactHistory;
        // Incoming messages and segment metadata cannot attest to files. A new
        // local turn can contribute only its verified on-disk change receipts.
        // The terminal callback owns collection in a managed delivery directory.
        // A passive replay must not attribute unrelated project changes to it.
        const collected = row.deliveryWorkspaceKey ? prior : await require('./device-history-artifacts.cjs').capture({ row, previous: prior, journal,
          ...(!receivingTurn ? { workspace, workRoot: workspace ? workRoot?.() : null, retained: manifest?.artifactHistory } : {}) });
        const artifacts = archive.retain(prior, collected);
        check();
        if (artifacts) {
          try {
            data.localArtifactHistory = await archive.preserve(app.getPath('userData'), row.id, artifacts, prior, check);
          } catch (error) {
            check();
            if (error.historyAccessFailure) throw error;
            data.localArtifactHistory = { ...artifacts, archivePending: true,
              ...(prior?.archive ? { archive: prior.archive } : {}) };
          }
          if (receivingTurn) data.localArtifactHistory.transferId = row.deviceTransferId;
        }
      }
      const current = await resolve(id); check();
      if (!current || current.deleted || current.replicaRevision !== row.replicaRevision ||
          current.deviceTransferId !== row.deviceTransferId) throw Error('历史记录已变化，请重新读取');
      const saved = await store.saveDeviceHistory(row.id, data, expected); check();
      await archive.retire(app.getPath('userData'), row.id, previous?.localArtifactHistory?.archive,
        data.localArtifactHistory?.archive, saved.ok).catch(() => {});
      if (!saved.ok) throw Object.assign(Error('历史记录已变化，请重新读取'), { code: 'HISTORY_CONCURRENT_UPDATE' });
      await register([{ ...current, deviceHistory: true, historyContentState: 'available',
        ...replayedUsage(data.snapshot, current),
        ...(data.historyProtection ? { historyProtection: data.historyProtection } : {}) }], { expectedRevision: current.revision }); check();
      return { ...data, digest: saved.digest };
    })().finally(() => {
      pending.delete(key);
      if (writers.get(id) === work) writers.delete(id);
    });
    writers.set(id, work); pending.set(key, work); return work;
  }
  async function canBackfill(row, receipt) {
    const cwd = await fs.realpath(row.cwd).catch(() => null);
    if (!cwd) return false;
    if (cwd === receipt.root) return true;
    if (!row.deliveryWorkspaceKey) return false;
    try { return require('./delivery-workspace.cjs').resolve(cwd, row.deliveryWorkspaceKey).draftRoot === receipt.root; }
    catch (_) { return false; }
  }
  async function saved(id, { refresh: update = false, verify, preferRecorded = false, onlyUpgrade = false } = {}) {
    const row = await resolve(id);
    if (!row || row.deleted || row.cached) return null;
    const check = readGuard(row, verify); check();
    let data = await store.deviceHistory(row.id); check();
    check(data?.historyProtection ? { historyProtection: data.historyProtection } : undefined);
    if (onlyUpgrade && !data?.localArtifactHistory) {
      if (data?.digest) await store.markArchiveReviewed(row.id, data.digest);
      return data;
    }
    const shared = requiresNativeEvidence(row);
    if (shared) await native.probe({ app, session, row, guard: check });
    if (row.deviceTransferId && data?.imported?.transferId !== row.deviceTransferId)
      throw Object.assign(Error('交接历史尚未完整接收，请先完成迁移'), { code: 'HISTORY_IMPORT_PENDING' });
    data = await restoreArchiveReceipts(row, data, check);
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
    if (!onlyUpgrade && !localDisplay && (update || !data || !data.coverage?.complete || transcriptError)) {
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
    // Legacy replicas can outlive the native CLI journal. Upgrade only their
    // already-verified file identities while the original workspace exists.
    if (archive.needsBackup(data?.localArtifactHistory) && !data.imported && !data.historyProtection &&
        allowsArtifacts(check.evidence()) && await canBackfill(row, data.localArtifactHistory)) {
      const { digest: oldDigest, savedAt, nativeReadError, ...stored } = data;
      const prior = data.localArtifactHistory;
      const updated = await archive.preserve(app.getPath('userData'), row.id, prior, prior, check)
        .catch(error => { if (error.historyAccessFailure) throw error; return null; });
      check();
      if (updated) {
        stored.localArtifactHistory = updated;
        const result = await store.saveDeviceHistory(row.id, stored, { expectedRevision: row.replicaRevision,
          expectedTransferId: row.deviceTransferId || '', expectedHistoryDigest: oldDigest });
        await archive.retire(app.getPath('userData'), row.id, prior.archive, updated.archive, result.ok).catch(() => {});
        check();
        if (!result.ok) throw Object.assign(Error('历史记录已变化，请重新读取'), { code: 'HISTORY_CONCURRENT_UPDATE' });
        data = { ...stored, digest: result.digest, savedAt, nativeReadError };
      }
    }
    if (onlyUpgrade) {
      if (data?.digest && !archive.needsBackup(data.localArtifactHistory)) await store.markArchiveReviewed(row.id, data.digest);
      return data;
    }
    if (localDisplay && update) schedule([row], { includeSaved: true });
    if (data?.nativeConflict) data = { ...data, nativeReadError: data.nativeConflict };
    check(data?.historyProtection ? { historyProtection: data.historyProtection } : undefined);
    await readDialogue();
    if (data?.snapshot && Array.isArray(data.coverage?.sources) && data.coverage.sources.length)
      data = { ...data, snapshot: require('./native-agent-source.cjs').restoreRunnerSources(data.snapshot, data.coverage.sources) };
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
  async function transferSources(id, ref) {
    const row = await resolve(id);
    if (!row || row.cached || row.cloud || row.deleted) throw Error('没有可迁移的本机会话');
    authorize(row);
    const check = readGuard(row), data = await saved(id, { verify: check });
    check(data?.historyProtection ? { historyProtection: data.historyProtection } : undefined);
    authorize(check.evidence());
    const sources = require('./device-transfer-sources.cjs');
    const authorized = !data?.historyProtection && (locallyReceivedArtifacts(row, data) ||
      !data?.imported && allowsArtifacts(check.evidence()));
    const files = authorized && data?.localArtifactHistory
      ? sources.artifactFiles(app.getPath('userData'), id, data.localArtifactHistory) : [];
    files.push(...await sources.inputFiles(workRoot?.(), ref, data?.snapshot));
    check();
    return files;
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
    const bundle = { schema: SCHEMA, conversation: { ...metadata(row), ...replayedUsage(data.snapshot, row), creator: row.creator || {
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
    const approved = new Map(), attachmentPaths = new Map(), received = [];
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
      if (file.artifact === true) received.push({ action: 'created', path: file.path,
        after: { exists: true, path: file.path, size: file.size, hash: file.sha256 } });
      if (typeof file.attachmentKey === 'string' && /^[a-f0-9]{64}$/.test(file.attachmentKey) &&
          file.path.startsWith('conversation-inputs/' + file.attachmentKey.slice(0, 16) + '/'))
        attachmentPaths.set(file.attachmentKey, target);
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
    const attachmentContract = require('../pi-session/attachment-contract');
    for (const message of snapshot.messages) {
      const inputs = (message.role === 'user' ? message.attachments || [] : []).map(item => {
        const key = typeof item.previewRef === 'string' && crypto.createHash('sha256').update(item.previewRef).digest('hex');
        if (key && attachmentPaths.has(key)) return attachmentPaths.get(key);
        if (item.path && attachmentContract.previewPath(item.previewRef) === item.path) return mapped.get(item.path);
      });
      cleanReference(message);
      inputs.forEach((target, index) => {
        if (target) Object.assign(message.attachments[index], { path: target, availability: 'available',
          previewRef: attachmentContract.previewRef(target) });
      });
    }
    await current();
    const [row] = await register([{ ...metadata(bundle.conversation), cwd, cached: false, cloud: false, deliveryWorkspaceKey: null,
      deviceHistory: true, deviceTransferId: transferId, deviceTransferDigest: sha256,
      workOwner, creator: { account: accountId(identity), hub: identity.hub }, historyAliasIds: [] }],
      { expectedRevision: old?.revision, expectedAbsent: !old, expectedHistoryDigest });
    await current();
    if (!row || row.deleted || row.deviceTransferId !== transferId || row.deviceTransferDigest !== sha256)
      throw Error('目标会话在接收期间已变化，请重新核对');
    const check = guard(row); check();
    const data = { snapshot, coverage: bundle.coverage,
      imported: { transferId, sha256 }, historyRecovery: { mode: 'device-history', nativeArchiveMissing: true } };
    if (received.length) {
      // Reclassify verified bytes in the receiving workspace. The sender's file
      // paths, preview capabilities, archive stamps and package actions are never imported.
      const captured = await require('./device-history-artifacts.cjs').capture({
        row, verifiedTransfer: true, journal: { cwd: await fs.realpath(cwd), turnId: transferId, files: received } });
      await current();
      if (captured) data.localArtifactHistory = {
        ...await archive.preserve(app.getPath('userData'), row.id, captured, null, check), transferId };
    }
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
      ...(data.localArtifactHistory && !data.historyProtection && (locallyReceivedArtifacts(row, data) || !data.imported && allowsArtifacts(verified))
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
  return { captureTurn, refresh, saved, schedule, transferSources, exportPortable, importPortable, prepareContinuation,
    attachments: message => attachments({ messages: [message] }),
    async close() { await background; await Promise.allSettled([...pending.values(), ...writers.values()]); } };
}
module.exports = { create, SCHEMA, locallyReceivedArtifacts };
