'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const sessions = require('../main/pi-session/session');
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-fixture-cleanup-'));
function address(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'agent/models.json'), 'utf8')).providers.soduwork.baseUrl;
}
test('aborting initialization closes the real fixture HTTP listener and disposes a late session', { timeout: 20000 }, async t => {
  const root = temporary(), controller = new AbortController();
  const original = sessions.open, stopped = [];
  let release, f;
  t.signal.addEventListener('abort', () => controller.abort(), { once: true });
  t.after(async () => {
    controller.abort(); sessions.open = original; release?.(); await f?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  f = await require('../e2e/fixtures/resumed-pi.cjs').create(root, { signal: controller.signal });
  assert.equal((await fetch(address(root))).status, 500, 'the isolated listener was actually running');
  sessions.open = () => new Promise(resolve => { release = () => resolve({ ok: true, session: {
    cancel: () => stopped.push('cancel'), close: () => stopped.push('close'),
  } }); });
  const opening = f.open();
  const rejected = assert.rejects(opening, /abort|closed/i);
  controller.abort(); await f.close();
  await assert.rejects(fetch(address(root), { signal: AbortSignal.timeout(2000) }), /fetch failed/);
  release(); await rejected;
  assert.deepEqual(stopped, ['cancel', 'close']);
});
for (const name of ['mcp-cancellation-server', 'steering-lifecycle']) {
  test(name + ' initialization failure releases its real HTTP listener and monitor hook', { timeout: 20000 }, async t => {
    const root = temporary(), original = sessions.open, controller = new AbortController();
    const control = require('../main/pi-session/run-control'), monitor = control.startMonitor;
    t.signal.addEventListener('abort', () => controller.abort(), { once: true });
    t.after(() => {
      controller.abort(); sessions.open = original; fs.rmSync(root, { recursive: true, force: true });
    });
    sessions.open = async () => ({ ok: false, reason: 'isolated initialization failure' });
    await assert.rejects(require('../e2e/fixtures/' + name + '.cjs').create(root, { signal: controller.signal }), /isolated initialization failure/);
    assert.equal(control.startMonitor, monitor);
    await assert.rejects(fetch(address(root), { signal: AbortSignal.timeout(2000) }), /fetch failed/);
  });
}
