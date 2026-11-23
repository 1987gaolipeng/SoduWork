'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const personal = require('../main/personal-plugins');
const grant = require('../main/pi-session/plugin-grant');
const {createRunnerRuntimeAdapter, getRunnerSessionDetails, _uuidV5} = require('../main/agent-runtime/runner-adapter');
const namespace = '9af442c8-cd1d-4b91-a668-22da2b2635bf';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 2000; i++) { if (predicate()) return; await pause(5); }
  throw Error('Synthetic conversation did not reach its expected boundary');
}

async function harness(t, kind) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-plugin-continuation-'));
  const cwd = path.join(root, 'workspace'), agentDir = path.join(root, 'agent');
  fs.mkdirSync(cwd); fs.mkdirSync(agentDir);
  const app = {getPath: () => root}, sessions = [], calls = [], resolutions = [], handlers = new Map();
  const h = {root, cwd, app, calls, resolutions, held: null, holdNext: false, failure: null, permission: true};
  const identity = {hub: 'https://synthetic.invalid', clientId: 'fixture', secret: 'fixture-secret'};
  const fetchImpl = async () => {
    if (h.failure) throw h.failure;
    return {ok: h.permission, status: h.permission ? 200 : 403,
      headers: {get: () => null}, json: async () => ({canUse: h.permission})};
  };
  personal.install({app, ipcMain: {handle: (name, fn) => handlers.set(name, fn)}, identityOf: () => identity, fetchImpl});
  h.create = (name, extra = {}) => personal.create(app, {template: 'method', name,
    version: '1.0.0', description: 'Synthetic continuation regression.',
    instructions: 'Answer the supplied synthetic message briefly.', ...extra}).plugin.pluginId;
  h.enable = (id, enabled) => handlers.get('personal-plugin-enable')(null, id, enabled);
  h.remove = id => handlers.get('personal-plugin-delete')(null, id);
  h.release = () => { const release = h.held; h.held = null; release?.(); };
  h.library = path.join(root, 'personal-plugins.json');
  const resolvePlugins = async ids => {
    resolutions.push(ids.slice());
    return grant.resolve({app, identityOf: () => identity, fetchImpl, pluginIds: ids, cwd, ref: 'fixture'});
  };
  function wrap(session, handle, archive) {
    sessions.push({session, handle});
    return {id: handle.sessionId, archive, snapshot: () => handle.snapshot(),
      submit: (text, options = {}) => kind === 'pi'
        ? handle.submit(text, [], options) : session.send({text, options}),
      async guardedSubmit(text, options = {}) {
        const guard = require('../main/pi-session/app-mcp-grant.cjs'), captured = {...options};
        guard.bind(handle, {}, '', app);
        await guard.guardSend(handle, captured);
        return this.submit(text, captured);
      },
      async send(text, options = {}) {
        const result = await this.submit(text, options).completion;
        await until(() => !handle.inFlight());
        return result;
      },
      cancel: id => handle.cancelQueued(id),
      close: () => kind === 'pi' ? handle.close() : session.dispose(),
    };
  }
  let closeTransport = async () => {};
  t.after(async () => {
    h.release();
    for (const {session, handle} of sessions) {
      if (kind === 'pi') handle.close(); else await session.dispose();
    }
    await closeTransport();
    fs.rmSync(root, {recursive: true, force: true});
  });
  if (kind === 'pi') {
    const sdk = await import('../node_modules/@earendil-works/pi-coding-agent/dist/index.js');
    const archives = new Map();
    const server = http.createServer((request, response) => {
      let raw = '';
      request.on('data', chunk => { raw += chunk; });
      request.on('end', () => {
        calls.push(JSON.parse(raw));
        const respond = () => {
          response.writeHead(200, {'content-type': 'text/event-stream'});
          for (const [delta, finish_reason] of [[{role: 'assistant', content: 'Fixture completed.'}, null], [{}, 'stop']]) {
            response.write('data: ' + JSON.stringify({id: 'fixture', object: 'chat.completion.chunk', model: 'fixture',
              choices: [{index: 0, delta, finish_reason}]}) + '\n\n');
          }
          response.end('data: [DONE]\n\n');
        };
        if (h.holdNext) { h.holdNext = false; h.held = respond; } else respond();
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    closeTransport = () => new Promise(resolve => server.close(resolve));
    const model = {id: 'fixture', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
      key: 'fixture-only', contextWindow: 200000};
    const runtime = await sdk.ModelRuntime.create({modelsPath: null, authPath: path.join(root, 'auth.json'),
      modelsStorePath: path.join(root, 'models.db')});
    runtime.registerProvider('soduwork', require('../main/conversation/model-selection').piProvider(model));
    t.mock.method(require('../main/pi-session/model-config'), 'prepare', async () => ({ok: true, agentDir, provider: 'soduwork', model}));
    t.mock.method(require('../main/pi-session/sdk-loader'), 'load', async () => ({...sdk,
      ModelRuntime: {create: async () => runtime}, createAgentSession: args => {
        const manager = args.sessionManager || sdk.SessionManager.create(cwd, path.join(agentDir, 'sessions'));
        archives.set(manager.getSessionId(), manager.getSessionFile());
        return sdk.createAgentSession({...args, sessionManager: manager, tools: []});
      }}));
    const resources = require('../main/pi-session/session-resources'), loadResources = resources.sessionResources;
    t.mock.method(resources, 'sessionResources', async (...args) => {
      args[5] = {...args[5], noExtensions: true};
      return {...await loadResources(...args), extensionsDeferred: false};
    });
    t.mock.method(require('../main/pi-session/media-artifacts'), 'recover', async () => ({files: [], errors: []}));
    const driverPath = require.resolve('../main/pi-session/session');
    // The module caches its SDK; each independent fixture must own its runtime.
    delete require.cache[driverPath];
    const driver = require(driverPath);
    h.open = async (ref, extra = {}) => {
      const result = await driver.open({app, identity: {}, cwd, ref, resolvePlugins, ...extra});
      assert.equal(result.ok, true, result.reason);
      return wrap(result.session, result.session, archives.get(result.session.sessionId));
    };
  } else {
    const events = new Map();
    const runtime = {async rpc(op, payload) {
      if (op === 'runtime.detect') return {ok: true, data: {accessControl: {
        schema: 'soduwork.access-policy/v1', supported: true, modes: ['standard', 'readonly', 'full']}}};
      if (op === 'job.dispatch' || op === 'job.comment') {
        calls.push({op, payload});
        const id = op === 'job.dispatch' ? _uuidV5(namespace, payload.dispatchId) : payload.ref;
        const rows = events.get(id) || []; events.set(id, rows);
        rows.push({seq: rows.length + 1, kind: 'user', text: op === 'job.dispatch' ? payload.ctx.conversationUserText : payload.text,
          plugins: op === 'job.dispatch' ? payload.ctx.conversationPlugins : payload.plugins});
        return {ok: true, data: {ref: id, ok: true}};
      }
      if (op === 'job.session') {
        if (h.holdNext) { h.holdNext = false; await new Promise(resolve => { h.held = resolve; }); }
        const rows = events.get(payload.ref) || [];
        if (rows.at(-1)?.kind === 'user') rows.push({seq: rows.length + 1, kind: 'say', text: 'Fixture completed.'});
        return {ok: true, data: {ok: true, status: 'done', items: rows.filter(row => row.seq > payload.since)}};
      }
      if (op === 'job.stop') return {ok: true, data: {ok: true}};
      throw Error(op);
    }};
    const adapter = createRunnerRuntimeAdapter({app,
      runtimeSpec: require('../main/agent-runtime/runtime-catalog').runtime('opencode'), runnerRuntime: runtime,
      modelConfig: {fetchModel: async () => ({ok: true, model: {id: 'fixture', baseUrl: 'http://model.invalid', key: 'fixture-only'}})}});
    h.open = async (ref, extra = {}) => {
      const session = await adapter.createSession({identity: {}, native: {runner: {openOptions: {
        app, identity: {}, cwd, ref, capabilityIds: [], resolvePlugins, ...extra}}}});
      const handle = getRunnerSessionDetails(session).handle;
      return wrap(session, handle, handle.sessionId);
    };
  }
  h.reopen = async previous => {
    await previous.close();
    return h.open('restored-' + previous.id, {resumePath: previous.archive, resumeCwd: cwd});
  };
  return h;
}

for (const kind of ['pi', 'runner']) {
  test(kind + ' ordinary continuation prunes disabled/deleted personal plugins and preserves history on reopen',
    {timeout: 30000}, async t => {
      const h = await harness(t, kind), removed = h.create('Retired method'), kept = h.create('Available method');
      let session = await h.open('plugin-history');
      assert.equal((await session.send('Original message', {pluginIds: [removed, kept]})).ok, true);
      const id = session.id;
      const historical = structuredClone(session.snapshot().messages.filter(row => row.role === 'user'));
      assert.deepEqual(historical[0].plugins.map(row => row.pluginId), [removed, kept]);
      await h.enable(removed, false);
      const continued = await session.send('Plain follow-up after disabling', {plugins: []});
      assert.equal(continued.ok, true, continued.reason);
      assert.deepEqual(session.snapshot().activePlugins, [kept]);
      assert.deepEqual(h.resolutions.at(-1), [kept], 'available inherited plugins still obtain fresh authorization');
      assert.equal(session.id, id);
      assert.deepEqual(session.snapshot().messages.filter(row => row.role === 'user')[0], historical[0]);
      session = await h.reopen(session);
      assert.equal((await session.send('Restored ordinary follow-up')).ok, true);
      assert.equal(session.id, id);
      assert.deepEqual(session.snapshot().activePlugins, [kept]);
      assert.deepEqual(session.snapshot().messages.filter(row => row.role === 'user')[0].plugins,
        historical[0].plugins, 'reopening must not rewrite historical plugin badges');
      await h.enable(removed, true);
      assert.equal((await session.send('Re-enabling does not reactivate a removed selection')).ok, true);
      assert.deepEqual(session.snapshot().activePlugins, [kept]);
      assert.equal((await session.send('Select both again', {pluginIds: [removed, kept]})).ok, true);
      h.remove(removed);
      assert.equal((await session.send('Plain follow-up after deleting', {plugins: []})).ok, true);
      assert.deepEqual(session.snapshot().activePlugins, [kept]);
      h.remove(kept);
      assert.equal((await session.send('All inherited plugins are deleted', {plugins: []})).ok, true);
      assert.deepEqual(session.snapshot().activePlugins, []);
      session = await h.reopen(session);
      assert.equal((await session.send('Reopen an empty selection')).ok, true);
      assert.equal(session.id, id);
      assert.deepEqual(session.snapshot().activePlugins, []);
      assert.equal(session.snapshot().messages.filter(row => row.role === 'user')[0].text, 'Original message');
    });

  test(kind + ' task, goal, automation and internal turns retain unavailable plugin failures',
    {timeout: 30000}, async t => {
      const h = await harness(t, kind), id = h.create('Required controlled method');
      const session = await h.open('controlled-selection');
      assert.equal((await session.send('Select required method', {pluginIds: [id]})).ok, true);
      await h.enable(id, false);
      const before = h.calls.length;
      for (const options of [{taskId: 'fixture-task'}, {goalMode: true}, {source: 'automation'}, {internal: true}]) {
        const result = await session.send('Do not silently reduce this turn capability', options);
        assert.equal(result.ok, false, JSON.stringify(options));
        assert.match(result.reason, /个人插件不存在或已停用/);
        assert.deepEqual(session.snapshot().activePlugins, [id]);
        assert.equal(h.calls.length, before);
      }
      assert.equal((await session.send('Explicitly clear the retired method', {clearPluginSelection: true})).ok, true);
      assert.deepEqual(session.snapshot().activePlugins, []);
    });

  test(kind + ' explicit unavailable plugins and source permission/network failures remain blocking',
    {timeout: 30000}, async t => {
      const h = await harness(t, kind), id = h.create('Enterprise derived method', {sourcePluginId: 'fixture-enterprise-source'});
      const session = await h.open('strict-authorization');
      assert.equal((await session.send('Use authorized method', {pluginIds: [id]})).ok, true);
      const before = h.calls.length;
      h.permission = false;
      const denied = await session.send('The source permission was revoked');
      assert.equal(denied.ok, false);
      assert.match(denied.reason, /没有源插件的使用权限/);
      assert.equal(h.calls.length, before);
      assert.deepEqual(session.snapshot().activePlugins, [id]);
      h.permission = true; h.failure = Error('Synthetic source network failure');
      const offline = await session.send('The source network is unavailable');
      assert.equal(offline.ok, false);
      assert.match(offline.reason, /Synthetic source network failure/);
      assert.equal(h.calls.length, before);
      assert.deepEqual(session.snapshot().activePlugins, [id]);
      h.failure = null;
      await h.enable(id, false);
      const explicit = await session.send('Explicitly request disabled plugin', {pluginIds: [id]});
      assert.equal(explicit.ok, false);
      assert.match(explicit.reason, /个人插件不存在或已停用/);
      assert.equal(h.calls.length, before);
      assert.deepEqual(session.snapshot().activePlugins, [id]);
      h.remove(id);
      const deleted = await session.send('Explicitly request deleted plugin', {plugins: [{pluginId: id}]});
      assert.equal(deleted.ok, false);
      assert.match(deleted.reason, /个人插件不存在或已停用/);
      assert.equal(h.calls.length, before);
      const fresh = await h.open('fresh-unrelated');
      assert.equal((await fresh.send('A new ordinary conversation')).ok, true);
      assert.deepEqual(fresh.snapshot().activePlugins, []);
    });

  test(kind + ' a corrupt or unreadable personal library cannot erase inherited selections',
    {timeout: 30000}, async t => {
      const h = await harness(t, kind), id = h.create('Method whose library must remain authoritative');
      const session = await h.open('strict-library');
      assert.equal((await session.send('Use method', {pluginIds: [id]})).ok, true);
      const valid = fs.readFileSync(h.library, 'utf8'), before = h.calls.length;
      for (const malformed of ['{broken JSON', JSON.stringify({schemaVersion: -1, plugins: []})]) {
        fs.writeFileSync(h.library, malformed);
        const result = await session.send('Library read is not deletion');
        assert.equal(result.ok, false);
        assert.equal(h.calls.length, before);
        assert.deepEqual(session.snapshot().activePlugins, [id]);
      }
      fs.writeFileSync(h.library, valid);
      const read = fs.readFileSync;
      const blockedRead = t.mock.method(fs, 'readFileSync', function (file, ...args) {
        if (path.resolve(String(file)) === h.library) throw Object.assign(Error('Synthetic permission denied'), {code: 'EACCES'});
        return read.call(this, file, ...args);
      });
      try {
        assert.equal((await session.send('Library cannot be opened')).ok, false);
        assert.equal(h.calls.length, before);
        assert.deepEqual(session.snapshot().activePlugins, [id]);
      } finally { blockedRead.mock.restore(); }
      assert.equal((await session.send('Retry after storage recovers')).ok, true);
    });

  test(kind + ' queued and cancelled ordinary turns do not prune plugins before execution',
    {timeout: 30000}, async t => {
      const h = await harness(t, kind), id = h.create('Temporarily available queued method');
      const session = await h.open('queued-selection');
      assert.equal((await session.send('Select method', {pluginIds: [id]})).ok, true);
      h.holdNext = true;
      const running = session.submit('In-flight work');
      await until(() => Boolean(h.held));
      const cancelled = session.submit('Cancelled queued message', {plugins: []});
      const next = session.submit('Queued ordinary continuation', {plugins: []});
      await h.enable(id, false);
      assert.equal(session.cancel(cancelled.queueId).ok, true);
      assert.deepEqual(session.snapshot().activePlugins, [id], 'a queued or cancelled turn cannot alter the active turn');
      const before = h.calls.length;
      h.release();
      assert.equal((await running.completion).ok, true);
      assert.equal((await cancelled.completion).cancelled, true);
      const result = await next.completion;
      assert.equal(result.ok, true, result.reason);
      await until(() => session.snapshot().activePlugins.length === 0);
      assert.equal(h.calls.length, before + 1);
      assert.deepEqual(session.snapshot().activePlugins, []);
      assert.ok(!session.snapshot().messages.some(row => row.text === 'Cancelled queued message'));
    });

  test(kind + ' guarded queued continuation retires its captured plugin without acquiring a preceding selection',
    {timeout: 30000}, async t => {
      const h = await harness(t, kind), first = h.create('Original method'), second = h.create('Queued replacement');
      const session = await h.open('guarded-selection');
      const initial = await session.guardedSubmit('Select first method', {pluginIds: [first]});
      assert.equal((await initial.completion).ok, true);
      h.holdNext = true;
      const running = await session.guardedSubmit('Hold first method');
      await until(() => Boolean(h.held));
      const replacement = await session.guardedSubmit('Select second method', {pluginIds: [second]});
      const ordinary = await session.guardedSubmit('Follow up on original selection', {pluginIds: []});
      await h.enable(first, false);
      assert.deepEqual(session.snapshot().activePlugins, [first]);
      h.release();
      assert.equal((await running.completion).ok, true);
      assert.equal((await replacement.completion).ok, true);
      const result = await ordinary.completion;
      assert.equal(result.ok, true, result.reason);
      assert.deepEqual(session.snapshot().activePlugins, []);
      assert.deepEqual(h.resolutions.at(-1), [second], 'the ordinary turn cannot acquire the queued replacement');
      const users = session.snapshot().messages.filter(row => row.role === 'user');
      assert.deepEqual(users.at(-2).plugins.map(row => row.pluginId), [second]);
      assert.deepEqual(users.at(-1).plugins || [], []);
    });
}

test('local builtins and remote selections remain authoritative when the personal library is missing', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-plugin-selection-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const app = {getPath: () => root};
  const retained = [personal.BUILDER_ID, personal.APP_DEVELOPER_ID, personal.SKILL_STUDIO_ID,
    personal.MCP_STUDIO_ID, personal.PRODUCT_INCUBATOR_ID, 'fixture-enterprise-plugin'];
  const selected = [...retained, 'local:deleted-personal-plugin'];
  assert.deepEqual(personal.pruneUnavailableInherited(app, selected), retained);
  assert.deepEqual(selected, [...retained, 'local:deleted-personal-plugin'], 'caller history is immutable');
  assert.deepEqual(fs.readdirSync(root), [], 'resolving absence cannot recreate or rewrite the personal library');
});
