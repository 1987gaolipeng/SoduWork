'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { createHash } = require('node:crypto');
const { baseline } = require('../../tools/ci/acceptance-common.cjs');
const source = 'https://github.com/example/project/releases/download/v1.13.15/installer.exe';
const cdn = 'https://release-assets.githubusercontent.com/fixture/installer.exe?signature=fixture';
const bytes = Buffer.from('accepted previous installer');

async function fixture(t, url = source) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-baseline-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'baselines.json');
  await fs.writeFile(file, JSON.stringify({ 'windows-x64-exe': {
    productName: 'SoduWork', version: '1.13.15', url, size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  } }));
  return { directory, options: { file, productName: 'SoduWork', candidateVersion: '1.13.16', cacheDirectory: null } };
}

test('GitHub upgrade baselines follow the public asset redirect and verify the original bytes', async t => {
  const f = await fixture(t), calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), options });
    return String(url) === source ? new Response(null, { status: 302, headers: { location: cdn } }) : new Response(bytes);
  });
  const result = await baseline('windows-x64-exe', f.directory, f.options);
  assert.equal(result.version, '1.13.15');
  assert.deepEqual(await fs.readFile(result.path), bytes);
  assert.deepEqual(calls.map(call => call.url), [source, cdn]);
  assert.deepEqual(calls.map(call => call.options.redirect), ['manual', 'error']);
  assert.equal(calls[0].options.signal, calls[1].options.signal);
});

test('GitHub baseline redirects reject unexpected hosts, insecure URLs and credentials', async t => {
  const f = await fixture(t);
  for (const location of ['https://example.test/installer.exe', 'http://release-assets.githubusercontent.com/installer.exe',
    'https://user:password@release-assets.githubusercontent.com/installer.exe']) {
    let calls = 0;
    const mock = t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location } });
    });
    await assert.rejects(baseline('windows-x64-exe', f.directory, f.options), /Unexpected GitHub baseline redirect/);
    assert.equal(calls, 1);
    mock.mock.restore();
  }
});

test('a redirected GitHub baseline still rejects changed installer bytes', async t => {
  const f = await fixture(t);
  t.mock.method(globalThis, 'fetch', async url => String(url) === source ?
    new Response(null, { status: 302, headers: { location: cdn } }) : new Response(Buffer.alloc(bytes.length)));
  await assert.rejects(baseline('windows-x64-exe', f.directory, f.options), /differs from pinned baseline/);
});

test('other baseline servers cannot redirect downloads', async t => {
  let requests = 0;
  const server = require('node:http').createServer((_req, res) => {
    requests++;
    res.writeHead(302, { location: '/redirected' });
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const f = await fixture(t, `http://127.0.0.1:${server.address().port}/installer.exe`);
  await assert.rejects(baseline('windows-x64-exe', f.directory, f.options), /fetch failed/);
  assert.equal(requests, 1);
});
