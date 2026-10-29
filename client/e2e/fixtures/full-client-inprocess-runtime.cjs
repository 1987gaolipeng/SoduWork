'use strict';

// Explicit QA runtime boundary: run the original Pi engine in the already
// isolated Electron process. This does not test utilityProcess/RPC/recovery.
// No UI results, API responses, model completions or archive writes are faked.
const path = require('node:path');

function install({ client = path.resolve(__dirname, '../..'), report } = {}) {
  if (!globalThis[Symbol.for('soduwork.five-account-isolation')]) {
    throw Error('Install full-client-isolation before the in-process QA runtime');
  }
  const resolve = name => require.resolve(path.join(client, 'main', name));
  if (require.cache[resolve('agent-runtime/pi-session-bridge.js')]) {
    throw Error('Install the QA runtime before production main or session bridge');
  }
  const target = resolve('agent-runtime/process-session.js');
  const engine = require(resolve('pi-session/session.js'));
  const storage = require(resolve('agent-runtime/process-storage.js'));
  const modelConfig = require(resolve('pi-session/model-config.js'));
  const locale = require(resolve('native-locale.cjs'));
  async function closeSessions() {
    const results = await Promise.allSettled(engine.list().map(session =>
      Promise.resolve().then(() => session.close())));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'In-process QA sessions did not all close');
  }
  const adapter = {
    ...engine,
    // The test entry explicitly awaits dispose before closing its app/Hub.
    installLifecycle() {},
    closeAll: closeSessions,
    async reset() { await closeSessions(); modelConfig.invalidate(); },
    dispose: closeSessions,
    setLocale: value => locale.setLocale(value),
    invalidateModels: () => modelConfig.invalidate(),
    reserveArchive: (app, cwd, title, owner) => storage.plan(app, cwd, title, owner),
    commitArchive: (app, plan) => storage.commit(app, plan),
    abandonArchive: (app, plan) => storage.abandon(app, plan),
    // Same trusted-path checks and implementation as process-worker's RPC
    // handler, now calling the real engine directly within this test boundary.
    async prepareSkills(app, request) {
      const skills = require(resolve('pi-session/skill-turn.js'));
      const selected = skills.names(request?.names);
      if (!path.isAbsolute(request?.cwd || '') || !Array.isArray(request?.items) ||
          request.items.length !== selected.length || request.items.some((row, index) =>
            row?.name !== selected[index] || !path.isAbsolute(row?.path || ''))) {
        throw Error('Selected skill paths are not trusted');
      }
      const loaded = await engine.loadSdk(app);
      if (!loaded.ok) return skills.failure(Error(loaded.reason));
      const prepared = await skills.prepare({ cwd: request.cwd,
        resolveSkills: async () => ({ items: request.items }) }, { skills: selected }, loaded.sdk);
      const { readScope, ...result } = prepared;
      return result;
    },
  };
  // Populate the normal CommonJS module entry, then replace only its exports
  // before any application consumer captures them. No production file changes.
  require(target);
  require.cache[target].exports = adapter;
  if (report) {
    report.runtimeBoundary = {
      mode: 'original-pi-engine-inprocess',
      reason: 'Windows process identity query exceeded its 8 second timeout',
      preserved: ['original Pi SDK', 'renderer/main IPC', 'real authentication and HTTP APIs',
        'original model configuration and streaming', 'original task and archive storage'],
      excluded: ['utilityProcess transport', 'runtime RPC', 'worker crash and recovery', 'external CLI tools'],
    };
  }
  return adapter;
}

module.exports = { install };
