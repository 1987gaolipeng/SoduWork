'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), crypto = require('node:crypto');
const materializeModule = require('../main/pi-session/attachment-materialize');
const outputCache = require('../main/conversation/cloud-output-cache');

test('attachment previews survive same-directory EXDEV with verified file replacement', async t => {
  const f = await fixture(t);
  t.mock.method(fs, 'rename', async () => { throw Object.assign(Error('managed filesystem'), { code: 'EXDEV' }); });
  const result = await f.controller.materialize({ ref: 'session', taskId: 'task' });
  assert.equal(result.ok, true);
  for (const file of result.artifacts) {
    const row = f.rows.find(row => row.id === file.attachmentId);
    assert.equal(digest(await fs.readFile(file.path)), row.sha256);
  }
});

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const attachment = (id, filename, bytes, extra = {}) => ({ id, taskId: 'task', filename, role: 'output',
  size: Buffer.byteLength(bytes), sha256: digest(bytes),
  url: '/attachments/' + id + '?ticket=fixture', ...extra });

async function fixture(t, options = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-deliverable-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const bytes = new Map([
    ['page', '<!doctype html><title>五子棋</title><link rel="stylesheet" href="assets/style.css">'],
    ['css', 'body{background:#111;color:#eee}'],
    ['shot', Buffer.from('fake-png-bytes')],
  ]);
  const rows = [
    // Exclude the entire older rejected identifier group.
    attachment('page0', 'index.html', '<!doctype html><title>old</title>',
      { evidenceMeta: { sha256: digest('<!doctype html><title>old</title>'), round: 1, category: 'primary', identifier: 'ui-old-1' }, createdAt: '2026-10-13T00:00:00Z' }),
    attachment('shot0', 'shot-old.png', 'old-shot',
      { evidenceMeta: { round: 1, category: 'primary', identifier: 'ui-old-1' }, createdAt: '2026-10-13T00:00:00Z' }),
    // The current delivery has a newer identifier group and timestamp.
    attachment('page', 'index.html', bytes.get('page'), { evidenceMeta: { sha256: digest(bytes.get('page')), round: 1, category: 'primary', identifier: 'ui-new-3' }, createdAt: '2026-10-14T03:42:00Z' }),
    attachment('css', 'assets/style.css', bytes.get('css'), { evidenceMeta: { category: 'supporting', identifier: 'ui-new-3' }, createdAt: '2026-10-14T03:42:00Z' }),
    attachment('shot', 'shot-dark.png', bytes.get('shot'), { evidenceMeta: { round: 1, category: 'primary', identifier: 'ui-new-3' }, createdAt: '2026-10-14T03:42:01Z' }),
    attachment('log', 'debug.log', 'process noise', { role: 'process' }),
  ];
  const calls = [], requests = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    requests.push({ url: req.url, headers: req.headers });
    if (req.headers.authorization !== 'Device ' + (options.session || 'fixture-session')) {
      res.statusCode = 401; return res.end('{}');
    }
    const pathname = new URL(req.url, 'http://x').pathname;
    const listMatch = pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/attachments$/);
    if (listMatch) {
      if (listMatch[1] !== 'task') { res.statusCode = 404; return res.end('missing task'); }
      if (options.listStatus) { res.statusCode = options.listStatus; return res.end('{}'); }
      options.beforeList?.();
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(rows));
    }
    const payload = bytes.get(pathname.split('/').at(-1));
    if (!payload) { res.statusCode = 404; return res.end('missing'); }
    if (options.corrupt === pathname.split('/').at(-1)) return res.end(payload.slice(0, -4));
    options.beforeDownload?.(pathname);
    res.end(payload);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const hub = 'http://127.0.0.1:' + server.address().port;
  const handle = { cwd: options.cwd === undefined ? cwd : options.cwd, deliveryOwner: 'fixture-owner' };
  const state = { handle, owner: 'fixture-owner', identity: { hub, clientId: 'fixture-device', session: 'fixture-session' } };
  const config = { app: {}, identityOf: async () => state.identity, ownerOf: () => state.owner,
    sessionOf: () => state.handle };
  const controller = materializeModule.create(config);
  return { cwd, bytes, calls, requests, controller, rows, hub, config, state };
}

test('desktop attachment IPC uses the authenticated device session when legacy secret auth is disabled', async t => {
  const f = await fixture(t), handlers = new Map();
  const main = await fs.readFile(path.join(__dirname, '../main.js'), 'utf8');
  const install = main.match(/require\('\.\/main\/pi-session\/attachment-materialize'\)\.install\(\{[\s\S]*?\}\);/);
  assert.ok(install, 'exercise the production installer wiring');
  const raw = { hub: f.hub, clientId: 'fixture-device', secret: 'fixture-secret' };
  require('node:vm').runInNewContext(install[0], {
    require: () => ({ install: options => materializeModule.install({ ...options, ownerOf: f.config.ownerOf }) }),
    app: {}, ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    _piSessions: { get: f.config.sessionOf },
    _deviceAuth: { identity: () => raw, authenticatedIdentity: async () => ({ ...raw, session: 'fixture-session' }) },
  });
  const frame = {}, event = { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false,
    getURL: () => require('node:url').pathToFileURL(path.resolve(__dirname, '../desk.html')).href } };
  const result = await handlers.get('attachment-materialize')(event, { ref: 'r', taskId: 'task', attachmentId: 'page' });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.artifacts.length, 3);
  assert.ok(f.requests.every(request => request.headers.authorization === 'Device fixture-session'));
  assert.ok(f.requests.every(request => !request.headers['x-soduwork-secret']), 'no legacy secret required');
});

test('missing login session is rejected before any attachment request', async t => {
  const f = await fixture(t);
  delete f.state.identity.session;
  await assert.rejects(f.controller.materialize({ ref: 'r', taskId: 'task' }), /登录/);
  assert.equal(f.calls.length, 0);
});

test('renewed login sessions are used for later downloads without changing ownership', async t => {
  const options = {}, f = await fixture(t, options);
  options.beforeList = () => {
    options.session = 'refreshed-session';
    f.state.identity = { ...f.state.identity, session: options.session };
  };
  const result = await f.controller.materialize({ ref: 'r', taskId: 'task' });
  assert.equal(result.artifacts.length, 3);
  assert.ok(f.requests.slice(1).every(request => request.headers.authorization === 'Device refreshed-session'));
});

test('denied list access cannot fall back to already cached files', async t => {
  const options = {}, f = await fixture(t, options);
  await f.controller.materialize({ ref: 'r', taskId: 'task' });
  f.calls.length = 0; options.listStatus = 403;
  await assert.rejects(f.controller.materialize({ ref: 'r', taskId: 'task' }), /HTTP 403/);
  assert.equal(f.calls.length, 1);
});

test('account, Hub or conversation changes reject late results before downloads', async t => {
  for (const change of ['account', 'hub', 'conversation']) {
    const options = {}, f = await fixture(t, options);
    options.beforeList = () => {
      if (change === 'account') f.state.owner = 'different-owner';
      else if (change === 'hub') f.state.identity = { ...f.state.identity, hub: 'https://other.invalid' };
      else f.state.handle = { ...f.state.handle };
    };
    await assert.rejects(f.controller.materialize({ ref: 'r', taskId: 'task' }), /会话|账号|服务/);
    assert.equal(f.calls.length, 1, change + ' never starts a download');
  }
});

test('an account switch during file download cannot publish the old account bytes', async t => {
  const options = {}, f = await fixture(t, options);
  options.beforeDownload = () => { f.state.owner = 'different-owner'; };
  await assert.rejects(f.controller.materialize({ ref: 'r', taskId: 'task' }), /账号|会话/);
  const listing = await fs.readdir(path.join(f.cwd, materializeModule.CACHE_DIR, 'task'), { recursive: true });
  assert.deepEqual(listing, [], 'neither final bytes nor temporary bytes are left behind');
});

test('attachment URLs cannot direct authenticated requests to another origin', async t => {
  const f = await fixture(t);
  f.rows.find(row => row.id === 'page').url = 'https://outside.invalid/attachments/page?ticket=fixture';
  await assert.rejects(f.controller.materialize({ ref: 'r', taskId: 'task' }), /地址|标识/);
  assert.equal(f.calls.length, 1);
});

test('current-round deliverables materialize as a group with verified bytes', async t => {
  const f = await fixture(t);
  const result = await f.controller.materialize({ ref: 'ref-1', taskId: 'task' });
  assert.equal(result.ok, true);
  assert.equal(result.artifacts.length, 3, 'process rows stay out of the deliverable group');
  const page = result.artifacts.find(row => row.name === 'index.html');
  assert.equal(page.kind, 'website');
  assert.equal(page.primary, true);
  assert.equal(page.relative, 'index.html');
  assert.ok(!result.artifacts.some(row => row.name === 'shot-old.png'), 'stale batches never resurface');
  assert.equal(page.attachmentId, 'page');
  assert.equal(page.round, 1);
  const css = result.artifacts.find(row => row.name === 'style.css');
  assert.equal(css.primary, false, 'supporting assets ride along but are not primary');
  assert.equal(css.relative, 'assets/style.css');
  assert.equal(await fs.readFile(css.path, 'utf8'), f.bytes.get('css'));
  assert.ok(page.path.startsWith(path.join(f.cwd, materializeModule.CACHE_DIR, 'task')));
  const shot = result.artifacts.find(row => row.name === 'shot-dark.png');
  assert.equal(shot.attachmentId, 'shot');
});

test('a second open reuses verified bytes without re-downloading', async t => {
  const f = await fixture(t);
  await f.controller.materialize({ ref: 'ref-1', taskId: 'task' });
  const downloads = () => f.calls.filter(url => !url.includes('/tasks/')).length;
  const before = downloads();
  const again = await f.controller.materialize({ ref: 'ref-1', taskId: 'task' });
  assert.equal(downloads(), before, 'cache hits are silent');
  assert.equal(again.artifacts.length, 3);
});

test('a later delivery batch replaces a same-name cache entry with different size', async t => {
  const f = await fixture(t);
  const first = await f.controller.materialize({ ref: 'ref-1', taskId: 'task' });
  const original = first.artifacts.find(row => row.name === 'index.html');
  const corrected = '<!doctype html><title>corrected delivery with a different length</title>';
  assert.notEqual(Buffer.byteLength(corrected), original.size);
  f.bytes.set('page-new', corrected);
  f.rows.push(attachment('page-new', 'index.html', corrected, {
    evidenceMeta: { identifier: 'ui-new-4', round: 1 }, createdAt: '2026-10-14T04:00:00Z',
  }));
  const again = await f.controller.materialize({ ref: 'ref-1', taskId: 'task' });
  const page = again.artifacts.find(row => row.name === 'index.html');
  assert.equal(page.path, original.path);
  assert.equal(page.attachmentId, 'page-new');
  assert.equal(page.size, Buffer.byteLength(corrected));
  assert.equal(await fs.readFile(page.path, 'utf8'), corrected);
  assert.equal(f.calls.filter(url => url.startsWith('/api/v1/attachments/page-new?')).length, 1);
});

test('same-size changed bytes require the new digest before cache reuse', async t => {
  const f = await fixture(t);
  await f.controller.materialize({ ref: 'ref-1', taskId: 'task' });
  const before = f.bytes.get('page'), corrected = before.replace('五子棋', '连连看');
  assert.equal(Buffer.byteLength(corrected), Buffer.byteLength(before));
  assert.notEqual(corrected, before);
  f.bytes.set('page-new', corrected);
  f.rows.push(attachment('page-new', 'index.html', corrected, {
    evidenceMeta: { identifier: 'ui-new-4' }, createdAt: '2026-10-14T04:00:00Z',
  }));
  const again = await f.controller.materialize({ ref: 'ref-1', taskId: 'task' });
  assert.equal(await fs.readFile(again.artifacts[0].path, 'utf8'), corrected);
  assert.equal(f.calls.filter(url => url.startsWith('/api/v1/attachments/page-new?')).length, 1);
});

test('an attachment without a declared digest is downloaded on every open', async t => {
  const f = await fixture(t);
  const pageRow = f.rows.find(row => row.id === 'page');
  delete pageRow.sha256;
  delete pageRow.evidenceMeta.sha256;
  await f.controller.materialize({ ref: 'ref-1', taskId: 'task' });
  const corrected = f.bytes.get('page').replace('五子棋', '连连看');
  assert.equal(Buffer.byteLength(corrected), pageRow.size, 'size alone cannot prove cache integrity');
  f.bytes.set('page', corrected);
  const again = await f.controller.materialize({ ref: 'ref-1', taskId: 'task' });
  const page = again.artifacts.find(row => row.name === 'index.html');
  assert.equal(await fs.readFile(page.path, 'utf8'), corrected);
  assert.equal(f.calls.filter(url => url.startsWith('/api/v1/attachments/page?')).length, 2);
});

test('tampered or lying bytes are rejected before reaching the canvas', async t => {
  const corrupt = await fixture(t, { corrupt: 'page' });
  await assert.rejects(corrupt.controller.materialize({ ref: 'r', taskId: 'task' }), /完整性|校验/);
  // The poisoned file must not survive as a "valid" cache entry.
  const listing = await fs.readdir(path.join(corrupt.cwd, materializeModule.CACHE_DIR, 'task'), { recursive: true });
  assert.ok(!listing.some(name => String(name).endsWith('.tmp')), 'temporary files never linger');

  const missing = await fixture(t);
  await assert.rejects(missing.controller.materialize({ ref: 'r', taskId: 'nope' }), /不可用|暂无/);
});

test('cloud and closed sessions refuse to guess a workspace', async t => {
  const cloud = await fixture(t, { cwd: '' });
  await assert.rejects(cloud.controller.materialize({ ref: 'r', taskId: 'task' }), /会话已结束|云端/);
  const closed = await fixture(t, { cwd: 'Z:/definitely/not/here' });
  await assert.rejects(closed.controller.materialize({ ref: 'r', taskId: 'task' }), /工作区不可用/);
  const noTask = await fixture(t);
  await assert.rejects(noTask.controller.materialize({ ref: 'r' }), /缺少任务归属/);
});
