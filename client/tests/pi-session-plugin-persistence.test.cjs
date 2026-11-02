'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const modelConfig = require('../main/pi-session/model-config');
const { piProvider } = require('../main/conversation/model-selection');

const pause = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 2000; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw Error('Fixture did not reach the expected boundary');
}

test('Pi executes inherited plugins with fresh grants, restores selections, consumes prior tool results, clears and isolates conversations',
  { timeout: 30000 }, async t => {
    const sdk = await import('../node_modules/@earendil-works/pi-coding-agent/dist/index.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-pi-plugins-'));
    const cwd = path.join(root, 'workspace'), agentDir = path.join(root, 'agent');
    fs.mkdirSync(cwd); fs.mkdirSync(agentDir);
    const resolutions = [], cleanups = [], executions = [], priorResults = [], requests = [], sessions = [];
    const grants = new Set(), archives = new Map();
    let held = null, holdNext = false, revoked = false;
    const server = http.createServer((request, response) => {
      let raw = '';
      request.on('data', chunk => { raw += chunk; });
      request.on('end', () => {
        const body = JSON.parse(raw); requests.push(body);
        const user = body.messages.findLast(message => message.role === 'user');
        const prompt = JSON.stringify(user?.content || '');
        const grant = /PLUGIN-GRANT-(\d+)/.exec(prompt)?.[1];
        const textOf = message => typeof message?.content === 'string' ? message.content
          : (Array.isArray(message?.content) ? message.content
            .filter(block => block?.type === 'text').map(block => block.text || '').join('\n') : '');
        const historicalResults = body.messages
          .filter(message => message?.role === 'tool' || message?.role === 'toolResult')
          .map(textOf).filter(Boolean);
        const lastRole = body.messages.at(-1)?.role;
        const call = grant && !['tool', 'toolResult'].includes(lastRole);
        const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: 'probe-' + grant,
          type: 'function', function: { name: 'plugin_probe', arguments: JSON.stringify({ grant,
            ...(historicalResults.length ? { priorResult: historicalResults.at(-1) } : {}) }) } }] }
          : { role: 'assistant', content: 'Fixture completed.' };
        const respond = () => {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture',
            choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
          response.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture',
            choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: 96000, prompt_tokens_details: { cached_tokens: 95000 },
              completion_tokens: 10, total_tokens: 96010 } }) + '\n\n');
          response.end('data: [DONE]\n\n');
        };
        if (holdNext) { holdNext = false; held = respond; } else respond();
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      held?.(); for (const session of sessions) session.close();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    });
    const fixtureModel = { id: 'fixture', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
      key: 'isolated-fixture', contextWindow: 2000000 };
    const runtime = await sdk.ModelRuntime.create({ modelsPath: null, authPath: path.join(root, 'auth.json'),
      modelsStorePath: path.join(root, 'models.db') });
    runtime.registerProvider('soduwork', piProvider(fixtureModel));
    const probe = { name: 'plugin_probe', label: 'Fixture plugin', description: 'Uses the current plugin grant',
      parameters: { type: 'object', properties: { grant: { type: 'string' }, priorResult: { type: 'string' } }, required: ['grant'] },
      async execute(_id, args) {
        assert.ok(grants.has(args.grant), 'the tool must have a live grant belonging to this turn');
        const expected = executions.length ? 'PLUGIN-RESULT-' + executions.at(-1) : undefined;
        assert.equal(args.priorResult, expected,
          'a follow-up plugin call must receive the previous turn tool result from native history');
        executions.push(args.grant);
        priorResults.push(args.priorResult || '');
        return { content: [{ type: 'text', text: 'PLUGIN-RESULT-' + args.grant }], details: {} };
      } };
    t.mock.method(modelConfig, 'prepare', async () => ({ ok: true, agentDir, provider: 'soduwork', model: fixtureModel }));
    t.mock.method(require('../main/pi-session/sdk-loader'), 'load', async () => ({ ...sdk,
      ModelRuntime: { create: async () => runtime },
      createAgentSession: args => {
        const manager = args.sessionManager || sdk.SessionManager.create(cwd, path.join(agentDir, 'sessions'));
        archives.set(manager.getSessionId(), manager.getSessionFile());
        return sdk.createAgentSession({ ...args, sessionManager: manager, tools: ['plugin_probe'], customTools: [probe] });
      },
    }));
    // Restrict discovery to the test's empty resources; retain the real SDK,
    // session driver, turn queue, plugin resolver and HTTP/tool execution.
    const resources = require('../main/pi-session/session-resources');
    const loadResources = resources.sessionResources;
    t.mock.method(resources, 'sessionResources', async (...args) => {
      args[5] = { ...args[5], noExtensions: true };
      const loaded = await loadResources(...args);
      return { ...loaded, extensionsDeferred: false };
    });
    t.mock.method(require('../main/pi-session/media-artifacts'), 'recover', async () => ({ files: [], errors: [] }));
    const driver = require('../main/pi-session/session');
    async function open(extra = {}) {
      const result = await driver.open({ app: { getPath: () => root }, identity: {}, cwd, ...extra,
        resolvePlugins: async ids => {
          if (revoked) throw Error('Plugin permission revoked');
          const id = String(resolutions.length + 1);
          resolutions.push(ids.slice()); grants.add(id);
          return { items: ids.map(pluginId => ({ pluginId, name: 'Test plugin', context: 'Use plugin_probe for the request.' })),
            grant: { servers: [], guide: 'PLUGIN-GRANT-' + id,
              cleanup() { grants.delete(id); cleanups.push(id); } } };
        } });
      assert.equal(result.ok, true, result.reason);
      sessions.push(result.session); return result.session;
    }
    async function send(session, text, options) {
      const result = await session.submit(text, [], options).completion;
      assert.equal(result.ok, true, result.reason);
      await until(() => !session.inFlight());
      return result;
    }
    const session = await open({ ref: 'original' });
    await send(session, 'first', { pluginIds: ['meeting'] });
    // Exercise the real HTTP -> Pi provider cache split -> driver -> UI path.
    // The upstream count covers the submitted system/history/tool/plugin data.
    assert.equal(session.snapshot().contextUsage.input, 1000);
    assert.equal(session.snapshot().contextUsage.cacheRead, 95000);
    const sandbox = { window: {} };
    require('node:vm').runInNewContext(fs.readFileSync(path.join(__dirname,
      '../components/panels/chat-context-meter.js'), 'utf8'), sandbox);
    const contextHtml = () => sandbox.window.ChatContextMeter.create({
      _snap: session.snapshot(), _model: fixtureModel,
    })._ctxHtml();
    assert.match(contextHtml(), /已用 96,000 标记/);
    assert.ok(requests[0].messages.some(message => message.role === 'system'));
    assert.ok(JSON.stringify(requests[0].tools).includes('plugin_probe'));
    assert.ok(JSON.stringify(requests[0].messages).includes('PLUGIN-GRANT-1'));
    await send(session, 'second without plugin parameters');
    assert.match(contextHtml(), /已用 96,000 标记/);
    assert.deepEqual(resolutions, [['meeting'], ['meeting']]);
    assert.deepEqual(executions, ['1', '2'], 'both turns actually execute the plugin tool');
    assert.deepEqual(cleanups, ['1', '2']);
    assert.equal(grants.size, 0);
    const archive = archives.get(session.sessionId);
    session.close();
    const restored = await open({ ref: 'restored', resumePath: archive, resumeCwd: cwd });
    assert.deepEqual(restored.snapshot().activePlugins, ['meeting']);
    await send(restored, 'after reopening');
    assert.deepEqual(executions, ['1', '2', '3']);
    const fresh = await open({ ref: 'fresh' });
    await send(fresh, 'unrelated conversation');
    assert.deepEqual(fresh.snapshot().activePlugins, []);
    assert.equal(resolutions.length, 3);

    // Direct sends must enqueue raw intent; clearing or choosing a future
    // plugin cannot change the active turn or an earlier queued follow-up.
    holdNext = true;
    const running = restored.submit('held');
    await until(() => held !== null);
    const earlier = restored.send('queued follow-up', []);
    const changed = restored.send('queued new selection', [], { pluginIds: ['calendar'] });
    const inherited = restored.send('queued after selection', []);
    assert.deepEqual(restored.snapshot().activePlugins, ['meeting']);
    assert.equal(resolutions.length, 4, 'queued turns must not resolve grants yet');
    const release = held; held = null; release();
    for (const result of await Promise.all([running.completion, earlier, changed, inherited])) assert.equal(result.ok, true, result.reason);
    await until(() => !restored.inFlight());
    assert.deepEqual(resolutions.slice(3), [['meeting'], ['meeting'], ['calendar'], ['calendar']]);
    assert.deepEqual(executions, ['1', '2', '3', '4', '5', '6', '7']);

    revoked = true;
    const before = requests.length;
    const denied = await restored.submit('permission removed').completion;
    assert.equal(denied.ok, false);
    assert.equal(denied.failureKind, 'plugin-grant');
    assert.equal(requests.length, before, 'revoked inherited plugins must not reach the model');
    await pause(); revoked = false;
    await send(restored, 'clear selection', { clearPluginSelection: true, pluginIds: ['stale'] });
    await send(restored, 'ordinary after clear');
    assert.deepEqual(restored.snapshot().activePlugins, []);
    assert.equal(resolutions.length, 7);
    restored.close();
    const cleared = await open({ ref: 'cleared', resumePath: archive, resumeCwd: cwd });
    assert.deepEqual(cleared.snapshot().activePlugins, []);
    await send(cleared, 'reopened after clear');
    assert.equal(resolutions.length, 7);
    assert.deepEqual(cleanups, executions, 'each issued grant is cleaned once after its tool finishes');
    assert.deepEqual(priorResults, ['', ...executions.slice(0, -1).map(grant => 'PLUGIN-RESULT-' + grant)],
      'each later plugin turn consumes the immediately preceding structured result');
  });
