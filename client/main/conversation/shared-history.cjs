'use strict';

const path = require('node:path');
const access = require('./history-access');
const { accountId } = require('../device-auth-request');
const { conversationTranscriptEntries } = require('./conversation-transcript.cjs');
const executionOutcome = require('./execution-outcome.cjs');
const { mergeNativeEvidence } = require('./history-evidence.cjs');
const { capturedCopyId, automaticAccountCache } = require('./history-cache-policy.cjs');

function cloudCacheSourceId(row, identity) {
  const source = row.source;
  if (!row.cached || row.importDigest || row.importedHistory || !source?.id ||
      (row.locationMode !== 'remote' && row.location !== 'cloud') ||
      !source.account || source.account !== accountId(identity)) return '';
  try { if (new URL(source.hub).origin !== new URL(identity.hub).origin) return ''; }
  catch (_) { return ''; }
  // Capture has always used this exact key. Recognize existing automatic caches
  // without migrating data or treating independent imports as identity aliases.
  return row.id === capturedCopyId(source.hub, source.account, source.id) ? source.id : '';
}

function create({ app, session, workRoot, identityOf = () => require('./requirement-context').cachedIdentity(app), store = require('./replica-store.cjs').createWorker(
  path.join(app.getPath('userData'), 'conversation-replicas', 'history.sqlite')) }) {
  const observed = new Map();
  let closed = false, closing;
  const scoped = require('./history-scope.cjs').create({ app, store, identityOf });
  const ordinaryDeviceChat = row => !row.cached && !row.historyProtection && access.usesDeviceChatContext(app, { chatId: row.id }, row);
  const deviceHistory = require('./device-history.cjs').create({ app, session, store, resolve, identityOf, register, workRoot,
    allowsArtifacts: ordinaryDeviceChat, usesDeviceDialogue: ordinaryDeviceChat,
    authorize: row => access.assertOwner(app, row.id, scoped.actor(), row),
    authorizeContinuation: row => {
      const captured = scoped.actor();
      if (access.classifyLocal(app, row.id, row).kind === 'ordinary')
        access.assertDeviceReadable(app, row.id, captured, row);
      else access.assertOwner(app, row.id, captured, row);
    },
    requiresNativeEvidence: row => access.assertDeviceReadable(app, row.id, scoped.actor(), row)?.sharedOnDevice === true,
    guard(row) {
      const captured = scoped.actor();
      let evidence = row;
      return nativeRow => {
        try {
          const current = currentActor(captured);
          access.assertLocalCurrent(app, captured, row, identityOf());
          evidence = mergeNativeEvidence(evidence, nativeRow);
          access.assertDeviceReadable(app, row.id, current, evidence);
        } catch (error) { error.historyAccessFailure = true; throw error; }
      };
    } });
  const localReader = require('../app-readonly-history.cjs').create({ app,
    session: new Proxy(session, { get: (target, key) => key === 'archivedConversation'
      ? (_app, id) => store.get(id) : target[key] }), localOnly: true,
    access: { actor: () => scoped.actor(), assertCurrent: (_app, actor) => scoped.guard(actor), assertOwner: access.assertDeviceReadable } });
  const accountReader = require('../app-readonly-history.cjs').create({ app,
    session: new Proxy(session, { get: (target, key) => key === 'archivedConversation'
      ? (_app, id) => store.get(id) : target[key] }), localOnly: true,
    access: { actor: () => scoped.actor(), assertCurrent: (_app, actor) => scoped.guard(actor), assertOwner: access.assertReadable } });
  function currentActor(captured) {
    scoped.guard(captured);
    const current = scoped.actor();
    if (captured.readScope) access.assertCurrent(app, captured, current.identity);
    return current;
  }
  const isNative = row => row && !row.accountProjection && !row.remoteProjection && !row.cloud;
  async function register(rows, options) {
    const result = [];
    for (let i = 0; i < rows.length; i += 200) result.push(...await store.register(rows.slice(i, i + 200), options));
    return result;
  }
  async function projectRows(rows, archived = false, records) {
    const native = [], discovered = rows.filter(isNative);
    for (let offset = 0; offset < discovered.length; offset += 200) {
      const batch = discovered.slice(offset, offset + 200);
      // Discovery must not fill the worker's entire request queue before a
      // foreground delete can be admitted. Transfer predecessors are native
      // identities, so this indexed lookup never follows remote origin aliases.
      const existing = await store.nativeRows(batch.map(row => row.id), { includeDeleted: true });
      const previousRows = new Map();
      for (const row of existing) for (const id of [row.id, ...row.historyAliasIds]) previousRows.set(id,row);
      for (const row of batch) {
        const previous = previousRows.get(row.id);
        if (previous?.deviceTransferId &&
            require('./runtime-segments').read(app, previous.id)?.deviceTransferId !== previous.deviceTransferId) {
          native.push(previous); continue;
        }
        const record = records ? records.get(row.id) : require('./runtime-segments').read(app, row.id);
        native.push({ ...require('./acceptance-session').projectHistory(app, row),
          accountConversation: false, accountProjection: false,
          archived: row.archived === true || session.isArchived?.(app, row.id) === true ||
          (archived && (!row.adapterId || row.adapterId === 'pi')), historyAliasIds: [...new Set([
          ...(row.historyAliasIds || []), ...[...(record?.segments || []), record?.active].filter(Boolean).map(part => part.sessionId),
        ])].filter(id => id !== row.id) });
      }
      if (offset + batch.length < discovered.length) await new Promise(resolve => setImmediate(resolve));
    }
    for (const row of native) if (row.historyAliasIds.length) await store.join(row.id, row.historyAliasIds);
    let registered = await register(native);
    const actor = scoped.actor();
    const repaired = [];
    for (let offset = 0; offset < registered.length; offset += 32) {
      repaired.push(...await Promise.all(registered.slice(offset,offset + 32).map(async row => {
        const recovered = executionOutcome.recover(row);
        if (!recovered || row.state === recovered.state && row.status === recovered.status && row.live === false) return row;
        try { access.assertLocalMutation(app, row.id, actor, row); } catch (_) { return row; }
        scoped.guard(actor);
        const [saved] = await register([recovered], { expectedRevision: row.revision });
        scoped.guard(actor); return saved;
      })));
    }
    registered = repaired;
    registered = registered.filter(Boolean);
    deviceHistory.schedule(registered.filter(row => scoped.readable(row, actor)));
    const byId = new Map();
    for (const row of registered) for (const id of [row.id, ...row.historyAliasIds]) byId.set(id, row);
    return rows.map(row => byId.get(row.id) || row).filter(row => !row.deleted && (row.archived === true) === archived && scoped.readable(row, actor));
  }
  async function resolveRaw(id) {
    let row = await store.get(id);
    if (row && !automaticAccountCache(row)) return row;
    if (row && isLocalIdentity(row, id)) return null;
    // Retired remote locators cannot shadow an actual native archive while
    // its local index is still being rebuilt after a restart.
    if (/^(?:acct-|cloud-execution:|task-execution:)/.test(id)) return null;
    const pi = await session.historyEntry?.(app, id, { strict: true });
    if (pi?.ok && pi.entry?.path) {
      if (pi.entry.id !== id) throw Error('本地会话记录不匹配，请刷新后重试');
      return (await register([{ ...pi.entry, id, adapterId: 'pi', cloud: false }]))[0];
    }
    const native = await session.archivedConversation(app, id, { nativeOnly: true, strict: true });
    if (!isNative(native)) return null;
    return (await register([native]))[0];
  }
  async function resolve(id, captured = scoped.actor()) {
    const row = await resolveRaw(id);
    const current = currentActor(captured);
    return row && scoped.readable(row, current) ? row : null;
  }
  async function lifecycle(id, action, identity, options) {
    const captured = scoped.actor();
    if (identity && access.readScope(identity) !== captured.readScope) throw Error('账号或服务已切换，请重新读取会话');
    const row = await resolve(id, captured);
    if (!row) return null;
    if (!isLocalIdentity(row, id)) return null;
    access.assertLocalCurrent(app, captured, row, identityOf());
    access.assertLocalMutation(app, row.id, captured, row);
    for (const alias of [row.id, ...row.historyAliasIds]) {
      if (session.findBySessionId(alias)?.inFlight?.()) throw Error('这条会话还在执行，完成或停止后再操作');
    }
    scoped.guard(captured);
    const result = await store.lifecycle(row.id, action, { account: accountId(captured.identity),
      hub: captured.identity?.hub, device: captured.identity?.clientId }, options);
    scoped.guard(captured); return result;
  }
  async function deleteCloudCaches(sourceIds) {
    const captured = scoped.actor(), ids = [...new Set(sourceIds)], removed = [];
    for (let offset = 0; offset < ids.length; offset += 200) {
      const batch = ids.slice(offset, offset + 200);
      const copies = await store.sourceCopies(batch);
      currentActor(captured);
      for (const copy of copies) {
        // Reuse the display proof: an import or explicitly saved copy is not
        // the automatic cache, even when it points at the same cloud source.
        if (!batch.includes(cloudCacheSourceId(copy, captured.identity))) continue;
        currentActor(captured);
        const result = await lifecycle(copy.id, 'delete', captured.identity, { preserveCopies: true });
        currentActor(captured);
        if (!result?.ok) throw Error('清理云端会话的自动缓存失败，请重试');
        removed.push(copy.id);
      }
    }
    return removed;
  }
  async function accountDisplayLinks(items, identity) {
    if (!identity?.clientId || !identity?.session || !accountId(identity)) return [];
    const account = accountId(identity);
    let hub;
    try { hub = new URL(identity.hub).origin; } catch (_) { return []; }
    const sources = new Map();
    for (const item of items || []) {
      if (!item?.id || item.deleted || item.sourceClientId !== identity.clientId || !item.sourceSessionId) continue;
      const id = String(item.sourceSessionId);
      if (!sources.has(id)) sources.set(id, []);
      sources.get(id).push(String(item.id));
    }
    const ids = [...sources.keys()], links = [], captured = access.actor(app, identity);
    for (let offset = 0; offset < ids.length; offset += 200) {
      // Keep display identity after a local deletion so its account directory
      // row cannot reappear as an unrelated conversation. This does not join
      // lifecycle aliases or mutate the account original.
      const rows = await store.nativeRows(ids.slice(offset, offset + 200), { includeDeleted: true });
      for (const row of rows) {
        if (!isNative(row) || row.cached) continue;
        // A display join uses the same original Hub/account provenance as the
        // archive read boundary, plus existing execution-owner conflict checks.
        if (row.creator?.account !== account) continue;
        try { if (new URL(row.creator.hub).origin !== hub) continue; }
        catch (_) { continue; }
        try { access.assertOwner(app, row.id, captured, row); }
        catch (_) { continue; }
        for (const alias of [row.id, ...(row.historyAliasIds || [])])
          for (const accountId of sources.get(alias) || []) links.push([accountId, row.id]);
      }
      // This is metadata-only reconciliation, never a native SDK/archive scan.
      // Yield between batches even when a large directory matches local history.
      if (offset + 200 < ids.length) await new Promise(resolve => setImmediate(resolve));
    }
    return links;
  }
  async function remoteLifecycle(rows, identity = require('./requirement-context').cachedIdentity(app)) {
    const remote = rows.filter(row => row.cloud || row.remoteProjection || row.accountProjection);
    if (!remote.length) return [];
    const owner = accountId(identity);
    if (!owner || !identity?.hub) return [];
    let hub;
    try { hub = new URL(identity.hub).origin; } catch (_) { return []; }
    const bySource = new Map(), byTask = new Map(), states = new Map();
    const add = (index, id, row) => {
      if (!id) return;
      if (!index.has(id)) index.set(id, new Set());
      index.get(id).add(row);
    };
    for (const row of remote) {
      for (const id of [row.id, ...(row.historyAliasIds || [])]) add(bySource, id, row);
      add(byTask, row.taskId, row);
    }
    const sourceIds = [...bySource.keys()], taskIds = [...byTask.keys()];
    for (let offset = 0; offset < Math.max(sourceIds.length, taskIds.length); offset += 200) {
      const copies = await store.remoteLifecycleRows({ account: owner,
        sourceIds: sourceIds.slice(offset, offset + 200), taskIds: taskIds.slice(offset, offset + 200) });
      for (const copy of copies) {
        try { if (new URL(copy.source.hub).origin !== hub) continue; }
        catch (_) { continue; }
        // Deleted copies are excluded by the store: deleting a local transcript
        // must not hide its cloud original. The latest explicit intent wins.
        const matched = new Set([...(bySource.get(copy.source.id) || []), ...(byTask.get(copy.taskId) || [])]);
        for (const row of matched) {
          const previous = states.get(row.id);
          if (!previous || copy.replicaRevision > previous.lifecycleRevision ||
              (copy.replicaRevision === previous.lifecycleRevision && copy.revision >= previous.revision)) {
            states.set(row.id, { id: row.id, archived: copy.archived, deleted: false,
              lifecycleRevision: copy.replicaRevision, revision: copy.revision });
          }
        }
      }
    }
    return [...states.values()];
  }
  async function read(id, options = {}, captured = scoped.actor(), openingBody) {
    const row = await resolve(id, captured);
    if (!row || row.deleted) throw Error('这条会话已经不存在了');
    access.assertLocalCurrent(app, captured, row, identityOf());
    access.assertDeviceReadable(app, row.id, currentActor(captured), row);
    let accountEvidence = row;
    const verify = options.accountOnly === true ? nativeRow => {
      accountEvidence = mergeNativeEvidence(accountEvidence, nativeRow);
      access.assertReadable(app, row.id, currentActor(captured), accountEvidence);
    } : undefined;
    verify?.();
    async function verifyCurrent() {
      if (!verify) return;
      const latest = await resolve(row.id, captured);
      if (!latest) throw Error('会话归属已变化，请重新打开');
      access.assertReadable(app, latest.id, currentActor(captured), latest);
    }
    const after = Number(options.after || 0);
    if (!Number.isSafeInteger(after) || after < 0) throw Error('Invalid local history cursor');
    if (row.cached) {
      const page = await store.messages(row.id, { after: after - 1, limit: options.limit || 100 });
      if (!await resolve(row.id, captured)) throw Error('会话归属已变化，请重新打开');
      access.assertLocalCurrent(app, captured, row, identityOf());
      await verifyCurrent();
      return { ...page, nextCursor: page.next == null ? null : page.next + 1, cursor: page.items.at(-1)?.position + 1 || after };
    }
    const saved = openingBody || await deviceHistory.saved(row.id, { refresh: after === 0, verify });
    scoped.guard(captured);
    verify?.();
    if (saved) {
      const limit = Math.min(200, Math.max(1, options.limit || 100));
      const messages = saved.snapshot.messages, end = Math.min(messages.length, after + limit);
      const items = await Promise.all(messages.slice(after, end).map(async (message, index) => ({ ...message,
        position: after + index, id: message.id || row.id + ':' + (after + index),
        ...(message.attachments?.length ? { attachments: await deviceHistory.attachments(message) } : {}),
        historyTools: saved.snapshot.tools.filter(tool => Number(tool.after || 0) === after + index) })));
      scoped.guard(captured);
      await verifyCurrent();
      return { items, format: 'messages', cursor: end, nextCursor: end < messages.length ? end : null,
        coverage: saved.coverage, nativeReadError: saved.nativeReadError };
    }
    // Encode the segment in the cursor so phones and passive desktop views
    // traverse runtime switches without mixing sequence namespaces.
    const span = 1000000000;
    const record = require('./runtime-segments').read(app, row.id);
    const parts = record ? [...new Set([...record.segments, record.active].filter(Boolean).map(part => part.sessionId))] : [row.id];
    const segment = Math.floor(after / span), offset = after % span;
    if (segment >= parts.length) throw Error('Invalid local history segment');
    const page = await (options.accountOnly === true ? accountReader : localReader)('conversations.read', { id: row.id, offset, after: offset,
      limit: options.limit || 100, segmentId: parts[segment] });
    if (!await resolve(row.id, captured)) throw Error('会话归属已变化，请重新打开');
    access.assertLocalCurrent(app, captured, row, identityOf());
    await verifyCurrent();
    const next = page.nextOffset ?? page.nextAfter;
    const cursor = segment * span + (page.cursor ?? offset + (page.items || []).length);
    return { ...page, cursor,
      items: (page.items || []).map(item => ({ ...item, id: parts[segment] + ':' + item.id,
        ...(page.format === 'events' ? { streamId: parts[segment] + ':' + item.streamId, revision: segment * span + Number(item.id) } : {}) })),
      nextCursor: next != null ? segment * span + next : segment + 1 < parts.length ? (segment + 1) * span : null };
  }
  async function previewChoice(row, actor, shared) {
    const record = require('./runtime-segments').read(app, row.id);
    if (record?.deviceShared ? record.executionOwner !== actor.owner : shared) return null;
    const { historyModel } = require('../local-model-store.cjs');
    const live = session.findBySessionId?.(row.id);
    if (live && !live.localReplica && live.usageIdentity?.accountScope === actor.owner) {
      const selection = live.snapshot().modelSelection;
      if (selection?.name) {
        return { adapterId: live.adapterId, name: selection.name, label: selection.model?.label || selection.name,
          ...(selection.model?.unavailable ? { unavailable: true } : historyModel(selection.name)) };
      }
    }
    const active = record?.active;
    const adapterId = active?.adapterId || row.adapterId || 'pi';
    const nativeId = active?.sessionId || row.id;
    const name = active?.modelName || (adapterId === 'pi'
      ? await require('../pi-session/session').archivedModelName(app, nativeId)
      : require('./model-selection').preference(app, nativeId).read());
    return { adapterId, name, label: name, ...historyModel(name) };
  }
  async function open(id, { historyPreview = false, allowContinuation = false, previewReason = '' } = {}) {
    const captured = scoped.actor(), row = await resolve(id, captured);
    if (!row || row.deleted) return null;
    let content = null, bodyMissing = false;
    if (!row.cached) {
      try { content = await deviceHistory.saved(row.id, { refresh: true, preferRecorded: true }); }
      catch (error) { if (error.code !== 'NATIVE_HISTORY_MISSING') throw error; bodyMissing = true; }
    }
    const nativeUnavailable = content?.nativeReadError && content.nativeReadError.code !== 'NATIVE_HISTORY_MISSING';
    const actor = currentActor(captured);
    const shared = access.assertDeviceReadable(app, row.id, actor, row)?.sharedOnDevice;
    let openingBody = content && !row.cached && !content.historyProtection && !shared ? content : null;
    const previewRow = { ...row,
      ...(content ? { deviceHistory: true, historyContentState: !content.coverage?.complete ? 'partial' :
        require('./device-history-native.cjs').unresolvedTools(content.snapshot).length || content.coverage?.unresolvedTools?.length
          ? 'unresolved-tools' : 'available' } : {}),
      ...(bodyMissing ? { historyContentState: 'missing' } : {}) };
    const canContinue = allowContinuation && previewRow.historyContentState === 'available' &&
      !row.cached && !content?.historyProtection && !nativeUnavailable &&
      access.usesDeviceChatContext(app, { chatId: row.id }, row);
    const choice = historyPreview && canContinue ? await previewChoice(row, actor, shared) : null;
    const view = await require('./local-history-view.cjs').create({ historyPreview, allowContinuation: canContinue, choice,
      previewReason: content?.nativeReadError?.code === 'TRANSCRIPT_CHECKSUM_MISMATCH' ? content.nativeReadError.reason :
        nativeUnavailable ? '可查看已有本机记录。原始档案暂时无法核验，请恢复后再继续' : previewReason,
      row: previewRow,
      read: bodyMissing ? async () => ({ items: [], nextCursor: null }) : (id, options) => read(id, options, captured, openingBody) });
    openingBody = null;
    scoped.guard(captured);
    for (const name of ['snapshot', 'uiSnapshot', 'historyRow']) {
      const original = view[name];
      view[name] = (...args) => { access.assertDeviceReadable(app, row.id, currentActor(captured), row); return original(...args); };
    }
    if (historyPreview && content?.localArtifactHistory && !content.imported && !content.historyProtection && ordinaryDeviceChat(row)) {
      let disposed = false;
      const close = view.close;
      view.close = async () => { disposed = true; return close(); };
      const guard = () => {
        if (disposed) throw Error('会话已关闭，请重新打开成果');
        access.assertDeviceReadable(app, row.id, currentActor(captured), row);
        if (!ordinaryDeviceChat(row)) throw Error('会话归属已变化，请重新打开成果');
      };
      const authorize = async () => {
        const latest = await resolve(row.id, captured);
        if (!latest || latest.deleted || latest.cwd !== row.cwd || !ordinaryDeviceChat(latest) ||
            await store.deviceHistoryVersion(row.id) !== content.digest)
          throw Error('会话归属或历史版本已变化，请重新打开成果');
        if (row.adapterId === 'pi') await require('./device-history-native.cjs').probe({ app, session, row: latest,
          guard: evidence => {
            guard();
            if (!ordinaryDeviceChat(mergeNativeEvidence(latest, evidence))) throw Error('会话归属已变化，请重新打开成果');
          } });
        guard();
        if (!ordinaryDeviceChat(latest))
          throw Error('会话归属已变化，请重新打开成果');
      };
      view.historyArtifacts = require('./device-history-artifacts.cjs').view(row.cwd, content.localArtifactHistory, guard, authorize);
    }
    const load = view.loadHistory;
    view.loadHistory = async (...args) => { scoped.guard(captured); await load(...args); scoped.guard(captured); };
    return view;
  }
  async function preserveLegacyOutbox(job, identity) {
    const id = 'recovered-' + require('node:crypto').createHash('sha256').update(
      JSON.stringify([job.hub, job.ownerKey, job.body.sourceSessionId, job.body.sourceEpoch])).digest('hex');
    const [row] = await register([{ id, cached: true, archived: true, title: job.body.title,
      source: { hub: job.hub, id: job.body.sourceSessionId, account: accountId(identity) } }]);
    if (row.deleted) return;
    const messages = [...(job.body.messages || [])].sort((a, b) => a.position - b.position);
    let batch = [], start = 0, bytes = 0;
    async function save() {
      if (!batch.length) return;
      const saved = await store.cache(id, batch, { start, expectedRevision: row.replicaRevision });
      if (!saved.ok) throw Error('Local recovery copy changed during migration');
      batch = []; bytes = 0;
    }
    for (const message of messages) {
      const size = Buffer.byteLength(JSON.stringify(message));
      if (batch.length && (message.position !== start + batch.length || batch.length >= 100 || bytes + size > 8 * 1024 * 1024)) await save();
      if (!batch.length) start = message.position;
      batch.push(message);
      bytes += size;
    }
    await save();
    if (job.body.deleted) await store.lifecycle(id, 'delete', { account: accountId(identity), hub: job.hub });
  }
  async function recordDialogue(row, snapshot, original, identity, retry = true) {
    if (!identity || row?.id !== original.id || row.deleted || row.cached || row.deviceTransferId) return;
    const evidence = mergeNativeEvidence(row, original.taskProjectionId ? { ...original, taskId: original.taskProjectionId } : original);
    const actor = access.actor(app, identity);
    // The registry may still deliver a closing handle after a profile switch.
    try {
      access.assertCurrent(app, actor, identityOf());
    } catch (_) { return; }
    if (evidence.historyProtection) {
      if (!row.historyProtection) await register([{ ...row, historyProtection: evidence.historyProtection }],
        { expectedRevision: row.revision });
      return;
    }
    if (!ordinaryDeviceChat(evidence) || snapshot.history?.truncated || Number(snapshot.history?.messageStart || 0) !== 0) return;
    try { access.assertDeviceReadable(app, row.id, actor, evidence); } catch (_) { return; }
    const messages = conversationTranscriptEntries(snapshot.messages);
    if (!messages.length) return;
    const result = await store.saveConversationTranscript(row.id, messages, {
      expectedRevision: row.replicaRevision, expectedCatalogRevision: row.revision, expectedTransferId: '',
    });
    // Native capture can advance the catalog while the worker is saving text.
    // Reauthorize the new row before retrying the same append once.
    if (result?.stale && retry)
      await recordDialogue(await store.get(row.id), snapshot, original, identity, false);
  }
  async function capture(handle, identity, { initialReplay = false, onRegistered } = {}) {
    if (closed || handle.localReplica || typeof handle.snapshot !== 'function') return;
    const snapshot = handle.snapshot(), original = handle.historyRow?.(snapshot);
    if (!original?.id) return;
    const previousImport = await store.get(original.id);
    if (previousImport?.deviceTransferId &&
        require('./runtime-segments').read(app, previousImport.id)?.deviceTransferId !== previousImport.deviceTransferId) return;
    if (original.accountProjection && !original.cloud) return;
    // A cache has its own identity so deleting it cannot delete or hide the
    // account-authorized cloud original in the cloud directory.
    const remote = original.cloud || original.accountProjection;
    const id = remote ? capturedCopyId(identity?.hub, accountId(identity), original.id) : original.id;
    let displayed = remote ? original : require('./acceptance-session').projectHistory(app, original);
    if (!remote) {
      let retainedFailure = false;
      if (initialReplay) {
        const previous = previousImport;
        // An older successful answer cannot disprove a later preflight failure.
        if (previous?.state === 'failed' && executionOutcome.recover(previous)?.state !== 'completed' && displayed.state === 'completed') {
          displayed = { ...displayed, state: previous.state, status: previous.status };
          retainedFailure = true;
        }
      }
      const outcome = original.runtimeUnavailable && !retainedFailure ? original.executionOutcome : {
        version: 1, source: 'runtime', state: displayed.state || '', status: displayed.status || snapshot.status || '',
      };
      displayed = { ...displayed, runtimeUnavailable: original.runtimeUnavailable === true,
        runtimeFailure: original.runtimeUnavailable ? original.runtimeFailure : null,
        executionOutcome: outcome ? { ...outcome, owner: accountId(identity), hub: identity?.hub } : null };
    }
    // Some runtime rows omit task fields once the binding is no longer active.
    // A later snapshot cannot downgrade an already protected conversation.
    const protection = remote ? 'account' : mergeNativeEvidence(previousImport?.id === id ? previousImport : { id }, displayed).historyProtection;
    const [row] = await register([{ ...displayed, id, cloud: false, accountProjection: false,
      accountConversation: false,
      ...(protection ? { historyProtection: protection } : {}),
      ...(original.taskProjectionId && !original.taskId ? { taskId: original.taskProjectionId } : {}),
      remoteProjection: false, cached: !!remote, source: remote ? { hub: identity?.hub, id: original.id, account: accountId(identity) } : null,
      creator: { account: accountId(identity), hub: identity?.hub }, historyAliasIds: remote ? [] : original.historyAliasIds || [] }]);
    onRegistered?.(row);
    if (row.deleted) return;
    if (!remote) {
      // Commit user-visible dialogue before any potentially slow native replay.
      if (!initialReplay && !onRegistered) {
        try { await recordDialogue(row, snapshot, displayed, identity); }
        catch (failure) { handle.localHistoryError = failure.message; }
      }
      try { await deviceHistory.refresh(row.id, { journal: handle.fileChanges || snapshot.fileChanges }); }
      catch (error) {
        // A failed native read keeps the previous complete copy. The runtime
        // snapshot is still useful as explicitly partial crash-recovery data.
        if (error.historyAccessFailure || error.code === 'HISTORY_CONCURRENT_UPDATE') {
          handle.localHistoryError = error.message; return;
        }
        if (!await store.deviceHistory(row.id)) await store.saveDeviceHistory(row.id, {
          snapshot: require('./device-history-native.cjs').publicSnapshot(snapshot),
          coverage: { complete: false }, nativeReadError: { code: error.code || 'NATIVE_HISTORY_UNAVAILABLE', reason: error.message },
        }, { expectedRevision: row.replicaRevision, expectedTransferId: row.deviceTransferId || '', expectedHistoryDigest: null });
        handle.localHistoryError = String(error.message || error);
      }
      return;
    }
    const messages = (snapshot.messages || []).filter(message => ['user', 'assistant'].includes(message.role));
    const offset = Number(snapshot.history?.messageStart || 0);
    const complete = !snapshot.history?.truncated && offset === 0;
    for (let start = 0; start < Math.max(1, messages.length);) {
      let end = start, bytes = 0;
      while (end < messages.length && end - start < 100) {
        const size = Buffer.byteLength(JSON.stringify(messages[end]));
        if (end > start && bytes + size > 8 * 1024 * 1024) break;
        bytes += size; end++;
      }
      const result = await store.cache(id, messages.slice(start, end), {
        start: offset + start, expectedRevision: row.replicaRevision, complete: complete && end >= messages.length });
      if (!result.ok) break;
      if (end === start) break;
      start = end;
    }
  }
  function observe(handle, identity) {
    if (!handle || observed.has(handle) || handle.localReplica) return;
    let pending, timer, disposed = false, error = '', dirty = false, executionObserved = false;
    let dialogueId, writing, dialogueDirty = false;
    const checkpoint = () => {
      if (!dialogueId || !executionObserved) return;
      dialogueDirty = true;
      if (writing) return;
      writing = (async () => {
        while (dialogueDirty) {
          dialogueDirty = false;
          const snapshot = handle.snapshot(), original = handle.historyRow?.(snapshot);
          if (original?.id !== dialogueId || original.cloud || original.accountProjection || original.remoteProjection) continue;
          const row = await store.get(original.id);
          if (row) await recordDialogue(row, snapshot, original, identity);
        }
      })().catch(failure => { handle.localHistoryError = failure.message; }).finally(() => { writing = null; });
    };
    const onRegistered = row => {
      dialogueId = !row.deleted && !row.cached && !row.historyProtection && !row.deviceTransferId ? row.id : null;
      // An accepted turn may arrive before the first index commit or while
      // native replay is waiting. Persist the latest display independently.
      checkpoint();
    };
    const flush = () => {
      if (timer) clearTimeout(timer); timer = null;
      dirty = true;
      if (pending) return pending;
      pending = (async () => {
        while (dirty) {
          dirty = false;
          try { await capture(handle, identity, { initialReplay: !executionObserved, onRegistered }); error = ''; }
          catch (failure) { error = failure.message; handle.localHistoryError = error; }
        }
      })().finally(() => { pending = null; });
      return pending;
    };
    const dispose = handle.on?.(event => {
      if (disposed) return;
      if (['user', 'message', 'run', 'started', 'settled', 'turn-queued', 'turn-dequeued', 'turn-finished'].includes(event?.kind)) {
        executionObserved = true;
        checkpoint();
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (pending) checkpoint();
        void flush();
      }, 1000); timer.unref?.();
    });
    const entry = { flush: async () => { await flush(); await writing; }, error: () => error, dispose: () => { disposed = true; clearTimeout(timer); dispose?.(); } };
    observed.set(handle, entry);
    // Registry facades intercept close; decorating that facade would make the
    // native close await its own registry disposal and deadlock shutdown.
    const native = handle[Symbol.for('soduwork.agent-runtime.native-handle')] || handle;
    const originalClose = native.close;
    if (typeof originalClose === 'function') native.close = async function (...args) {
      const result = await originalClose.apply(this, args);
      if (result !== false) { entry.dispose(); await entry.flush(); observed.delete(handle); }
      return result;
    };
    void flush();
  }
  let refreshing, refreshedAt = 0;
  async function directory(after = 0, limit = 100) {
    const captured = scoped.actor();
    // Coalesce simultaneous phone/sidebar scans. Native providers own their
    // indexes; directory responses contain metadata only and use keyset cursors.
    if (!refreshing && Date.now() - refreshedAt > 5000) refreshing = Promise.all([session.history(app, Number.MAX_SAFE_INTEGER),
      session.archivedHistory(app, Number.MAX_SAFE_INTEGER)]).then(result => {
        if (result.some(row => row.ok === false)) throw Error('Local history inventory is temporarily unavailable');
        refreshedAt = Date.now();
      }).finally(() => { refreshing = null; });
    await refreshing;
    scoped.guard(captured);
    return scoped.directory(after, limit, captured);
  }
  return { resolve, read, open, register, projectRows, lifecycle, deleteCloudCaches, remoteLifecycle, accountDisplayLinks, capture, observe, store, directory, preserveLegacyOutbox,
    exportPortable: deviceHistory.exportPortable, importPortable: deviceHistory.importPortable,
    prepareContinuation: deviceHistory.prepareContinuation, backfill: deviceHistory.refresh,
    captureScope: () => scoped.actor(), guardScope: captured => scoped.guard(captured),
    async indexedRow(id) {
      const captured = scoped.actor(), row = await store.get(id);
      scoped.guard(captured); return row && scoped.readable(row, captured) ? row : null;
    },
    list: options => scoped.list(options),
    async page(options) {
      const captured = scoped.actor(), result = await scoped.page(options, captured);
      scoped.guard(captured);
      return { ...result, chats: result.chats.map(row => {
        const { displayCloudSourceId: ignored, ...entry } = row;
        const source = cloudCacheSourceId(row, captured.identity);
        return source ? { ...entry, displayCloudSourceId: source } : entry;
      }) };
    },
    lifecycleRows: () => scoped.lifecycleRows(),
    async indexedRows(archived, limit) {
      const captured = scoped.actor();
      const items = []; let after;
      do {
        const page = await scoped.list({ archived, after, limit: Math.min(200, Math.max(1, limit - items.length)) }, captured);
        items.push(...page.items); after = page.next;
      } while (after && items.length < limit);
      // The desktop IPC rechecks merged rows. Keep native owner evidence
      // inside the main process until that last check projects the public row.
      return access.authorizedRows(app, items, identityOf(), true);
    },
    close() { return closing ||= (async () => {
      for (const entry of observed.values()) entry.dispose();
      await Promise.all([...observed.values()].map(entry => entry.flush()));
      closed = true; observed.clear(); await deviceHistory.close(); await store.close();
    })(); } };
}
// Source locators permit passive transcript recovery, not lifecycle ownership
// or interception of an authenticated account original.
function isLocalIdentity(row, id) {
  return !!row && (row.id === id || Array.isArray(row.historyAliasIds) && row.historyAliasIds.includes(id));
}
module.exports = { create, isLocalIdentity };
