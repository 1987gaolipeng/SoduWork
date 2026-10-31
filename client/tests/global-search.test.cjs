'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../components/workspace/global-search-core');
const nativeSearch = require('../main/conversation/search.cjs');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('keywords rank exact titles, prefixes and body matches; snippets preserve text safely', () => {
  const rows = core.rank([{ id: 'body', text: 'release notes', title: 'Other' }, { id: 'prefix', title: 'Release notes' }, { id: 'exact', title: 'release' }], 'release');
  assert.deepEqual(rows.map(row => row.id), ['exact', 'prefix', 'body']);
  assert.equal(core.match({ title: '版本更新', text: '中英文说明' }, '版本 英文') >= 0, true);
  assert.equal(core.match({ title: '其他' }, '版本'), -1);
  assert.match(core.snippet('x'.repeat(200) + 'release notes', 'release'), /^…x+release notes$/);
  assert.equal(core.rank([{ id: 'old', at: 1 }, { id: 'new', at: 2 }], '')[0].id, 'new');
});

test('sources settle independently and expose failures instead of empty success', async () => {
  const pending = deferred(), updates = [];
  const search = core.create({ scope: () => 'a', update: value => updates.push(value), sources: [
    { id: 'slow', categories: ['chats'], load: () => pending.promise },
    { id: 'fast', categories: ['tasks'], load: async () => ({ rows: [{ id: 'fast', title: 'hit' }] }) },
    { id: 'failed', categories: ['library'], load: async () => { throw Error('offline'); } },
  ] });
  const complete = search.search('hit'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(updates.at(-1).rows[0].id, 'fast');
  assert.equal(updates.at(-1).sources.slow.status, 'loading');
  assert.equal(updates.at(-1).sources.failed.status, 'error');
  pending.resolve({ rows: [] }); await complete;
  assert.equal(updates.at(-1).sources.slow.status, 'ready');
});

test('late queries, account changes and modal cancellation cannot restore stale results', async () => {
  for (const reason of ['query', 'account', 'close']) {
    let owner = 'a'; const pending = deferred(), updates = [];
    const search = core.create({ scope: () => owner, update: value => updates.push(value), sources: [{ id: 'one', categories: ['chats'], load: q => q === 'old' ? pending.promise : { rows: [{ id: 'new', title: 'new' }] } }] });
    const old = search.search('old'); await Promise.resolve();
    if (reason === 'query') await search.search('new');
    else if (reason === 'account') owner = 'b';
    else search.cancel();
    const count = updates.length; pending.resolve({ rows: [{ id: 'old', title: 'old' }] }); await old;
    assert.equal(updates.length, count, reason);
    assert.equal(updates.some(value => value.rows.some(row => row.id === 'old')), false);
  }
});

test('timeout, denied permission and incomplete sources have distinct statuses', async () => {
  let result;
  const search = core.create({ scope: () => 'a', timeout: 10, update: value => { result = value; }, sources: [
    { id: 'timeout', categories: ['chats'], load: () => new Promise(() => {}) },
    { id: 'denied', categories: ['tasks'], load: () => { throw Object.assign(Error('denied'), { status: 403 }); } },
    { id: 'partial', categories: ['plugins'], load: () => ({ rows: [{ id: 'one', title: 'Plugin' }], partial: true }) },
  ] });
  await search.search('');
  assert.equal(result.sources.timeout.status, 'error'); assert.equal(result.sources.denied.status, 'denied');
  assert.equal(result.sources.partial.status, 'partial');
});

test('cached titles render synchronously and progress does not wait for a slow body source', async () => {
  const pending = deferred(), updates = [];
  let progress;
  const service = core.create({ scope: () => 'a', update: value => updates.push(value), sources: [{
    id: 'chats', categories: ['chats'], peek: () => ({ rows: [{ type: 'chats', id: 'one', title: 'needle title' }] }),
    load: (_query, _current, publish) => { progress = publish; return pending.promise; },
  }] });
  service.preview('needle');
  assert.equal(updates.at(-1).rows[0].title, 'needle title');
  const running = service.search('needle'); await Promise.resolve();
  progress({ rows: [{ type: 'chats', id: 'one', title: 'needle title', text: 'body result' }] });
  assert.equal(updates.at(-1).rows.length, 1); assert.equal(updates.at(-1).rows[0].text, 'body result');
  assert.equal(updates.at(-1).sources.chats.status, 'loading');
  service.preview('other'); const count = updates.length;
  progress({ rows: [{ id: 'stale', title: 'other' }] });
  pending.resolve({ rows: [{ id: 'stale', title: 'other' }] }); await running;
  assert.equal(updates.length, count);
});

test('metadata cache shares in-flight reads, expires, and fences scope changes and explicit invalidation', async () => {
  let owner = 'a', now = 1, calls = 0;
  const cache = core.createCache({ scope: () => owner, clock: () => now, ttl: 10, maxEntries: 2 });
  const pending = deferred(), loader = () => { calls++; return pending.promise; };
  const first = cache.load('list', loader), second = cache.load('list', loader);
  pending.resolve(['one']); assert.deepEqual(await first, ['one']); await second;
  assert.equal(calls, 1); assert.deepEqual(cache.peek('list'), ['one']);
  await cache.load('list', () => { throw Error('unneeded'); });
  now = 12; assert.equal(cache.peek('list'), undefined);
  assert.deepEqual(await cache.load('list', () => ['updated']), ['updated']);
  owner = 'b'; assert.equal(cache.peek('list'), undefined);
  const late = deferred(), old = cache.load('late', () => late.promise);
  cache.clear(); late.resolve(['private']); await assert.rejects(old, /STALE_SEARCH_SCOPE/);
  assert.equal(cache.peek('late'), undefined);
  await assert.rejects(cache.load('failure', () => { throw Error('offline'); }), /offline/);
  assert.deepEqual(await cache.load('failure', () => ['recovered']), ['recovered']);
});

function nativeFixture(rows, read, extra = {}) {
  let owner = 'a';
  const access = { actor: () => ({ owner }), assertCurrent(_app, captured) { if (owner !== captured.owner) throw Error('switched'); },
    assertOwner(_app, id) { if (id === 'other-user') throw Error('denied'); } };
  return { search: nativeSearch.create({ app: { getPath: () => path.join(__dirname, 'not-created-search-fixture') },
    session: { history: async () => ({ ok: true, chats: rows }) }, access, read, ...extra }), switchAccount: () => { owner = 'b'; } };
}
test('native search filters ownership, reads paged local text and never fetches cloud bodies', async () => {
  const reads = [];
  const fixture = nativeFixture([{ id: 'title', title: 'release' }, { id: 'body', title: 'Other' }, { id: 'cloud', cloud: true, title: 'Remote' }, { id: 'other-user', title: 'release secret' }], async (_method, p) => {
    reads.push(p.id);
    return p.offset ? { format: 'messages', items: [{ text: 'release body' }], nextOffset: null } : { format: 'messages', items: [{ text: 'hello' }], nextOffset: 1 };
  });
  const result = await fixture.search.search('release');
  assert.deepEqual(result.chats.map(row => row.id).sort(), ['body', 'title']);
  assert.equal(result.chats.find(row => row.id === 'body').messageIndex, 1);
  assert.equal(result.partial, true); assert.deepEqual(reads, ['body', 'body']);
});
test('native searches are fenced across account switches and superseding queries', async () => {
  for (const change of ['account', 'cancel', 'new-query']) {
    const pending = deferred(), fixture = nativeFixture([{ id: 'body', title: 'Title' }], async () => pending.promise);
    const result = fixture.search.search('needle'); await new Promise(resolve => setImmediate(resolve));
    if (change === 'account') fixture.switchAccount();
    else if (change === 'cancel') fixture.search.cancel();
    else await fixture.search.search('Title');
    pending.resolve({ format: 'messages', items: [{ text: 'needle' }], nextOffset: null });
    await assert.rejects(result, /switched|SEARCH_CANCELLED/);
  }
});
test('native read errors and pagination limits return partial coverage, not fabricated matches', async () => {
  const fixture = nativeFixture([{ id: 'failed', title: 'Fail' }, { id: 'huge', title: 'Huge' }], async (_method, p) => {
    if (p.id === 'failed') throw Error('unreadable');
    return { format: 'messages', items: [{ text: 'other' }], nextOffset: p.offset + 1 };
  }, { maxPages: 2 });
  const result = await fixture.search.search('needle');
  assert.equal(result.chats.length, 0); assert.equal(result.partial, true);
});
test('native search bounds returned body excerpts while preserving a multi-keyword match', async () => {
  const fixture = nativeFixture([{ id: 'body', title: 'Other' }], async () => ({ format: 'messages', items: [{ text: 'alpha ' + 'x'.repeat(5000) + ' omega' }], nextOffset: null }));
  const result = await fixture.search.search('alpha omega');
  assert.equal(result.chats.length, 1); assert.ok(result.chats[0].text.length <= 362);
  assert.equal(core.rank(result.chats, 'alpha omega').length, 1);
});
test('native body pages are reused only for a current archive revision and account', async () => {
  const row = { id: 'archive', title: 'Chat', path: path.join(__dirname, 'archive.jsonl'), count: 2, at: 100 };
  let calls = 0, text = 'alpha beta';
  const fixture = nativeFixture([row], async () => { calls++; return { format: 'messages', items: [{ text }], nextOffset: null }; });
  await fixture.search.search('alpha'); await fixture.search.search('beta'); assert.equal(calls, 1);
  row.count++; text = 'gamma';
  assert.equal((await fixture.search.search('alpha')).chats.length, 0); assert.equal(calls, 2);
  fixture.switchAccount(); await fixture.search.search('gamma'); assert.equal(calls, 3);
  fixture.search.dispose(); await fixture.search.search('gamma'); assert.equal(calls, 4);
});
test('local search adapter reads actual archives without a Runner or agent process', async t => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'soduwork-fast-search-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, local = nativeSearch.localSession(require('../main/pi-session/session'));
  const directory = path.join(require('../main/pi-session/model-config').agentDir(app), 'sessions', 'fixture');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'fixture.jsonl'), [
    { type: 'session', id: 'local-fast-search', timestamp: new Date().toISOString(), cwd: root },
    { type: 'message', id: 'one', message: { role: 'user', content: [{ type: 'text', text: 'A question' }], timestamp: Date.now() } },
    { type: 'message', id: 'two', message: { role: 'assistant', content: [{ type: 'text', text: 'needle from local archive' }], timestamp: Date.now() } },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const access = { actor: () => ({ owner: 'fixture' }), assertCurrent() {}, assertOwner() {} };
  const reader = require('../main/app-readonly-history.cjs').create({ app, session: local, access });
  let reads = 0;
  const service = nativeSearch.create({ app, session: local, access, read: (...args) => { reads++; return reader(...args); } });
  const firstAt = performance.now();
  const result = await service.search('needle');
  const firstMs = performance.now() - firstAt, secondAt = performance.now();
  await service.search('archive');
  const nextMs = performance.now() - secondAt;
  assert.equal(reads, 1);
  t.diagnostic(JSON.stringify({ localFixtureColdMs: Math.round(firstMs), localFixtureWarmMs: Math.round(nextMs), bodyReadsForTwoQueries: reads }));
  assert.equal(result.chats.length, 1); assert.equal(result.chats[0].id, 'local-fast-search');
  assert.match(result.chats[0].text, /local archive/);
});
test('native search reads an actual JSONL archive through the existing safe reader', async t => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'soduwork-search-archive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'pi-agent', 'sessions', 'project', 'fixture.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    { type: 'session', id: 'real-archive' },
    { type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: '普通问题' }] } },
    { type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: '实际存档中的 release 中文说明' }] } },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const app = { getPath: () => root }, access = { actor: () => ({ owner: 'fixture' }), assertCurrent() {}, assertOwner() {} };
  const session = { history: async () => ({ ok: true, chats: [{ id: 'real-archive', title: 'Chat' }] }),
    archivedConversation: async () => ({ id: 'real-archive' }), historyEntry: async () => ({ ok: true, entry: { path: file } }) };
  const read = require('../main/app-readonly-history.cjs').create({ app, session, access });
  const service = nativeSearch.create({ app, session, access, read });
  const result = await service.search('release 中文');
  assert.equal(result.chats.length, 1); assert.equal(result.partial, false);
  assert.match(result.chats[0].text, /实际存档/);
  session.historyEntry = async () => ({ ok: true, entry: { path: path.join(root, 'outside.jsonl') } });
  fs.writeFileSync(path.join(root, 'outside.jsonl'), fs.readFileSync(file));
  const blocked = await service.search('release');
  assert.equal(blocked.chats.length, 0); assert.equal(blocked.partial, true);
});

test('archive path canonicalization preserves same-root reads and refuses junctions and outside files', async t => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'soduwork-search-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, 'pi-agent'), directory = path.join(base, 'sessions');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'fixture.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'message', message: { role: 'user', content: 'trusted archive' } }) + '\n');
  let selected = fs.realpathSync.native(file);
  const app = { getPath: () => root }, access = { actor: () => ({ owner: 'fixture' }), assertCurrent() {}, assertOwner() {} };
  const session = { archivedConversation: async () => ({ id: 'fixture', adapterId: 'pi' }),
    historyEntry: async () => ({ ok: true, entry: { path: selected } }) };
  const read = require('../main/app-readonly-history.cjs').create({ app, session, access });
  assert.equal((await read('conversations.messages', { id: 'fixture' })).items[0].text, 'trusted archive');
  const linked = path.join(base, 'linked');
  fs.symlinkSync(directory, linked, process.platform === 'win32' ? 'junction' : 'dir');
  selected = path.join(linked, 'fixture.jsonl');
  await assert.rejects(read('conversations.messages', { id: 'fixture' }), /链接|联接点/);
  selected = path.join(root, 'outside.jsonl');
  fs.copyFileSync(file, selected);
  await assert.rejects(read('conversations.messages', { id: 'fixture' }), /路径不受信任/);
});

test('an application-owned profile can use a parent alias without permitting archive-root links', async t => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'soduwork-search-profile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, 'profile'), alias = path.join(root, 'profile-alias');
  const base = path.join(profile, 'pi-agent'), directory = path.join(base, 'sessions');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'fixture.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'message', message: { role: 'user', content: 'trusted profile' } }) + '\n');
  fs.symlinkSync(profile, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const app = { getPath: () => alias }, access = { actor: () => ({ owner: 'fixture' }), assertCurrent() {}, assertOwner() {} };
  let selected = path.join(alias, 'pi-agent', 'sessions', 'fixture.jsonl');
  const session = { archivedConversation: async () => ({ id: 'fixture', adapterId: 'pi' }),
    historyEntry: async () => ({ ok: true, entry: { path: selected } }) };
  const read = require('../main/app-readonly-history.cjs').create({ app, session, access });
  assert.equal((await read('conversations.messages', { id: 'fixture' })).items[0].text, 'trusted profile');
  selected = fs.realpathSync.native(file);
  assert.equal((await read('conversations.messages', { id: 'fixture' })).items[0].text, 'trusted profile');
  fs.renameSync(base, path.join(profile, 'moved'));
  fs.symlinkSync(path.join(profile, 'moved'), base, process.platform === 'win32' ? 'junction' : 'dir');
  selected = path.join(base, 'sessions', 'fixture.jsonl');
  await assert.rejects(read('conversations.messages', { id: 'fixture' }), /链接|联接点/);
});

function sourceFixture(overrides = {}) {
  const routes = [], window = { SoduWorkSearchCore: core, SoduWorkI18n: { translateText: text => text },
    SoduWorkAPI: { taskStorageKey: () => 'account-a', ...overrides },
    WorkspaceHost: { open: (...args) => routes.push(args) },
    WorkspaceShell: { projectForChat: () => null, searchProjects: () => [] },
    ShortcutBindings: require('../core/shortcut-bindings'),
    soduWorkAPI: {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/workspace/global-search-sources.js'), 'utf8'), { window });
  return { window, api: window.SoduWorkSearchSources, routes };
}
test('catalog results separate installed apps, plugins, disabled entries and denied entries', async () => {
  const app = { pluginId: 'app', name: 'App', installed: true, ui: { contributions: [{ slot: 'workspace.navigation' }] } };
  const f = sourceFixture({ pluginCatalog: async () => ({ remoteError: 'offline', items: [app, { ...app, pluginId: 'market', installed: false },
    { pluginId: 'plugin', name: 'Plugin' }, { pluginId: 'disabled', name: 'No', enabled: false }, { pluginId: 'denied', name: 'No', permissions: { canUse: false } }] }) });
  const result = await f.api.createSources().find(source => source.id === 'catalog').load('');
  assert.deepEqual(Array.from(result.rows, row => [row.type, row.id]), [['apps', 'app'], ['plugins', 'plugin']]);
  assert.equal(result.partial, true);
});
test('library searches span folders, find note text and never parse binary documents', async () => {
  const reads = [], filters = [], f = sourceFixture({ listLibrary: async filter => { filters.push(filter); return { items: [
    { id: 'nested', title: 'Notes', filename: 'notes.md', folderId: 'nested-folder', contentType: 'text/markdown', size: 30 },
    { id: 'binary', title: 'Report', filename: 'report.pdf', size: 30 },
    { id: 'removed', title: 'Deleted', deletedAt: '2026-01-01' },
  ] }; }, readLibraryContent: async id => { reads.push(id); return { content: 'release details' }; } });
  const result = await f.api.createSources().find(source => source.id === 'library-local').load('release');
  assert.equal(filters[0].scope, 'recommended'); assert.deepEqual(reads, ['nested']);
  assert.deepEqual(Array.from(core.rank(result.rows, 'release'), row => row.id), ['nested']);
});
test('typing reuses list and note reads; title results arrive before unread notes', async () => {
  const pending = deferred(), updates = []; let lists = 0, reads = 0;
  const f = sourceFixture({ listLibrary: async () => { lists++; return { items: [{ id: 'note', title: 'alpha title', filename: 'note.txt', contentType: 'text/plain', updatedAt: 1, size: 30 }] }; },
    readLibraryContent: () => { reads++; return pending.promise; } });
  const source = f.api.createSources().find(item => item.id === 'library-local');
  const searching = source.load('beta', () => true, result => updates.push(result));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updates[0].rows[0].title, 'alpha title'); assert.equal(reads, 1);
  pending.resolve({ content: 'beta gamma body' }); await searching;
  assert.equal(core.rank(source.peek('alpha').rows, 'alpha')[0].id, 'note');
  assert.equal(core.rank((await source.load('gamma')).rows, 'gamma')[0].id, 'note');
  assert.equal(lists, 1); assert.equal(reads, 1);
  source.invalidate(); await source.load('alpha'); assert.equal(lists, 2);
});
test('local body hits publish while remote conversation inventory is still pending', async () => {
  const f = sourceFixture(), pending = deferred(), updates = [];
  f.window.WorkspaceShell.searchChats = () => [{ id: 'sidebar', title: 'needle sidebar' }];
  f.window.soduWorkAPI.conversationSession = { history: async () => ({ chats: [] }), searchHistory: () => pending.promise,
    search: async () => ({ ok: true, chats: [{ id: 'body', title: 'Other', text: 'needle body' }] }) };
  const source = f.api.createSources().find(item => item.id === 'chats');
  assert.equal(source.peek('needle').rows[0].id, 'sidebar');
  const searching = source.load('needle', () => true, result => updates.push(result));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(updates.some(result => result.rows.some(row => row.id === 'body')));
  pending.resolve({ ok: true, items: [{ id: 'remote', title: 'needle remote' }] });
  const result = await searching;
  assert.deepEqual(Array.from(result.rows, row => row.id).sort(), ['body', 'remote']);
});
test('remote metadata queries can find older matching files beyond the latest-500 window', async () => {
  const f = sourceFixture({ getLibraryStorageStatus: async () => ({ storage: { remote: { backend: 'nfs', configured: true, available: true } } }),
    listLibrary: async filters => ({ items: filters.query ? [{ id: 'older', title: 'release note', filename: 'note.pdf' }] : Array.from({ length: 500 }, (_, id) => ({ id: String(id), title: 'Other', filename: 'other.pdf' })) }) });
  const result = await f.api.createSources().find(source => source.id === 'library-remote').load('release');
  assert.equal(result.partial, true);
  assert.deepEqual(Array.from(core.rank(result.rows, 'release'), row => row.id), ['older']);
});
test('remote outage remains an error even when the status adapter has no cached configuration', async () => {
  const f = sourceFixture({ listLibrary: async () => ({ items: [] }), getLibraryStorageStatus: async () => ({ storage: { remote: { state: 'unavailable', configured: false, available: false } } }) });
  await assert.rejects(f.api.createSources().find(source => source.id === 'library-remote').load('release'), /UNAVAILABLE/);
});
test('search shortcuts whitelist navigation actions and respect configured bindings', async () => {
  const f = sourceFixture(); const executed = [];
  f.window.ShortcutSettings = { getRows: () => [{ id: 'open-library', title: 'Library', binding: 'Ctrl+Alt+L' }, { id: 'delete-everything', title: 'Delete' }], execute: id => executed.push(id) };
  const result = await f.api.createSources()[0].load('');
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].shortcut, 'Ctrl + Alt + L');
  await f.api.open({ type: 'actions', id: 'delete-everything' }); assert.deepEqual(executed, []);
  await f.api.open(result.rows[0]); assert.deepEqual(executed, ['open-library']);
});
test('automation results open the existing editor route without running a job', async () => {
  const f = sourceFixture(); await f.api.open({ type: 'schedules', id: 'daily' });
  assert.deepEqual(JSON.parse(JSON.stringify(f.routes)), [['schedules', { scheduleId: 'daily' }]]);
});
test('search copy registers complete English, Japanese and Korean packs after a frozen catalog', () => {
  const context = vm.createContext({ SoduWorkLocaleMessages: Object.freeze({ 'en-US': Object.freeze({ Existing: 'Existing' }) }) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../core/locales/global-search.js'), 'utf8'), context);
  const packs = context.SoduWorkLocaleMessages;
  for (const locale of ['en-US', 'ja-JP', 'ko-KR']) {
    assert.ok(packs[locale]['全局搜索']); assert.ok(packs[locale]['关闭搜索']);
    assert.deepEqual(Object.keys(packs[locale]).filter(key => key !== 'Existing').sort(), Object.keys(packs['en-US']).filter(key => key !== 'Existing').sort());
    assert.equal(Object.values(packs[locale]).every(value => typeof value === 'string' && value.trim()), true);
  }
  assert.equal(packs['en-US'].Existing, 'Existing');
});
