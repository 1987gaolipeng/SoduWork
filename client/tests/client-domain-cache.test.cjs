'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { create, actor } = require('../main/client-domain-cache.cjs');
const settle = () => new Promise(resolve => setImmediate(resolve));
function identity(user = 'alice', device = 'desktop', version = 1) {
  return { hub: 'https://fixture.invalid', clientId: device,
    session: Buffer.from(JSON.stringify({ typ: 'device', uid: user, cid: device, ver: version })).toString('base64url') + '.fixture' };
}
function fixture(t, request = async () => ({ items: [] })) {
  let current = identity(), at = 1000, confirmed = false, calls = 0;
  const timers = new Set(), wake = new Map(), changes = [];
  const cache = create({ identityOf: async () => current, now: () => at,
    discovery: { register(topic, fn) { wake.set(topic, fn); return () => wake.delete(topic); }, confirmed: () => confirmed },
    setTimeout(fn, ms) { const timer = { fn, at: at + ms, unref() {} }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); }, changed: (...args) => changes.push(args),
    fetch: async (...args) => { calls++; const value = await request(...args); return value instanceof Response ? value : new Response(JSON.stringify(value)); } });
  t.after(() => cache.close());
  return { cache, wake, changes, calls: () => calls, scope: () => actor(current), setIdentity: value => { current = value; },
    confirm: value => { confirmed = value; },
    async advance(ms) { at += ms; for (const timer of [...timers]) if (timer.at <= at) { timers.delete(timer); timer.fn(); } await settle(); },
    read: () => cache.read('conversation-projects', actor(current)) };
}
test('windows share one authenticated project snapshot and cannot mutate its cached rows', async t => {
  const f = fixture(t, async () => ({ items: [{ id: 'one', name: 'Original' }] }));
  const values = await Promise.all(Array.from({ length: 20 }, () => f.read()));
  assert.equal(f.calls(), 1); values[0].items[0].name = 'Local edit';
  assert.equal((await f.read()).items[0].name, 'Original');
});
test('old and mixed Hubs retain the legacy bound; confirmed domains use low frequency reconciliation', async t => {
  const f = fixture(t); await f.read(); await f.advance(10001); await f.read(); assert.equal(f.calls(), 2);
  f.confirm(true); await f.advance(10001); await f.read(); assert.equal(f.calls(), 2);
  f.confirm(false); await f.read(); assert.equal(f.calls(), 3);
});
test('pushes during an older server snapshot collapse into one trailing fetch', async t => {
  let release, entered, version = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, async () => {
    const snapshot = ++version;
    if (snapshot === 1) { entered(); await new Promise(resolve => { release = resolve; }); }
    return { items: [{ id: 'one', revision: snapshot }] };
  });
  const pending = f.read(); await ready;
  await Promise.all(Array.from({ length: 100 }, () => f.cache.invalidate('conversation-projects', f.scope())));
  release(); assert.equal((await pending).items[0].revision, 2); assert.equal(f.calls(), 2);
  await f.advance(50); assert.equal(f.changes.length, 1);
});
test('a continuous invalidation storm cannot starve UI reads or loop without backoff', async t => {
  const f = fixture(t, async () => {
    await f.cache.invalidate('conversation-projects', f.scope());
    return {items: [{id: 'one', revision: f.calls()}]};
  });
  assert.equal((await f.read()).items[0].revision, 2);
  for (let i = 0; i < 100; i++) await f.read();
  assert.equal(f.calls(), 2);
  await f.advance(1000); assert.equal(f.calls(), 4);
});
test('pending notifications from an old scope cannot suppress the new account wake', async t => {
  const f = fixture(t); await f.read();
  await f.cache.invalidate('conversation-projects', f.scope());
  f.setIdentity(identity('bob')); await f.read();
  await f.cache.invalidate('conversation-projects', f.scope());
  await f.advance(50);
  assert.equal(f.changes.length, 1); assert.equal(f.changes[0][1].userId, 'bob');
});
test('offline reads back off even when every window and push asks for a refresh', async t => {
  const f = fixture(t, async () => { throw Error('offline'); });
  await assert.rejects(f.read(), /offline/);
  for (let i = 0; i < 100; i++) {
    await f.cache.invalidate('conversation-projects', f.scope());
    await assert.rejects(f.read(), /offline/);
  }
  assert.equal(f.calls(), 1); await f.advance(5000); assert.equal(f.calls(), 2);
});
test('a new failure pushes an older reconciliation timer beyond the complete backoff', async t => {
  let attempts = 0;
  const f = fixture(t, async () => { if (++attempts === 2) throw Error('offline'); return {items: []}; });
  f.confirm(true); await f.read(); await f.advance(119000);
  await f.cache.invalidate('conversation-projects', f.scope()); await assert.rejects(f.read(), /offline/);
  await f.advance(1000); assert.equal(f.calls(), 2);
  await f.advance(3999); assert.equal(f.calls(), 2);
  await f.advance(1); assert.equal(f.calls(), 3);
});
test('push and reconnect wakes refresh an active snapshot without a renderer read', async t => {
  let revision = 1;
  const f = fixture(t, async () => ({items: [{id: 'one', revision}]}));
  f.confirm(true); await f.read(); revision = 2;
  f.wake.get('conversation-projects')(); await settle();
  await f.advance(1000); assert.equal(f.calls(), 2);
  assert.equal((await f.read()).items[0].revision, 2);
});
test('late reads and cached data cannot cross account, device or authorization versions', async t => {
  for (const next of [identity('bob'), identity('alice', 'other'), identity('alice', 'desktop', 2)]) {
    let release, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const f = fixture(t, async () => { entered(); await new Promise(resolve => { release = resolve; }); return { items: [{ id: 'private' }] }; });
    const pending = f.read(); await ready; f.setIdentity(next); release(); await assert.rejects(pending, /账号或设备/);
  }
});
test('an obsolete renderer cannot read or invalidate the newly signed in account', async t => {
  const f = fixture(t), previous = f.scope(); f.setIdentity(identity('bob'));
  await assert.rejects(f.cache.read('conversation-projects', previous), /账号或设备/);
  await assert.rejects(f.cache.invalidate('conversation-projects', previous), /账号或设备/);
  assert.equal(f.calls(), 0);
  await assert.rejects(f.cache.read('../../client-auth/me', f.scope()), /不支持/);
});
test('local writes invalidate fresh cache and reconciliation repairs a missed event', async t => {
  let revision = 1; const f = fixture(t, async () => ({ items: [{ id: 'one', revision }] }));
  f.confirm(true); await f.read(); revision = 2;
  await f.cache.invalidate('conversation-projects', f.scope()); assert.equal((await f.read()).items[0].revision, 2);
  revision = 3; await f.advance(120000); assert.equal((await f.read()).items[0].revision, 3);
});
test('model metadata is shared only under its confirmed topic and invalidation refreshes all callers', async t => {
  let model = 'first';
  const f = fixture(t, async () => ({providers: [], usable: [{name: model}], myModels: []}));
  const read = () => f.cache.read('models', f.scope());
  await Promise.all(Array.from({length: 8}, read)); assert.equal(f.calls(), 1);
  await read(); assert.equal(f.calls(), 2, 'old Hub explicit model reload remains a real read');
  f.confirm(true); await read(); assert.equal(f.calls(), 2);
  model = 'second'; await f.cache.invalidate('models', f.scope());
  assert.equal((await read()).usable[0].name, 'second');
});
test('configuration keeps its exact shape and personal caches cannot cross devices', async t => {
  const f = fixture(t, async () => ({theme: 'dark', dockVisible: false}));
  f.confirm(true);
  assert.deepEqual(await f.cache.read('config', f.scope()), {theme: 'dark', dockVisible: false});
  f.setIdentity(identity('alice', 'second-device'));
  await f.cache.read('config', f.scope()); assert.equal(f.calls(), 2);
});
test('periodic reads use the renewed session directly while retaining the same account fence', async t => {
  const sessions = [], original = identity();
  const f = fixture(t, async current => { sessions.push(current.session); return {items: []}; });
  f.confirm(true); await f.read();
  const claims = JSON.parse(Buffer.from(original.session.split('.')[0], 'base64url'));
  const renewed = {...original, session: Buffer.from(JSON.stringify({...claims, jti: 'renewed'})).toString('base64url') + '.fixture'};
  f.setIdentity(renewed); await f.advance(120000);
  assert.deepEqual(sessions, [original.session, renewed.session]);
});
test('message consumers share one folder snapshot only after its specific capability is confirmed', async t => {
  const f = fixture(t, async () => ({ok: true, folder: 'received', items: [], nextCursor: '', revision: 'current'}));
  const read = () => f.cache.read('team-messages-received', f.scope());
  await assert.rejects(read(), error => error.code === 'DOMAIN_POLL_FALLBACK'); assert.equal(f.calls(), 0);
  f.confirm(true); await Promise.all(Array.from({length: 8}, read)); assert.equal(f.calls(), 1);
  await f.advance(60000); await read(); assert.equal(f.calls(), 1);
  f.wake.get('team-messages')(); await settle(); await f.advance(1000); assert.equal(f.calls(), 2);
  f.confirm(false); await assert.rejects(read(), error => error.code === 'DOMAIN_POLL_FALLBACK');
  await f.advance(120000); assert.equal(f.calls(), 2, 'capability loss also stops unconditional background message reads');
});
test('cached transports retain HTTP status and structured failure details, including non-JSON proxies', async t => {
  const body = {detail: {code: 'SERVICE_BUSY', message: 'Busy', retryable: true}};
  const f = fixture(t, async () => new Response(JSON.stringify(body), {status: 503}));
  await assert.rejects(f.read(), error => error.status === 503 && error.httpBody.detail.code === 'SERVICE_BUSY');
  const html = fixture(t, async () => new Response('<html>Unavailable</html>', {status: 503}));
  await assert.rejects(html.read(), error => error.status === 503);
});
test('only a current HTTP response or transport failure reports reachability, never a snapshot or replayed error', async t => {
  let failure;
  const f = fixture(t, async () => { if (failure) throw failure; return {items: []}; });
  const states = [], read = () => f.cache.read('conversation-projects', f.scope(), online => states.push(online));
  f.confirm(true); await read(); await read(); assert.deepEqual(states, [true]);
  failure = Error('offline'); await f.cache.invalidate('conversation-projects', f.scope());
  await assert.rejects(read(), /offline/); await assert.rejects(read(), /offline/);
  assert.deepEqual(states, [true, false]);
  const http = fixture(t, async () => new Response('{}', {status: 503}));
  const httpStates = [], readHttp = () => http.cache.read('conversation-projects', http.scope(), value => httpStates.push(value));
  await assert.rejects(readHttp()); await assert.rejects(readHttp()); assert.deepEqual(httpStates, [true]);
});
