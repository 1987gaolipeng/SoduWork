'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { initialize } = require('../main/pi-session/extension-lifecycle');
const { sessionResources, initializeExtensions } = require('../main/pi-session/session-resources');
const { piProvider } = require('../main/conversation/model-selection');

test('binding is shared once per session; failed initialization cannot replay side effects', async () => {
  let calls = 0, finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const session = { async bindExtensions(bindings) {
    calls++; assert.equal(bindings.uiContext, undefined); assert.equal(bindings.mode, undefined); await gate;
  } };
  const first = initialize(session), second = initialize(session);
  assert.equal(first, second); finish(); await first;
  await initialize(session); assert.equal(calls, 1);
  let failedCalls = 0;
  const broken = { async bindExtensions(bindings) {
    failedCalls++; bindings.onError({ event: 'session_start', error: 'fixture startup failed' });
  } };
  await assert.rejects(initialize(broken), /fixture startup failed/);
  await assert.rejects(initialize(broken), /fixture startup failed/);
  assert.equal(failedCalls, 1);
  await assert.rejects(initialize({ bindExtensions: () => new Promise(() => {}) }, { timeoutMs: 250 }),
    error => error.code === 'EXTENSION_START_TIMEOUT');
});

function putExtension(agentDir, log) {
  const directory = path.join(agentDir, 'extensions'); fs.mkdirSync(directory, { recursive: true });
  // Reproduce deep-research's process.cwd default and module-level singleton.
  // The only correct initialization path is the SDK's session_start hook.
  fs.writeFileSync(path.join(agentDir, 'lifecycle-state.ts'),
    'let value = {cwd:process.cwd(),starts:0}; export function settings(){return value;}');
  fs.writeFileSync(path.join(directory, 'lifecycle.ts'), `import fs from 'node:fs';
import path from 'node:path'; import {settings} from '../lifecycle-state.ts';
export default function(pi) {
  const state = settings();
  pi.on('session_start', async (_event, ctx) => {
    state.cwd = ctx.cwd; state.starts++;
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({cwd:ctx.cwd,starts:state.starts,
      hasUI:ctx.hasUI,confirmed:await ctx.ui.confirm('fixture','No approval UI should be added')})+'\\n');
  });
  pi.registerTool({name:'save_report',label:'Fixture report',description:'Save an isolated report',
    parameters:{type:'object',properties:{markdown:{type:'string'}},required:['markdown']},
    async execute(_id,args) { const target=path.join(state.cwd,'deep-research','reports','fixture-report.md');
      fs.mkdirSync(path.dirname(target),{recursive:true}); fs.writeFileSync(target,args.markdown);
      return {content:[{type:'text',text:'Report saved: '+target}],details:{report_path:target}}; }});
}`);
}

test('real SDK initializes two simultaneous session directories independently and executes reports under each cwd', { timeout: 30000 }, async t => {
  const sdk = await import('../node_modules/@earendil-works/pi-coding-agent/dist/index.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-extension-isolation-'));
  const agentDir = path.join(root, 'agent'), log = path.join(root, 'starts.jsonl');
  const sessions = [], requests = [];
  putExtension(agentDir, log);
  const server = http.createServer((request, response) => {
    let raw = ''; request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw); requests.push(body);
      const isTool = body.messages.at(-1).role !== 'tool';
      const content = body.messages.at(-1).content;
      const markdown = typeof content === 'string' ? content : content.filter(part => part.type === 'text').map(part => part.text).join('');
      const delta = isTool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'report_once', type: 'function',
        function: { name: 'save_report', arguments: JSON.stringify({ markdown }) } }] }
        : { role: 'assistant', content: 'Saved in this session workspace.' };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk',
        choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
      response.end('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: isTool ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  t.after(async () => {
    for (const session of sessions) { await session.abort(); session.dispose(); }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const runtime = await sdk.ModelRuntime.create({ modelsPath: null, authPath: path.join(root, 'auth.json'), modelsStorePath: path.join(root, 'models.db') });
  runtime.registerProvider('lifecycle-fixture', piProvider({ id: 'lifecycle-fixture', key: 'isolated-fixture',
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', contextWindow: 32000 }));
  const originalCwd = process.cwd();
  const workspaces = await Promise.all(['one', 'two'].map(async name => {
    const cwd = path.join(root, name); fs.mkdirSync(cwd);
    const resources = await sessionResources(sdk, cwd, agentDir, [], [], { noExtensions: false });
    resources.settingsManager.applyOverrides({ compaction: { enabled: false }, retry: { enabled: false } });
    const { session } = await sdk.createAgentSession({ cwd, agentDir, modelRuntime: runtime,
      model: runtime.getModel('lifecycle-fixture', 'lifecycle-fixture'), resourceLoader: resources.resourceLoader,
      settingsManager: resources.settingsManager, sessionManager: sdk.SessionManager.inMemory(cwd), tools: ['save_report'] });
    sessions.push(session);
    await Promise.all([initializeExtensions(session, resources), initializeExtensions(session, resources)]);
    return { session, cwd, name };
  }));
  const starts = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(starts.map(row => row.cwd).sort(), workspaces.map(row => row.cwd).sort());
  assert.ok(starts.every(row => row.starts === 1 && !row.hasUI && row.confirmed === false));
  assert.equal(process.cwd(), originalCwd, 'no process-global cwd mutation');
  await Promise.all(workspaces.map(({ session, name }) => session.prompt('report-' + name)));
  assert.equal(requests.length, 4, 'one real tool execution plus one final response per session');
  for (const { cwd, name } of workspaces) {
    assert.equal(fs.readFileSync(path.join(cwd, 'deep-research/reports/fixture-report.md'), 'utf8'), 'report-' + name);
  }
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 2, 'normal turns do not restart extensions');
});

test('production fresh open, deferred history activation and permission rebuild bind startup exactly once', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-extension-production-'));
  const fixture = await require('../e2e/fixtures/resumed-pi.cjs').create(root);
  const log = path.join(root, 'starts.jsonl'); putExtension(fixture.agentDir, log);
  const rules = require('../main/access-control/policy');
  const handles = [];
  t.after(async () => { handles.forEach(handle => handle.close()); await fixture.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const count = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').length : 0;
  fixture.reply(body => body.messages.at(-1).role === 'tool' ? { text: '已完成保存。' }
    : { tool: 'save_report', args: { markdown: 'Lifecycle report' } });
  const fresh = await fixture.open({ resumePath: undefined, ephemeral: true, noExtensions: false }); handles.push(fresh);
  assert.equal(count(), 1, 'fresh session initializes before its first prompt');
  assert.equal((await fresh.submit('保存测试报告。').completion).ok, true);
  assert.equal(count(), 1);
  assert.equal(fs.readFileSync(path.join(fixture.cwd, 'deep-research/reports/fixture-report.md'), 'utf8'), 'Lifecycle report');
  fresh.close();

  const standard = rules.create('standard', fixture.cwd);
  const restored = await fixture.open({ accessPolicy: standard }); handles.push(restored);
  assert.equal(count(), 1, 'opening standard history must not start disabled extensions');
  fixture.reply(() => ({ text: '普通说明。' }));
  assert.equal((await restored.submit('解释一下。').completion).ok, true);
  assert.equal(count(), 1);
  assert.equal((await restored.setAccessPolicy(rules.next('full', fixture.cwd, standard, 1), 1)).ok, true);
  assert.equal((await restored.submit('继续解释。').completion).ok, true);
  assert.equal(count(), 2, 'deferred full resources initialize when activated');
  const full = restored.snapshot().accessPolicy;
  assert.equal((await restored.setAccessPolicy(rules.next('readonly', fixture.cwd, full, full.revision), full.revision)).ok, true);
  assert.equal((await restored.submit('只读说明。').completion).ok, true);
  assert.equal(count(), 2, 'readonly rebuilt session cannot start disabled extensions');
  const readonly = restored.snapshot().accessPolicy;
  assert.equal((await restored.setAccessPolicy(rules.next('full', fixture.cwd, readonly, readonly.revision), readonly.revision)).ok, true);
  assert.equal((await restored.submit('恢复说明。').completion).ok, true);
  assert.equal(count(), 3, 'each newly activated extension runtime initializes once');
  const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.every(row => row.cwd === fixture.cwd && !row.hasUI && row.confirmed === false));
  assert.ok(fs.readFileSync(fixture.resumePath, 'utf8').startsWith(fixture.archivePrefix));
});

test('a failed real startup never sends a model request and history can retry on a fresh runtime', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-extension-start-failure-'));
  const fixture = await require('../e2e/fixtures/resumed-pi.cjs').create(root);
  const broken = path.join(fixture.agentDir, 'extensions', 'broken.ts');
  fs.writeFileSync(broken, `export default function(pi) {
    pi.on('session_start', () => { throw Error('fixture session initialization failed'); });
  }`);
  t.after(async () => { await fixture.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await assert.rejects(fixture.open({ resumePath: undefined, ephemeral: true, noExtensions: false }),
    /fixture session initialization failed/);
  const restored = await fixture.open();
  const failed = await restored.submit('继续。').completion;
  assert.equal(failed.ok, false);
  assert.equal(failed.failureKind, 'session-resources');
  assert.match(failed.reason, /fixture session initialization failed/);
  assert.equal(fixture.requests.length, 0);
  assert.ok(fs.readFileSync(fixture.resumePath, 'utf8').startsWith(fixture.archivePrefix));
  fs.unlinkSync(broken);
  fixture.reply(() => ({ text: '恢复后完成。' }));
  assert.equal(restored.updateQueue('', 'resume').ok, true);
  assert.equal((await restored.submit('重试。').completion).ok, true);
  assert.equal(fixture.requests.length, 1);
});
