'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { create } = require('../main/conversation/cloud-handoff');
const portable = require('../main/conversation/portable-workspace');

async function fixture(t, agentId = 'opencode') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-handoff-fallback-'));
  const cwd = path.join(root, 'work'); await fs.mkdir(cwd); await fs.writeFile(path.join(cwd, '进度.md'), '# Finished step one');
  let available = ['pi'], supported = true, stops = 0, uploads = 0, starts = 0, receipt, sent, manifest, uid = 'alice', probeGate;
  const queries = [], state = { messages: [{ role: 'user', text: 'Complete steps one and two' },
    { role: 'assistant', text: 'Step one is done' }], modelSelection: { name: 'local-model' }, queue: [], status: 'streaming' };
  const handle = { ref: 'local-ref', sessionId: 'local-id', adapterId: agentId, cwd, ui: {}, running: true,
    snapshot: () => ({ ...state }), inFlight() { return this.running; }, historyRow: () => ({ title: 'Continue work' }),
    cancel() { stops++; this.running = false; }, close() {}, bindTask: async () => ({ ok: true }),
    appendTaskMessage() {}, appendTaskTool() {}, selectAgent: () => ({ ok: true }), selectModel: () => ({ ok: true }) };
  const identityOf = async () => ({ hub: 'http://127.0.0.1:9', clientId: 'test-device', session:
    Buffer.from(JSON.stringify({ typ: 'device', cid: 'test-device', uid, iat: 1, exp: 9999999999 })).toString('base64url') + '.' + 'a'.repeat(64) });
  const cloud = create({ app: { getPath: () => root }, identityOf, interval: 60000, workspace: {
    scan: portable.scan, create: async (...args) => { const result = await portable.create(...args); manifest = result.manifest; return result; },
  }, request: async (_identity, route, options = {}) => {
    if (route.includes('/targets?')) {
      const agent = new URL('http://test' + route).searchParams.get('agentId'); queries.push(agent);
      if (probeGate) await probeGate;
      return { targets: available.includes(agent) ? [{ id: 'runner:remote:' + agent, agentId: agent, modelMode: agent === 'codex' ? 'account' : 'managed' }] : [],
        handoffCapabilities: { piFallback: supported } };
    }
    if (options.body instanceof FormData) {
      assert.equal(handle.running, false); uploads++; sent = JSON.parse(options.body.get('options'));
      receipt = { ok: true, phase: 'prepared', transferId: route.split('/').at(-1), sha256: sent.sha256,
        taskId: 'cloud-task', target: { id: 'runner:remote:' + sent.agentId, agentId: sent.agentId } }; return receipt;
    }
    if (route.endsWith('/commit')) { starts++; return { ...receipt, phase: 'committed', ref: 'cloud-run' }; }
    if (route.includes('ai-session?')) return { status: 'done', last: 0, items: [] };
    if (route.includes('/attachments')) return [];
    return receipt;
  } });
  t.after(async () => { handle.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { cloud, handle, state, queries, get stops() { return stops; }, get starts() { return starts; },
    get uploads() { return uploads; }, get sent() { return sent; }, get manifest() { return manifest; },
    set available(v) { available = v; }, set supported(v) { supported = v; }, set uid(v) { uid = v; }, set gate(v) { probeGate = v; } };
}
const input = p => ({ previewId: p.previewId, instruction: 'Continue with step two' });
const consent = p => ({ ...p.fallback, accepted: true });

test('same Agent is preferred without querying Pi and preserves the reviewed model', async t => {
  const f = await fixture(t); f.available = ['opencode', 'pi'];
  const p = await f.cloud.preview(f.handle); assert.equal(p.fallback, null); assert.deepEqual(f.queries, ['opencode']);
  assert.equal(f.stops, 0); assert.equal(f.uploads, 0);
  await f.cloud.confirm(f.handle, { ...input(p), model: 'renderer-replacement' });
  assert.equal(f.sent.agentId, 'opencode'); assert.equal(f.sent.model, 'local-model'); assert.equal(f.sent.agentFallback, undefined);
  assert.equal(f.stops, 1); assert.equal(f.starts, 1);
});

test('Pi fallback never stops or uploads until the exact reviewed fallback is accepted', async t => {
  const f = await fixture(t); const p = await f.cloud.preview(f.handle);
  assert.deepEqual(p.fallback, { fromAgentId: 'opencode', toAgentId: 'pi' }); assert.equal(p.model, '');
  for (const agentFallback of [undefined, { ...p.fallback, accepted: false }, { ...p.fallback, accepted: 'true' },
    { fromAgentId: 'qwen', toAgentId: 'pi', accepted: true }, { ...p.fallback, toAgentId: 'qwen', accepted: true }]) {
    await assert.rejects(f.cloud.confirm(f.handle, { ...input(p), agentFallback }), /确认是否改用 Pi/);
    assert.equal(f.stops, 0); assert.equal(f.uploads, 0); assert.equal(f.cloud.guard(f.handle), null);
  }
  await f.cloud.confirm(f.handle, { ...input(p), agentFallback: consent(p) });
  assert.equal(f.sent.agentId, 'pi'); assert.deepEqual(f.sent.agentFallback, consent(p));
  assert.equal(f.manifest.source.adapterId, 'opencode'); assert.equal(f.manifest.source.sessionId, 'local-id');
  assert.equal(f.manifest.source.messages.length, 2); assert.equal(f.manifest.files[0].path, '进度.md');
  assert.equal(f.stops, 1); assert.equal(f.starts, 1); assert.equal(f.handle.snapshot().adapterId, 'pi');
  assert.equal(f.handle.selectAgent('qwen').ok, false, 'handoff must fence local runtime switching');
});

test('native-account fallback uses the authorized cloud default rather than the native model name', async t => {
  const f = await fixture(t, 'codex'); const p = await f.cloud.preview(f.handle);
  await f.cloud.confirm(f.handle, { ...input(p), model: 'gpt-native-account', agentFallback: consent(p) });
  assert.equal(f.sent.model, ''); assert.equal(f.manifest.source.modelName, 'local-model');
});

test('no destination or an older Hub leaves the local job running', async t => {
  const f = await fixture(t); f.available = [];
  let p = await f.cloud.preview(f.handle); assert.equal(p.fallback, null); assert.deepEqual(p.targets, []);
  await assert.rejects(f.cloud.confirm(f.handle, input(p)), /没有兼容/);
  f.available = ['pi']; f.supported = false; p = await f.cloud.preview(f.handle);
  assert.equal(p.fallback, null); assert.deepEqual(p.targets, []); assert.match(p.diagnostics.summary, /更新后台/);
  assert.equal(f.stops, 0); assert.equal(f.uploads, 0); assert.equal(f.handle.running, true);
});

test('changed Agent, model, account or expired review cannot reuse fallback consent', async t => {
  const f = await fixture(t); const p = await f.cloud.preview(f.handle);
  f.handle.adapterId = 'qwen';
  await assert.rejects(f.cloud.confirm(f.handle, { ...input(p), agentFallback: consent(p) }), /已变化/);
  f.handle.adapterId = 'opencode'; f.state.modelSelection.name = 'new-model';
  await assert.rejects(f.cloud.confirm(f.handle, { ...input(p), agentFallback: consent(p) }), /已变化/);
  f.state.modelSelection.name = 'local-model'; f.uid = 'bob';
  await assert.rejects(f.cloud.confirm(f.handle, { ...input(p), agentFallback: consent(p) }), /已过期/);
  f.uid = 'alice'; await f.cloud.preview(f.handle);
  await assert.rejects(f.cloud.confirm(f.handle, { ...input(p), agentFallback: consent(p) }), /已过期/);
  assert.equal(f.stops, 0); assert.equal(f.uploads, 0);
});

test('Agent switching and account changes while discovering destinations are rejected', async t => {
  const f = await fixture(t); f.state.runtimeSwitching = true;
  await assert.rejects(f.cloud.preview(f.handle), /正在切换 Agent/);
  f.state.runtimeSwitching = false; let release; f.gate = new Promise(r => { release = r; });
  const pending = f.cloud.preview(f.handle); await new Promise(r => setImmediate(r)); f.uid = 'bob'; release();
  await assert.rejects(pending, /连接已变化/); assert.equal(f.stops, 0); assert.equal(f.uploads, 0);
});

test('persistent local plugins and changes during stopping cannot be silently transferred', async t => {
  const f = await fixture(t); f.state.activePlugins = ['meeting'];
  await assert.rejects(f.cloud.preview(f.handle), /本机插件/);
  assert.equal(f.stops, 0); f.state.activePlugins = [];
  const p = await f.cloud.preview(f.handle);
  f.handle.cancel = () => { f.handle.running = false; f.state.modelSelection.name = 'changed-during-stop'; };
  await assert.rejects(f.cloud.confirm(f.handle, { ...input(p), agentFallback: consent(p) }), /模型或工作目录已变化/);
  assert.equal(f.cloud.guard(f.handle), null); assert.equal(f.uploads, 0);
});

test('a closed dialog late preview cannot invalidate the newly opened dialog confirmation', async t => {
  const f = await fixture(t); f.available = ['opencode']; let release;
  f.gate = new Promise(r => { release = r; });
  const older = assert.rejects(f.cloud.preview(f.handle), /已有更新的交接预览/);
  await new Promise(r => setImmediate(r)); f.gate = null;
  const latest = await f.cloud.preview(f.handle); release(); await older;
  assert.equal(f.stops, 0); assert.equal(f.uploads, 0);
  await f.cloud.confirm(f.handle, input(latest)); assert.equal(f.starts, 1);
});
