'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), crypto = require('node:crypto');
const cacheModule = require('../main/conversation/cloud-output-cache');
const runtime = require('../main/conversation/artifact-runtime');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const attachment = (id, filename, bytes, extra = {}) => ({ id, taskId: 'task', filename, role: 'output',
  size: Buffer.byteLength(bytes), sha256: digest(bytes), url: '/attachments/' + id + '?ticket=fixture', ...extra });
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-cloud-cache-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, record = { sessionId: 'session', transferId: 'transfer', taskId: 'task', owner: 'alice' };
  return { root, app, record, cache: cacheModule.create({ app, ...options }) };
}

test('async index validates 200 fresh files without blocking and rejects replaced bytes immediately', async t => {
  const f = await fixture(t, { fetch: async () => new Response('fixture') });
  const rows = Array.from({ length: 200 }, (_, index) => attachment('file-' + index, 'result-' + index + '.txt', 'fixture'));
  const result = await f.cache.materialize(f.record, { hub: 'http://fixture.invalid' }, rows);
  f.record.materializedOutputs = result.materializedOutputs;
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    const actual = await cacheModule.indexAsync(f.app, f.record);
    assert.equal(actual.files.length, 200);
    assert.deepEqual(actual, cacheModule.index(f.app, f.record));
    assert.ok(ticks > 0);
    await fs.writeFile(actual.files[0].path, 'changed');
    assert.equal((await cacheModule.indexAsync(f.app, f.record)).files.length, 199);
  } finally { clearInterval(timer); }
});

test('real HTTP bytes are privately materialized, previewed with dependencies, reused and repaired after same-size changes', async t => {
  const bytes = new Map([['page', '<!doctype html><title>Cloud result</title><link rel="stylesheet" href="assets/style.css"><h1>Done</h1>'],
    ['css', 'h1{color:green}']]);
  const calls = [];
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Device fixture-session');
    calls.push(req.url); const id = req.url.split('/').at(-1).split('?')[0];
    res.end(bytes.get(id));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const f = await fixture(t), current = { hub: 'http://127.0.0.1:' + server.address().port, session: 'fixture-session' };
  const rows = [attachment('page', 'index.html', bytes.get('page')),
    attachment('css', 'assets/style.css', bytes.get('css'), { evidenceMeta: { category: 'supporting' } })];
  const result = await f.cache.materialize({ ...f.record, cwd: f.root, resultCwd: path.dirname(f.root) }, current, rows);
  assert.notEqual(result.cwd, f.root);
  f.record.materializedOutputs = result.materializedOutputs;
  const indexed = cacheModule.index(f.app, f.record);
  assert.equal(indexed.files.length, 2); assert.equal(indexed.files.find(file => file.name === 'style.css').primary, false);
  const session = { sessionId: 'session', cwd: result.cwd, outputSnapshot: () => cacheModule.index(f.app, f.record) };
  const preview = await runtime.preview(session, 'cloud-http', indexed.files.find(file => file.name === 'index.html').artifactId);
  t.after(() => runtime.closeRef('cloud-http'));
  assert.equal(preview.ok, true);
  assert.match(await (await fetch(preview.url)).text(), /Cloud result/);
  assert.equal(await (await fetch(new URL('assets/style.css', preview.url))).text(), bytes.get('css'));
  await f.cache.materialize(f.record, current, rows); assert.equal(calls.length, 2);
  await fs.writeFile(path.join(result.cwd, 'assets/style.css'), 'h1{color:black}');
  assert.equal(cacheModule.index(f.app, f.record).files.length, 1, 'modified bytes lose the attachment proof immediately');
  const repaired = await f.cache.materialize(f.record, current, rows);
  assert.equal(calls.length, 3); assert.equal(repaired.files, 2);
  assert.equal(await fs.readFile(path.join(result.cwd, 'assets/style.css'), 'utf8'), bytes.get('css'));
});

test('streaming limits cancel a lying body before reading the complete response', async t => {
  let count = 0, canceled = false;
  const f = await fixture(t, { fileLimit: 8, totalLimit: 16, fetch: async () => new Response(new ReadableStream({
    pull(controller) { count++; controller.enqueue(Buffer.alloc(4)); }, cancel() { canceled = true; },
  })) });
  await assert.rejects(f.cache.materialize(f.record, { hub: 'http://fixture.invalid' }, [attachment('one', 'one.txt', '123')]), /限制/);
  assert.ok(count < 5); assert.equal(canceled, true);
  assert.deepEqual(await fs.readdir(cacheModule.directory(f.app, f.record)), []);
});

test('size and digest failures never install an incomplete file or unzip an archive', async t => {
  let body = 'abc';
  const f = await fixture(t, { fetch: async () => new Response(body) });
  const current = { hub: 'http://fixture.invalid' };
  await assert.rejects(f.cache.materialize(f.record, current, [attachment('one', 'one.txt', 'abcd')]), /完整性/);
  await assert.rejects(f.cache.materialize(f.record, current, [attachment('one', 'one.txt', 'xyz')]), /完整性/);
  body = 'PK untrusted bytes';
  const out = await f.cache.materialize(f.record, current, [attachment('zip', 'bundle.zip', body)]);
  assert.deepEqual(await fs.readdir(out.cwd), ['bundle.zip']);
});

test('cached files still consume the whole collection budget', async t => {
  let calls = 0;
  const f = await fixture(t, { fileLimit: 8, totalLimit: 8, fetch: async () => { calls++; return new Response('12345'); } });
  const row = attachment('one', 'one.txt', '12345'), current = { hub: 'http://fixture.invalid' };
  const result = await f.cache.materialize(f.record, current, [row]);
  await assert.rejects(f.cache.materialize({ ...f.record, materializedOutputs: result.materializedOutputs }, current,
    [row, attachment('two', 'two.txt', '12345')]), /限制/);
  assert.equal(calls, 1);
});

test('a partially failed replacement never labels new bytes with an old attachment identity', async t => {
  let body = 'old';
  const f = await fixture(t, { fetch: async () => new Response(body) }), current = { hub: 'http://fixture.invalid' };
  const old = await f.cache.materialize(f.record, current, [attachment('old', 'report.md', 'old')]);
  f.record.materializedOutputs = old.materializedOutputs;
  body = 'new';
  await assert.rejects(f.cache.materialize(f.record, current, [attachment('new', 'report.md', 'new'), attachment('bad', 'other.txt', 'expected')]), /完整性/);
  assert.equal(await fs.readFile(path.join(old.cwd, 'report.md'), 'utf8'), 'new');
  assert.deepEqual(cacheModule.index(f.app, f.record).cloudOutputs, []);
});

test('ownership changes before publication leave no installed output', async t => {
  let changed = false;
  const f = await fixture(t, { fetch: async () => { changed = true; return new Response('abc'); } });
  await assert.rejects(f.cache.materialize(f.record, { hub: 'http://fixture.invalid' }, [attachment('one', 'one.txt', 'abc')],
    async () => { if (changed) throw Error('account changed'); }), /account changed/);
  assert.deepEqual(await fs.readdir(cacheModule.directory(f.app, f.record)), []);
  assert.notEqual(cacheModule.directory(f.app, f.record), cacheModule.directory(f.app, { ...f.record, owner: 'bob' }));
  assert.notEqual(cacheModule.directory(f.app, f.record), cacheModule.directory(f.app, { ...f.record, taskId: 'other' }));
});

test('links, traversal, reserved filenames and foreign task or URL identity are rejected', async t => {
  const f = await fixture(t, { fetch: async () => { throw Error('must not fetch'); } });
  for (const name of ['../outside', '/absolute', 'C:/absolute', 'CON.txt', 'x/NUL', 'x//y', '.soduwork/delivery.json']) assert.equal(cacheModule.safeName(name), '');
  assert.throws(() => cacheModule.rows([attachment('id', 'a.txt', 'x', { taskId: 'other' })], 'task'), /不属于/);
  assert.throws(() => cacheModule.rows([attachment('id', 'a.txt', 'x', { url: '/attachments/wrong?ticket=x' })], 'task'), /不匹配/);
  const cwd = cacheModule.directory(f.app, f.record), elsewhere = path.join(f.root, 'original-workspace');
  await fs.mkdir(cwd, { recursive: true }); await fs.mkdir(elsewhere);
  await fs.symlink(elsewhere, path.join(cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.cache.materialize(f.record, { hub: 'http://fixture.invalid' }, [attachment('id', 'linked/a.txt', 'x')]), /链接/);
  assert.deepEqual(await fs.readdir(elsewhere), []);
});

test('new completion rounds replace old filenames but retain unversioned declared dependencies', () => {
  const rows = cacheModule.rows([
    attachment('old', 'old-report.md', 'a', { evidenceMeta: { round: 1 } }),
    attachment('new', 'new-report.html', 'b', { evidenceMeta: { round: 2 } }),
    attachment('css', 'assets/shared.css', 'c', { evidenceMeta: { category: 'supporting' } }),
    attachment('legacy', 'legacy-report.md', 'd'),
    attachment('screenshot', 'evidence.png', 'x', { evidenceMeta: { round: 3, kind: 'screenshot' } }),
  ], 'task');
  assert.deepEqual(rows.map(row => row.id), ['new', 'css']);
});

test('EXDEV cloud output publication verifies Chinese paths, replacements and failed copies', async t => {
  let body = 'old HTML', corrupt = false;
  const f = await fixture(t, { fetch: async () => new Response(body) }), current = { hub: 'https://fixture.invalid' };
  t.mock.method(fs, 'rename', async () => { throw Object.assign(Error('managed volume'), { code: 'EXDEV' }); });
  const copy = fs.copyFile.bind(fs);
  t.mock.method(fs, 'copyFile', async (source, target, ...args) => {
    if (corrupt && source.endsWith('.tmp')) { await fs.writeFile(target, 'corrupted'); return; }
    return copy(source, target, ...args);
  });
  const filename = '网页/结果.html';
  const first = await f.cache.materialize(f.record, current, [attachment('old', filename, body)]);
  f.record.materializedOutputs = first.materializedOutputs;
  body = 'new longer HTML';
  const second = await f.cache.materialize(f.record, current, [attachment('new', filename, body)]);
  f.record.materializedOutputs = second.materializedOutputs;
  assert.equal(await fs.readFile(path.join(second.cwd, filename), 'utf8'), body);
  assert.equal(cacheModule.index(f.app, f.record).cloudOutputs[0].attachmentId, 'new');
  corrupt = true; body = 'unpublished';
  await assert.rejects(f.cache.materialize(f.record, current, [attachment('failed', filename, body)]), /完整性/);
  assert.equal(await fs.readFile(path.join(second.cwd, filename), 'utf8'), 'new longer HTML');
  assert.equal(cacheModule.index(f.app, f.record).cloudOutputs.some(row => row.attachmentId === 'failed'), false);
  assert.deepEqual(await fs.readdir(path.join(second.cwd, '网页')), ['结果.html']);
});

test('EXDEV output copying rechecks account ownership before publishing and restores prior bytes', async t => {
  let body = 'old', changed = false;
  const f = await fixture(t, { fetch: async () => new Response(body) }), current = { hub: 'https://fixture.invalid' };
  const first = await f.cache.materialize(f.record, current, [attachment('old', 'index.html', body)]);
  f.record.materializedOutputs = first.materializedOutputs;
  t.mock.method(fs, 'rename', async () => { throw Object.assign(Error('managed volume'), { code: 'EXDEV' }); });
  const copy = fs.copyFile.bind(fs);
  t.mock.method(fs, 'copyFile', async (source, target, ...args) => {
    await copy(source, target, ...args);
    if (source.endsWith('.tmp')) changed = true;
  });
  body = 'new';
  await assert.rejects(f.cache.materialize(f.record, current, [attachment('new', 'index.html', body)],
    async () => { if (changed) throw Error('account changed during publication'); }), /account changed/);
  assert.equal(await fs.readFile(path.join(first.cwd, 'index.html'), 'utf8'), 'old');
  assert.deepEqual(await fs.readdir(first.cwd), ['index.html']);
});


test('automatic cache downloads only preview content; external results remain available for manual download', async t => {
  const calls = [], body = 'fixture';
  const f = await fixture(t, { fetch: async (_current, url) => { calls.push(url); return new Response(body); } });
  const current = { hub: 'http://fixture.invalid' };
  const rows = ['index.html', 'assets/style.css', 'assets/app.js', 'assets/font.woff2', 'notes.md',
    'image.png', 'movie.mp4', 'report.pdf', 'table.xlsx', 'slides.pptx', 'report.docx', 'bundle.zip', 'data.bin']
    .map((name, i) => attachment(String(i), name, body));
  const first = await f.cache.materialize(f.record, current, rows, undefined, { previewOnly: true });
  assert.equal(calls.length, 8, 'Office, archives and unknown files are not automatically downloaded');
  f.record.materializedOutputs = first.materializedOutputs;
  assert.deepEqual(cacheModule.index(f.app, f.record).files.map(x => x.relative).sort(), rows.slice(0, 8).map(x => x.filename).sort());
  const manual = await f.cache.materialize(f.record, current, rows);
  assert.equal(calls.length, rows.length, 'explicit collection download still retrieves every result');
  f.record.materializedOutputs = manual.materializedOutputs;
  const refreshed = await f.cache.materialize(f.record, current, rows, undefined, { previewOnly: true });
  f.record.materializedOutputs = refreshed.materializedOutputs;
  assert.equal(cacheModule.index(f.app, f.record).files.length, rows.length, 'automatic refresh retains previously downloaded files');
  assert.equal(calls.length, rows.length);
});
