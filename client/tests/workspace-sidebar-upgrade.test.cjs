'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/workspace/workspace-sidebar-state.js'), 'utf8');
const HUB = 'https://hub.example.invalid';
const oldKey = ({ prefix = 'soduwork_work_sidebar_projects_v1:', stem = 'soduwork_work_tasks_v5', hub = HUB, device = 'device-a', user = 'user-a' } = {}) =>
  prefix + encodeURIComponent(stem + '@' + [hub, device, user].map(encodeURIComponent).join('@'));
const row = { id: 'saved', title: '保留的长期会话', usedHarnesses: ['pi', 'qwen'] };
const saved = () => ({ version: 1, pins: [row.id], rows: [row], projects: [{ id: 'project-a', name: '工作项目', folders: [], chatIds: [row.id] }],
  archivedProjects: [{ id: 'project-old', name: '已归档', folders: [], chatIds: ['archived'] }] });
function fixture() {
  const window = {}, values = new Map();
  vm.runInNewContext(source, { window, URL });
  let blocked = false, unreadable = false;
  const storage = { get length() { if (unreadable) throw Error('unavailable'); return values.size; },
    key: index => [...values.keys()][index] || null,
    getItem: key => { if (unreadable) throw Error('unavailable'); return values.get(key) ?? null; },
    setItem: (key, value) => { if (blocked) throw Error('quota'); values.set(key, value); } };
  const identity = { hub: HUB, device: 'device-a', user: 'user-a' };
  const api = { hubBase: () => identity.hub, clientAuthSnapshot: () => ({ clientId: identity.device, user: identity.user ? { id: identity.user } : null }),
    taskStorageKey: () => 'soduwork_work_tasks_v5@' + [identity.hub, identity.device, identity.user || 'unbound'].map(encodeURIComponent).join('@') };
  const options = () => window.WorkspaceSidebarState.accountOptions({ storage, api, legacyPins: ['unverified'] });
  return { values, storage, identity, options, block: () => { blocked = true; }, unreadable: () => { unreadable = true; },
    open: () => window.WorkspaceSidebarState.create(options()) };
}
const pins = store => Array.from(store.get().pins);

test('upgrade recovers the historical scoped prefix and task stem within the same profile and account', () => {
  const f = fixture(), key = oldKey({ prefix: 'soduwork_sidebar_projects_v1:', stem: 'soduwork_work_tasks_v5' });
  const before = JSON.stringify(saved()); f.values.set(key, before);
  const s = f.open();
  assert.deepEqual(pins(s), ['saved']);
  assert.equal(s.view([]).pinned[0].title, row.title);
  assert.deepEqual(Array.from(s.view([]).pinned[0].usedHarnesses), ['pi', 'qwen']);
  assert.equal(s.get().projects[0].name, '工作项目'); assert.equal(s.get().archivedProjects[0].name, '已归档');
  assert.equal(f.values.get(key), before, 'Migration keeps the recoverable original bytes');
  assert.ok(f.values.has(f.options().key));
});

test('the same canonical HTTPS origin and a replaced device retain the same account layout', () => {
  const f = fixture(); f.values.set(oldKey({ hub: HUB, device: 'old-device' }), JSON.stringify(saved()));
  assert.deepEqual(pins(f.open()), ['saved']); const key = f.options().key;
  f.identity.device = 'new-device'; assert.equal(f.options().key, key);
  f.identity.hub = HUB + '/'; assert.equal(f.options().key, key);
  assert.deepEqual(pins(f.open()), ['saved']);
});

test('unpin and project edits remain authoritative across restart, device replacement and old-key recovery', () => {
  const f = fixture(); f.values.set(oldKey(), JSON.stringify(saved()));
  const s = f.open(); s.togglePin('saved'); s.removeProject('project-a');
  f.identity.device = 'replacement'; const restored = f.open();
  assert.deepEqual(pins(restored), []); assert.equal(restored.get().projects.length, 0);
  assert.equal(JSON.parse(f.values.get(oldKey())).pins[0], 'saved');
});

test('an existing empty current legacy scope wins over older pinned snapshots', () => {
  const f = fixture(); f.values.set(oldKey(), JSON.stringify({ version: 1, pins: [] }));
  f.values.set(oldKey({ prefix: 'soduwork_sidebar_projects_v1:', stem: 'soduwork_work_tasks_v5' }), JSON.stringify(saved()));
  f.values.set(oldKey({ device: 'previous' }), JSON.stringify(saved()));
  assert.deepEqual(pins(f.open()), []);
});

test('unbound startup cannot read, migrate or overwrite another account layout', () => {
  const f = fixture(); f.values.set(oldKey(), JSON.stringify(saved())); f.identity.user = null;
  const before = [...f.values.entries()], pending = f.open();
  assert.deepEqual(pins(pending), []); pending.remember([row]);
  assert.throws(() => pending.togglePin(row.id), /登录/);
  assert.deepEqual([...f.values.entries()], before);
  f.identity.user = 'user-a'; assert.deepEqual(pins(f.open()), ['saved']);
  f.identity.user = 'user-b'; assert.deepEqual(pins(f.open()), []);
  f.identity.user = 'user-a'; assert.deepEqual(pins(f.open()), ['saved']);
});

test('Hub-only pins, unknown task stems, unbound rows and other users are never adopted', () => {
  const f = fixture();
  for (const key of [oldKey({ user: 'other-user' }), oldKey({ user: 'unbound' }), oldKey({ stem: 'other_tasks_v5' }),
    'soduwork_work_chat_pins_v1:' + encodeURIComponent(HUB), 'soduwork_chat_pins_v1:' + encodeURIComponent(HUB),
    'soduwork_work_sidebar_projects_v1:' + encodeURIComponent(HUB)]) f.values.set(key, JSON.stringify(saved()));
  assert.deepEqual(pins(f.open()), []);
});

for (const hub of ['http://hub.example.invalid', 'https://hub.example.invalid:444', 'https://hub.example.invalid/other',
  'https://hub.example.invalid.attacker.invalid', 'https://legacy.example.invalid', 'https://other.invalid', 'http://127.0.0.1:9080']) {
  test('upgrade cannot recover layout from unrelated service ' + hub, () => {
    const f = fixture(); f.values.set(oldKey({ hub }), JSON.stringify(saved()));
    assert.deepEqual(pins(f.open()), []);
  });
}

test('multiple conflicting obsolete device snapshots are preserved without arbitrarily restoring stale pins', () => {
  const f = fixture(); f.identity.device = 'fresh-device';
  f.values.set(oldKey({ device: 'old-a' }), JSON.stringify(saved()));
  f.values.set(oldKey({ device: 'old-b' }), JSON.stringify({ version: 1, pins: [] }));
  const before = [...f.values.entries()], s = f.open();
  assert.throws(() => s.togglePin('new'), /原数据已保留/);
  assert.deepEqual([...f.values.entries()], before);
});

test('malformed current data and migration write failure preserve every source without creating empty replacement', () => {
  const f = fixture(); f.values.set(oldKey(), '{broken');
  const s = f.open(); assert.throws(() => s.togglePin('new'), /原数据已保留/);
  assert.equal(f.values.size, 1); assert.equal(f.values.get(oldKey()), '{broken');
  const g = fixture(); g.values.set(oldKey(), JSON.stringify(saved())); g.block();
  const blocked = g.open(); assert.throws(() => blocked.togglePin('new'), /原数据已保留/);
  assert.equal(g.values.size, 1); assert.deepEqual(JSON.parse(g.values.get(oldKey())).pins, ['saved']);
  const h = fixture(); h.values.set(h.options().key, '{current broken'); h.values.set(oldKey(), JSON.stringify(saved()));
  assert.throws(() => h.open().togglePin('new'), /原数据已保留/);
  assert.equal(h.values.get(h.options().key), '{current broken');
  const empty = fixture(); empty.values.set(empty.options().key, '');
  assert.throws(() => empty.open().togglePin('new'), /原数据已保留/);
  assert.equal(empty.values.get(empty.options().key), '');
});

test('unreadable profile storage does not turn into a successful empty save', () => {
  const f = fixture(); f.values.set(oldKey(), JSON.stringify(saved())); f.unreadable();
  assert.throws(() => f.open().togglePin('new'), /原数据已保留/);
  assert.equal(f.values.size, 1);
});

test('a different window that saves during discovery remains authoritative over legacy recovery', () => {
  const f = fixture(); f.values.set(oldKey(), JSON.stringify(saved()));
  const key = f.options().key, originalRead = f.storage.getItem;
  f.storage.getItem = name => {
    if (name === oldKey()) f.values.set(key, JSON.stringify({ version: 1, pins: [], projects: [] }));
    return originalRead(name);
  };
  assert.deepEqual(pins(f.open()), []);
});
