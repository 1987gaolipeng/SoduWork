'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { create } = require('../main/conversation/account-sync');
const { identity } = require('./helpers/platform-session-fixture.cjs');

function fixture(t, fetch) {
  let current = identity();
  const sync = create({ app: {}, identityOf: () => current, localIdentityOf: () => current,
    store: { jobs: () => [] }, fetch });
  t.after(() => sync.close());
  return { sync, actor: value => { current = value; } };
}
test('account history drains more than 100 conversations before returning a complete directory', async t => {
  const calls = [];
  const f = fixture(t, async (_actor, route) => {
    const after = Number(new URL(route).searchParams.get('after')); calls.push(after);
    const items = Array.from({ length: after ? 5 : 100 }, (_, i) => ({ id: 'conversation-' + (after + i + 1) }));
    return new Response(JSON.stringify({ items, cursor: after + items.length, hasMore: !after }));
  });
  const result = await f.sync.history();
  assert.equal(result.ok, true); assert.equal(result.chats.length, 105); assert.deepEqual(calls, [0, 100]);
});
test('account history rejects a late page after an account or Hub change', async t => {
  for (const changed of [identity('two'), { ...identity(), hub: 'https://other.invalid' }]) {
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const f = fixture(t, async () => { entered(); await gate; return new Response(JSON.stringify({ items: [{ id: 'private' }] })); });
    const request = f.sync.history(); await ready; f.actor(changed); release();
    const result = await request;
    assert.equal(result.ok, false); assert.deepEqual(result.chats, []);
  }
});
test('a repeating directory cursor fails without returning a silently truncated history', async t => {
  const f = fixture(t, async () => new Response(JSON.stringify({ items: [{ id: 'one' }], cursor: 0, hasMore: true })));
  const result = await f.sync.history();
  assert.equal(result.ok, false); assert.deepEqual(result.chats, []);
});
