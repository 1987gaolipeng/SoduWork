'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const personal = require('../main/personal-plugins');
const core = require('../main/personal-plugin-debug');
const runner = require('../main/personal-plugin-debug-runner');
const capabilities = require('../main/conversation/capabilities');
const models = require('../main/pi-session/model-config');
const grants = require('../main/pi-session/plugin-grant');
const createExecutor = options => runner.create({ piSession: { probe: async () => ({ ok: true,
  accessControl: { schema: 'soduwork.access-policy/v1', supported: true, modes: ['standard', 'readonly', 'full'] },
}) }, ...options });
function setup(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-debug-runner-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, cwd = path.join(root, 'work'); fs.mkdirSync(cwd);
  const plugin = personal.create(app, { template: 'workflow', key: 'runner-test', name: '调试执行测试',
    description: '检查执行与真实产出', version: '1.0.0', instructions: '只执行当前节点并写入产出。' }).plugin;
  const record = core.createRecord(plugin, 'conversation-runner', '验证真实协议');
  const node = record.nodes[0];
  node.config.agentKind = 'local:opencode';
  Object.assign(node, { status: 'running', attempt: 1, startedAt: Date.now(), dispatchId: 'plugin-debug:test-run-000001:plan:1' });
  node.outputs = [{ key: 'plan', kind: 'file', path: 'plan.md', label: '计划', required: true }];
  const events = [], calls = [], saved = [];
  const handle = { cwd, adapterId: 'pi', model: { id: 'test-model' },
    appendTaskMessage: (...args) => events.push(['message', ...args]), appendTaskTool: (...args) => events.push(['tool', ...args]) };
  const originals = { resolve: capabilities.resolve, model: models.fetchModel, grant: grants.resolve };
  capabilities.resolve = async () => ({ capabilityIds: [], skills: [], skillDirs: [] });
  models.fetchModel = async () => ({ ok: true, model: { id: 'test-model', key: 'do-not-expose-this-ticket', baseUrl: 'http://127.0.0.1:1' } });
  grants.resolve = async () => ({ items: [{ context: '已加载本机插件方法' }], grant: null });
  t.after(() => { capabilities.resolve = originals.resolve; models.fetchModel = originals.model; grants.resolve = originals.grant; });
  let terminalStatus = 'done';
  const runtime = { rpc: async (op, payload) => {
    calls.push({ op, payload });
    if (op === 'job.dispatch') {
      assert.equal(saved.at(-1).nodes[0].ref, node.ref, 'save identity before dispatch');
      assert.equal(payload.cli, 'opencode');
      assert.equal(payload.task.id.startsWith('chat-'), false, 'child job must not create another conversation');
      assert.equal(payload.ctx.workDir, path.join(cwd, 'plugin-debug', record.id, 'understand-1'));
      assert.deepEqual(payload.ctx.expectedOutputs, node.outputs);
      assert.equal(payload.ctx.pluginNodeName, node.name);
      fs.writeFileSync(path.join(payload.ctx.workDir, 'plan.md'), '# 实际计划');
      return { ok: true, data: { ref: node.ref } };
    }
    if (op === 'job.has') return { ok: true, data: { has: true } };
    if (op === 'job.session') return { ok: true, data: { status: terminalStatus, seq: 3,
      items: [
        { seq: 1, kind: 'do', tool: 'write', callId: 'write-plan', text: 'plan.md' },
        { seq: 2, kind: 'out', tool: 'write', callId: 'write-plan', text: 'written' },
        { seq: 3, kind: 'say', text: '计划文件已经生成。 do-not-expose-this-ticket' },
      ].filter(item => item.seq > payload.since) } };
    throw new Error('unexpected ' + op);
  } };
  const executor = createExecutor({ app, handle, plugin, runtime, identityOf: async () => ({}), skillDirs: [], deviceGrants: [], wait: async () => {} });
  return { root, cwd, app, plugin, record, node, handle, calls, events, saved, executor, runtime,
    persist: () => saved.push(JSON.parse(JSON.stringify(record))), setStatus: value => { terminalStatus = value; } };
}
test('Runner adapter dispatches a node locally, validates real files and preserves message/tool events', async t => {
  const f = setup(t);
  const result = await f.executor.executeNode(f.node, [], f.record, f.persist);
  assert.equal(result[0].path.endsWith('understand-1/plan.md'), true);
  assert.match(result[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(f.events.filter(row => row[0] === 'tool').length, 2);
  assert.equal(f.events.filter(row => row[0] === 'message').length, 2);
  assert.match(f.events.find(row => row[0] === 'message' && row[2].startsWith('交付文件'))[2], /plugin-debug\/.*understand-1\/plan.md/);
  assert.doesNotMatch(JSON.stringify(f.events), /do-not-expose-this-ticket/);
  assert.doesNotMatch(JSON.stringify(f.record), /do-not-expose/);
  assert.doesNotMatch(f.calls.find(row => row.op === 'job.dispatch').payload.ctx.brief, /do-not-expose/);
  // Resume the exact same persisted attempt: read existing events, never dispatch again.
  await f.executor.executeNode(f.node, [], f.record, f.persist);
  assert.equal(f.calls.filter(row => row.op === 'job.dispatch').length, 1);
});
test('missing terminal evidence is not success, even when the model wrote a result file', async t => {
  const f = setup(t); f.setStatus('unknown');
  await assert.rejects(f.executor.executeNode(f.node, [], f.record, f.persist), /未正常完成/);
});

test('a stopped node fails promptly and can be safely retried without stopping it again', async t => {
  const f = setup(t); f.setStatus('stopped');
  await assert.rejects(f.executor.executeNode(f.node, [], f.record, f.persist), /未正常完成：stopped/);
  await f.executor.stopNode(f.node);
  assert.equal(f.calls.filter(row => row.op === 'job.stop').length, 0);
});

test('Runner stopped acknowledgement releases the stop guard, but unknown never does', async t => {
  const f = setup(t); f.node.ref = 'existing-node';
  let stopped = false, terminal = 'stopped';
  f.runtime.rpc = async op => {
    if (op === 'job.has') return { ok: true, data: { has: true } };
    if (op === 'job.stop') { stopped = true; return { ok: true, data: { stopped: true } }; }
    if (op === 'job.session') return { ok: true, data: { status: stopped ? terminal : 'running' } };
    throw Error(op);
  };
  await f.executor.stopNode(f.node);
  stopped = false; terminal = 'unknown';
  await assert.rejects(f.executor.stopNode(f.node), /尚未确认停止/);
});
test('editing the plugin version during a run prevents silent version drift', async t => {
  const f = setup(t);
  personal.create(f.app, { ...f.plugin.localDraft, version: '1.0.1', instructions: '新方法' });
  await assert.rejects(f.executor.executeNode(f.node, [], f.record, f.persist), /版本已变化/);
  assert.equal(f.calls.length, 0);
});
test('missing MCP grants and hosted routing fail before starting a local Agent', async t => {
  const f = setup(t);
  f.node.capabilities.mcpServers = ['oa'];
  await assert.rejects(f.executor.executeNode(f.node, [], f.record, f.persist), /连接器授权不完整/);
  f.node.config.agentKind = 'hosted';
  await assert.rejects(f.executor.executeNode(f.node, [], f.record, f.persist), /非本机路由/);
  assert.equal(f.calls.length, 0);
});
test('transport exceptions never echo model credentials into debug failure messages', async t => {
  const f = setup(t);
  f.runtime.rpc = async () => { throw new Error('Transport failed with do-not-expose-this-ticket'); };
  await assert.rejects(f.executor.executeNode(f.node, [], f.record, f.persist), error => {
    assert.match(error.message, /执行机连接失败/);
    assert.doesNotMatch(error.message, /do-not-expose/);
    return true;
  });
});

test('Runner payloads route non-Pi runtimes independently and never give account Codex a Pi model', async t => {
  const f = setup(t), requests = [], dispatched = [];
  models.fetchModel = async (...args) => {
    requests.push(args);
    return { ok: true, model: { id: args[1] || args[5] + '-default', key: 'ticket-' + args[5], baseUrl: 'http://localhost' } };
  };
  f.runtime.rpc = async (op, payload) => {
    if (op === 'job.dispatch') {
      dispatched.push(payload);
      fs.writeFileSync(path.join(payload.ctx.workDir, 'plan.md'), 'actual fixture output');
      return { ok: true, data: { ref: f.node.ref } };
    }
    if (op === 'job.session') return { ok: true, data: { status: 'done', items: [], seq: 0 } };
    throw Error('unexpected ' + op);
  };
  for (const agent of ['codex-harness', 'qwen', 'opencode', 'dsh', 'codex']) {
    f.node.config.agentKind = 'local:' + agent;
    f.node.config.model = '';
    f.node.dispatchId = 'plugin-debug:test-six-engines:' + agent + ':1';
    delete f.node.dispatched; delete f.node.ref;
    await f.executor.executeNode(f.node, [], f.record, f.persist);
  }
  assert.deepEqual(dispatched.map(row => row.cli), ['codex-harness', 'qwen', 'opencode', 'dsh', 'codex']);
  assert.deepEqual(requests.map(args => [args[1], args[5]]), [
    ['', 'codex-harness'], ['', 'qwen'], ['', 'opencode'], ['', 'dsh'],
  ]);
  assert.equal(dispatched[0].cfg.llm.model, 'codex-harness-default');
  assert.equal(dispatched[2].cfg.llm.model, 'opencode-default');
  assert.equal(dispatched[4].cfg.codex_model, '');
  assert.equal(dispatched[4].cfg.llm, undefined);
  assert.equal(dispatched[4].ctx.agentExecution.model, '');
});

test('an account switch while resolving grants prevents dispatch at the final owner fence', async t => {
  const f = setup(t); let owner = 'alice';
  grants.resolve = async () => { owner = 'bob'; return { items: [], grant: null }; };
  const executor = createExecutor({ app: f.app, handle: f.handle, plugin: f.plugin,
    runtime: f.runtime, identityOf: async () => ({ owner }), skillDirs: [], deviceGrants: [],
    assertOwner(identity) { if (identity.owner !== 'alice') throw Error('account switched'); },
  });
  await assert.rejects(executor.executeNode(f.node, [], f.record, f.persist), /account switched/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.node.ref, undefined);
});

test('workflow dispatch and renewed authorization preserve model limits, capabilities and credential isolation', async t => {
  const f = setup(t), requests = [], configs = [];
  f.node.config.agentKind = 'local:opencode';
  let authorized = false;
  models.fetchModel = async (...args) => {
    requests.push(args);
    return { ok: true, model: { id: 'opencode-default', key: args[4] ? 'renewed-secret-ticket' : 'initial-secret-ticket',
      baseUrl: 'http://localhost', contextWindow: args[4] ? 32000 : 64000, maxOutputTokens: args[4] ? 4096 : 8192,
      input: ['text', 'image'], imageRouting: 'native', visionFallbackAvailable: false,
      capabilityProfile: { schema: 1, images: true }, configRevision: args[4] ? 'config-2' : 'config-1', runtimeRevision: 'runtime-1' } };
  };
  function modelContract(llm, renewed) {
    assert.equal(llm.contextWindow, renewed ? 32000 : 64000);
    assert.equal(llm.maxOutputTokens, renewed ? 4096 : 8192);
    assert.deepEqual(llm.input, ['text', 'image']);
    assert.equal(llm.imageRouting, 'native');
    assert.equal(llm.visionFallbackAvailable, false);
    assert.deepEqual(llm.capabilityProfile, { schema: 1, images: true });
    assert.equal(llm.configRevision, renewed ? 'config-2' : 'config-1');
    assert.equal(llm.runtimeRevision, 'runtime-1');
  }
  f.runtime.rpc = async (op, payload) => {
    if (op === 'job.dispatch') {
      configs.push(structuredClone(payload.cfg.llm));
      fs.writeFileSync(path.join(payload.ctx.workDir, 'plan.md'), 'plan');
      return { ok: true, data: { ref: f.node.ref } };
    }
    if (op === 'job.authorize') {
      configs.push(structuredClone(payload.cfg.llm));
      assert.equal(payload.cfg.llm.key, 'renewed-secret-ticket'); authorized = true;
      return { ok: true, data: {} };
    }
    if (op === 'job.session') return { ok: true, data: {
      status: authorized ? 'done' : 'running', authorizationRequired: !authorized,
      seq: 1, items: authorized ? [] : [{ seq: 1, kind: 'say', text: 'initial-secret-ticket renewed-secret-ticket' }],
    } };
    throw Error(op);
  };
  await f.executor.executeNode(f.node, [], f.record, f.persist);
  assert.equal(configs.length, 2);
  modelContract(configs[0], false); modelContract(configs[1], true);
  assert.deepEqual(requests.map(args => [args[1], args[4], args[5]]), [
    ['', false, 'opencode'], ['opencode-default', true, 'opencode'],
  ]);
  assert.equal(authorized, true);
  assert.doesNotMatch(JSON.stringify(f.events), /initial-secret-ticket|renewed-secret-ticket/);
  assert.doesNotMatch(JSON.stringify(f.record), /secret-ticket/);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('cancel during model preparation or grant preparation never starts a child job', async t => {
  for (const stage of ['model', 'grant']) {
    await t.test(stage, async t => {
      const f = setup(t), entered = deferred(), release = deferred();
      if (stage === 'model') models.fetchModel = async () => {
        entered.resolve(); await release.promise;
        return { ok: true, model: { id: 'model', key: 'ticket', baseUrl: 'http://localhost' } };
      };
      else grants.resolve = async () => { entered.resolve(); await release.promise; return { items: [], grant: null }; };
      const execution = f.executor.executeNode(f.node, [], f.record, f.persist);
      await entered.promise;
      await f.executor.stopNode(f.node);
      f.record.status = 'cancelled'; release.resolve();
      await assert.rejects(execution, /已停止/);
      assert.equal(f.calls.length, 0);
      assert.equal(f.node.ref, undefined);
    });
  }
});

test('cancel waits for in-flight dispatch acknowledgement then stops the exact child', async t => {
  const f = setup(t), entered = deferred(), release = deferred(), calls = [];
  let stopped = false;
  f.runtime.rpc = async (op, payload) => {
    calls.push(op);
    if (op === 'job.dispatch') { entered.resolve(); await release.promise; return { ok: true, data: { ref: f.node.ref } }; }
    if (op === 'job.has') return { ok: true, data: { has: true } };
    if (op === 'job.stop') { stopped = true; return { ok: true }; }
    if (op === 'job.session') return { ok: true, data: { status: stopped ? 'stopped' : 'running' } };
    throw Error(op);
  };
  const execution = f.executor.executeNode(f.node, [], f.record, f.persist);
  const rejected = assert.rejects(execution, /已停止/);
  await entered.promise;
  let confirmed = false;
  const stopping = f.executor.stopNode(f.node).then(() => { confirmed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(confirmed, false);
  assert.deepEqual(calls, ['job.dispatch']);
  release.resolve();
  await stopping; await rejected;
  assert.equal(stopped, true);
  assert.equal(calls.filter(op => op === 'job.dispatch').length, 1);
});

test('an unconfirmed dispatch cannot release the cancellation guard even if inventory is empty', async t => {
  const f = setup(t);
  f.runtime.rpc = async op => {
    if (op === 'job.dispatch') throw Error('connection lost after server accepted');
    if (op === 'job.has') return { ok: true, data: { has: false } };
    throw Error(op);
  };
  await assert.rejects(f.executor.executeNode(f.node, [], f.record, f.persist), /执行机连接失败/);
  assert.ok(f.node.ref);
  assert.equal(f.node.dispatched, undefined);
  await assert.rejects(f.executor.stopNode(f.node), /派发结果未知/);
});

test('dispatch wait times out without falsely confirming cancellation', async t => {
  const f = setup(t), entered = deferred(), release = deferred();
  f.runtime.rpc = async op => {
    assert.equal(op, 'job.dispatch'); entered.resolve(); await release.promise;
    return { ok: true, data: { ref: f.node.ref } };
  };
  const executor = createExecutor({ app: f.app, handle: f.handle, plugin: f.plugin,
    runtime: f.runtime, identityOf: async () => ({}), skillDirs: [], deviceGrants: [], stopTimeoutMs: 5 });
  const execution = executor.executeNode(f.node, [], f.record, f.persist);
  const rejected = assert.rejects(execution, /已停止/);
  await entered.promise;
  await assert.rejects(executor.stopNode(f.node), /派发尚未确认/);
  release.resolve(); await rejected;
});

test('child jobs preserve explicit and pending parent permission choices inside their own workspace', async t => {
  const f = setup(t), rules = require('../main/access-control/policy');
  const policies = [];
  f.runtime.rpc = async (op, payload) => {
    if (op === 'runtime.detect') return { ok: true, data: { accessControl: {
      schema: rules.SCHEMA, supported: true, modes: [...rules.MODES],
    } } };
    if (op === 'job.dispatch') {
      policies.push({ cfg: payload.cfg.accessPolicy, ctx: payload.ctx });
      fs.writeFileSync(path.join(payload.ctx.workDir, 'plan.md'), 'fixture result');
      return { ok: true, data: { ref: f.node.ref } };
    }
    if (op === 'job.session') return { ok: true, data: { status: 'done', items: [], seq: 0 } };
    throw Error(op);
  };
  for (const mode of ['standard', 'readonly', 'full']) {
    f.handle.snapshot = () => ({ accessPolicy: rules.create('standard', f.cwd),
      nextAccessPolicy: rules.next(mode, f.cwd, rules.create('standard', f.cwd), 1) });
    delete f.node.dispatched; delete f.node.ref;
    await f.executor.executeNode(f.node, [], f.record, f.persist);
  }
  assert.deepEqual(policies.map(row => row.cfg.mode), ['standard', 'readonly', 'full']);
  for (const row of policies) {
    assert.equal(row.cfg.workspaceRoot, row.ctx.workDir);
    assert.notEqual(row.cfg.workspaceRoot, f.cwd);
    assert.deepEqual(row.cfg, row.ctx.accessPolicy);
    assert.equal(row.ctx.mode, row.cfg.mode === 'readonly' ? 'plan' : 'work');
  }
});

test('permission requests expose a bounded safe summary and reply only once to the matching child request', async t => {
  const f = setup(t), waiting = deferred(), release = deferred(), answers = [];
  let answered = false;
  f.runtime.rpc = async (op, payload) => {
    if (op === 'job.dispatch') {
      fs.writeFileSync(path.join(payload.ctx.workDir, 'plan.md'), 'result');
      return { ok: true, data: { ref: f.node.ref } };
    }
    if (op === 'job.session') return { ok: true, data: { status: answered ? 'done' : 'running',
      items: [], seq: 0, pendingPermissions: answered ? [] : [{ requestId: 'permission-1', policyRevision: 2,
        action: 'command.execute', title: 'do-not-show-secret', arguments: { command: 'echo ready --token do-not-expose-this-ticket' } }],
    } };
    if (op === 'job.permission') { answers.push(payload); answered = true; return { ok: true, data: { ok: true } }; }
    throw Error(op);
  };
  const executor = createExecutor({ app: f.app, handle: f.handle, plugin: f.plugin,
    runtime: f.runtime, identityOf: async () => ({}), skillDirs: [], deviceGrants: [],
    wait: async () => { waiting.resolve(); await release.promise; } });
  const execution = executor.executeNode(f.node, [], f.record, f.persist);
  await waiting.promise;
  assert.equal(f.node.pendingPermissions[0].summary, '执行命令');
  assert.match(f.node.pendingPermissions[0].detail, /^echo ready/);
  assert.equal(f.node.pendingPermissions[0].reviewable, true);
  assert.doesNotMatch(f.node.pendingPermissions[0].detail, /do-not-expose/);
  await assert.rejects(executor.answerPermission(f.record, { nodeKey: f.node.key, requestId: 'wrong', allow: true }), /已失效/);
  await executor.answerPermission(f.record, { nodeKey: f.node.key, requestId: 'permission-1', allow: true });
  await assert.rejects(executor.answerPermission(f.record, { nodeKey: f.node.key, requestId: 'permission-1', allow: true }), /已失效/);
  assert.deepEqual(answers, [{ ref: f.node.ref, requestId: 'permission-1', policyRevision: 2, decision: 'once' }]);
  release.resolve(); await execution;
  assert.doesNotMatch(JSON.stringify(f.saved), /do-not-show-secret|"token"/);
});

test('whole-plan preflight checks the installed plugin version and current source authorization', async t => {
  const f = setup(t), sourceAccess = require('../main/plugin-source-access');
  const original = sourceAccess.check;
  t.after(() => { sourceAccess.check = original; });
  f.runtime.rpc = async op => {
    assert.equal(op, 'runtime.detect');
    return { ok: true, data: { installed: true, state: 'ready' } };
  };
  sourceAccess.check = async () => { throw Error('sensitive authorization body'); };
  const denied = await f.executor.preflight(f.record);
  assert.equal(denied.ok, false);
  assert.equal(denied.issues.some(row => row.code === 'plugin_access'), true);
  assert.doesNotMatch(JSON.stringify(denied), /sensitive authorization/);
  sourceAccess.check = original;
  personal.create(f.app, { ...f.plugin.localDraft, version: '1.0.1', instructions: 'changed plugin' });
  const changed = await f.executor.preflight(f.record);
  assert.equal(changed.ok, false);
  assert.equal(changed.issues.some(row => row.code === 'plugin_changed'), true);
});

test('verified upstream and user inputs are separate readable node-local copies, never sibling workspace paths', async t => {
  const f = setup(t), crypto = require('node:crypto'), rules = require('../main/access-control/policy');
  const digest = data => crypto.createHash('sha256').update(data).digest('hex');
  fs.mkdirSync(path.join(f.cwd, 'earlier-node'));
  const user = Buffer.from('user instructions'), upstream = Buffer.from('verified upstream result');
  fs.writeFileSync(path.join(f.cwd, 'plan.md'), user);
  fs.writeFileSync(path.join(f.cwd, 'earlier-node', 'plan.md'), upstream);
  f.record.attachments = [{ name: 'plan.md', path: 'plan.md', sha256: digest(user), type: 'text/plain' }];
  const inputs = [{ key: 'plan', inputKey: 'previous', fromNode: 'earlier', kind: 'file',
    path: 'earlier-node/plan.md', sha256: digest(upstream) }];
  f.handle.snapshot = () => ({ accessPolicy: rules.create('standard', f.cwd) });
  let dispatched;
  f.runtime.rpc = async (op, payload) => {
    if (op === 'runtime.detect') return { ok: true, data: { accessControl: {
      schema: rules.SCHEMA, supported: true, modes: [...rules.MODES],
    } } };
    if (op === 'job.dispatch') {
      dispatched = payload;
      assert.equal(payload.localFiles.length, 2);
      assert.equal(new Set(payload.localFiles.map(file => file.path)).size, 2);
      for (const file of payload.localFiles) {
        assert.equal(rules.within(payload.ctx.workDir, file.path), true);
        assert.equal(digest(fs.readFileSync(file.path)), file.sha256);
        assert.equal(rules.operation(payload.cfg.accessPolicy, 'read', { path: file.path }).verdict, 'allow');
        assert.ok(payload.ctx.brief.includes(JSON.stringify(file.path)));
      }
      assert.doesNotMatch(payload.ctx.brief, /earlier-node/);
      fs.writeFileSync(path.join(payload.ctx.workDir, 'plan.md'), 'new output');
      return { ok: true, data: { ref: f.node.ref } };
    }
    if (op === 'job.session') return { ok: true, data: { status: 'done', items: [], seq: 0 } };
    throw Error(op);
  };
  await f.executor.executeNode(f.node, inputs, f.record, f.persist);
  assert.equal(fs.readFileSync(path.join(f.cwd, 'plan.md'), 'utf8'), user.toString());
  assert.equal(fs.readFileSync(path.join(f.cwd, 'earlier-node', 'plan.md'), 'utf8'), upstream.toString());
  assert.match(dispatched.localFiles[0].path, /\.soduwork-inputs[\\/]user[\\/]/);
  assert.match(dispatched.localFiles[1].path, /\.soduwork-inputs[\\/]upstream[\\/]/);
  fs.writeFileSync(dispatched.localFiles[1].path, 'tampered node input');
  await assert.rejects(f.executor.executeNode(f.node, inputs, f.record, f.persist), /输入副本已被修改/);
});

test('the shipped file-to-file builder example consumes the actual staged input manifest', async t => {
  const f = setup(t), text = personal.get(f.app, personal.BUILDER_ID).localDraft.instructions;
  const line = text.split('\n').find(value => value.startsWith('最小双底座流程示例'));
  const raw = JSON.parse(line.slice(line.indexOf('{')));
  assert.equal(raw.workflow?.nodes[0].outputs[0].path, 'plan.md');
  const plugin = personal.create(f.app, raw).plugin;
  const record = core.createRecord(plugin, 'example-conversation', 'Use the existing plan to create the result.');
  const parent = record.nodes[0], parentDir = path.join(f.cwd, 'previous-plan');
  fs.mkdirSync(parentDir); fs.writeFileSync(path.join(parentDir, 'plan.md'), 'verified-example-plan');
  parent.outputsFound = await runner.verify(parent, parentDir, f.cwd, 'plan ready');
  parent.status = 'completed';
  let dispatched;
  const runtime = { rpc: async (op, payload) => {
    if (op === 'job.dispatch') {
      dispatched = payload;
      assert.equal(payload.cli, 'qwen');
      const section = payload.task.note.split('上游已校验材料：\n')[1].split('\n\n')[0];
      const inputs = JSON.parse(section);
      assert.equal(inputs.length, 1);
      assert.equal(inputs[0].inputKey, 'plan');
      assert.equal(inputs[0].fromNode, 'plan');
      assert.match(inputs[0].path, /^\.soduwork-inputs\/upstream\//);
      assert.equal(path.resolve(payload.ctx.workDir, inputs[0].path), inputs[0].absolutePath);
      assert.equal(inputs[0].absolutePath, payload.localFiles[0].path);
      assert.equal(fs.readFileSync(inputs[0].absolutePath, 'utf8'), 'verified-example-plan');
      assert.equal(fs.existsSync(path.join(payload.ctx.workDir, 'input/plan.md')), false);
      assert.match(payload.task.note, /上游已校验材料.*inputKey=plan.*path/);
      fs.writeFileSync(path.join(payload.ctx.workDir, 'result.md'), 'result based on verified-example-plan');
      return { ok: true, data: { ref: record.nodes[1].ref } };
    }
    if (op === 'job.session') return { ok: true, data: { status: 'done', items: [], seq: 0 } };
    throw Error(op);
  } };
  const executor = createExecutor({ app: f.app, handle: f.handle, plugin, runtime,
    identityOf: async () => ({}), skillDirs: [], deviceGrants: [], wait: async () => {} });
  const controller = core.create({ record, executeNode: executor.executeNode, stopNode: executor.stopNode, save: () => {} });
  const completion = controller.execute();
  try {
    const deadline = Date.now() + 3000;
    while (record.status !== 'waiting') {
      assert.notEqual(record.status, 'failed', record.reason);
      assert.ok(Date.now() < deadline, 'the parsed example should reach human approval');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(dispatched);
    assert.equal(record.nodes[1].outputsFound[0].kind, 'file');
    assert.deepEqual(record.nodes[2].dependsOn, ['plan', 'work']);
    assert.deepEqual(record.nodes[2].inputs.map(input => input.fromNode), ['plan', 'work']);
    assert.equal(record.nodes[2].status, 'waiting', 'both verified upstream files are ready for human review');
    await controller.action('approve', record.revision, 'accept');
    assert.equal((await completion).ok, true);
  } finally { if (record.status !== 'completed') await controller.cancel(); }
});

test('Pi nodes use the direct session permission path rather than the legacy Runner Pi adapter', async t => {
  const f = setup(t), rules = require('../main/access-control/policy');
  f.node.config.agentKind = 'local:pi';
  f.handle.snapshot = () => ({ accessPolicy: rules.create('standard', f.cwd) });
  const opened = [];
  let snapshot = { accessControl: { supported: true, schema: rules.SCHEMA, modes: [...rules.MODES] },
    messages: [], tools: [], pendingPermissions: [] };
  const piSession = { probe: async () => ({ ok: true, accessControl: snapshot.accessControl }),
    open: async opts => {
      opened.push(opts); let callback = () => {};
      const child = { snapshot: () => snapshot, on: fn => { callback = fn; return () => {}; },
        inFlight: () => false, cancel() {}, close() {},
        submit: () => ({ accepted: true, completion: Promise.resolve().then(() => {
          assert.equal(opts.accessPolicy.workspaceRoot, opts.cwd);
          assert.equal(rules.operation(opts.accessPolicy, 'write', { path: path.join(opts.cwd, 'plan.md') }).verdict, 'allow');
          fs.writeFileSync(path.join(opts.cwd, 'plan.md'), 'actual Pi output');
          snapshot = { ...snapshot, messages: [{ role: 'assistant', done: true, text: 'Complete' }],
            tools: [{ id: 'pi-write', name: 'write', args: { path: 'plan.md' }, state: 'done', result: 'written' }] };
          callback({}, snapshot); return { ok: true };
        }) }) };
      return { ok: true, session: child };
    } };
  const executor = createExecutor({ app: f.app, handle: f.handle, plugin: f.plugin, piSession,
    runtime: { rpc: async () => assert.fail('Pi must not use the legacy Runner execution transport') },
    identityOf: async () => ({}), skillDirs: [], deviceGrants: [] });
  const outputs = await executor.executeNode(f.node, [], f.record, f.persist);
  assert.equal(opened[0].modelName, 'test-model');
  assert.equal(opened[0].ephemeral, true);
  assert.equal(outputs[0].path.endsWith('understand-1/plan.md'), true);
  assert.match(outputs[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(f.events.filter(row => row[0] === 'message').length, 2);
  const write = f.events.find(row => row[0] === 'tool' && row[1].type === 'tool_execution_start')[1];
  assert.equal(write.args.path, path.join(opened[0].cwd, 'plan.md'));
  assert.equal(fs.readFileSync(write.args.path, 'utf8'), 'actual Pi output');
  assert.equal(snapshot.tools[0].args.path, 'plan.md', 'the real child arguments are not rewritten');
  await executor.executeNode(f.node, [], f.record, f.persist);
  assert.equal(opened.length, 1);
});

test('time spent awaiting a user permission is not counted against the node execution budget', async t => {
  const f = setup(t), actualNow = Date.now;
  let now = actualNow(), answered = false;
  t.after(() => { Date.now = actualNow; });
  Date.now = () => now;
  f.node.config.timeoutSeconds = 1;
  f.runtime.rpc = async (op, payload) => {
    if (op === 'job.dispatch') {
      fs.writeFileSync(path.join(payload.ctx.workDir, 'plan.md'), 'result');
      return { ok: true, data: { ref: f.node.ref } };
    }
    if (op === 'job.session') return { ok: true, data: { status: answered ? 'done' : 'running', items: [], seq: 0,
      pendingPermissions: answered ? [] : [{ requestId: 'user-wait', policyRevision: 1,
        action: 'command.execute', arguments: { command: 'echo result' } }] } };
    if (op === 'job.permission') { answered = true; return { ok: true, data: { ok: true } }; }
    assert.fail('permission wait must not trigger stop: ' + op);
  };
  const executor = createExecutor({ app: f.app, handle: f.handle, plugin: f.plugin,
    runtime: f.runtime, identityOf: async () => ({}), skillDirs: [], deviceGrants: [],
    wait: async () => { now += 180000; await executor.answerPermission(f.record,
      { nodeKey: f.node.key, requestId: 'user-wait', allow: true }); } });
  const outputs = await executor.executeNode(f.node, [], f.record, f.persist);
  assert.equal(outputs.length, 1);
  assert.equal(f.node.activeElapsedMs, 0);
});

 test('workflow nodes inherit completed dependency context and copied full conversation without widening access', async t => {
  const f = setup(t), contextFile = path.join(f.cwd, 'context.txt');
  fs.writeFileSync(contextFile, 'EARLY-REQUIREMENT\nLATEST-CLARIFICATION');
  f.record.contextFile = { path: 'context.txt', name: '会话参考.txt', sha256: require('crypto').createHash('sha256').update(fs.readFileSync(contextFile)).digest('hex') };
  f.node.dependsOn = ['prior'];
  f.record.nodes.push({ key: 'prior', name: '设计阶段', agent: 'qwen-code', status: 'completed', dependsOn: [],
    handoffSummary: '品牌用蓝色，保留原布局', outputsFound: [{ key: 'design', kind: 'evidence', text: '验收约束：窄屏正常' }] });
  f.record.nodes.push({ key: 'unrelated', name: '无关分支', status: 'completed', outputsFound: [{ text: 'DO-NOT-INHERIT' }] });
  const outputs = await f.executor.executeNode(f.node, [], f.record, f.persist);
  const sent = f.calls.find(row => row.op === 'job.dispatch').payload;
  assert.match(sent.ctx.brief, /下一节点由平台自动调度/);
  assert.match(sent.ctx.brief, /真实权限请求、缺失材料和执行失败必须如实说明/);
  assert.match(sent.ctx.brief, /品牌用蓝色，保留原布局/); assert.match(sent.ctx.brief, /窄屏正常/);
  assert.doesNotMatch(sent.ctx.brief, /DO-NOT-INHERIT/);
  const copied = fs.readdirSync(path.join(sent.ctx.workDir, '.soduwork-inputs', 'context'));
  assert.equal(copied.length, 1);
  assert.equal(fs.readFileSync(path.join(sent.ctx.workDir, '.soduwork-inputs', 'context', copied[0]), 'utf8'), 'EARLY-REQUIREMENT\nLATEST-CLARIFICATION');
  assert.match(f.node.handoffSummary, /计划文件已经生成/);
  assert.match(f.events.filter(row => row[0] === 'message').at(-1)[2], /交付文件：/);
  assert.equal(outputs[0].path.startsWith('plugin-debug/'), true);
});

test('verified file links escape Markdown labels without leaking source code', async t => {
  const f = setup(t); f.node.outputs[0].label = '[设计]\\说明';
  await f.executor.executeNode(f.node, [], f.record, f.persist);
  const row = f.events.find(item => item[0] === 'message' && item[2].startsWith('交付文件'));
  assert.equal(row[2], '交付文件：[\\[设计\\]\\\\说明](plugin-debug/' + f.record.id + '/understand-1/plan.md)');
  assert.doesNotMatch(row[2], /const output|projections|dispatchId/);
  assert.equal(row[7].agentId, 'opencode');
});

test('a running Runner child follows parent access changes using native ACKs without redispatch', async t => {
  const f = setup(t), rules = require('../main/access-control/policy');
  let parent = rules.create('standard', f.cwd), child, listener = () => {}, finished = false;
  f.handle.snapshot = () => ({ accessPolicy: parent, accessControl: { changeTakesEffect: 'current-turn' } });
  f.handle.on = cb => { listener = cb; return () => { listener = () => {}; }; };
  const changes = [], operations = [];
  f.runtime.rpc = async (op, payload) => {
    operations.push(op);
    if (op === 'runtime.detect') return { ok: true, data: { accessControl: {
      schema: rules.SCHEMA, supported: true, modes: [...rules.MODES] } } };
    if (op === 'job.dispatch') {
      child = payload.ctx.accessPolicy;
      fs.writeFileSync(path.join(payload.ctx.workDir, 'plan.md'), 'permission fixture');
      parent = rules.next('full', f.cwd, parent, parent.revision);
      return { ok: true, data: { ref: f.node.ref } };
    }
    if (op === 'job.session') return { ok: true, data: {
      accessPolicy: child, status: finished ? 'done' : 'running', items: [], seq: 0 } };
    if (op === 'job.access') {
      changes.push(payload);
      assert.equal(payload.ref, f.node.ref);
      assert.equal(payload.expectedRevision, child.revision);
      assert.equal(payload.accessPolicy.workspaceRoot, child.workspaceRoot);
      assert.equal(payload.applyDuringTurn, true);
      child = payload.accessPolicy;
      if (child.mode === 'full') {
        parent = rules.next('readonly', f.cwd, parent, parent.revision); listener('access-changed');
      } else finished = true;
      return { ok: true, data: { ok: true, effective: 'current-turn', accessPolicy: child } };
    }
    throw Error(op);
  };
  await f.executor.executeNode(f.node, [], f.record, f.persist);
  assert.deepEqual(changes.map(row => row.accessPolicy.mode), ['full', 'readonly']);
  assert.equal(operations.filter(op => op === 'job.dispatch').length, 1);
  assert.equal(f.node.accessPolicy.mode, 'readonly');
  assert.equal(f.node.parentAccessRevision, 3);
  assert.equal(f.node.accessPolicy.workspaceRoot.endsWith('understand-1'), true);
});
test('an unsupported live Runner downgrade stops the existing job instead of continuing with full access', async t => {
  const f = setup(t), rules = require('../main/access-control/policy');
  let parent = rules.create('full', f.cwd), child, stopped = false;
  const operations = [];
  f.handle.snapshot = () => ({ accessPolicy: parent });
  f.runtime.rpc = async (op, payload) => {
    operations.push(op);
    if (op === 'runtime.detect') return { ok: true, data: { accessControl: {
      schema: rules.SCHEMA, supported: true, modes: [...rules.MODES] } } };
    if (op === 'job.dispatch') {
      child = payload.ctx.accessPolicy; parent = rules.next('readonly', f.cwd, parent, parent.revision);
      return { ok: true, data: { ref: f.node.ref } };
    }
    if (op === 'job.session') return { ok: true, data: { accessPolicy: child, status: stopped ? 'stopped' : 'running', items: [], seq: 0 } };
    if (op === 'job.access') return { ok: true, data: { ok: false, error: 'private token body' } };
    if (op === 'job.has') return { ok: true, data: { has: true } };
    if (op === 'job.stop') { stopped = true; return { ok: true, data: {} }; }
    throw Error(op);
  };
  await assert.rejects(f.executor.executeNode(f.node, [], f.record, f.persist), /未能同步会话访问权限/);
  assert.equal(stopped, true);
  assert.equal(operations.filter(op => op === 'job.dispatch').length, 1);
  assert.equal(operations.filter(op => op === 'job.access').length, 1);
  assert.equal(f.node.accessPolicy, undefined);
});

test('node evidence and its downstream summary retain earlier replies before the final acknowledgement', async t => {
  const f = setup(t);
  f.node.outputs = [{ key: 'analysis', kind: 'evidence', label: 'Complete analysis', required: true }];
  f.runtime.rpc = async op => {
    if (op === 'job.dispatch') return { ok: true, data: { ref: f.node.ref } };
    if (op === 'job.session') return { ok: true, data: { status: 'done', seq: 2, items: [
      { seq: 1, kind: 'say', text: 'The required finding is in the first reply.' },
      { seq: 2, kind: 'say', text: 'Node complete.' },
    ] } };
    throw Error(op);
  };
  const outputs = await f.executor.executeNode(f.node, [], f.record, f.persist);
  const full = 'The required finding is in the first reply.\n\nNode complete.';
  assert.equal(outputs[0].text, full); assert.equal(f.node.handoffSummary, full);
});
