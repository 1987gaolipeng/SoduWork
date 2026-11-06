'use strict';

const path = require('path');
const { CAPABILITIES, RuntimeContractError } = require('./contract');
const { AgentRuntimeRegistry } = require('./registry');
const defaultRuntimeCatalog = require('./runtime-catalog');
const {
  createPiRuntimeAdapter,
  getPiSessionDetails,
} = require('./pi-adapter');
const {
  createRunnerRuntimeAdapter,
  getRunnerSessionDetails,
} = require('./runner-adapter');
const {
  FileGoalCheckpointStore,
  MemoryGoalCheckpointStore,
} = require('./goal-checkpoint-store');
const { GoalSupervisor } = require('./goal-supervisor');

const runtimeSegments = require('../conversation/runtime-segments');
const switchable = require('./switchable-conversation');

const RUNTIME_RECORD = Symbol.for('soduwork.agent-runtime.record');
const LEGACY_GOAL_CONTROLS = Object.freeze({
  continueGoal: 'continue',
  pauseGoal: 'pause',
  disableGoal: 'disable',
});

function _reason(error) {
  return String((error && error.message) || error || 'Pi session failed to open');
}

function _isRecoverable(checkpoint) {
  const row = checkpoint && typeof checkpoint === 'object' ? checkpoint : {};
  const goal = row.goal && typeof row.goal === 'object' ? row.goal : {};
  const action = row.action && typeof row.action === 'object' ? row.action : {};
  if (['completed', 'cancelled', 'disabled'].includes(String(goal.state || ''))) return false;
  if (action.name === 'disable' && action.state === 'accepted') return false;
  return Boolean(goal.configured && row.adapterId && row.sessionId);
}

function createPiSessionBridge(options) {
  const opts = options || {};
  const workOpenings = new Set();
  const runtimeCatalog = opts.catalog || defaultRuntimeCatalog;
  const sessionModule = opts.sessionModule;
  if (!sessionModule || typeof sessionModule.open !== 'function') {
    throw new TypeError('Pi session bridge needs the legacy session module');
  }

  const registry = opts.registry || new AgentRuntimeRegistry();
  const piAdapter = opts.adapter || createPiRuntimeAdapter({
    sessionModule,
    version: opts.version || '1',
    app: opts.app,
  });
  const runnerAdapters = Array.isArray(opts.runnerAdapters) ? opts.runnerAdapters.slice()
    : opts.runnerAdapter ? [opts.runnerAdapter]
      : runtimeCatalog.runnerRuntimes().map((runtimeSpec) =>
        createRunnerRuntimeAdapter({ app: opts.app, runtimeSpec }));
  registry.register(piAdapter);
  runnerAdapters.forEach((adapter) => registry.register(adapter));

  const byRef = new Map();
  const bySessionId = new Map();
  const pendingDisposals = new Set();
  const fileStores = new Map();
  const memoryStore = new MemoryGoalCheckpointStore();

  function checkpointStore(app) {
    if (opts.checkpointStore) {
      return { store: opts.checkpointStore, durable: opts.checkpointDurable === true };
    }
    let root = String(opts.checkpointRoot || '');
    if (!root && app && typeof app.getPath === 'function') {
      root = path.join(app.getPath('userData'), 'agent-runtime', 'goal-checkpoints');
    }
    if (root) {
      const resolved = path.resolve(root);
      if (!fileStores.has(resolved)) {
        fileStores.set(resolved, new FileGoalCheckpointStore(resolved));
      }
      return { store: fileStores.get(resolved), durable: true };
    }
    if (!process.versions.electron || opts.allowMemoryCheckpoints === true) {
      return { store: memoryStore, durable: false };
    }
    throw new RuntimeContractError('GOAL_CHECKPOINT_UNAVAILABLE',
      'Goal sessions require a durable checkpoint directory');
  }

  function needsGoalSupervisor(record) {
    const canControl = (record.descriptor.capabilities || [])
      .some((item) => item.id === CAPABILITIES.GOAL_CONTROL);
    if (!canControl) return false;
    if (record.consumer === 'goal') return true;
    try {
      const snapshot = record.session.snapshot();
      return Boolean(snapshot && snapshot.execution && snapshot.execution.configured);
    } catch (error) {
      return false;
    }
  }

  function createSupervisor(record, app, runtimeId) {
    if (!needsGoalSupervisor(record)) return null;
    const selected = checkpointStore(app);
    const supervisor = new GoalSupervisor({
      session: record.session,
      adapterId: record.adapterId,
      sessionId: record.session.id,
      runtimeId,
      store: selected.store,
    });
    if (selected.durable && supervisor.persistenceError) {
      supervisor.dispose();
      throw new RuntimeContractError('GOAL_CHECKPOINT_WRITE_FAILED',
        'Goal checkpoint could not be written', { reason: supervisor.persistenceError });
    }
    return supervisor;
  }

  function forget(entry) {
    if (!entry) return;
    if (byRef.get(entry.ref) === entry) byRef.delete(entry.ref);
    if (bySessionId.get(entry.sessionId) === entry) bySessionId.delete(entry.sessionId);
    for (const [key, value] of byRef) if (value === entry) byRef.delete(key);
  }

  function closeEntry(entry) {
    if (!entry) return Promise.resolve(false);
    if (entry.closeCompletion) return entry.closeCompletion;
    if (entry.closed) return Promise.resolve(false);
    entry.closed = true;
    forget(entry);
    const cleanup = entry.switchable ? Promise.resolve().then(() => entry.raw.close()).catch(() => {}) : Promise.resolve();
    try { if (entry.supervisor) entry.supervisor.dispose(); }
    catch (error) { /* Runtime disposal must still close the native session. */ }
    const completion = cleanup.then(() => entry.record ? registry.disposeSession(entry.record.adapterId, entry.record.session.id) : entry.raw.close()).then(() => true).catch(async () => {
      /* Registry disposal is authoritative. The raw close is only a last-resort
         process leak guard and deliberately does not restore the facade maps. */
      try {
        if (typeof entry.raw.close === 'function') await entry.raw.close();
      } catch (error) { /* ignore */ }
      return false;
    });
    entry.closeCompletion = completion;
    pendingDisposals.add(completion);
    completion.finally(() => pendingDisposals.delete(completion));
    return completion;
  }

  function facade(entry) {
    const bound = new Map();
    return new Proxy(entry.raw, {
      get(target, property, receiver) {
        if (property === RUNTIME_RECORD) return entry.record;
        // Main-process transport decorators need the native lifecycle, not the
        // registry close facade. This symbol never crosses the preload bridge.
        if (property === Symbol.for('soduwork.agent-runtime.native-handle')) return entry.raw;
        if (property === 'close') return () => closeEntry(entry);
        if (entry.supervisor && LEGACY_GOAL_CONTROLS[property]) {
          return () => entry.supervisor.control(LEGACY_GOAL_CONTROLS[property]);
        }
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        if (bound.get(property)?.source !== value) bound.set(property, { source: value, call: value.bind(target) });
        return bound.get(property).call;
      },
      set(target, property, value) {
        return Reflect.set(target, property, value, target);
      },
    });
  }

  function runtimeFacade(entry) {
    const bound = new Map();
    return new Proxy(entry.record.session, {
      get(target, property, receiver) {
        if (property === 'send' && entry.raw.snapshot?.().cloudHandoff) return () => ({ accepted: false, ok: false, reason: '会话已转到云端执行' });
        if (property === 'controlGoal' && entry.supervisor) {
          return (action) => entry.supervisor.control(action);
        }
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        if (!bound.has(property)) bound.set(property, value.bind(target));
        return bound.get(property);
      },
    });
  }

  function canRecoverExpiredRunnerResume(error, options, restored) {
    if (!restored || String(restored.active?.adapterId || 'pi') === 'pi' || !options?.resumePath) return false;
    const text = String(error && (error.message || error.reason || error) || '').toLowerCase();
    // Runner session ids are provider-side credentials. A 401/expired-session
    // response must create a fresh native session while the public conversation
    // keeps its persisted prefix and audit history.
    return /acpbridge|unauthori[sz]ed|凭证|credential|expired|session.*(invalid|expired|not found)|\b401\b/.test(text);
  }

  async function openNative(legacyOptions) {
    const adapterId = String(legacyOptions.adapterId || 'pi');
    const request = { adapterId, consumer: legacyOptions.intent === 'goal' ? 'goal' : 'chat',
      runtimeId: String(legacyOptions.runtimeId || 'desktop'), runtime: { app: legacyOptions.app || opts.app },
      identity: legacyOptions.identity, native: { pi: { openOptions: legacyOptions }, runner: { openOptions: legacyOptions } } };
    const record = legacyOptions.resumePath ? await registry.resumeSession(request) : await registry.createSession(request);
    const details = record.adapterId === 'pi' ? getPiSessionDetails(record.session) : getRunnerSessionDetails(record.session);
    if (!details?.handle) { await registry.disposeSession(record.adapterId, record.session.id); throw Error('Agent Runtime did not expose its compatibility handle'); }
    return { record, raw: details.handle, details };
  }

  async function open(openOptions) {
    let record = null, workId = '', workCommitted = false;
    let legacyOptions = { ...openOptions, app: openOptions?.app || opts.app }, restored;
    try {
      await Promise.allSettled([...pendingDisposals]);
      // A process exit leaves a readable projection, not a reusable runtime.
      // Explicit reopen disposes those registry entries before resuming the
      // same native archive; no command is replayed by the transport itself.
      for (const entry of new Set(byRef.values())) {
        if (entry.raw.snapshot?.().runtimeUnavailable) await closeEntry(entry);
      }
      ({ options: legacyOptions, row: restored } = switchable.resumeOptions(legacyOptions));
      if (legacyOptions.workConversation || legacyOptions.workConversationId) {
        workId = legacyOptions.workConversation?.id || legacyOptions.workConversationId;
        if (restored || workOpenings.has(workId) || bySessionId.has(workId)) { workId = ''; throw Error('此工作表单会话正在接入执行底座，请稍候'); }
        if (typeof legacyOptions.validateWorkConversation !== 'function') { workId = ''; throw Error('工作表单会话来源无效'); }
        workOpenings.add(workId);
      }
      await legacyOptions.validateWorkConversation?.();
      const adapterId = String(legacyOptions.adapterId || 'pi');
      if ((legacyOptions.intent === 'goal' || legacyOptions.mode === 'goal') &&
          runtimeCatalog.runtime(adapterId)?.goalMode !== 'native') {
        throw new RuntimeContractError('GOAL_MODE_UNSUPPORTED',
          '当前 Agent 暂不支持目标模式，请选择其他 Agent 或取消目标后发送');
      }
      let opened;
      try {
        opened = await openNative(legacyOptions);
      } catch (error) {
        if (!canRecoverExpiredRunnerResume(error, legacyOptions, restored)) throw error;
        // The transcript is already in runtime-segments.prefix. Do not replay
        // the dead provider session; start a clean native segment and let the
        // normal persistence callback replace the active descriptor.
        legacyOptions = { ...legacyOptions, resumePath: '', resumeCwd: '', runtimeConversationId: '' };
        opened = await openNative(legacyOptions);
      }
      record = opened.record; const details = opened.details;
      let raw = details.handle;
      await legacyOptions.validateWorkConversation?.();
      if (legacyOptions.workConversation) {
        restored = require('../conversation/work-conversation-opening').bootstrapRecord(legacyOptions.workConversation, raw, legacyOptions);
        await runtimeSegments.save(legacyOptions.app, restored); workCommitted = true;
        await legacyOptions.validateWorkConversation();
      }
      // Runner archives may have been opened with a retired model and then
      // recovered to the current default. Keep the public manifest aligned
      // with the live native segment so the next reopen does not keep offering
      // the dead model name.
      if (restored && raw.adapterId !== 'pi' && typeof raw.snapshot === 'function') {
        const selected = raw.snapshot()?.modelSelection?.name;
        if (typeof selected === 'string' && restored.active?.modelName !== selected) {
          restored = { ...restored, active: { ...restored.active, modelName: selected } };
          void runtimeSegments.save(legacyOptions.app, restored).catch(() => {});
        }
      }
      const ref = String(raw.ref || '');
      const sessionId = String(restored?.id || raw.sessionId || record.session.id || '');
      if (!ref || byRef.has(ref) || bySessionId.has(sessionId)) {
        throw Error('Pi Runtime returned a duplicate or invalid session identity');
      }
      const supervisor = createSupervisor(record, legacyOptions.app || opts.app,
        String(legacyOptions.runtimeId || 'desktop'));
      const entry = {
        ref, sessionId, raw, record, supervisor, closed: false, view: null, runtimeView: null, switchable: true,
      };
      entry.raw = raw = switchable.create({ raw, options: legacyOptions, restored, openNative,
        disposeNative: part => registry.disposeSession(part.adapterId, part.sessionId), probe, catalog: runtimeCatalog,
        changed(next) {
          entry.supervisor?.dispose(); entry.supervisor = null; entry.record = next.record;
          entry.runtimeView = runtimeFacade(entry); byRef.set(next.raw.ref, entry);
        } });
      entry.view = facade(entry);
      entry.runtimeView = runtimeFacade(entry);
      byRef.set(ref, entry);
      bySessionId.set(sessionId, entry);
      return {
        ...(details.result || {}),
        ok: true,
        session: entry.view,
      };
    } catch (error) {
      if (record) {
        try { await registry.disposeSession(record.adapterId, record.session.id); } catch (cleanupError) { /* ignore */ }
      }
      if (workCommitted) await runtimeSegments.remove(legacyOptions.app, workId);
      return { ok: false, reason: _reason(error), runtimeError: error && error.code || '',
        ...(error?.code === 'TASK_BINDING_MISMATCH' ? { code: error.code } : {}) };
    } finally { if (workId) workOpenings.delete(workId); }
  }

  function get(ref) {
    const entry = byRef.get(String(ref || ''));
    return entry ? entry.view : null;
  }

  // Passive remote views share lookup, UI events and disposal with ordinary
  // sessions. They deliberately have no registered local execution runtime.
  function attachView(raw) {
    if (!raw?.ref || !raw.sessionId || byRef.has(raw.ref) || bySessionId.has(raw.sessionId)) {
      throw new RuntimeContractError('SESSION_IDENTITY_CONFLICT', '会话已经打开，请接回原会话');
    }
    const entry = { ref: raw.ref, sessionId: raw.sessionId, raw, record: null,
      supervisor: null, closed: false, runtimeView: null };
    entry.view = facade(entry); byRef.set(entry.ref, entry); bySessionId.set(entry.sessionId, entry);
    return entry.view;
  }

  function list() {
    return [...new Set(byRef.values())].map((entry) => entry.view);
  }

  function findBySessionId(sessionId) {
    const entry = bySessionId.get(String(sessionId || ''));
    if (entry?.raw.snapshot?.().runtimeUnavailable) { void closeEntry(entry); return null; }
    return entry ? entry.view : null;
  }

  /* Runner adapters share an inventory request. Query concurrently so an
     unavailable runner cannot incur one timeout per adapter. */
  let externalHistory = null;
  async function externalRows(options) {
    try { return externalHistory ? await externalHistory.history(options) : { ok: false, chats: [] }; }
    catch (error) { return { ok: false, chats: [], reason: _reason(error) }; }
  }
  function normalizeHistoryRow(row) {
    const value = row && typeof row === 'object' ? row : {};
    let remote = value.cloud === true || String(value.locationMode || '').toLowerCase() === 'remote' ||
      String(value.location || '').toLowerCase() === 'cloud';
    if (!remote && externalHistory && typeof externalHistory.isRemote === 'function') {
      try { remote = Boolean(externalHistory.isRemote(value.id)); } catch (_) { /* a stale receipt is still a local row */ }
    }
    if (!remote) return { ...value, locationMode: value.locationMode || 'local', location: value.location || 'local', cloud: false };
    // A remote receipt may contain the renderer's local replay cache path.
    // Keep that path private to the passive view; history consumers must not
    // use it as a local project/workspace directory.
    return { ...value, cwd: '', workDir: '', workspaceDir: '', workspaceName: '云端环境', workspaceLabel: '云端环境',
      locationMode: 'remote', location: 'cloud', cloud: true };
  }
  function historyPriority(row) { return normalizeHistoryRow(row).cloud ? 2 : 1; }
  async function findRunnerRow(id, { nativeOnly = false } = {}) {
    const wanted = String(id || '').trim();
    if (!wanted) return null;
    // A sidebar row may be replaced by its synchronized replay receipt while
    // navigation is in flight. Resolve its authenticated alias by exact ID.
    const cloud = !nativeOnly && (await externalRows({ includeAliases: true })).chats.find(row => row.id === wanted);
    if (cloud) return cloud;
    const results = await Promise.all(runnerAdapters.map(async (adapter) => {
      try {
        return typeof adapter.historyEntry === 'function'
          ? await adapter.historyEntry(wanted) : await adapter.history(Number.MAX_SAFE_INTEGER);
      }
      catch (error) { return { ok: false, reason: _reason(error), chats: [] }; }
    }));
    const row = results.flatMap(result => result.chats || [])
      .find(item => item && item.id === wanted);
    if (row) return row;
    if (runnerAdapters.length && !results.some(result => result && result.ok)) {
      const failed = results.find(result => result && result.reason);
      throw new RuntimeContractError('RUNNER_HISTORY_UNAVAILABLE',
        String(failed && failed.reason || '读不到 Runner 会话目录'));
    }
    return null;
  }

  function closeAll() {
    [...byRef.values()].forEach(closeEntry);
  }

  async function probe(app, adapterId = 'pi') {
    try { return await registry.detect(String(adapterId || 'pi'), { app: app || opts.app }); }
    catch (error) { return { ok: false, reason: _reason(error) }; }
  }

  async function history(app, limit = 50) {
    const rows = await Promise.all([
      externalRows(),
      Promise.resolve(sessionModule.history(app || opts.app, limit))
        .catch((error) => ({ ok: false, reason: _reason(error), chats: [] })),
      // Apply the sidebar limit after filtering archives; archived recent runs
      // must not hide older visible conversations. The runner inventory is shared.
      ...runnerAdapters.map((adapter) => Promise.resolve(adapter.history(Number.MAX_SAFE_INTEGER))
        .catch((error) => ({ ok: false, reason: _reason(error), chats: [] }))),
    ]);
    let archivedIds = null;
    if (sessionModule.archiveState && typeof sessionModule.archiveState.read === 'function' &&
        typeof sessionModule.archiveRoot === 'function') {
      try {
        archivedIds = sessionModule.archiveState.read(
          sessionModule.archiveRoot(app || opts.app),
        ).conversations;
      } catch (error) {
        return { ok: false, chats: [], reason: '读取归档状态失败：' + _reason(error) };
      }
    }
    const merged = new Map();
    const sourcePriority = new Map();
    rows.forEach((result, sourceIndex) => (result.chats || []).forEach((row) => {
      if (!row || !row.id) return;
      const normalized = normalizeHistoryRow({ ...row, adapterId: row.adapterId || 'pi' });
      if (archivedIds && Object.prototype.hasOwnProperty.call(archivedIds, normalized.id)) return;
      const old = merged.get(normalized.id);
      // The external cloud inventory is authoritative when a handed-off Pi
      // row with the same id is still present locally. Keep its metadata and
      // private replay scope instead of letting the local copy win on `at`.
      const oldSource = sourcePriority.get(normalized.id);
      if (!old || historyPriority(normalized) > historyPriority(old) ||
          historyPriority(normalized) === historyPriority(old) &&
          (sourceIndex < oldSource || (sourceIndex === oldSource && Number(normalized.at || 0) >= Number(old.at || 0)))) {
        merged.set(normalized.id, normalized);
        sourcePriority.set(normalized.id, sourceIndex);
      }
    }));
    const chats = runtimeSegments.mergeHistory(app || opts.app, [...merged.values()])
      .filter(row => !archivedIds || !Object.hasOwn(archivedIds, row.id))
      .sort((left, right) => Number(right.at || 0) - Number(left.at || 0))
      .slice(0, Math.max(1, Number(limit) || 50));
    const ok = rows.some((result) => result.ok);
    const failed = rows.find((result) => result.reason);
    return { ok, chats, reason: ok ? '' : String(failed && failed.reason || '') };
  }

  async function archivedHistory(app, limit = Number.MAX_SAFE_INTEGER) {
    const rows = await Promise.all([
      externalRows(),
      typeof sessionModule.archivedHistory === 'function'
        ? Promise.resolve(sessionModule.archivedHistory(app || opts.app, limit))
          .catch((error) => ({ ok: false, reason: _reason(error), chats: [] }))
        : Promise.resolve({ ok: true, chats: [] }),
      ...runnerAdapters.map((adapter) => Promise.resolve(adapter.history(Number.MAX_SAFE_INTEGER))
        .catch((error) => ({ ok: false, reason: _reason(error), chats: [] }))),
    ]);
    let archivedIds = null;
    if (typeof sessionModule.isArchived === 'function' &&
        sessionModule.archiveState && typeof sessionModule.archiveState.read === 'function' &&
        typeof sessionModule.archiveRoot === 'function') {
      try {
        archivedIds = sessionModule.archiveState.read(
          sessionModule.archiveRoot(app || opts.app),
        ).conversations;
      } catch (error) {
        return { ok: false, chats: [], reason: '读取归档状态失败：' + _reason(error) };
      }
    }
    const merged = new Map();
    const sourcePriority = new Map();
    rows.forEach((result, sourceIndex) => (result.chats || []).forEach((row) => {
      if (!row || !row.id) return;
      const normalized = normalizeHistoryRow({
        ...row,
        adapterId: row.adapterId || 'pi',
        archivedAt: row.archivedAt || (archivedIds && archivedIds[row.id]) || 0,
      });
      if (archivedIds && !Object.prototype.hasOwnProperty.call(archivedIds, normalized.id)) return;
      if (!archivedIds && typeof sessionModule.isArchived === 'function') {
        try {
          if (!sessionModule.isArchived(app || opts.app, normalized.id)) return;
        } catch (_) { return; }
      }
      const old = merged.get(normalized.id);
      const oldSource = sourcePriority.get(normalized.id);
      if (!old || historyPriority(normalized) > historyPriority(old) ||
          historyPriority(normalized) === historyPriority(old) &&
          (sourceIndex < oldSource || (sourceIndex === oldSource && Number(normalized.at || 0) >= Number(old.at || 0)))) {
        merged.set(normalized.id, normalized);
        sourcePriority.set(normalized.id, sourceIndex);
      }
    }));
    const ok = rows.some(result => result.ok);
    const failed = rows.find(result => result && result.reason);
    const chats = runtimeSegments.mergeHistory(app || opts.app, [...merged.values()])
      .sort((left, right) => Number(right.archivedAt || right.at || 0) - Number(left.archivedAt || left.at || 0))
      .slice(0, Math.max(1, Number(limit) || Number.MAX_SAFE_INTEGER));
    return { ok, chats, reason: ok ? '' : String(failed && failed.reason || '') };
  }

  async function archiveHistory(app, id) {
    const wanted = String(id || '').trim();
    if (!wanted) return { ok: false, reason: '没有指定要归档的会话' };
    const pi = typeof sessionModule.historyEntry === 'function'
      ? await sessionModule.historyEntry(app || opts.app, wanted) : { ok: false, notFound: true };
    if (pi && pi.ok && pi.entry && typeof sessionModule.archiveHistory === 'function') {
      return sessionModule.archiveHistory(app || opts.app, wanted);
    }
    if (pi && pi.ok === false && !pi.notFound) return pi;
    const runner = await findRunnerRow(wanted);
    if (!runner || typeof sessionModule.setArchived !== 'function') {
      return { ok: false, reason: '找不到这条会话' };
    }
    if (['starting', 'running', 'streaming', 'queued', 'waiting', 'waiting-user'].includes(runner.state)) {
      return { ok: false, reason: '这条会话还在执行，完成或停止后再归档' };
    }
    const archivedAt = sessionModule.setArchived(app || opts.app, wanted, true);
    return { ok: true, id: wanted, archived: true, archivedAt, entry: runner };
  }

  async function restoreHistory(app, id) {
    const wanted = String(id || '').trim();
    if (!wanted) return { ok: false, reason: '没有指定要恢复的会话' };
    const piEntry = typeof sessionModule.historyEntry === 'function'
      ? await sessionModule.historyEntry(app || opts.app, wanted) : { ok: false, notFound: true };
    if (piEntry && piEntry.ok && piEntry.entry && typeof sessionModule.restoreHistory === 'function') {
      return sessionModule.restoreHistory(app || opts.app, wanted);
    }
    if (piEntry && piEntry.ok === false && !piEntry.notFound) return piEntry;
    const runner = await findRunnerRow(wanted);
    if (!runner) return { ok: false, notFound: true, reason: '找不到这条会话' };
    if (typeof sessionModule.setArchived === 'function') {
      if (!sessionModule.isArchived(app || opts.app, wanted)) {
        return { ok: false, reason: '这条会话不在归档历史中' };
      }
      sessionModule.setArchived(app || opts.app, wanted, false);
      return { ok: true, id: wanted, archived: false, entry: runner };
    }
    return { ok: false, reason: '归档状态不可用' };
  }

  async function permanentlyDeleteNativeHistory(app, id) {
    const wanted = String(id || '').trim();
    if (!wanted) return { ok: false, reason: '没有指定要删除的会话' };
    const piEntry = typeof sessionModule.historyEntry === 'function'
      ? await sessionModule.historyEntry(app || opts.app, wanted) : { ok: false, notFound: true };
    if (piEntry && piEntry.ok && piEntry.entry && typeof sessionModule.permanentlyDeleteHistory === 'function') {
      return sessionModule.permanentlyDeleteHistory(app || opts.app, wanted);
    }
    if (piEntry && piEntry.ok === false && !piEntry.notFound) return piEntry;
    if (typeof sessionModule.isArchived !== 'function' || !sessionModule.isArchived(app || opts.app, wanted)) {
      return { ok: false, reason: '只能从归档历史彻底删除会话' };
    }
    const runner = await findRunnerRow(wanted);
    if (!runner) {
      sessionModule.setArchived(app || opts.app, wanted, false);
      return { ok: true, id: wanted, alreadyDeleted: true };
    }
    if (['starting', 'running', 'streaming', 'queued', 'waiting', 'waiting-user'].includes(runner.state)) {
      return { ok: false, reason: '这条会话还在执行，完成或停止后再删除' };
    }
    if (runner.cloud && externalHistory) {
      const deleted = await externalHistory.forget(wanted);
      if (deleted.ok) sessionModule.setArchived(app || opts.app, wanted, false);
      return deleted;
    }
    const adapter = runnerAdapters.find(item => item && item.id === runner.adapterId);
    if (!adapter || typeof adapter.forgetSession !== 'function') return { ok: false, reason: '这个执行底座不支持彻底删除会话' };
    const deleted = await adapter.forgetSession(wanted);
    if (deleted && (deleted.ok || deleted.notFound) && typeof sessionModule.setArchived === 'function') {
      sessionModule.setArchived(app || opts.app, wanted, false);
    }
    if (deleted && deleted.notFound) return { ...deleted, alreadyDeleted: true };
    return deleted;
  }

  async function permanentlyDeleteHistory(app, id) {
    const record = runtimeSegments.read(app || opts.app, id);
    if (!record) return permanentlyDeleteNativeHistory(app, id);
    if (!sessionModule.isArchived?.(app || opts.app, id)) return { ok: false, reason: '只能从归档历史彻底删除会话' };
    const live = findBySessionId(id);
    if (live?.inFlight?.()) return { ok: false, reason: '请先等待会话完成' };
    await closeEntry(bySessionId.get(id));
    // Keep the public archive and manifest until all native archives are gone.
    for (const part of [...record.segments, record.active].filter(p => p.sessionId !== id)) {
      sessionModule.setArchived?.(app || opts.app, part.sessionId, true);
      const result = await permanentlyDeleteNativeHistory(app, part.sessionId);
      if (!result?.ok && !result?.notFound) return result;
    }
    const result = await permanentlyDeleteNativeHistory(app, id);
    if (result?.ok || result?.notFound) await runtimeSegments.remove(app || opts.app, id);
    return result;
  }

  function runtimes() {
    return runtimeCatalog.runtimes().map((runtimeSpec) => {
      const descriptor = registry.describe(runtimeSpec.id);
      return descriptor ? runtimeCatalog.publicRuntime(runtimeSpec, descriptor.capabilities) : null;
    }).filter(Boolean);
  }

  // The catalog is only a declaration of what this build knows about. UI
  // pickers must use a health-checked projection so an installed-but-offline
  // Runner cannot be selected and leave the conversation on a dead path.
  const availabilityCache = { app: null, at: 0, value: null, flight: null, generation: 0 };
  function invalidateRuntimes() {
    availabilityCache.generation++; availabilityCache.value = null; availabilityCache.at = 0; availabilityCache.flight = null;
  }
  const AVAILABILITY_TTL_MS = 30000;
  async function availableRuntimes(app, options = {}) {
    const owner = app || opts.app || null;
    const force = options && options.force === true;
    if (!force && availabilityCache.value && availabilityCache.app === owner &&
        Date.now() - availabilityCache.at < AVAILABILITY_TTL_MS) {
      return availabilityCache.value;
    }
    if (!force && availabilityCache.flight && availabilityCache.app === owner) {
      return availabilityCache.flight;
    }
    const generation = ++availabilityCache.generation;
    const catalogRows = runtimes();
    const job = Promise.all(catalogRows.map(async (row) => {
      let health;
      try {
        health = await registry.detect(row.id, { app: owner });
      } catch (error) {
        health = { ok: false, reason: _reason(error), state: 'error' };
      }
      const value = health && typeof health === 'object' ? { ...health } : { ok: false, state: 'unknown' };
      // Pi is the local compatibility runtime and remains available as the
      // recovery path even while its optional probe is warming up or fails.
      const ready = row.id === 'pi' || value.ok === true;
      return { row, health: value, ready };
    })).then(results => {
      const ready = results.filter(item => item.ready).map(item => ({
        ...item.row, availability: { ...item.health, ok: true },
      }));
      const missing = results.filter(item => !item.ready).map(item => ({
        ...item.row, availability: item.health,
      }));
      const value = { ok: true, runtimes: catalogRows, availableRuntimes: ready, missing,
        checkedAt: Date.now() };
      if (generation === availabilityCache.generation) {
        availabilityCache.app = owner; availabilityCache.at = Date.now(); availabilityCache.value = value;
      }
      return value;
    }).catch(error => ({ ok: false, reason: _reason(error), runtimes: [], availableRuntimes: [], missing: catalogRows }));
    availabilityCache.app = owner; availabilityCache.flight = job;
    return job.finally(() => { if (availabilityCache.flight === job) availabilityCache.flight = null; });
  }

  function addRuntime(declaration) {
    const spec = defaultRuntimeCatalog.normalize(declaration);
    if (spec.transport !== 'runner') throw new RuntimeContractError('INVALID_RUNTIME_CATALOG', 'A Runner adapter is required');
    const existing = registry.describe(spec.id);
    if (existing) {
      if (runtimeCatalog.runtime(spec.id) && JSON.stringify(runtimeCatalog.runtime(spec.id)) === JSON.stringify(spec)) return spec;
      throw new RuntimeContractError('DUPLICATE_ADAPTER', 'Agent already registered: ' + spec.id);
    }
    if (typeof runtimeCatalog.addRuntime !== 'function') throw new RuntimeContractError('INVALID_RUNTIME_CATALOG', 'Runtime catalog is read-only');
    const adapter = createRunnerRuntimeAdapter({ app: opts.app, runtimeSpec: spec, ...(opts.dynamicRunnerOptions || {}) });
    const unregister = registry.register(adapter);
    try { runtimeCatalog.addRuntime(spec); }
    catch (error) { unregister(); throw error; }
    runnerAdapters.push(adapter);
    invalidateRuntimes();
    return spec;
  }

  function runtimeSession(ref) {
    const entry = byRef.get(String(ref || ''));
    return entry ? entry.runtimeView : null;
  }

  function goalCheckpoint(ref) {
    const key = String(ref || '');
    const entry = byRef.get(key) || bySessionId.get(key);
    return entry && entry.supervisor ? entry.supervisor.checkpoint() : null;
  }

  function goalRecovery(ref) {
    const key = String(ref || '');
    const entry = byRef.get(key) || bySessionId.get(key);
    return entry && entry.supervisor ? entry.supervisor.recovery() : null;
  }

  function recoverableGoals(app) {
    const selected = checkpointStore(app || opts.app);
    if (!selected.store || typeof selected.store.list !== 'function') return [];
    const active = new Set([...bySessionId.keys()]);
    return selected.store.list().filter((row) => _isRecoverable(row) && !active.has(row.sessionId))
      .sort((left, right) => String(right.at || '').localeCompare(String(left.at || '')))
      .map((row) => ({
        adapterId: row.adapterId,
        sessionId: row.sessionId,
        runtimeId: row.runtimeId,
        status: row.status,
        safeBoundary: row.safeBoundary,
        goal: row.goal,
        recovery: row.recovery,
        lastEvent: row.lastEvent,
        at: row.at,
      }));
  }

  async function dispose() {
    closeAll();
    await Promise.allSettled([...pendingDisposals]);
    await registry.dispose();
  }

  const api = {
    setExternalHistory(source) { externalHistory = source; },
    async archivedConversation(app, id, options = {}) {
      const wanted = String(id || '');
      if (!wanted) return null;
      const switched = runtimeSegments.read(app || opts.app, wanted);
      if (switched) return normalizeHistoryRow(runtimeSegments.row(switched));
      // The sidebar is capped at 50 items; opening by identity is not.
      let unreadable = null;
      if (typeof sessionModule.historyEntry === 'function') {
        const found = await sessionModule.historyEntry(app || opts.app, wanted);
        if (found && found.ok && found.entry) return normalizeHistoryRow({ ...found.entry, adapterId: 'pi' });
        if (found && found.ok === false && !found.notFound) unreadable = found;
      }
      const runner = await findRunnerRow(wanted, options);
      if (runner) return normalizeHistoryRow(runner);
      if (unreadable) throw new RuntimeContractError('HISTORY_UNAVAILABLE',
        String(unreadable.reason || '暂时无法读取会话存档'));
      return null;
    },
    open,
    attachView,
    get,
    list,
    findBySessionId,
    findRunnerRow,
    async forgetRunner(app, id) {
      const row = await findRunnerRow(id);
      if (!row) return { ok: false, notFound: true, reason: '这条会话不在执行底座的运行记录里' };
      if (row.cloud && externalHistory) return externalHistory.forget(id);
      const adapter = runnerAdapters.find(item => item && item.id === row.adapterId);
      if (!adapter || typeof adapter.forgetSession !== 'function') {
        return { ok: false, reason: '这个执行底座不支持删除会话' };
      }
      return adapter.forgetSession(row.id);
    },
    closeAll,
    probe,
    runtimes,
    availableRuntimes,
    invalidateRuntimes,
    addRuntime,
    history,
    archivedHistory,
    archiveHistory,
    restoreHistory,
    permanentlyDeleteHistory,
    runtimeSession,
    goalCheckpoint,
    goalRecovery,
    recoverableGoals,
    dispose,
    registry,
  };
  [
    'loadSdk', 'prewarm', 'sessionResources', 'historyEntry',
    'isArchived', 'setArchived', 'maintenanceWorkloads', 'reserveArchive', 'commitArchive', 'abandonArchive',
    '_explain', '_presenceState', '_mergeHistory', '_title', '_seed',
  ].forEach((name) => {
    if (typeof sessionModule[name] === 'function') {
      api[name] = (...args) => sessionModule[name](...args);
    }
  });
  return Object.freeze(api);
}

const bridge = createPiSessionBridge({
  sessionModule: require('./process-session'),
});

module.exports = Object.assign({}, bridge, {
  RUNTIME_RECORD,
  createPiSessionBridge,
});
