'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const catalog = require('../main/agent-runtime/runtime-catalog');
const { createRunnerRuntimeAdapter, getRunnerSessionDetails } = require('../main/agent-runtime/runner-adapter');
const artifacts = require('../main/conversation/artifact-runtime');
const outputs = require('../main/pi-session/outputs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 300; i++) { if (check()) return; await delay(10); } throw Error('Fixture timed out'); }
function workspace(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-output-reopen-'));
  t.after(() => { artifacts.closeAll(); fs.rmSync(cwd, { recursive: true, force: true }); });
  return cwd;
}
function put(cwd, name, text, time) {
  const file = path.join(cwd, name); fs.writeFileSync(file, text);
  fs.utimesSync(file, new Date(time), new Date(time)); return file;
}
for (const spec of catalog.runnerRuntimes()) test(spec.id + ': old outputs remain readable after archive restoration and another user turn', async t => {
  const cwd = workspace(t), old = Date.now() - 86400000, recent = Date.now() - 20000;
  // Old input files sort before every output; a whole-workspace scan would
  // exhaust its bounded index before discovering any of this chat's results.
  for (let i = 0; i < 61; i++) put(cwd, 'a-input-' + i + '.txt', 'existing input', old - 86400000);
  // Qwen's real Node runtime creates this cache after writing its report.
  // Runtime internals must not crowd completed documents out of any adapter.
  const cache = path.join(cwd, 'temp', 'node-compile-cache', 'v24-fixture');
  fs.mkdirSync(cache, { recursive: true });
  for (let i = 0; i < 100; i++) put(cache, i.toString(16), 'compiled runtime', recent + 4000);
  put(cwd, 'older-result.html', '<h1>previous result</h1>', old + 1000);
  put(cwd, 'earlier-report.md', '# Earlier report', old + 2000);
  put(cwd, 'current-report.md', '# Current report', recent + 1000);
  let next = false;
  const adapter = createRunnerRuntimeAdapter({ runtimeSpec: spec,
    modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'fixture', key: 'fixture' } }) },
    runnerRuntime: { async rpc(op) {
      if (op === 'job.comment') { next = true; return { ok: true, data: { ok: true } }; }
      if (op === 'job.session') return { ok: true, data: { status: 'done', started: recent / 1000, ended: (recent + 5000) / 1000, firstStarted: old / 1000,
        items: [{ seq: 1, kind: 'user', text: 'create a website', at: new Date(old).toISOString() },
          { seq: 2, kind: 'say', text: 'older-result.html earlier-report.md' },
          { seq: 3, kind: 'user', text: 'summarize it', at: new Date(recent).toISOString() },
          { seq: 4, kind: 'say', text: 'current-report.md' }] } };
      return { ok: true, data: {} };
    } }
  });
  let session = await adapter.resumeSession({ native: { runner: { openOptions: { cwd, resumePath: 'archive-' + spec.id } } } });
  t.after(() => session.dispose());
  const handle = getRunnerSessionDetails(session).handle;
  await until(() => handle.snapshot().status === 'idle');
  assert.deepEqual(handle.outputs().map(x => x.name).sort(), ['current-report.md', 'earlier-report.md', 'older-result.html']);
  let rows = artifacts.snapshot(handle).items;
  assert.equal(rows.find(x => x.name === 'earlier-report.md').changedInTurn, false);
  assert.equal(rows.find(x => x.name === 'current-report.md').changedInTurn, true);
  const site = rows.find(x => x.name === 'older-result.html');
  const first = await artifacts.preview(handle, handle.ref, site.artifactId);
  assert.equal(first.ok, true); assert.match(await (await fetch(first.url)).text(), /previous result/);
  artifacts.closeRef(handle.ref);
  const restarted = await artifacts.preview(handle, handle.ref, site.artifactId);
  assert.equal(restarted.ok, true);
  await session.send({ text: 'continue with another question' }).completion;
  assert.equal(next, true);
  rows = artifacts.snapshot(handle).items;
  assert.ok(rows.some(x => x.artifactId === site.artifactId));
  assert.equal((await artifacts.action(handle, handle.ref, rows.find(x => x.name === 'earlier-report.md').artifactId, 'read', {})).text, '# Earlier report');
});
test('reopening retains every scanned HTML/Markdown result even if a later manifest names only the latest website', async t => {
  const cwd = workspace(t), now = Date.now();
  put(cwd, 'index.html', '<h1>new site</h1>', now);
  put(cwd, 'previous.html', '<h1>older site</h1>', now - 100000);
  put(cwd, 'previous.md', '# Older document', now - 100000);
  fs.mkdirSync(path.join(cwd, '.soduwork'));
  fs.writeFileSync(path.join(cwd, '.soduwork', 'delivery.json'), JSON.stringify({ schemaVersion: 1, deliverables: [{ path: 'index.html' }] }));
  const session = { cwd, outputSnapshot: () => outputs.scan(cwd, 0, 0) };
  const index = artifacts.snapshot(session);
  assert.equal(index.delivery.items.length, 1, 'delivery acceptance retains the existing manifest contract');
  assert.equal(index.items.length, 3, 'available file references must not be limited to the primary delivery list');
  const previous = index.items.find(x => x.name === 'previous.html');
  assert.equal(previous.primary, false);
  assert.equal((await artifacts.preview(session, 'restored-pi', previous.artifactId)).ok, true);
  assert.equal((await artifacts.action(session, 'restored-pi', index.items.find(x => x.name === 'previous.md').artifactId, 'read', {})).text, '# Older document');
});
test('a fresh conversation retains earlier turns without including pre-existing workspace files', async t => {
  const cwd = workspace(t);
  put(cwd, 'pre-existing.md', '# Existing workspace input', Date.now() - 86400000);
  let handle, round = 0, started;
  const adapter = createRunnerRuntimeAdapter({ runtimeSpec: catalog.runtime('opencode'),
    modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'fixture', key: 'fixture' } }) },
    runnerRuntime: { async rpc(op) {
      if (op === 'job.dispatch' || op === 'job.comment') {
        round++; started = Date.now();
        put(cwd, 'result-' + round + '.md', '# Result ' + round, started);
        return { ok: true, data: { ref: handle.sessionId } };
      }
      if (op === 'job.session') return { ok: true, data: { status: 'done', started: started / 1000,
        ended: Date.now() / 1000, round, items: [{ seq: round * 2 - 1, kind: 'user', text: 'create ' + round,
          at: new Date(started).toISOString() }, { seq: round * 2, kind: 'say', text: 'result-' + round + '.md' }] } };
      return { ok: true, data: {} };
    } }
  });
  const session = await adapter.createSession({ native: { runner: { openOptions: { cwd } } } });
  t.after(() => session.dispose());
  handle = getRunnerSessionDetails(session).handle;
  assert.equal((await session.send({ text: 'create 1' }).completion).ok, true);
  await delay(10);
  assert.equal((await session.send({ text: 'create 2' }).completion).ok, true);
  const rows = handle.outputSnapshot().files;
  assert.deepEqual(rows.map(x => x.name).sort(), ['result-1.md', 'result-2.md']);
  assert.equal(rows.find(x => x.name === 'result-1.md').changedInTurn, false);
  assert.equal(rows.find(x => x.name === 'result-2.md').changedInTurn, true);
});
test('an undated legacy archive keeps its recovery scope after a newly timestamped follow-up', async t => {
  const cwd = workspace(t);
  put(cwd, 'older-result.md', '# Legacy result', Date.now() - 86400000);
  let next = false;
  const adapter = createRunnerRuntimeAdapter({ runtimeSpec: catalog.runtime('opencode'),
    modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'fixture', key: 'fixture' } }) },
    runnerRuntime: { async rpc(op) {
      if (op === 'job.comment') next = true;
      if (op === 'job.session') return { ok: true, data: { status: 'done', items: next
        ? [{ seq: 3, kind: 'user', text: 'continue', at: new Date().toISOString() }, { seq: 4, kind: 'say', text: 'done' }]
        : [{ seq: 1, kind: 'user', text: 'write a report' }, { seq: 2, kind: 'say', text: 'older-result.md' }] } };
      return { ok: true, data: {} };
    } }
  });
  const session = await adapter.resumeSession({ native: { runner: { openOptions: { cwd, resumePath: 'undated' } } } });
  t.after(() => session.dispose());
  const handle = getRunnerSessionDetails(session).handle;
  await until(() => handle.snapshot().status === 'idle');
  const id = artifacts.snapshot(handle).items.find(x => x.name === 'older-result.md').artifactId;
  assert.equal((await session.send({ text: 'continue' }).completion).ok, true);
  assert.equal((await artifacts.action(handle, handle.ref, id, 'read', {})).text, '# Legacy result');
});
