'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const personal = require('../main/personal-plugins');
const core = require('../main/personal-plugin-debug');
const debugIpc = require('../main/personal-plugin-debug-ipc');
const grant = require('../main/pi-session/plugin-grant');
function identity(uid = 'alice', hub = 'https://example.invalid') {
  const iat = Math.floor(Date.now() / 1000);
  return { hub, clientId: 'device', session: Buffer.from(JSON.stringify({ typ: 'device', uid, cid: 'device', iat, exp: iat + 3600 })).toString('base64url') + '.' + 'a'.repeat(64) };
}
function setup(t, createExecutor) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-debug-ipc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root, isPackaged: false }, methods = new Map(), submissions = [];
  const cwd = path.join(root, 'workspace'); fs.mkdirSync(cwd);
  const plugin = personal.create(app, { template: 'workflow', key: 'ipc-demo', name: '验证简报', description: '验证本机简报流程',
    version: '1.0.0', instructions: '输出简报后等待人工检查。', inputs: [{ key: 'format', type: 'select', label: '格式', required: true, options: ['md', 'txt'] }] }).plugin;
  const handle = { ref: 'chat-test', sessionId: 'conversation-test', adapterId: 'pi', cwd,
    attachedWindow: { isDestroyed: () => false, webContents: { id: 7 } },
    snapshot: () => ({ messages: [{ role: 'user', text: '不能丢失的原始需求' }] }),
    submit: (text, files, options) => { submissions.push({ text, files, options }); return { accepted: true, completion: new Promise(() => {}) }; },
    pluginDebugChanged() {}, appendTaskMessage() {} };
  let currentIdentity = identity();
  const install = () => debugIpc.install({ app, ipcMain: { handle: (key, method) => methods.set(key, method) },
    session: { get: ref => ref === handle.ref ? handle : null }, skillDirs: () => [], deviceGrants: () => [],
    managedInputsRoot: () => path.join(root, 'temp'), identityOf: async () => currentIdentity,
    ...(createExecutor ? { createExecutor } : {}) });
  const guard = install();
  const call = (options, id = 7) => methods.get('personal-plugin-debug')({ sender: { id } }, handle.ref, options);
  return { app, root, cwd, plugin, handle, submissions, guard, install, call, setIdentity: value => { currentIdentity = value; } };
}
const request = plugin => ({ command: 'start', pluginId: plugin.pluginId, requestId: 'e2e-debug-request-0001',
  prompt: '验证插件节点', parameters: { format: 'md' } });

test('conversation workflow receives the exact long original request before node preprocessing', async t => {
  const f = setup(t), raw = '  /需求 #1\r\n' + '原文'.repeat(900) + '\n  ';
  const result = await f.guard.submitConversation(f.handle, raw, [], { submissionId: 'original-source-request-0001' },
    [{ pluginId: f.plugin.pluginId, inputValues: { format: 'txt' } }]);
  assert.equal(result.accepted, true);
  const record = core.store(path.join(f.root, 'plugin-debug-runs'), f.handle.sessionId).read();
  assert.equal(record.userText, raw);
  assert.ok(record.prompt.startsWith(raw));
});
test('IPC is scoped to the owning conversation window, even for read requests', async t => {
  const f = setup(t);
  const result = await f.call({ command: 'get' }, 8);
  assert.equal(result.ok, false); assert.match(result.reason, /当前打开的对话/);
  assert.equal(f.guard.guard(f.handle), '');
});
test('debug creation is idempotent and creates no backend task or second conversation', async t => {
  const f = setup(t);
  const first = await f.call(request(f.plugin));
  assert.equal(first.ok, true, first.reason);
  const second = await f.call(request(f.plugin));
  assert.equal(second.run.id, first.run.id);
  assert.equal(f.submissions.length, 1);
  assert.equal(f.submissions[0].options.taskId, undefined);
  assert.equal(f.submissions[0].options.pluginDebug, true);
  const stored = core.store(path.join(f.root, 'plugin-debug-runs'), f.handle.sessionId).read();
  assert.match(stored.prompt, /不能丢失的原始需求/);
  assert.match(stored.prompt, /"format":"md"/);
});
test('debug context carries completed tool results into the plugin prompt as evidence', async t => {
  const f = setup(t);
  f.handle.snapshot = () => ({
    messages: [{ role: 'user', text: 'Use the previous result' }],
    tools: [{ name: 'plugin_probe', state: 'done', after: 0,
      result: { content: [{ type: 'text', text: 'PLUGIN-RESULT-IPC' }] } }],
  });
  const result = await f.call(request(f.plugin));
  assert.equal(result.ok, true, result.reason);
  const stored = core.store(path.join(f.root, 'plugin-debug-runs'), f.handle.sessionId).read();
  assert.match(stored.prompt, /PLUGIN-RESULT-IPC/);
  assert.match(stored.prompt, /untrusted/);
});
test('invalid public parameters fail before queueing or creating a journal', async t => {
  const f = setup(t);
  const result = await f.call({ ...request(f.plugin), parameters: {} });
  assert.equal(result.ok, false); assert.match(result.reason, /格式/);
  assert.equal(f.submissions.length, 0);
  assert.equal(core.store(path.join(f.root, 'plugin-debug-runs'), f.handle.sessionId).read(), null);
});
test('clipboard binary attachments and history files are retained with hashes', async t => {
  const f = setup(t), file = path.join(f.cwd, '原始材料.txt');
  fs.writeFileSync(file, '原始内容');
  f.handle.snapshot = () => ({ messages: [{ role: 'user', text: '分析附件',
    attachments: [{ name: '原始材料.txt', previewRef: require('../main/pi-session/attachment-contract').previewRef(file) }] }] });
  const result = await f.call({ ...request(f.plugin), attachments: [{ name: '截图.png', type: 'image/png', data: new Uint8Array([1, 2, 3]) }] });
  assert.equal(result.ok, true, result.reason);
  const stored = core.store(path.join(f.root, 'plugin-debug-runs'), f.handle.sessionId).read();
  assert.equal(stored.attachments.length, 2);
  for (const item of stored.attachments) {
    assert.ok(fs.existsSync(path.join(f.cwd, item.path)));
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(stored.attachments[0].type, 'image/png');
});
test('after main-process restart, unfinished debug requires explicit recovery; cancel unblocks ordinary chat', async t => {
  const f = setup(t), created = await f.call(request(f.plugin));
  const guard = f.install();
  assert.match(guard.guard(f.handle), /未恢复/);
  const result = await f.call({ command: 'get' });
  assert.equal(result.recoverable, true);
  assert.equal(f.submissions.length, 1);
  const cancelled = await f.call({ command: 'cancel', runId: created.run.id, revision: result.run.revision });
  assert.equal(cancelled.ok, true, cancelled.reason);
  assert.equal(cancelled.run.status, 'cancelled');
  assert.equal(guard.guard(f.handle), '');
  assert.equal(f.submissions.length, 1);
});
test('explicit cancellation after worker loss releases the parent callback only after node stop is confirmed', async t => {
  let lost = false, stopped = false, stopConfirmed = false;
  const gone = () => Object.assign(Error('isolated runtime exited'), { code: 'RUNTIME_PROCESS_GONE' });
  const f = setup(t, () => ({
    executeNode: async node => { node.ref = 'workflow-pi:lost-child'; node.dispatched = true; lost = true; throw gone(); },
    stopNode: async () => { if (!stopConfirmed) throw Error('node cleanup not confirmed'); stopped = true; },
  }));
  const snapshot = f.handle.snapshot;
  f.handle.snapshot = () => ({ ...snapshot(), runtimeUnavailable: lost });
  f.handle.pluginDebugChanged = () => { if (lost) throw gone(); };
  const created = await f.call(request(f.plugin));
  const executing = f.submissions[0].options.controlled.execute();
  executing.catch(() => {});
  const journal = core.store(path.join(f.root, 'plugin-debug-runs'), f.handle.sessionId);
  for (let i = 0; i < 50 && journal.read()?.status !== 'failed'; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(journal.read().status, 'failed');
  const cancel = () => f.call({ command: 'cancel', runId: created.run.id, revision: journal.read().revision });
  const unresolved = await cancel();
  assert.equal(unresolved.ok, false); assert.match(unresolved.reason, /cleanup not confirmed/);
  assert.equal(journal.read().status, 'failed'); assert.equal(stopped, false);
  stopConfirmed = true;
  const cancelled = await cancel();
  assert.equal(cancelled.ok, true, cancelled.reason);
  assert.equal(cancelled.run.status, 'cancelled'); assert.equal(stopped, true);
  await assert.rejects(executing, { code: 'RUNTIME_PROCESS_GONE' });
  assert.equal(f.guard.guard(f.handle), ''); assert.equal(f.submissions.length, 1);
});
test('public parameter types preserve false and zero; reject unexpected options', () => {
  const fields = [{ key: 'enabled', label: '启用', type: 'boolean', required: true },
    { key: 'count', label: '数量', type: 'number', required: true }];
  assert.deepEqual(core.inputValues(fields, { enabled: false, count: 0 }), { enabled: false, count: 0 });
  assert.throws(() => core.inputValues(fields, { enabled: 'true', count: 0 }), /格式/);
  assert.throws(() => core.inputValues(fields, { enabled: true, count: Infinity }), /格式/);
  assert.throws(() => core.inputValues(fields, { enabled: true, count: 2, secret: 'bad' }), /未声明/);
});
test('debug node MCP grant is restricted to the declared subset', async t => {
  const f = setup(t);
  const plugin = personal.create(f.app, { template: 'connector', name: '最小授权', version: '1.0.0',
    description: '只使用一个连接', instructions: '读取目标系统', mcpServers: ['oa', 'crm'] }).plugin;
  let requested;
  const value = await grant.resolve({ app: f.app, pluginIds: [plugin.pluginId], personalMcpServers: ['oa'],
    identityOf: async () => ({ hub: 'https://example.invalid', clientId: 'device', session: 'test-only' }),
    fetchImpl: async (_url, options) => {
      requested = JSON.parse(options.body);
      return { ok: true, json: async () => ({ ok: true, items: [], mcpGrant: { ticket: 'fixture-ticket', servers: ['oa'] } }) };
    } });
  assert.deepEqual(requested.personalMcpServers, ['oa']);
  assert.doesNotMatch(value.grant.guide, /fixture-ticket/);
  value.grant.cleanup();
  await assert.rejects(grant.resolve({ app: f.app, pluginIds: [plugin.pluginId], personalMcpServers: ['unknown'] }), /未声明/);
});
test('a paused conversation cannot silently accept an unstartable debug run', async t => {
  const f = setup(t);
  f.handle.snapshot = () => ({ messages: [], execution: { turnQueue: { paused: true } } });
  const result = await f.call(request(f.plugin));
  assert.equal(result.ok, false); assert.match(result.reason, /队列已暂停/);
  assert.equal(f.submissions.length, 0);
  const pending = await f.call({ command: 'get' });
  assert.equal(pending.recoverable, true);
});
test('ordinary conversation relative attachment references survive a second debug run', async t => {
  const f = setup(t), dir = path.join(f.cwd, '.soduwork-inputs');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'source.txt'), 'FACT-0907');
  f.handle.snapshot = () => ({ messages: [{ role: 'user', text: '请阅读原始资料',
    attachments: [{ name: 'source.txt', previewRef: require('../main/pi-session/attachment-contract').previewRef('.soduwork-inputs/source.txt') }] }] });
  const result = await f.call(request(f.plugin));
  assert.equal(result.ok, true, result.reason);
  const stored = core.store(path.join(f.root, 'plugin-debug-runs'), f.handle.sessionId).read();
  assert.equal(stored.attachments.length, 1);
  assert.equal(fs.readFileSync(path.join(f.cwd, stored.attachments[0].path), 'utf8'), 'FACT-0907');
});

test('relative history references cannot escape the owning conversation workspace', async t => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.root, 'outside.txt'), 'not an authorized attachment');
  f.handle.snapshot = () => ({ messages: [{ role: 'user',
    attachments: [{ name: 'outside.txt', previewRef: require('../main/pi-session/attachment-contract').previewRef('../outside.txt') }] }] });
  const result = await f.call(request(f.plugin));
  assert.equal(result.ok, false);
  assert.match(result.reason, /历史附件无法安全定位/);
  assert.equal(f.submissions.length, 0);
  assert.equal(core.store(path.join(f.root, 'plugin-debug-runs'), f.handle.sessionId).read(), null);
});

test('debug IPC waits for asynchronous queue admission while retaining the independent completion', async t => {
  const f = setup(t);
  let entering, admit, complete;
  const entered = new Promise(resolve => { entering = resolve; });
  const admission = new Promise(resolve => { admit = resolve; });
  const completion = new Promise(resolve => { complete = resolve; });
  f.handle.submit = (...args) => { f.submissions.push(args); entering(); return admission; };
  let replied = false;
  const pending = f.call(request(f.plugin)).then(value => { replied = true; return value; });
  await entered; assert.equal(replied, false);
  admit({ accepted: true, completion });
  const result = await pending;
  assert.equal(result.ok, true, result.reason); assert.equal(result.recoverable, false);
  assert.equal(f.submissions.length, 1);
  complete({ ok: true }); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.call({ command: 'get' })).recoverable, true);
});

test('a remote queue rejection releases the debug submission lock for explicit recovery', async t => {
  const f = setup(t);
  f.handle.submit = async () => ({ accepted: false, result: { ok: false } });
  const rejected = await f.call(request(f.plugin));
  assert.equal(rejected.ok, false); assert.match(rejected.reason, /未能进入/);
  assert.equal((await f.call({ command: 'get' })).recoverable, true);
});


test('ordinary explicit workflow use dispatches once; inherited selection never starts a flow', async t => {
  const f = setup(t), opts = { submissionId: 'conversation-send-0001' };
  const selection = [{ pluginId: f.plugin.pluginId, inputValues: { format: 'txt' } }];
  assert.equal(await f.guard.submitConversation(f.handle, '继续', [], opts, []), null);
  const first = await f.guard.submitConversation(f.handle, '完成汇总', [], opts, selection);
  assert.equal(first.accepted, true); assert.equal(first.workflowRun.mode, 'conversation');
  assert.equal(f.submissions.length, 1);
  assert.equal(f.submissions[0].options.controlled.execute instanceof Function, true);
  const stored = core.store(path.join(f.root, 'plugin-debug-runs'), f.handle.sessionId).read();
  assert.match(stored.prompt, /不能丢失的原始需求/);
  assert.equal(stored.parameters.format, 'txt'); assert.equal(stored.userText, '完成汇总');
  await f.guard.submitConversation(f.handle, '完成汇总', [], opts, selection);
  assert.equal(f.submissions.length, 1);
  await assert.rejects(f.guard.submitConversation(f.handle, '新工作', [], { submissionId: 'conversation-send-0002' }, selection), /已有协作/);
});

test('resumed legacy workflow badges use accepted record identity and debug mode adds no selection badge', async t => {
  for (const mode of ['conversation', 'debug']) {
    const f = setup(t, () => ({ preflight: async () => ({ ok: true }), stopNode: async () => {} }));
    const result = await f.call({ ...request(f.plugin), mode });
    assert.equal(result.ok, true, result.reason);
    const journal = core.store(path.join(f.root, 'plugin-debug-runs'), f.handle.sessionId);
    const record = journal.read();
    delete record.plugins;
    record.name = 'Accepted legacy name'; record.version = '0.9.0';
    record.nodes.forEach(node => { node.status = 'completed'; });
    journal.write(record);
    f.install();
    const announced = [];
    f.handle.appendTaskMessage = (...args) => announced.push(args);
    const resumed = await f.call({ command: 'resume', runId: record.id, revision: record.revision });
    assert.equal(resumed.ok, true, resumed.reason);
    await f.submissions.at(-1).options.controlled.execute();
    const user = announced.find(args => args[0] === 'user');
    assert.deepEqual(user[7], mode === 'conversation' ? [{ pluginId: f.plugin.pluginId,
      name: 'Accepted legacy name', version: '0.9.0', scopeLabel: '仅自己' }] : []);
  }
});
test('read, action and resumed dispatch all require the original account and service', async t => {
  const f = setup(t); const started = await f.call(request(f.plugin)); assert.equal(started.ok, true);
  for (const changed of [identity('bob'), identity('alice', 'https://other.invalid')]) {
    f.setIdentity(changed);
    assert.equal((await f.call({ command: 'get' })).ok, false);
    assert.equal((await f.call({ command: 'cancel', runId: started.run.id, revision: started.run.revision })).ok, false);
    await assert.rejects(f.submissions[0].options.controlled.execute(), /另一个账号或服务/);
  }
  f.setIdentity(identity()); assert.equal((await f.call({ command: 'get' })).ok, true);
});
test('durable request receipt still prevents replay after another run and main-process restart', async t => {
  const f = setup(t), first = await f.call(request(f.plugin));
  await f.call({ command: 'cancel', runId: first.run.id, revision: first.run.revision });
  const second = await f.call({ ...request(f.plugin), requestId: 'e2e-debug-request-0002' });
  assert.equal(second.ok, true);
  f.install();
  const replay = await f.call(request(f.plugin));
  assert.equal(replay.run.id, first.run.id); assert.equal(replay.duplicate, true);
  assert.equal(f.submissions.length, 2);
});

test('resume uses a fresh queue receipt after an interrupted admission without replaying a start', async t => {
  const f = setup(t), queue = require('../main/pi-session/turn-queue').createTurnQueue();
  f.handle.submit = (text, attachments, options) => {
    const item = queue.add({ text, attachments, options });
    f.submissions.push(item);
    return { accepted: true, completion: item.completion };
  };
  const started = await f.call(request(f.plugin));
  f.setIdentity(identity('bob'));
  const first = queue.take();
  const failed = await queue.run(first, () => first.options.controlled.execute());
  assert.equal(failed.ok, false);
  f.setIdentity(identity()); queue.resume();
  const before = await f.call({ command: 'get' }); assert.equal(before.recoverable, true);
  const recovered = await f.call({ command: 'resume', runId: started.run.id, revision: before.run.revision });
  assert.equal(recovered.ok, true, recovered.reason);
  assert.equal(f.submissions.length, 2);
  assert.notEqual(f.submissions[0].options.submissionId, f.submissions[1].options.submissionId);
  assert.equal(queue.size(), 1);
  const duplicate = await f.call(request(f.plugin));
  assert.equal(duplicate.duplicate, true); assert.equal(f.submissions.length, 2);
  await f.call({ command: 'cancel', runId: started.run.id, revision: recovered.run.revision });
});

test('queued collaboration freezes the latest conversation only when its turn starts', async t => {
  const observed = [];
  const f = setup(t, () => ({ preflight: async () => ({ ok: true }), stopNode: async () => {},
    executeNode: async (_node, _inputs, record) => { observed.push(record.prompt); return [{ key: 'result', kind: 'evidence', text: 'done' }]; } }));
  const plugin = personal.create(f.app, { ...f.plugin.localDraft, version: '1.0.1', workflow: { nodes: [
    { key: 'work', name: '执行', type: 'ai', outputs: [{ key: 'result', kind: 'evidence' }], config: { prompt: '回答当前问题' } },
    { key: 'done', name: '完成', type: 'publish', dependsOn: ['work'], outputs: [] },
  ] } }).plugin;
  const messages = [{ role: 'user', text: '起初要求：绿色网页' }];
  f.handle.snapshot = () => ({ messages });
  const first = await f.guard.submitConversation(f.handle, '按刚才要求接力', [],
    { submissionId: 'queued-workflow-context-01' }, [{ pluginId: plugin.pluginId, inputValues: { format: 'md' } }]);
  assert.equal(first.accepted, true);
  messages.push({ role: 'assistant', text: '前一轮最终结果：改用蓝色网页', sourceAgent: { agentId: 'opencode' } });
  await f.submissions[0].options.controlled.execute();
  const stored = core.store(path.join(f.root, 'plugin-debug-runs'), f.handle.sessionId).read();
  assert.match(observed[0], /OpenCode：前一轮最终结果：改用蓝色网页/);
  assert.equal(stored.contextFrozen, true); assert.equal(stored.status, 'completed');
  messages.push({ role: 'assistant', text: '之后无关的输出' });
  await f.submissions[0].options.controlled.execute();
  assert.equal(observed.length, 1, 'completed control replay never starts another node');
  assert.doesNotMatch(core.store(path.join(f.root, 'plugin-debug-runs'), f.handle.sessionId).read().prompt, /之后无关/);
});
 test('large conversations retain recent clarification and a verified full reference without blocking', async t => {
  const f = setup(t);
  f.handle.snapshot = () => ({ messages: [{ role: 'user', text: '原始要求-' + 'a'.repeat(90000) },
    { role: 'assistant', blocks: [{ kind: 'thinking', text: 'PRIVATE-THOUGHT' }, { kind: 'text', text: '已采用企业主题' }], sourceAgent: { agentId: 'codex' } },
    { role: 'user', text: '最新澄清：保留深蓝色和原来的布局' }] });
  const result = await f.call(request(f.plugin)); assert.equal(result.ok, true, result.reason);
  const stored = core.store(path.join(f.root, 'plugin-debug-runs'), f.handle.sessionId).read();
  assert.ok(stored.prompt.length < 35000);
  assert.match(stored.prompt, /最新澄清：保留深蓝色和原来的布局/);
  assert.doesNotMatch(stored.prompt, /PRIVATE-THOUGHT/);
  const data = fs.readFileSync(path.join(f.cwd, stored.contextFile.path));
  assert.equal(require('crypto').createHash('sha256').update(data).digest('hex'), stored.contextFile.sha256);
  assert.match(data.toString(), /原始要求-/);
  assert.doesNotMatch(data.toString(), /PRIVATE-THOUGHT/);
});
 test('a queued workflow never refreshes the accepted bytes of a user attachment', async t => {
  const f = setup(t), file = path.join(f.cwd, 'input.txt'); fs.writeFileSync(file, 'accepted input');
  const result = await f.call({ ...request(f.plugin), attachments: [{ name: 'input.txt', path: file }] });
  assert.equal(result.ok, true, result.reason);
  fs.writeFileSync(file, 'changed after submission');
  const accepted = core.store(path.join(f.root, 'plugin-debug-runs'), f.handle.sessionId).read().inputAttachments[0];
  const staged = path.join(f.cwd, accepted.path);
  assert.notEqual(staged, file);
  assert.equal(fs.readFileSync(staged, 'utf8'), 'accepted input', 'editing the original must not alter accepted bytes');
  fs.writeFileSync(staged, 'tampered accepted copy');
  await assert.rejects(f.submissions[0].options.controlled.execute(), /输入附件已变化/);
});

test('workflow completion waits for the final parent transcript acknowledgement', async t => {
  const f = setup(t, () => ({
    executeNode: async node => node.outputs.map(output => ({ ...output, text: 'Actual fixture result' })),
    stopNode: async () => {},
  }));
  let saveFinal, finalStarted = false, completed = false;
  f.handle.appendTaskMessage = async (_role, text) => {
    if (!text.includes('协作已完成')) return;
    finalStarted = true; await new Promise(resolve => { saveFinal = resolve; });
  };
  await f.guard.submitConversation(f.handle, 'Run the fixture', [], { submissionId: 'final-ack-request-0001' },
    [{ pluginId: f.plugin.pluginId, inputValues: { format: 'txt' } }]);
  const executing = f.submissions[0].options.controlled.execute().then(value => { completed = true; return value; });
  const journal = core.store(path.join(f.root, 'plugin-debug-runs'), f.handle.sessionId);
  for (let n = 0; n < 100 && journal.read()?.status !== 'waiting'; n++) await new Promise(resolve => setImmediate(resolve));
  const waiting = journal.read(); assert.equal(waiting.status, 'waiting');
  const approving = f.call({ command: 'approve', runId: waiting.id, revision: waiting.revision,
    nodeKey: waiting.nodes.find(node => node.type === 'human_review').key });
  for (let n = 0; n < 100 && !finalStarted; n++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(finalStarted, true); assert.equal(completed, false);
  saveFinal(); assert.equal((await executing).ok, true); assert.equal((await approving).ok, true);
});
