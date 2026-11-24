'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

// chat-workspace-info is also loaded by the renderer where `window` exists.
// Provide the smallest equivalent for this parser-only regression test.
global.window = global;
const info = require('../components/panels/chat-workspace-info');
const chatTools = require('../components/panels/panels-chat-tools');
const preview = require('../main/work-preview');

test('ISO timestamps are never promoted to service URLs', () => {
  assert.equal(info.normalizeUrl('2026-09-20T10:18'), '');
  assert.equal(info.normalizeUrl('http://2026-09-20t10:18/'), '');
  assert.deepEqual(info.serviceCandidates('started at 2026-09-20T10:18'), []);
  assert.equal(preview._normalizeAddress('http://2026-09-20t10:18/'), '');
  assert.equal(chatTools.normalizeAddress('http://2026-09-20t10:18/'), '');
});

test('real local and cloud listeners remain valid service URLs', () => {
  assert.equal(info.normalizeUrl('localhost:4173'), 'http://127.0.0.1:4173/');
  assert.equal(info.normalizeUrl('192.0.2.20:4173'), 'http://192.0.2.20:4173/');
  assert.deepEqual(info.serviceCandidates('Local: http://localhost:4173/'), [
    'http://localhost:4173/',
  ]);
  assert.equal(preview._normalizeAddress('http://192.0.2.20:4173/'), 'http://192.0.2.20:4173/');
});

test('cloud loopback listeners resolve to IPv6 Runner hosts and preserve URL components', () => {
  const suffix = ':4173/review/%E4%B8%AD%E6%96%87.html?view=1#result';
  for (const host of ['2001:db8::20', '[2001:db8::20]']) {
    for (const listener of ['localhost', '127.0.0.1', '0.0.0.0', '[::]', '[::1]']) {
      const url = info.normalizeUrl('https://' + listener + suffix, { cloud: true, cloudHost: host });
      assert.equal(url, 'https://[2001:db8::20]' + suffix, host + ' / ' + listener);
      assert.equal(preview._normalizeAddress(url), url);
    }
  }
});

test('cloud previews wait for a valid target instead of opening desktop loopback', () => {
  const output = 'Local: http://localhost:4173/review?view=1#result';
  for (const cloudHost of ['', 'bad/host', 'runner.test:8080', 'user@runner.test',
    'https://runner.test/', '2001:db8::invalid', '[2001:db8::20']) {
    const rows = info.services([command('npm run dev', output)], { cloud: true, cloudHost });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].url, '', cloudHost);
    assert.equal(rows[0].unreachable, true, cloudHost);
    assert.equal(rows[0].state, '等待云端地址', cloudHost);
  }
  const published = 'https://preview.example.test/review?view=1#result';
  assert.equal(info.services([command('start-managed-app', '', { previewUrl: published })],
    { cloud: true, cloudHost: 'bad/host' })[0].url, published);
});

test('structured IPv6 listener metadata produces an address accepted by native preview', () => {
  for (const host of ['2001:db8::20', '[2001:db8::20]', '::ffff:192.0.2.20']) {
    const rows = info.services([command('node server.js', '', { host, port: 4173 })],
      { cloud: true, cloudHost: host });
    assert.equal(rows.length, 1, host);
    const expectedHost = new URL('http://' + (host.startsWith('[') ? host : '[' + host + ']')).hostname;
    assert.equal(rows[0].url, 'http://' + expectedHost + ':4173/', host);
    assert.equal(rows[0].unreachable, false, host);
    assert.equal(preview._normalizeAddress(rows[0].url), rows[0].url);
  }
});

test('existing IPv4, DNS and local previews retain their address behavior', () => {
  for (const host of ['192.0.2.20', 'runner.example.test']) {
    const options = { cloud: true, cloudHost: host };
    const url = 'http://' + host + ':4173/';
    assert.equal(info.normalizeUrl('localhost:4173', options), url);
    assert.equal(info.services([command('node server.js', '', { host, port: 4173 })], options)[0].url, url);
  }
  assert.equal(info.normalizeUrl('http://[::1]:4173/'), 'http://127.0.0.1:4173/');
});

const command = (cmd, output = '', metadata = {}) => ({ id: 'tool', name: 'bash',
  args: { command: cmd }, state: 'done', result: output, ...metadata });

test('research, browser checks and HTTP clients never advertise visited pages as services', () => {
  for (const cmd of [
    'node skills/browser-use/scripts/browser.mjs text https://www.bing.com/news/search?q=AI',
    'node browser.mjs shot http://127.0.0.1:5173/ verify.png',
    'cd /workspace && curl http://127.0.0.1:5173/',
    'curl https://example.test | head -10', 'npx playwright test',
  ]) {
    const log = 'Local: http://127.0.0.1:5173/\nResearch source https://www.bing.com/news\nAvailable at https://example.test/';
    assert.deepEqual(info.services([command(cmd, log)]), [], cmd);
  }
  assert.deepEqual(info.services([command('node inspect.js http://localhost:5173/', 'page read')]), []);
});

test('source coordinates and incidental Local text never become service addresses', () => {
  for (const [cmd, log] of [
    ['uv run python -m pyflakes src', 'src/main.py:35:5: local variable unused\nsrc/bridge.py:13: imported but unused'],
    ['pnpm exec tsc --noEmit', 'at getFinalError (file:///C:/Users/me/AppData/Local/pnpm/pnpm.mjs:24952:14)'],
    ['node inspect.js', 'Local storage for https://www.bing.com/news\nremote browser at http://127.0.0.1:9222/'],
    ['cat README.md', 'Run npm run dev, then visit https://example.test/docs'],
    ['cat README.md', 'Local: http://localhost:5173/'],
    ['python -c "import requests; print(requests.get(url).text)"', 'Available at https://news.example.test/article'],
    ['vite build', 'built; docs https://vite.dev/'],
  ]) assert.deepEqual(info.services([command(cmd, log)]), [], cmd);
  assert.deepEqual(info.serviceCandidates('src/main.py:35:5 file:///C:/AppData/Local/pnpm.mjs:24952:14'), []);
});

test('service evidence belongs to the announced endpoint instead of all URLs in a command or log', () => {
  const rows = info.services([command('npm run dev -- --source https://source.test',
    'Read https://vite.dev/guide\n  ➜ Local: http://localhost:5173/ docs https://docs.test\nhttps://other.test/')]);
  assert.deepEqual(rows.map(row => row.url), ['http://127.0.0.1:5173/']);
  assert.deepEqual(info.services([command('npm run dev', 'https://vite.dev/guide')]).map(row => row.url), ['']);
  assert.deepEqual(info.services([command('node app.js', 'http://localhost:9222/')]), []);
  assert.deepEqual(info.services([command('node server.js', 'Listening on localhost:4173/ docs https://docs.example.test/')])
    .map(row => row.url), ['http://127.0.0.1:4173/']);
});

test('real custom listeners and structured cloud previews remain usable', () => {
  for (const output of ['Server listening on port 4174', 'Listening at http://localhost:4174/',
    'INFO: Uvicorn running on http://127.0.0.1:4174 (Press CTRL+C to quit)',
    'Serving HTTP on :: port 4174 (http://[::]:4174/)']) {
    assert.equal(info.services([command('node app.js', output)])[0]?.url, 'http://127.0.0.1:4174/', output);
  }
  const remote = info.services([command('start-managed-app', 'unrelated https://docs.test',
    { previewUrl: 'https://preview.example.test/中文.html' })]);
  assert.equal(remote[0].url, 'https://preview.example.test/%E4%B8%AD%E6%96%87.html');
  assert.equal(info.services([command('node server.js', '', { host: '192.0.2.20', port: 4173 })])[0].url,
    'http://192.0.2.20:4173/');
  assert.deepEqual(info.services([command('node server.js', '', { port: 999999 })]), []);
  for (const [cmd, output] of [
    ['npm run dev & curl -I http://localhost:4173/', 'Local: http://localhost:4173/'],
    ['python -m flask run', ' * Running on http://127.0.0.1:4173'],
    ['python manage.py runserver', 'Starting development server at http://127.0.0.1:4173/'],
  ]) assert.equal(info.services([command(cmd, output)])[0]?.url, 'http://127.0.0.1:4173/', cmd);
});
