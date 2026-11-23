'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const gate = require('../main/pi-session/plugin-generation-gate.cjs');
const outputs = require('../main/pi-session/outputs');
const cache = require('../main/app-resource-cache.cjs');
const body = { template: 'method', key: 'ideas', name: 'Ideas', version: '1.0.0',
  description: 'Collect ideas', instructions: 'Collect ideas and produce an HTML report.' };
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-authoring-completion-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, 'soduwork-plugin-draft.json');
  const manifest = path.join(cwd, '.soduwork/delivery.json');
  const handle = { cwd, sessionId: 'synthetic', deliveryOwner: { account: 'fixture' },
    outputSnapshot: () => outputs.scan(cwd, 0, 0) };
  const report = (source = 'manifest', presentation = 'artifacts') => {
    fs.writeFileSync(path.join(cwd, 'report.html'), '<!doctype html><h1>Ideas</h1>');
    if (source === 'manifest') {
      fs.mkdirSync(path.dirname(manifest), { recursive: true });
      fs.writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, presentation,
        deliverables: [{ path: 'report.html' }] }));
    }
  };
  return { cwd, file, manifest, handle, report, write: (name = file) => fs.writeFileSync(name, JSON.stringify(body)),
    begin: options => gate.begin({ handle, selectedPluginIds: ['local:plugin-builder'], ...options }) };
}
test.after(() => cache.close());
for (const source of ['manifest', 'inferred']) test(source + ' HTML authoring completion creates and validates the missing package in the same turn', async t => {
  const f = fixture(t); let calls = 0;
  const turn = await f.begin({ repair: async (prompt, options) => {
    calls++; assert.match(prompt, /Create soduwork-plugin-draft.json/);
    assert.match(prompt, /Do not install/); assert.equal(options.recordUser, false);
    f.write(); return { ok: true };
  } });
  f.report(source); const preview = fs.readFileSync(path.join(f.cwd, 'report.html'));
  const result = await turn.finish({ ok: true });
  assert.equal(result.ok, true); assert.equal(calls, 1);
  assert.equal(gate.records(f.handle)[0].state, 'ready');
  assert.deepEqual(fs.readFileSync(path.join(f.cwd, 'report.html')), preview);
});
test('running authoring previews remain readable without starting a repair until successful completion', async t => {
  const f = fixture(t); let calls = 0;
  const turn = await f.begin({ repair: async () => { calls++; f.write(); return { ok: true }; } });
  f.report('inferred');
  for (let read = 0; read < 2; read++) {
    const snapshot = f.handle.outputSnapshot();
    assert.equal(snapshot.delivery.items[0].kind, 'website');
    assert.deepEqual(await gate.inspect({ handle: f.handle, snapshot }), []);
    assert.equal(calls, 0); assert.equal(fs.existsSync(f.file), false);
  }
  assert.equal((await turn.finish({ ok: true })).ok, true);
  assert.equal(calls, 1);
});
test('changed inferred HTML requires a plugin but unchanged inherited previews do not', async t => {
  for (const changed of [false, true]) {
    const f = fixture(t); let calls = 0;
    f.report('inferred');
    const turn = await f.begin({ repair: async () => { calls++; f.write(); return { ok: true }; } });
    if (changed) fs.appendFileSync(path.join(f.cwd, 'report.html'), '<p>New preview</p>');
    assert.equal((await turn.finish({ ok: true })).ok, true);
    assert.equal(calls, changed ? 1 : 0);
  }
});
test('inferred HTML in a source workspace cannot replace the final plugin package', async t => {
  const f = fixture(t); let calls = 0;
  fs.writeFileSync(path.join(f.cwd, 'package.json'), '{}');
  const turn = await f.begin({ repair: async () => { calls++; f.write(); return { ok: true }; } });
  f.report('inferred');
  assert.equal(f.handle.outputSnapshot().delivery.items.length, 0, 'source HTML is intentionally omitted from inferred final artifacts');
  assert.equal((await turn.finish({ ok: true })).ok, true);
  assert.equal(calls, 1);
});
for (const source of ['manifest', 'inferred']) test(source + ' missing package repair stays bounded when the model deletes its completion evidence', async t => {
  const f = fixture(t); let calls = 0;
  const turn = await f.begin({ repair: async () => {
    calls++; fs.rmSync(source === 'manifest' ? f.manifest : path.join(f.cwd, 'report.html'), { force: true }); return { ok: true };
  } });
  f.report(source); const result = await turn.finish({ ok: true });
  assert.equal(calls, 2); assert.equal(result.ok, false); assert.equal(result.retrySafe, false);
  assert.equal(result.failureKind, 'plugin-validation');
  assert.equal(gate.records(f.handle)[0].state, 'invalid');
});
test('repair accepts a recognized alternative draft name and validates its real bytes', async t => {
  const f = fixture(t), alternate = path.join(f.cwd, 'plugin.json');
  const turn = await f.begin({ repair: async () => { f.write(alternate); return { ok: true }; } });
  f.report(); const result = await turn.finish({ ok: true });
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(gate.records(f.handle).map(row => [row.relative, row.state]), [['plugin.json', 'ready']]);
});
for (const scenario of ['ordinary', 'cleared-selection', 'inferred-non-html', 'summary', 'clarification', 'existing-draft', 'unchanged-delivery']) {
  test(scenario + ' does not create an unsolicited missing-package repair', async t => {
    const f = fixture(t); let calls = 0;
    if (scenario === 'existing-draft') f.write();
    if (scenario === 'unchanged-delivery') f.report();
    const turn = await f.begin({ selectedPluginIds: ['ordinary', 'cleared-selection'].includes(scenario) ? [] : ['local:plugin-builder'],
      repair: async () => { calls++; return { ok: true }; } });
    if (scenario === 'inferred-non-html') fs.writeFileSync(path.join(f.cwd, 'notes.txt'), 'Clarification notes');
    else if (scenario === 'summary') f.report('manifest', 'summary');
    else if (!['clarification', 'unchanged-delivery'].includes(scenario)) f.report();
    assert.equal((await turn.finish({ ok: true })).ok, true);
    assert.equal(calls, 0);
  });
}
for (const source of ['manifest', 'inferred']) for (const result of [{ ok: true, cancelled: true }, { ok: false, failureKind: 'model-request' }, { ok: true, paused: true }]) {
  test('non-completed model result does not repair a missing package: ' + JSON.stringify(result), async t => {
    const f = fixture(t); let calls = 0;
    const turn = await f.begin({ repair: async () => { calls++; } });
    f.report(source); assert.deepEqual(await turn.finish(result), result); assert.equal(calls, 0);
  });
}
test('account or permission cancellation during missing-package repair cannot publish readiness', async t => {
  for (const boundary of ['account', 'permission']) {
    const f = fixture(t); let cancelled = false;
    const turn = await f.begin({ cancelled: () => cancelled, repair: async () => {
      f.write(); if (boundary === 'account') f.handle.deliveryOwner = { account: 'other' }; else cancelled = true;
      return { ok: true };
    } });
    f.report(); assert.equal((await turn.finish({ ok: true })).cancelled, true);
    assert.notEqual(gate.records(f.handle)[0]?.state, 'ready');
  }
});
