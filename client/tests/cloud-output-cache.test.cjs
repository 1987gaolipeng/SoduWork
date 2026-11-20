'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), crypto = require('node:crypto');
const zlib = require('node:zlib');
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

test('compressed HTTP outputs validate decoded file bytes instead of the encoded Content-Length', async context => {
  const bytes = Buffer.from('<h1>Published result</h1>'.repeat(100));
  for (const [encoding, compress] of Object.entries({ gzip: zlib.gzipSync, deflate: zlib.deflateSync, br: zlib.brotliCompressSync })) {
    await context.test(encoding, async scenario => {
      const compressed = compress(bytes);
      assert.notEqual(compressed.length, bytes.length);
      const server = http.createServer((request, response) => {
        assert.equal(request.headers.authorization, 'Device fixture-session');
        response.writeHead(200, { 'Content-Encoding': encoding, 'Content-Length': compressed.length });
        response.end(compressed);
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      scenario.after(() => new Promise(resolve => server.close(resolve)));
      const fixtureState = await fixture(scenario);
      const current = { hub: 'http://127.0.0.1:' + server.address().port, session: 'fixture-session' };
      const result = await fixtureState.cache.materialize(fixtureState.record, current,
        [attachment('compressed-result', 'result.html', bytes)]);
      assert.deepEqual(await fs.readFile(path.join(result.cwd, 'result.html')), bytes);
      assert.equal(result.materializedOutputs['compressed-result'].size, bytes.length);
      assert.equal(result.materializedOutputs['compressed-result'].sha256, digest(bytes));
    });
  }
});

test('compressed HTTP outputs still reject decoded size and digest mismatches without leaving files', async context => {
  const expected = Buffer.from('expected output'.repeat(100));
  for (const [name, bytes, reason] of [
    ['oversized', Buffer.concat([expected, Buffer.from('extra')]), /限制/],
    ['truncated', expected.subarray(0, -1), /完整性/],
    ['wrong-digest', Buffer.alloc(expected.length, 120), /完整性/],
  ]) {
    await context.test(name, async scenario => {
      const compressed = zlib.gzipSync(bytes);
      const server = http.createServer((_request, response) => {
        response.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': compressed.length });
        response.end(compressed);
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      scenario.after(() => new Promise(resolve => server.close(resolve)));
      const fixtureState = await fixture(scenario);
      const current = { hub: 'http://127.0.0.1:' + server.address().port, session: 'fixture-session' };
      await assert.rejects(fixtureState.cache.materialize(fixtureState.record, current,
        [attachment('compressed-result', 'result.txt', expected)]), reason);
      assert.deepEqual(await fs.readdir(cacheModule.directory(fixtureState.app, fixtureState.record)), []);
    });
  }
});

test('broken compressed streams leave no partial output, preserve cached files and allow retry', async context => {
  const expected = Buffer.from('<h1>Updated cloud result</h1>'.repeat(100));
  const previous = Buffer.from('Previously verified cloud result');
  for (const [encoding, compress, decompress] of [
    ['gzip', zlib.gzipSync, zlib.gunzipSync],
    ['deflate', zlib.deflateSync, zlib.inflateSync],
    ['br', zlib.brotliCompressSync, zlib.brotliDecompressSync],
  ]) {
    const compressed = compress(expected), corrupted = Buffer.from(compressed);
    // Damage the integrity trailer, or the Brotli header (Brotli has no checksum).
    if (encoding === 'br') corrupted.fill(0xff, 0, 4);
    else corrupted[corrupted.length - 1] ^= 0xff;
    for (const [failure, damaged] of [
      // Cut into the payload; fetch may tolerate a missing gzip/deflate trailer.
      ['truncated', compressed.subarray(0, Math.floor(compressed.length / 2))],
      ['corrupted', corrupted],
    ]) {
      await context.test(encoding + ': ' + failure, async scenario => {
        assert.throws(() => decompress(damaged), 'the compressed stream itself must be invalid');
        let wire = damaged, requests = 0;
        const server = http.createServer((request, response) => {
          assert.equal(request.headers.authorization, 'Device fixture-session');
          requests++;
          // Keep HTTP framing valid so the failure comes from the compressed body.
          response.writeHead(200, { 'Content-Encoding': encoding, 'Content-Length': wire.length });
          response.end(wire);
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        scenario.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
        const f = await fixture(scenario);
        const current = { hub: 'http://127.0.0.1:' + server.address().port, session: 'fixture-session' };
        const row = attachment('updated', 'result.html', expected);
        const cwd = cacheModule.directory(f.app, f.record), target = path.join(cwd, row.filename);

        await assert.rejects(f.cache.materialize(f.record, current, [row]));
        assert.deepEqual(await fs.readdir(cwd), [], 'failed first download must remove temporary files');

        wire = compress(previous);
        const saved = await f.cache.materialize(f.record, current, [attachment('previous', row.filename, previous)]);
        f.record.materializedOutputs = saved.materializedOutputs;
        const receipt = structuredClone(saved.materializedOutputs);
        wire = damaged;
        await assert.rejects(f.cache.materialize(f.record, current, [row]));
        assert.deepEqual(await fs.readFile(target), previous, 'a broken replacement must preserve verified bytes');
        assert.deepEqual(f.record.materializedOutputs, receipt, 'a failed download must preserve the old receipt');
        assert.deepEqual(await fs.readdir(cwd), [row.filename], 'failed replacement must not leave temporary files');
        assert.equal(cacheModule.index(f.app, f.record).cloudOutputs[0].attachmentId, 'previous');

        wire = compressed;
        const retried = await f.cache.materialize(f.record, current, [row]);
        assert.deepEqual(await fs.readFile(target), expected);
        assert.equal(retried.materializedOutputs.updated.size, expected.length);
        assert.equal(retried.materializedOutputs.updated.sha256, digest(expected));
        assert.deepEqual(await fs.readdir(cwd), [row.filename]);
        assert.equal(requests, 4, 'retry must fetch again instead of reusing a failed download');
      });
    }
  }
});

test('identity responses retain the early Content-Length mismatch check', async context => {
  for (const encoding of [undefined, 'identity']) {
    await context.test(encoding || 'absent', async scenario => {
      let canceled = false;
      const headers = { 'content-length': '100' };
      if (encoding) headers['content-encoding'] = encoding;
      const fixtureState = await fixture(scenario, { fetch: async () => new Response(new ReadableStream({
        cancel() { canceled = true; },
      }), { headers }) });
      await assert.rejects(fixtureState.cache.materialize(fixtureState.record, { hub: 'http://fixture.invalid' },
        [attachment('identity-result', 'result.txt', 'fixture')]), /大小校验失败/);
      assert.equal(canceled, true);
      assert.deepEqual(await fs.readdir(cacheModule.directory(fixtureState.app, fixtureState.record)), []);
    });
  }
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
