'use strict';
// Real production session driver, Pi SDK, loopback provider and filesystem.
// Only model configuration and private storage are injected; tool construction,
// permission transitions, approval hooks and command execution remain real.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');

async function fixture(t, defaultTools, extension = false) {
  const sdk = await import('../node_modules/@earendil-works/pi-coding-agent/dist/index.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-readonly-upgrade-'));
  const cwd = path.join(root, 'workspace'), agentDir = path.join(root, 'agent');
  fs.mkdirSync(cwd); fs.mkdirSync(agentDir);
  const extensionOutput = path.join(cwd, 'extension-output.txt');
  if (extension) {
    fs.mkdirSync(path.join(agentDir, 'extensions'));
    fs.writeFileSync(path.join(agentDir, 'extensions/fixture.ts'), `import fs from 'node:fs';
export default function(pi) {
  pi.registerTool({name:'fixture_extension',label:'Fixture extension',description:'Write isolated test evidence',
    parameters:{type:'object',properties:{}},async execute() {
      fs.writeFileSync(${JSON.stringify(extensionOutput)}, 'EXTENSION-OK');
      return {content:[{type:'text',text:'Extension complete.'}],details:{}};
    }});
}`);
  }
  const requests = [], sessions = [];
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', data => { raw += data; });
    request.on('end', () => {
      const body = JSON.parse(raw), last = body.messages.at(-1);
      requests.push(body);
      let operation;
      if (last.role === 'user') {
        const text = typeof last.content === 'string' ? last.content : last.content.map(block => block.text || '').join('');
        try { operation = JSON.parse(text); } catch (_) { /* Follow-up control messages need no extra tools. */ }
      }
      const delta = operation ? { role: 'assistant', tool_calls: [{ index: 0, id: 'upgrade-' + requests.length,
        type: 'function', function: { name: operation.tool, arguments: JSON.stringify(operation.args) } }] }
        : { role: 'assistant', content: 'Operation finished.' };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [value, finish] of [[delta, null], [{}, operation ? 'tool_calls' : 'stop']]) {
        response.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture',
          choices: [{ index: 0, delta: value, finish_reason: finish }] }) + '\n\n');
      }
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const session of sessions) await session.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const model = { id: 'fixture', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
    key: 'local-fixture', contextWindow: 32000 };
  const runtime = await sdk.ModelRuntime.create({ modelsPath: null, authPath: path.join(root, 'auth.json'),
    modelsStorePath: path.join(root, 'models.db') });
  runtime.registerProvider('soduwork', require('../main/conversation/model-selection').piProvider(model));
  t.mock.method(require('../main/pi-session/model-config'), 'prepare', async () => ({ ok: true, agentDir, provider: 'soduwork', model }));
  t.mock.method(require('../main/pi-session/sdk-loader'), 'load', async () => ({ ...sdk,
    ModelRuntime: { create: async () => runtime },
    createAgentSession: args => sdk.createAgentSession({ ...args,
      sessionManager: args.sessionManager || sdk.SessionManager.create(cwd, path.join(agentDir, 'sessions')) }),
  }));
  const resources = require('../main/pi-session/session-resources'), load = resources.sessionResources;
  t.mock.method(resources, 'sessionResources', async (...args) => {
    const result = await load(...args);
    result.settingsManager.applyOverrides({ compaction: { enabled: false }, retry: { enabled: false },
      ...(defaultTools ? { defaultTools } : {}) });
    return result;
  });
  // Require the driver after replacing its injected construction boundaries.
  delete require.cache[require.resolve('../main/pi-session/session')];
  const rules = require('../main/access-control/policy');
  const driver = require('../main/pi-session/session');
  const openOptions = { app: { getPath: () => root }, identity: {}, cwd, ref: 'readonly-upgrade-fixture' };
  const opened = await driver.open({ ...openOptions, accessPolicy: rules.create('readonly', cwd) });
  assert.equal(opened.ok, true, opened.reason);
  let session = opened.session; sessions.push(session);
  const reopen = async () => {
    const resumePath = session.resumeLocation(), id = session.sessionId;
    await session.close();
    const result = await driver.open({ ...openOptions, resumePath, resumeCwd: cwd, noExtensions: true });
    assert.equal(result.ok, true, result.reason);
    session = result.session; sessions.push(session);
    assert.equal(session.sessionId, id);
  };
  const send = async (tool, args) => {
    const result = await session.submit(JSON.stringify({ tool, args })).completion;
    assert.equal(result.ok, true, result.reason);
    return result;
  };
  const change = async mode => {
    const previous = session.snapshot().accessPolicy;
    const result = await session.setAccessPolicy(rules.next(mode, cwd, previous, previous.revision), previous.revision);
    assert.equal(result.ok, true, result.reason);
    assert.equal(session.snapshot().accessPolicy.mode, mode);
  };
  const tools = () => (requests.findLast(body => body.messages.at(-1)?.role === 'user').tools || []).map(tool => tool.function.name);
  return { root, cwd, extensionOutput, get session() { return session; }, requests, send, change, tools, reopen };
}

test('readonly to standard restores real writes and approved commands; later readonly removes them again', { timeout: 30000 }, async t => {
  const f = await fixture(t), sid = f.session.sessionId;
  await f.send('write', { path: 'blocked.txt', content: 'not permitted' });
  assert.equal(fs.existsSync(path.join(f.cwd, 'blocked.txt')), false);
  assert.ok(!f.tools().includes('write'));
  await f.change('standard');
  await f.send('write', { path: 'writable.txt', content: 'STANDARD-WRITE-OK' });
  assert.equal(fs.readFileSync(path.join(f.cwd, 'writable.txt'), 'utf8'), 'STANDARD-WRITE-OK');
  const commandTool = f.tools().includes('execute') ? 'execute' : 'bash';
  assert.ok(f.tools().includes(commandTool));
  const running = f.send(commandTool, { command: 'printf STANDARD-COMMAND-OK > executed.txt', timeout: 5 });
  const deadline = Date.now() + 5000;
  let pending;
  while (!(pending = f.session.snapshot().pendingPermissions?.[0]) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(pending, 'standard mode still requires command approval');
  assert.equal(fs.existsSync(path.join(f.cwd, 'executed.txt')), false);
  assert.equal(f.session.answerUi({ ...pending, decision: 'once' }).ok, true);
  await running;
  assert.equal(fs.readFileSync(path.join(f.cwd, 'executed.txt'), 'utf8'), 'STANDARD-COMMAND-OK');
  await f.change('readonly');
  await f.send('write', { path: 'blocked-again.txt', content: 'not permitted' });
  assert.equal(fs.existsSync(path.join(f.cwd, 'blocked-again.txt')), false);
  assert.ok(!f.tools().includes('write') && !f.tools().includes('execute') && !f.tools().includes('bash'));
  await f.change('full');
  const external = path.join(f.root, 'full-write.txt');
  await f.send('write', { path: external, content: 'FULL-WRITE-OK' });
  assert.equal(fs.readFileSync(external, 'utf8'), 'FULL-WRITE-OK');
  assert.equal(f.session.sessionId, sid, 'all transitions retain the same conversation');
  assert.ok(f.session.snapshot().messages.filter(message => message.role === 'user').length >= 5);
});

test('leaving readonly respects an explicitly restricted configured default tool set', { timeout: 30000 }, async t => {
  const f = await fixture(t, ['read', 'grep']);
  await f.send('write', { path: 'before.txt', content: 'not enabled' });
  await f.change('standard');
  await f.send('write', { path: 'after.txt', content: 'not enabled' });
  assert.equal(fs.existsSync(path.join(f.cwd, 'after.txt')), false);
  assert.deepEqual(f.tools().sort(), ['grep', 'read'], 'a permission change must not override configured tool exclusions');
});

for (const mode of ['standard', 'full']) {
  test('reopening an unprompted upgrade to ' + mode + ' retains writable tools and conversation history', { timeout: 30000 }, async t => {
    const f = await fixture(t);
    await f.send('write', { path: 'blocked.txt', content: 'blocked' });
    await f.change(mode);
    await f.reopen();
    assert.equal(f.session.snapshot().accessPolicy.mode, mode);
    await f.send('write', { path: 'resumed.txt', content: 'RESUMED-WRITE-OK' });
    assert.equal(fs.readFileSync(path.join(f.cwd, 'resumed.txt'), 'utf8'), 'RESUMED-WRITE-OK');
    assert.ok(f.session.snapshot().messages.filter(message => message.role === 'user').length >= 2);
    await f.reopen();
    await f.send('write', { path: 'resumed-again.txt', content: 'RECORDED-WRITE-OK' });
    assert.equal(fs.readFileSync(path.join(f.cwd, 'resumed-again.txt'), 'utf8'), 'RECORDED-WRITE-OK');
  });
}

test('an explicit empty default tool set remains empty after upgrade, activation and reopening', { timeout: 30000 }, async t => {
  const f = await fixture(t, []);
  await f.send('write', { path: 'blocked.txt', content: 'blocked' });
  await f.change('full');
  await f.reopen();
  await f.send('write', { path: 'still-blocked.txt', content: 'blocked' });
  assert.equal(fs.existsSync(path.join(f.cwd, 'still-blocked.txt')), false);
  assert.deepEqual(f.tools(), []);
});

test('full access still activates new extension tools after the readonly tool selection is repaired', { timeout: 30000 }, async t => {
  const f = await fixture(t, undefined, true);
  await f.send('fixture_extension', {});
  assert.equal(fs.existsSync(f.extensionOutput), false);
  await f.change('full');
  await f.send('fixture_extension', {});
  assert.ok(f.tools().includes('write') && f.tools().includes('fixture_extension'));
  assert.equal(fs.readFileSync(f.extensionOutput, 'utf8'), 'EXTENSION-OK');
});

for (const defaults of [[], ['read', 'grep']]) {
  test('upgrading before the first prompt preserves configured tool exclusions: ' + JSON.stringify(defaults), { timeout: 30000 }, async t => {
    const f = await fixture(t, defaults);
    await f.change('standard');
    await f.send('write', { path: 'excluded.txt', content: 'blocked' });
    assert.equal(fs.existsSync(path.join(f.cwd, 'excluded.txt')), false);
    assert.deepEqual(f.tools().sort(), defaults.slice().sort());
  });
}

test('unrecorded upgrades follow the active branch and survive successive policy changes', () => {
  const { unrecordedUpgrade } = require('../main/access-control/pi-tool-selection');
  const policy = mode => ({ type: 'custom', customType: 'soduwork.access.policy', data: { mode } });
  const declaration = { type: 'message', message: { role: 'system', toolsAdded: [{ name: 'read' }] } };
  const branch = [policy('readonly'), declaration, policy('standard'), policy('full'),
    { type: 'message', message: { role: 'system', content: 'A prompt update without tool changes.' } }];
  const manager = { getBranch: () => branch, getEntries: () => [...branch, declaration] };
  assert.equal(unrecordedUpgrade(manager), true, 'unrelated branches and plain system text do not record a tool choice');
  branch.push(declaration);
  assert.equal(unrecordedUpgrade(manager), false, 'a later recorded tool choice must remain authoritative');
  branch.push(policy('readonly'));
  assert.equal(unrecordedUpgrade(manager), false, 'a later downgrade never enables writable defaults');
});
