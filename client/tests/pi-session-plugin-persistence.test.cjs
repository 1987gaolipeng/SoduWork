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
    const hubActions = [];
    const grants = new Set(), archives = new Map();
    let held = null, holdNext = false, revoked = false, generation = false, generated = 0, failNative = false, freezeWrites = false, htmlOnly = false;
    const server = http.createServer((request, response) => {
      let raw = '';
      request.on('data', chunk => { raw += chunk; });
      request.on('end', () => {
        if (request.url.startsWith('/api/v1/tasks/permission-task')) {
          const task = { id: 'permission-task', title: 'Permission change' };
          let result = task;
          if (request.url.endsWith('/attachments')) result = [];
          if (request.url.endsWith('/conversation-turn')) {
            hubActions.push(JSON.parse(raw).action);
            result = { task, turn: { state: 'queued' } };
          }
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(result));
          return;
        }
        const body = JSON.parse(raw); requests.push(body);
        const user = body.messages.findLast(message => message.role === 'user');
        const prompt = JSON.stringify(user?.content || '');
        const grant = /PLUGIN-GRANT-(\d+)/.exec(prompt)?.[1] || (generation
          ? /PLUGIN-GRANT-(\d+)/.exec(JSON.stringify(body.messages.findLast(message =>
            /PLUGIN-GRANT-/.test(JSON.stringify(message.content || '')))?.content || ''))?.[1] : '');
        const textOf = message => typeof message?.content === 'string' ? message.content
          : (Array.isArray(message?.content) ? message.content
            .filter(block => block?.type === 'text').map(block => block.text || '').join('\n') : '');
        const historicalResults = body.messages
          .filter(message => message?.role === 'tool' || message?.role === 'toolResult')
          .map(textOf).filter(Boolean);
        const lastRole = body.messages.at(-1)?.role;
        if (failNative && ['tool','toolResult'].includes(lastRole)) {
          response.writeHead(400, {'content-type':'application/json'});
          response.end(JSON.stringify({error:{message:'Synthetic native generation failure'}}));return;
        }
        const call = grant && !['tool', 'toolResult'].includes(lastRole);
        const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: 'probe-' + grant + (generation ? '-' + requests.length : ''),
          type: 'function', function: { name: 'plugin_probe', arguments: JSON.stringify({ grant,
            ...(generation ? {repair:prompt.includes('<soduwork-internal-plugin-repair>')} : {}),
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
      parameters: { type: 'object', properties: { grant: { type: 'string' }, priorResult: { type: 'string' }, repair: {type:'boolean'} }, required: ['grant'] },
      async execute(_id, args) {
        assert.ok(grants.has(args.grant), 'the tool must have a live grant belonging to this turn');
        const expected = generation && generated === 0 ? undefined : executions.length ? 'PLUGIN-RESULT-' + executions.at(-1) : undefined;
        assert.equal(args.priorResult, expected,
          'a follow-up plugin call must receive the previous turn tool result from native history');
        if (generation && (!freezeWrites || args.repair)) {
          const target = path.join(cwd, 'soduwork-plugin-draft.json');
          generated++;
          if (htmlOnly && !args.repair) {
            fs.writeFileSync(path.join(cwd, 'report.html'), '<!doctype html><h1>Business report</h1>');
            if (htmlOnly === 'manifest') {
              fs.mkdirSync(path.join(cwd, '.soduwork'), { recursive: true });
              fs.writeFileSync(path.join(cwd, '.soduwork/delivery.json'), JSON.stringify({
                schemaVersion: 1, deliverables: [{ path: 'report.html' }],
              }));
            }
          } else fs.writeFileSync(target, generated === 1 ? '{invalid final JSON' : JSON.stringify({
            template:'method', key:'native-gate-fixture', name:'Native fixture', version:'1.0.0',
            description:'Synthetic generation validation', instructions:'Read the supplied material.',
          }));
        }
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

    for (const [title, expectedAction] of [
      ['a task without plugins completes after an in-place permission upgrade', 'complete'],
      ['explicitly stopping an upgraded task still cancels it', 'cancel'],
    ]) await t.test(title, async () => {
      const rules = require('../main/access-control/policy');
      const standard = rules.create('standard', cwd);
      const handle = await open({ ref: 'permission-' + expectedAction, accessPolicy: standard });
      const identity = { hub: new URL(fixtureModel.baseUrl).origin, clientId: 'fixture', secret: 'test-only' };
      const firstAction = hubActions.length;
      const task = await require('../main/pi-session/task-input').prepare(identity, 'permission-task',
        handle.sessionId, 'turn-' + expectedAction, 'Finish the work.', {}, { handle });
      holdNext = true;
      const running = handle.submit(task.text, task.attachments, { taskId: task.task.id,
        beforeTurn: task.beforeTurn, afterTurn: task.afterTurn });
      await until(() => held !== null);
      const release = held;
      held = null;
      let stopping;
      try {
        const upgrade = await handle.setAccessPolicy(rules.next('full', cwd, standard, standard.revision), standard.revision);
        assert.equal(upgrade.ok, true, upgrade.reason);
        assert.equal(upgrade.effective, 'current-turn');
        if (expectedAction === 'cancel') stopping = handle.cancel({ userInitiated: true });
      } finally {
        release();
      }
      await stopping;
      await running.completion;
      assert.deepEqual(hubActions.slice(firstAction), ['prepare', 'start', expectedAction]);
    });

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

    // The actual SDK must repair inside the original grant and logical queue turn.
    generation = true;
    const author = await open({ref:'authoring'}), beforeGrants=resolutions.length;
    const beforeUsers=author.snapshot().messages.filter(message=>message.role==='user').length;
    const result=await author.submit('Generate a synthetic plugin draft',[],{pluginIds:['authoring']}).completion;
    assert.equal(result.ok,true,result.reason);
    assert.equal(generated,2,'one generation and one host-requested repair execute');
    assert.equal(resolutions.length,beforeGrants+1,'repair reuses the live original plugin grant');
    assert.equal(author.snapshot().messages.filter(message=>message.role==='user').length,beforeUsers+1,
      'hidden repair must not create a new user turn');
    const validated=(await author.outputSnapshotAsync()).pluginValidation;
    assert.equal(validated.find(row=>row.relative==='soduwork-plugin-draft.json').state,'ready');
    assert.equal(grants.size,0,'original grant is cleaned after static validation and repair settle');

    // A provider failure exits before finish; finally must still release the gate.
    failNative = true; generated = 0;
    const failing = await open({ref:'failed-authoring'});
    const failed = await failing.submit('Generate then fail natively',[],{pluginIds:['authoring']}).completion;
    assert.equal(require('../main/pi-session/task-turn').resultState(failed),'failed');
    await until(()=>!failing.inFlight());
    const inspected = await require('../main/pi-session/plugin-generation-gate.cjs').inspect({
      handle:failing,snapshot:await failing.outputSnapshotAsync(),
    });
    assert.equal(inspected.find(row=>row.relative==='soduwork-plugin-draft.json')?.state,'invalid',
      'failed native generation must release inspection instead of leaving an active gate');

    // An internal recovery leaves the earlier invalid draft unchanged until the
    // shared logical gate requests its repair inside the recovery's live grant.
    failNative = false; freezeWrites = true;
    const recovered = await failing.send('Synthetic native runtime recovery',[],{
      internal:true,runtimeRecovery:true,pluginIds:['authoring'],
    });
    assert.equal(recovered.ok,true,recovered.reason);
    assert.equal(generated,2,'recovery must gate the original changed draft instead of treating it as old');
    assert.equal((await failing.outputSnapshotAsync()).pluginValidation.find(row=>
      row.relative==='soduwork-plugin-draft.json').state,'ready');
    // Both inferred and explicitly declared one-off HTML results must be
    // repaired through the actual SDK and live grant at authoring completion.
    for (const source of ['inferred', 'manifest']) {
      htmlOnly = source; freezeWrites = false; generated = 0;
      for (const name of ['soduwork-plugin-draft.json', 'report.html', '.soduwork/delivery.json']) fs.rmSync(path.join(cwd, name), { force: true });
      const htmlAuthor = await open({ ref: 'html-authoring-' + source }), htmlGrants = resolutions.length;
      const htmlResult = await htmlAuthor.submit('Make a plugin that produces HTML', [], { pluginIds: ['local:plugin-builder'] }).completion;
      assert.equal(htmlResult.ok, true, htmlResult.reason);
      assert.equal(generated, 2, 'one HTML generation and one missing-package repair execute');
      assert.equal(resolutions.length, htmlGrants + 1, 'missing-package repair retains the original grant');
      assert.equal(htmlAuthor.snapshot().messages.filter(message => message.role === 'user').length, 1);
      assert.equal((await htmlAuthor.outputSnapshotAsync()).pluginValidation.find(row =>
        row.relative === 'soduwork-plugin-draft.json').state, 'ready');
      assert.equal(grants.size, 0);
      assert.match(fs.readFileSync(path.join(cwd, 'report.html'), 'utf8'), /Business report/);
    }
    // Real Pi requests must carry authoring intent even when the visible text
    // only describes the future plugin's business behavior.
    generation = false; executions.length = 0; priorResults.length = 0;
    const featureAuthor = await open({ ref: 'feature-authoring' });
    const latestUserText = () => {
      const content = requests.at(-1).messages.findLast(message => message.role === 'user').content;
      return typeof content === 'string' ? content : content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    };
    const feature = '我给你区域范围、时间、人数和偏好，输出预算、路线和 HTML 旅行计划。';
    for (const [text, options] of [[feature, { pluginIds: ['local:plugin-builder'] }], ['再支持随机推荐', {}]]) {
      await send(featureAuthor, text, options);
      assert.match(latestUserText(), /"authoring":\{"intent":"plugin-authoring"/);
      assert.match(latestUserText(), /changing values.*plugin inputs/);
      assert.equal(require('../main/pi-session/plugin-context').parse(latestUserText()).text, text);
    }
    await send(featureAuthor, '改为普通旅行讨论', { clearPluginSelection: true });
    assert.doesNotMatch(latestUserText(), /"authoring":/);
    assert.doesNotMatch(JSON.stringify(featureAuthor.snapshot().messages), /"authoring":|changing values/);
    await require('../main/app-resource-cache.cjs').close();
  });
