'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { create } = require('../main/computer-use/service.cjs');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function setup(options = {}) {
  const calls = [], events = new Set(); let active = true;
  const owner = { desktopControlScope: 'pi:chat:turn1', cwd: 'D:/workspace', inFlight: () => active,
    on(callback) { events.add(callback); return () => events.delete(callback); },
    cancel() { calls.push('cancel-owner'); active = false; for (const callback of events) callback(); } };
  const overlay = { show: async () => { calls.push('show'); }, hide: () => calls.push('hide'), dispose: () => calls.push('dispose'), ...options.overlay };
  const service = create({ sessions: () => [owner], stopRunner: ref => calls.push('stop:' + ref), ...options, overlay });
  const input = { scope: owner.desktopControlScope, cwd: owner.cwd, pid: process.pid, action: 'click' };
  return { service, calls, owner, input, emit(event) { for (const callback of events) callback(event); }, finish() { active = false; for (const callback of events) callback(); } };
}
test('begin only acknowledges after HUD is ready; repeated actions retain HUD until the owning turn ends', async () => {
  const ready = deferred(), h = setup({ overlay: { show: () => ready.promise } });
  let started = false; const pending = h.service.dispatch('/begin', h.input).then(value => { started = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(started, false);
  ready.resolve(); const lease = await pending; assert.equal(lease.ok, true);
  await h.service.dispatch('/end', { scope: h.input.scope, leaseId: lease.leaseId });
  assert.equal(h.calls.includes('hide'), false);
  h.finish(); assert.equal(h.calls.includes('hide'), true);
  await h.service.dispose();
});
test('Escape revokes only active computer-control scopes and stops their owner, while a new user turn can run', async () => {
  const h = setup(), lease = await h.service.dispatch('/begin', h.input);
  h.service.cancel();
  assert.equal(h.calls.filter(x => x === 'cancel-owner').length, 1);
  assert.equal((await h.service.dispatch('/status', { scope: h.input.scope, leaseId: lease.leaseId })).cancelled, true);
  h.owner.inFlight = () => true;
  assert.equal((await h.service.dispatch('/begin', h.input)).cancelled, true);
  h.owner.desktopControlScope = 'pi:chat:turn2';
  assert.equal((await h.service.dispatch('/begin', { ...h.input, scope: h.owner.desktopControlScope })).ok, true);
  await h.service.dispose();
});
test('overlay/shortcut failure and expired heartbeat prevent input and cancel the associated run', async () => {
  const broken = setup({ overlay: { show: async () => { throw Error('shortcut unavailable'); } } });
  assert.equal((await broken.service.dispatch('/begin', broken.input)).ok, false);
  await broken.service.dispose();
  let time = 100; const h = setup({ now: () => time });
  await h.service.dispatch('/begin', h.input); time += 5001; h.service.sweep();
  assert.ok(h.calls.includes('cancel-owner')); assert.ok(h.calls.includes('hide'));
  await h.service.dispose();
});
test('explicit foreign scope cannot steal a same-directory chat; screenshots and skill availability never show control', async () => {
  const h = setup();
  assert.equal((await h.service.dispatch('/begin', { ...h.input, scope: 'pi:other:turn' })).ok, false);
  for (const action of ['shot', 'windows', 'read', 'computer-use']) assert.equal((await h.service.dispatch('/begin', { ...h.input, action })).ok, false);
  assert.deepEqual(h.calls, []); await h.service.dispose();
});
test('local Runner operation without a visible chat is cancelled through its exact job reference', async () => {
  const h = setup(), scope = 'runner:local-job:2';
  assert.equal((await h.service.dispatch('/begin', { ...h.input, scope })).ok, true);
  h.service.cancel(); assert.ok(h.calls.includes('stop:local-job'));
  assert.equal((await h.service.dispatch('/begin', { ...h.input, scope })).cancelled, true);
  await h.service.dispose();
});
test('lifecycle HTTP only accepts authenticated non-browser loopback requests', async () => {
  const h = setup(), endpoint = await h.service.start();
  try {
    const request = (extra = {}) => fetch(endpoint.url + '/begin', { method: 'POST', body: JSON.stringify(h.input), headers: {
      'Content-Type': 'application/json', Authorization: 'Bearer ' + endpoint.token, ...extra } });
    assert.equal((await request({ Authorization: 'Bearer wrong' })).status, 403);
    assert.equal((await request({ Origin: 'https://example.com' })).status, 403);
    assert.equal((await request()).status, 200);
    assert.equal(h.calls.filter(x => x === 'show').length, 1);
  } finally { await h.service.dispose(); }
});
test('a slow HUD start is not reaped as an idle headless Runner and parallel operations wait for the same readiness', async () => {
  let time = 100, shows = 0;
  const ready = deferred(), h = setup({ now: () => time, overlay: { show: () => { shows++; return ready.promise; } } });
  const input = { ...h.input, scope: 'runner:scheduled:1' };
  const a = h.service.dispatch('/begin', input), b = h.service.dispatch('/begin', input);
  await new Promise(resolve => setImmediate(resolve));
  time += 2000; h.service.sweep(); assert.equal(h.calls.includes('hide'), false);
  ready.resolve(); assert.equal((await a).ok, true); assert.equal((await b).ok, true); assert.equal(shows, 1);
  await h.service.dispose();
});
test('known Runner chats cannot submit an outdated scope as a headless operation', async () => {
  const h = setup(); h.owner.sessionId = 'local-job'; h.owner.desktopControlScope = 'runner:local-job:4';
  assert.equal((await h.service.dispatch('/begin', { ...h.input, scope: 'runner:local-job:3' })).cancelled, true);
  assert.deepEqual(h.calls, []); await h.service.dispose();
});
test('cancellation during renderer startup refuses ACK and cleans up a late readiness result', async () => {
  const ready = deferred(), h = setup({ overlay: { show: () => ready.promise } });
  const pending = h.service.dispatch('/begin', h.input);
  await new Promise(resolve => setImmediate(resolve)); h.service.cancel(); ready.resolve();
  assert.equal((await pending).cancelled, true);
  assert.equal(h.calls.filter(c => c === 'cancel-owner').length, 1);
  await h.service.dispose();
});
test('a completed desktop turn never cancels a newly queued ordinary turn through a late heartbeat or Escape', async () => {
  for (const action of ['heartbeat', 'escape', 'sweep']) {
    const h = setup(), lease = await h.service.dispatch('/begin', h.input);
    await h.service.dispatch('/end', { scope: h.input.scope, leaseId: lease.leaseId });
    const late = await h.service.dispatch('/begin', h.input);
    h.owner.desktopControlScope = 'pi:chat:next-turn'; // inFlight remains true because work is queued.
    if (action === 'heartbeat') assert.equal((await h.service.dispatch('/status', { scope: h.input.scope, leaseId: late.leaseId })).cancelled, true);
    else if (action === 'escape') h.service.cancel();
    else h.service.sweep();
    assert.equal(h.calls.includes('cancel-owner'), false, action);
    assert.ok(h.calls.includes('hide'), action); await h.service.dispose();
  }
});
test('real completion events clear HUD even when an image/ordinary message is still queued on that handle', async () => {
  for (const [scope, kind] of [['pi:chat:turn1', 'turn-finished'], ['runner:chat:1', 'settled']]) {
    const h = setup(); h.owner.desktopControlScope = scope;
    await h.service.dispatch('/begin', { ...h.input, scope });
    h.emit({ kind }); assert.ok(h.calls.includes('hide')); h.service.cancel();
    assert.equal(h.calls.includes('cancel-owner'), false); await h.service.dispose();
  }
});
