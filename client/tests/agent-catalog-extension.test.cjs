'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRuntimeCatalog, loadCatalog } = require('../main/agent-runtime/runtime-catalog');
const { createRunnerRuntimeAdapter, _uuidV5 } = require('../main/agent-runtime/runner-adapter');
const { createPiSessionBridge } = require('../main/agent-runtime/pi-session-bridge');
const source = require('../../hub-backend/app/agent_catalog.json');
const extension = () => ({
  ...structuredClone(source.agents.find(row => row.id === 'qwen')),
  id: 'sample-acp', displayName: 'Sample ACP', order: 80,
  runner: { adapter: 'acp', bins: ['sample-acp'], args: ['--acp'] },
  install: { installer: 'manual', install_how: 'Install the vendor CLI' },
});

test('one new catalog row is discoverable without a new desktop ID list or adapter', () => {
  const catalog = createRuntimeCatalog({ ...source, agents: [...source.agents, extension()] });
  assert.equal(catalog.runtimes().length, source.agents.length + 1);
  assert.equal(catalog.runnerRuntimes().at(-1).id, 'sample-acp');
  const publicRow = catalog.publicRuntime('sample-acp', [{ id: 'session.resume' }]);
  assert.deepEqual(publicRow.capabilities, ['session.resume']);
  assert.equal(Object.hasOwn(publicRow, 'install'), false);
  assert.equal(Object.hasOwn(publicRow, 'runner'), false);
  assert.throws(() => publicRow.accessControl.modes.push('other'), TypeError);
});

test('catalog rejects duplicate identities and absent permission or execution declarations', () => {
  for (const broken of [
    { ...source, schemaVersion: 0 },
    { ...source, agents: [...source.agents, source.agents[0]] },
    { ...source, agents: [{ ...extension(), accessControl: null }] },
    { ...source, agents: [{ ...extension(), transport: 'shell' }] },
    { ...source, agents: [{ ...extension(), transport: 'direct' }] },
  ]) assert.throws(() => createRuntimeCatalog(broken), error => error.code === 'INVALID_RUNTIME_CATALOG');
});

test('packaged declarations take precedence; a corrupt installed catalog cannot silently use developer source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-agent-catalog-'));
  try {
    const file = path.join(root, 'agent_catalog.json');
    fs.writeFileSync(file, JSON.stringify({ ...source, agents: [extension()] }));
    assert.equal(loadCatalog({ resourcesPath: root }).runtimes()[0].id, 'sample-acp');
    fs.writeFileSync(file, '{}');
    assert.throws(() => loadCatalog({ resourcesPath: root }), error => error.code === 'INVALID_RUNTIME_CATALOG');
    fs.writeFileSync(file, '{');
    assert.throws(() => loadCatalog({ resourcesPath: root }), error => error.code === 'INVALID_RUNTIME_CATALOG');
    fs.unlinkSync(file);
    assert.equal(loadCatalog({ resourcesPath: root, isPackaged: false }).runtimes().length, source.agents.length);
    assert.throws(() => loadCatalog({ resourcesPath: root, isPackaged: true }), error => error.code === 'INVALID_RUNTIME_CATALOG');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('declared ACP extension reaches real desktop registration, detect, dispatch and follow-up paths', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-agent-extension-'));
  const catalog = createRuntimeCatalog({ ...source, agents: [...source.agents, extension()] });
  const calls = []; let round = 0;
  const runtime = { async rpc(op, payload) {
    calls.push({ op, payload });
    if (op === 'runtime.detect') return { ok: true, data: { installed: true, state: 'ready' } };
    if (op === 'job.dispatch') { round++; return { ok: true, data: {
      ref: _uuidV5('9af442c8-cd1d-4b91-a668-22da2b2635bf', payload.dispatchId),
    } }; }
    if (op === 'job.comment') { round++; return { ok: true, data: { ok: true } }; }
    if (op === 'job.session') return { ok: true, data: { ok: true, status: 'done', round,
      items: [{ seq: round, kind: 'say', text: 'Delivered ' + round }] } };
    if (op === 'job.stop') return { ok: true, data: { ok: true } };
    throw Error('Unexpected RPC ' + op);
  } };
  const runner = createRunnerRuntimeAdapter({ runtimeSpec: catalog.runtime('sample-acp'), runnerRuntime: runtime,
    modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'fixture', key: 'fixture-secret', baseUrl: 'http://fixture.invalid' } }) } });
  const bridge = createPiSessionBridge({ catalog, runnerAdapters: [runner],
    sessionModule: { probe: async () => ({ ok: true }), open: async () => { throw Error('must not fall back to Pi'); } } });
  let handle;
  try {
    assert.equal(bridge.runtimes().find(row => row.id === 'sample-acp').displayName, 'Sample ACP');
    assert.equal((await bridge.probe(null, 'sample-acp')).ok, true);
    const opened = await bridge.open({ adapterId: 'sample-acp', cwd: root, ref: 'extension-test', identity: { clientId: 'fixture' } });
    assert.equal(opened.ok, true, opened.reason); handle = opened.session;
    for (const text of ['First request', 'Follow-up']) {
      const result = await handle.submit(text).completion;
      assert.equal(result.ok, true, JSON.stringify(result));
    }
    assert.equal(calls.filter(row => row.op === 'job.dispatch').length, 1);
    assert.equal(calls.find(row => row.op === 'job.dispatch').payload.cfg.local_cli, 'sample-acp');
    assert.equal(calls.find(row => row.op === 'job.comment').payload.cfg.local_cli, 'sample-acp');
    assert.equal(handle.snapshot().adapterId, 'sample-acp');
    assert.doesNotMatch(JSON.stringify(handle.snapshot()), /fixture-secret/);
  } finally { if (handle) await handle.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
