/* Last successfully used runtime/model pair for an explicitly selected directory. */
(function (global) {
  'use strict';
  const prefix = 'soduwork_compose_directory_v1:';
  const memory = new Map();
  let options = {}, active = false, generation = 0, activeKey = '', pending = null, blocked = false, expected = null;
  let explicitRevision = 0;
  const owner = () => String(global.SoduWorkAPI?.taskStorageKey?.('ops') || 'renderer');
  function scope() {
    const workspace = options.workspace?.() || {};
    // Picker/project paths are already absolute. Preserve case on case-sensitive filesystems.
    const raw = workspace.direct ? String(workspace.dir || '') : '';
    const windows = /^[a-z]:[\\/]/i.test(raw) || raw.startsWith('\\\\');
    const path = windows ? raw.replace(/\\/g, '/') : raw;
    const dir = path.replace(/\/+$/, '') + (/^[a-z]:\/+$/i.test(path) ? '/' : '') || (path.startsWith('/') ? '/' : '');
    return { owner: owner(), dir, location: global.ComposeRuntime?.location?.() === 'cloud' ? 'cloud' : 'local' };
  }
  const identity = value => JSON.stringify([value.owner, value.location, value.dir]);
  // Cloud sessions choose their own remote workspace; a local picker path is not its identity.
  const key = value => value.dir && value.location === 'local' ? prefix + identity(value) : '';
  function pair(value) {
    if (!value || typeof value !== 'object' || !/^[a-z][a-z0-9._-]{0,47}$/.test(value.adapterId || '')) return null;
    if (typeof value.modelName !== 'string' || value.modelName.length > 2048) return null;
    return { adapterId: value.adapterId, modelName: value.modelName,
      reasoningEffort: String(value.reasoningEffort || '').slice(0, 24), thinkingLevel: String(value.thinkingLevel || '').slice(0, 24) };
  }
  function read(storageKey) {
    if (!storageKey) return null;
    if (memory.has(storageKey)) return memory.get(storageKey);
    try {
      const saved = pair(JSON.parse(global.localStorage?.getItem(storageKey) || 'null'));
      if (saved) memory.set(storageKey, saved);
      return saved;
    } catch (_) { return null; }
  }
  function announce() {
    options.say?.('此目录上次使用的 Agent 或模型暂不可用，请重新选择可用的 Agent 和模型');
  }
  function begin({ newSession = false } = {}) {
    active = true; blocked = false;
    const ticket = ++generation, context = scope(), storageKey = key(context);
    activeKey = identity(context);
    const current = () => active && ticket === generation && identity(scope()) === identity(context);
    const saved = read(storageKey);
    expected = saved;
    const job = Promise.resolve().then(async () => {
      if (!current()) return false;
      // Clear both locations before a runtime probe yields. Only the current
      // model lookup should gate readiness after a location/runtime change.
      if (newSession) void Promise.resolve(global.ComposeModelPicker?.resetNewDraft?.()).catch(() => {});
      if (context.location === 'cloud') {
        if (newSession) await global.ComposeModelPicker?.ready?.();
        return current();
      }
      // A new directory must not retain a protected missing-model choice from the previous one.
      await global.ComposeRuntime?.resetNewDraft?.();
      if (!current()) return false;
      await (newSession ? global.ComposeModelPicker?.ready?.() : global.ComposeModelPicker?.resetDirectory?.());
      if (!current() || !saved) return current();
      const runtimeReady = await global.ComposeRuntime?.restoreSelection?.(saved.adapterId, current);
      if (!current()) return false;
      const modelReady = runtimeReady && await global.ComposeModelPicker?.restoreSelection?.(saved, current);
      if (!current()) return false;
      blocked = !modelReady;
      if (blocked) announce();
      return !blocked;
    }).catch(() => { if (current()) { blocked = Boolean(saved); if (blocked) announce(); } return false; })
      .finally(() => { if (pending === job) pending = null; });
    pending = job;
    return job;
  }
  function sync() {
    if (active && activeKey !== identity(scope())) return begin();
    return pending || Promise.resolve(!blocked);
  }
  async function ready() {
    if (!active) return true;
    await sync();
    while (pending) await pending;
    if (expected && !matchesExpected()) blocked = true;
    if (blocked) announce();
    return active && !blocked;
  }
  function selectionStarted() { explicitRevision++; if (active) { if (pending) blocked = true; generation++; pending = null; } }
  function selectionCommitted() {
    selectionStarted();
    if (!active) return;
    blocked = false; expected = null;
    global.ComposeModelPicker?.releasePreference?.();
  }
  function matchesExpected() {
    return !expected || (global.ComposeRuntime?.value?.() === expected.adapterId &&
      global.ComposeModelPicker?.value?.().modelName === expected.modelName);
  }
  function capture() {
    if (!active || pending || blocked || !matchesExpected()) return null;
    const context = scope(), storageKey = key(context);
    const selected = pair({ adapterId: global.ComposeRuntime?.value?.(), ...global.ComposeModelPicker?.value?.() });
    // Codex can run with an implicit default during discovery failure; its concrete model is unverified.
    if (selected?.adapterId === 'codex' && !selected.modelName) return null;
    return storageKey && identity(context) === activeKey && selected ? { scope: context, pair: selected } : null;
  }
  function remember(snapshot) {
    const selected = pair(snapshot?.pair), context = snapshot?.scope;
    if (!selected || !context?.dir || context.owner !== owner()) return false;
    const storageKey = key(context);
    if (!storageKey) return false;
    memory.set(storageKey, selected);
    try { global.localStorage?.setItem(storageKey, JSON.stringify(selected)); } catch (_) { /* Retain the renderer's last successful pair. */ }
    return true;
  }
  function stop() { active = false; generation++; pending = null; blocked = false; expected = null; }
  global.ComposeDirectoryPreferences = { bind: config => { options = config || {}; }, begin, sync, ready,
    selectionStarted, selectionCommitted, selectionRevision: () => explicitRevision, capture, remember, stop };
  for (const event of ['soduwork-data-scope-changed', 'soduwork-device-auth']) {
    // Heartbeats also publish auth events. Restore only when the actual scope
    // changes, preserving unsent choices and any restoration already in flight.
    global.addEventListener?.(event, () => { if (active) void sync(); });
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = global.ComposeDirectoryPreferences;
})(typeof window !== 'undefined' ? window : globalThis);
