'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const context = require('../main/conversation/requirement-context');
const { prepare } = require('../main/pi-session/task-input');
const { executionSpec } = require('../main/pi-session/controlled-task-turn');
const { createTurnQueue } = require('../main/pi-session/turn-queue');
const { runtimes } = require('../main/agent-runtime/runtime-catalog');

function identity(user = 'alice', device = 'device', hub = 'http://fixture.invalid') {
  const now = Math.floor(Date.now() / 1000);
  return { hub, clientId: device, session: Buffer.from(JSON.stringify({
    typ: 'device', uid: user, cid: device, iat: now, exp: now + 1800,
  })).toString('base64url') + '.' + '0'.repeat(64) };
}
function fixture(t, adapterId = 'pi') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-requirement-context-'));
  const app = new EventEmitter(); app.getPath = () => root; app.getVersion = () => '0.0.0-fixture';
  const workRoot = path.join(root, 'SoduWork'), cwd = path.join(workRoot, 'repo-one');
  fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(path.join(workRoot, 'repo-two'));
  let auth = identity();
  const handle = { ref: 'live-ref', sessionId: 'native-archive', adapterId, cwd, model: 'existing-model',
    taskIds: [], taskBindings: [], taskRef: '', usageIdentity: { hub: auth.hub, clientId: auth.clientId },
    snapshot: () => ({ status: 'idle', messages: [], tools: [], modelSelection: { name: 'existing-model' } }),
    historyRow: () => ({ id: handle.sessionId, cwd, adapterId }),
    bindTask(id, title) {
      handle.taskRef = id; handle.taskIds = [...new Set([...handle.taskIds, id])];
      handle.taskBindings = handle.taskIds.map(taskId => ({ taskId, title }));
      return { ok: true };
    },
  };
  const tasks = { one: { id: 'one', ownerClientId: auth.clientId, title: 'First requirement', projectId: 'project', repoId: 'r1' },
    two: { id: 'two', ownerClientId: auth.clientId, title: 'Second requirement', projectId: 'project', repoId: 'r1' } };
  const repos = [{ id: 'r1', projectId: 'project', localDir: 'repo-one' },
    { id: 'r2', projectId: 'project', localDir: 'repo-two' }];
  const requests = [];
  const request = async route => {
    requests.push(route);
    if (route === '/repos') return { repos };
    const task = tasks[decodeURIComponent(route.split('/').at(-1))];
    if (!task) throw Error('Unavailable fixture task');
    return structuredClone(task);
  };
  const runtime = () => ({ app, handle, workRoot, identity: auth, identityOf: async () => auth });
  const validate = (task = tasks.one, requested = { reuseConversation: true }) => context.validate(runtime(), task,
    requested, executionSpec(task, requested), request);
  t.after(() => {
    app.emit('before-quit');
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('soduwork-requirement-context-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, app, workRoot, cwd, handle, tasks, repos, request, requests, runtime, validate,
    identity: () => auth, switchIdentity: next => { auth = next; } };
}
function mockHub(t, f) {
  const receipts = [];
  t.mock.method(global, 'fetch', async (url, options = {}) => {
    const route = new URL(url).pathname.replace('/api/v1', '');
    if (route.endsWith('/attachments')) return Response.json([]);
    if (route.endsWith('/conversation-turn')) {
      const body = JSON.parse(options.body); receipts.push({ taskId: route.split('/')[2], ...body });
      return Response.json({ turn: { state: body.action === 'prepare' ? 'queued' : body.action } });
    }
    if (route === '/usage/events') return Response.json({ ok: true });
    return Response.json(await f.request(route));
  });
  return receipts;
}

test('显式本机改选只接受待开始需求，仍校验身份、Agent和工程目录', async t => {
  const f=fixture(t);
  const saved={...f.tasks.one,status:'todo',workRouting:{selectedStrategy:'workflow',workflowBindingId:'old-flow'},
    executionContext:{strategy:'workflow',runner:{mode:'remote'},model:'old-model'}};
  const selected={executionChoice:'native',agentId:'local:pi',model:''};
  assert.equal(executionSpec(saved,selected).mode,'native');
  await f.validate(saved,selected);
  for(const patch of [{status:'doing'}, {archivedAt:1}, {requirementStage:'reviewing'}, {ai:{executionState:'running'}},
    {workRouting:{conversationTurn:{state:'completed'}}}, {workRouting:{conversationTurn:{state:'running'}}}]) {
    await assert.rejects(f.validate({...saved,...patch},selected),/开始|执行|结果/);
  }
  await assert.rejects(f.validate({...saved,ownerClientId:'other'},selected),/无权/);
  await assert.rejects(f.validate(saved,{...selected,agentId:'local:qwen'}),/Agent/);
  await assert.rejects(f.validate({...saved,repoId:'r2'},selected),/目录/);
  await f.validate({...saved,workRouting:{selectedStrategy:'workflow'}},selected);
});

function nativeHub(t, f, { ignoreChoice = false, loseFirstPrepareResponse = false } = {}) {
  const receipts = [], downloads = [];
  let responseLost = false;
  f.tasks.one = { ...f.tasks.one, status: 'todo', note: '完整需求' + '内容'.repeat(2200) + '尾部验收标记',
    workRouting: { selectedStrategy: 'workflow', workflowBindingId: 'old-flow',
      executionContext: { strategy: 'workflow', runner: { mode: 'remote' }, model: 'old-model' } } };
  t.mock.method(global, 'fetch', async (url, options = {}) => {
    const route = new URL(url).pathname.replace('/api/v1', '');
    if (route === '/attachments/input') { downloads.push(url); return new Response('原始附件'); }
    if (route.endsWith('/attachments')) return Response.json([
      { id: 'input', filename: '材料.txt', url: '/api/v1/attachments/input?ticket=fixture' }]);
    if (route.endsWith('/conversation-turn')) {
      const body = JSON.parse(options.body); receipts.push(body);
      const routing = f.tasks.one.workRouting;
      if (body.executionChoice === 'native' && !ignoreChoice) {
        routing.selectedStrategy = 'direct'; routing.workflowBindingId = '';
        routing.executionContext = { strategy: 'direct', agent: { id: body.agentId },
          runner: { mode: 'local' }, model: body.model };
      }
      routing.conversationTurn = { ...body, state: body.action === 'prepare' ? 'queued' : body.action };
      if (loseFirstPrepareResponse && body.action === 'prepare' && !responseLost) {
        responseLost = true; throw new Error('隔离网络故障：Hub 已提交，但 prepare 响应丢失');
      }
      return Response.json({ turn: routing.conversationTurn, task: f.tasks.one });
    }
    return Response.json(await f.request(route));
  });
  return { receipts, downloads };
}

test('本机改选 prepare 回执丢失后仅恢复同一次排队，仍拒绝并发和运行中', async t => {
  const f = fixture(t), { receipts } = nativeHub(t, f, { loseFirstPrepareResponse: true });
  const selected = { executionChoice: 'native', agentId: 'local:pi', model: '' };
  const attempt = (turnId = 'native-turn') => prepare(f.identity(), 'one', f.handle.sessionId, turnId,
    '执行完整需求', selected, f.runtime());
  await assert.rejects(attempt(), /响应丢失/);
  const routing = f.tasks.one.workRouting, saved = { ...routing.conversationTurn };
  assert.equal(saved.state, 'queued');
  await assert.rejects(attempt('different-turn'), /开始|执行/);
  for (const patch of [{ conversationId: 'another-chat' }, { state: 'running' }, { executor: 'workflow' }]) {
    routing.conversationTurn = { ...saved, ...patch };
    await assert.rejects(attempt(), /开始|执行/);
  }
  routing.conversationTurn = saved;
  routing.executionContext.agent.id = 'local:qwen';
  await assert.rejects(attempt(), /选择|变化|开始|执行/);
  routing.executionContext.agent.id = 'local:pi';
  f.tasks.one.ownerClientId = 'other-device';
  await assert.rejects(attempt(), /无权/);
  f.tasks.one.ownerClientId = f.identity().clientId;
  assert.equal(receipts.length, 1, '冲突重试不能改写 Hub 排队收据');
  const input = await attempt();
  assert.equal(input.executor, 'native'); assert.match(input.text, /尾部验收标记/);
  assert.equal(input.attachments[0].data.toString(), '原始附件');
  await input.beforeTurn();
  assert.deepEqual(receipts.map(row => row.action), ['prepare', 'prepare', 'start']);
  assert.ok(receipts.every(row => row.turnId === 'native-turn' && row.conversationId === f.handle.sessionId));
});

test('显式本机改选完整带入正文附件并保留默认模型，排队后禁止恢复旧流程', async t => {
  const f = fixture(t), { receipts, downloads } = nativeHub(t, f);
  const input = await prepare(f.identity(), 'one', f.handle.sessionId, 'native-turn', '执行完整需求',
    { executionChoice: 'native', agentId: 'local:pi', model: '' }, f.runtime());
  assert.equal(input.executor, 'native'); assert.equal(input.controlled, null); assert.equal(input.modelName, '');
  assert.match(input.text, /尾部验收标记/); assert.match(input.text, /执行完整需求/);
  assert.equal(input.attachments[0].name, '材料.txt');
  assert.equal(input.attachments[0].data.toString(), '原始附件'); assert.equal(downloads.length, 1);
  assert.equal(receipts[0].executionChoice, 'native'); assert.equal(receipts[0].agentId, 'local:pi');
  await input.beforeTurn(); assert.equal(receipts.at(-1).action, 'start');
  await input.beforeRetry();
  assert.equal(receipts.at(-1).executionChoice, undefined, '重试沿用已保存选择，不能再次改选');
  await input.beforeTurn(); assert.equal(receipts.at(-1).action, 'start');
  f.tasks.one.workRouting.executionContext.agent.id = 'local:qwen';
  await assert.rejects(input.beforeTurn(), /选择|Agent|变化/);
  f.tasks.one.workRouting.executionContext.agent.id = 'local:pi';
  f.tasks.one.workRouting.selectedStrategy = 'workflow'; f.tasks.one.workRouting.workflowBindingId = 'another-flow';
  await assert.rejects(input.beforeTurn(), /选择|工作流|变化/);
});

test('显式本机改选不能伪装为追问绕过状态校验或丢弃正文附件', async t => {
  const f = fixture(t), { receipts } = nativeHub(t, f);
  const selected = { executionChoice: 'native', agentId: 'local:pi', reuseConversation: true, followUp: true };
  f.tasks.one.status = 'doing';
  await assert.rejects(prepare(f.identity(), 'one', f.handle.sessionId, 'blocked', '执行', selected, f.runtime()), /开始|执行/);
  assert.equal(receipts.length, 0);
  f.tasks.one.status = 'todo';
  const input = await prepare(f.identity(), 'one', f.handle.sessionId, 'allowed', '执行', selected, f.runtime());
  assert.match(input.text, /尾部验收标记/); assert.equal(input.attachments.length, 1);
});

test('旧 Hub 没保存显式改选时拒绝启动并取消本次排队', async t => {
  const f = fixture(t), { receipts } = nativeHub(t, f, { ignoreChoice: true });
  await assert.rejects(prepare(f.identity(), 'one', f.handle.sessionId, 'native-turn', '执行',
    { executionChoice: 'native', agentId: 'local:pi' }, f.runtime()), /选择|更新|改选/);
  assert.deepEqual(receipts.map(row => row.action), ['prepare', 'cancel']);
});

test('IPC 不能把显式本机改选的校验失败降级为无需求普通发送', async t => {
  const f = fixture(t); nativeHub(t, f); f.tasks.one.status = 'doing';
  let sends = 0;
  f.handle.submit = () => { sends++; return { accepted: true, completion: Promise.resolve({ ok: true }) }; };
  const bridge = { get: ref => ref === f.handle.ref ? f.handle : null, list: () => [], closeAll() {} };
  const { handlers } = await installFixtureIpc(t, f, bridge);
  const result = await handlers.get('pi-session-send')({}, f.handle.ref, '执行', [], { taskId: 'one', submissionId: 'blocked',
    taskExecution: { executionChoice: 'native', agentId: 'local:pi', reuseConversation: true, followUp: true } });
  assert.equal(result.ok, false); assert.match(result.reason, /开始|执行/); assert.equal(sends, 0);
});
function loadIpc(bridge) {
  const file = require.resolve('../main/pi-session/ipc'), nativeRequire = createRequire(file), module = { exports: {} };
  const load = name => name === '../agent-runtime/pi-session-bridge' ? bridge
    : name === 'electron' ? { shell: {}, dialog: {} } : nativeRequire(name);
  vm.runInThisContext('(function(require,module,exports,__filename,__dirname){\n' + fs.readFileSync(file, 'utf8') + '\n})',
    { filename: file })(load, module, module.exports, file, path.dirname(file));
  return module.exports;
}

async function installFixtureIpc(t, f, bridge) {
  // The fixture's signed identity backs both the asynchronous resolver and
  // offline lookup. Register through the production open before testing reuse.
  t.mock.method(context, 'cachedIdentity', () => f.identity());
  let registered = false;
  const laterOpen = bridge.open;
  bridge.open = async () => {
    if (registered) {
      if (laterOpen) return laterOpen();
      throw Error('Reuse must not open another runtime');
    }
    registered = true;
    return { ok: true, session: f.handle };
  };
  f.handle.on = () => () => {};
  f.handle.status = () => 'idle';
  f.handle.close = async () => true;
  const handlers = new Map(), ipcMain = { handle: (name, handler) => handlers.set(name, handler), on() {} };
  const installed = loadIpc(bridge).install({ app: f.app, ipcMain,
    BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null }, identityOf: async () => f.identity() });
  const opened = await installed.open({ adapterId: f.handle.adapterId, cwd: f.cwd, capabilities: [] });
  assert.equal(opened.ok, true, opened.reason);
  assert.equal(opened.ref, f.handle.ref);
  assert.equal(registered, true, 'fixture setup must register through the actual IPC open');
  return { handlers, installed };
}

test('authorized repository reuses a stable native context across different requirements and process reopen', async t => {
  const f = fixture(t); await f.validate(); f.handle.bindTask('one', 'First');
  await f.validate(f.tasks.two);
  assert.deepEqual(context.publicContext(f.app, f.handle.sessionId), { projectId: 'project', repoId: 'r1' });
  const restored = { ...f.handle, taskIds: [], taskBindings: [], taskRef: '', requirementContext: undefined };
  context.assertOwner(f.app, restored, f.identity());
  assert.deepEqual(restored.requirementContext, { projectId: 'project', repoId: 'r1' });
  const publicRow = context.decorate(f.app, { id: restored.sessionId });
  assert.equal(JSON.stringify(publicRow).includes('owner'), false);
  assert.deepEqual(publicRow.requirementContext, restored.requirementContext);
  assert.equal(context.decorate(f.app, { id: restored.sessionId }, identity('bob')).requirementContext, undefined);
  assert.deepEqual(context.decorate(f.app, { id: restored.sessionId }, f.identity()).requirementContext, restored.requirementContext);
  assert.equal(restored.cwd, f.cwd); assert.equal(restored.model, 'existing-model');
});

test('legacy archives rebuild project ownership from authenticated task bindings, including completed requirements', async t => {
  const f = fixture(t); f.tasks.one.status = 'done'; f.handle.bindTask('one', 'First');
  await f.validate(f.tasks.two);
  assert.ok(f.requests.includes('/tasks/one'));
  const other = fixture(t); other.tasks.one.projectId = 'another-project'; other.handle.bindTask('one', 'Old');
  await assert.rejects(other.validate(other.tasks.two), /同一项目或工程/);
  assert.equal(context.publicContext(other.app, other.handle.sessionId), null);
});

test('project-only native requirements can share a session but cannot switch project or acquire another repository', async t => {
  const f = fixture(t); delete f.tasks.one.repoId; delete f.tasks.two.repoId;
  await f.validate(); await f.validate(f.tasks.two);
  await assert.rejects(f.validate({ ...f.tasks.two, projectId: 'another' }), /同一项目或工程/);
  await assert.rejects(f.validate({ ...f.tasks.two, repoId: 'r1' }), /同一项目或工程/);
});

test('live cwd and Hub localDir are authoritative; renderer repo paths cannot override them', async t => {
  const f = fixture(t);
  const spoof = { reuseConversation: true, cwd: f.cwd, repo: { id: 'r1', path: f.cwd } };
  f.handle.cwd = path.join(f.workRoot, 'repo-two');
  await assert.rejects(f.validate(f.tasks.one, spoof), /工程目录/);
  f.handle.cwd = f.cwd;
  f.repos[0].projectId = 'forbidden'; await assert.rejects(f.validate(f.tasks.one, spoof), /不属于需求项目/);
  f.repos[0].projectId = 'project'; f.repos[0].localDir = '../outside';
  await assert.rejects(f.validate(f.tasks.one, spoof), /超出工作目录/);
  f.repos[0].localDir = f.cwd; await assert.rejects(f.validate(f.tasks.one, spoof), /有效的本地目录/);
});

test('repository symlinks cannot escape the work root, and a changed repo mapping is revalidated', async t => {
  const f = fixture(t); await f.validate();
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.workRoot, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  f.repos[0].localDir = 'escape'; await assert.rejects(f.validate(), /指向工作目录之外/);
  f.repos[0].localDir = 'repo-two'; await assert.rejects(f.validate(), /工程目录/);
});

test('workflow, remote, squad, Agent/model mismatches and unauthorized tasks fail before any native work', async t => {
  const f = fixture(t);
  for (const patch of [{ workflowBindingId: 'workflow' }, { workRouting: { selectedStrategy: 'workflow', workflowBindingId: 'wf' } },
    { executionContext: { runner: { mode: 'remote' } } }, { executionContext: { assigneeType: 'squad' } }]) {
    await assert.rejects(f.validate({ ...f.tasks.one, ...patch }, { reuseConversation: true, executionContext: { runner: { mode: 'local' }, assigneeType: 'agent' } }));
  }
  await assert.rejects(f.validate(f.tasks.one, { reuseConversation: true, agentId: 'local:qwen' }), /Agent/);
  await assert.rejects(f.validate(f.tasks.one, { reuseConversation: true, model: 'different-model' }), /模型/);
  await assert.rejects(f.validate({ ...f.tasks.one, ownerClientId: 'different-device' }), /无权/);
  await assert.rejects(f.validate({ ...f.tasks.one, canViewExecution: false }), /无权/);
  await assert.rejects(f.validate({ ...f.tasks.one, readOnly: true }), /无权/);
  assert.equal(context.publicContext(f.app, f.handle.sessionId), null);
});

test('durable account/device/Hub identity prevents reuse or bind after account switch and restart', async t => {
  const f = fixture(t); await f.validate();
  for (const next of [identity('bob'), identity('alice', 'other-device'), identity('alice', 'device', 'http://other.invalid')]) {
    f.switchIdentity(next);
    await assert.rejects(f.validate(), /账号|设备|服务/);
    await assert.rejects(context.checkBinding(f.runtime(), 'two', f.request), /账号|设备|服务/);
  }
  f.switchIdentity(identity());
  await assert.rejects(context.checkBinding(f.runtime(), 'other', async () => ({ ...f.tasks.two, projectId: 'other' })), /同一项目或工程/);
  await f.validate(f.tasks.two);
});

test('queued reuse rechecks identity and project routing before start; original receipt remains task-scoped', async t => {
  const f = fixture(t), receipts = mockHub(t, f);
  const input = await prepare(f.identity(), 'one', f.handle.sessionId, 'submission-one', '',
    { reuseConversation: true }, f.runtime());
  assert.equal(input.executor, 'native'); assert.equal(Object.hasOwn(input, 'modelName'), false);
  assert.equal(input.controlled, null);
  f.switchIdentity(identity('bob'));
  await assert.rejects(input.beforeTurn(), /另一个账号/);
  assert.deepEqual(receipts.map(row => row.action), ['prepare']);
  f.switchIdentity(identity()); f.tasks.one.executionContext = { runner: { mode: 'remote' } };
  await assert.rejects(input.beforeTurn(), /远程执行/);
  delete f.tasks.one.executionContext;
  await input.beforeTurn(); await input.afterTurn('completed');
  assert.deepEqual(receipts.map(row => row.action), ['prepare', 'start', 'complete']);
  assert.ok(receipts.every(row => row.taskId === 'one' && row.conversationId === f.handle.sessionId && row.executor === 'native'));
});

test('a forged runtime identity, expired captured token, or an outdated model selection cannot redirect native reuse', async t => {
  const f = fixture(t), receipts = mockHub(t, f);
  await assert.rejects(prepare(f.identity(), 'one', 'forged-conversation', 'fake', '',
    { reuseConversation: true }, f.runtime()), /无法确认原会话/);
  await assert.rejects(prepare(f.identity(), 'one', f.handle.sessionId, 'fake', '',
    { reuseConversation: true }), /无法确认原会话/);
  assert.equal(receipts.length, 0);
  const input = await prepare(f.identity(), 'one', f.handle.sessionId, 'actual', '',
    { reuseConversation: true }, f.runtime());
  const previous = f.identity(); f.switchIdentity(identity()); previous.session = 'expired';
  await input.beforeTurn();
  assert.equal(receipts.at(-1).action, 'start');
  f.handle.snapshot = () => ({ modelSelection: { name: 'new-model', model: { id: 'new-model' } } });
  await assert.rejects(f.validate(f.tasks.two, { reuseConversation: true, model: 'existing-model' }), /模型/);
});

test('all registered Agents use the same IPC reuse boundary and sequential per-requirement queue without opening another runtime', async t => {
  for (const runtimeSpec of runtimes()) await t.test(runtimeSpec.id, async t => {
    const f = fixture(t, runtimeSpec.id), receipts = mockHub(t, f), queue = createTurnQueue(), turns = [], completions = [];
    let draining = false, newRuntimeCalls = 0;
    f.handle.submit = (text, files, options) => {
      const queued = queue.blocked() || queue.size() > 0;
      const item = queue.add({ text, attachments: files, options });
      completions.push(item.completion);
      if (!draining) {
        draining = true;
        Promise.resolve().then(async () => {
          for (let next; (next = queue.take());) await queue.run(next, async () => {
            turns.push({ taskId: next.options.taskId, model: f.handle.model, adapterId: f.handle.adapterId,
              cwd: f.handle.cwd, sessionId: f.handle.sessionId, options: next.options, text: next.text });
            return { ok: true };
          });
          draining = false;
        });
      }
      return { accepted: true, queued, queueId: item.id, completion: item.completion };
    };
    const bridge = { get: ref => ref === f.handle.ref ? f.handle : null, list: () => [], closeAll() {},
      open() { newRuntimeCalls++; throw Error('Reuse must not open another runtime'); } };
    const { handlers } = await installFixtureIpc(t, f, bridge);
    for (const taskId of ['one', 'two']) {
      const result = await handlers.get('pi-session-send')({}, f.handle.ref, 'Execute ' + taskId, [], {
        taskId, submissionId: 'submit-' + taskId, projectId: 'renderer-spoof',
        taskExecution: { reuseConversation: true, agentId: 'local:' + runtimeSpec.id, model: 'existing-model',
          repo: { id: 'r1', path: '/renderer/path/is/ignored' } },
      });
      assert.equal(result.ok, true, result.reason);
      assert.deepEqual(result.snapshot.requirementContext, { projectId: 'project', repoId: 'r1' });
      f.handle.bindTask(taskId, taskId);
    }
    await Promise.all(completions);
    assert.deepEqual(turns.map(row => row.taskId), ['one', 'two']);
    assert.ok(turns.every(row => row.sessionId === 'native-archive' && row.adapterId === runtimeSpec.id &&
      row.cwd === f.cwd && row.model === 'existing-model' && row.options.projectId === 'project' &&
      !Object.hasOwn(row.options, 'modelName') && row.options.controlled === null));
    assert.equal(newRuntimeCalls, 0);
    assert.deepEqual((await handlers.get('pi-session-snapshot')({}, f.handle.ref)).snapshot.requirementContext,
      { projectId: 'project', repoId: 'r1' });
    assert.deepEqual(receipts.filter(row => row.action === 'complete').map(row => row.taskId), ['one', 'two']);
    f.switchIdentity(identity('bob'));
    const rejected = await handlers.get('pi-session-bind-task')({}, f.handle.ref, 'two', 'spoof');
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, '这条会话已经不在了（可能已关闭）');
    assert.throws(() => context.assertOwner(f.app, f.handle, f.identity()), /另一个账号/);
  });
});
