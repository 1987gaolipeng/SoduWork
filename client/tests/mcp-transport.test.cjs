const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { readFileSync } = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const bridge = path.resolve(__dirname, '../../skills/mcp-tools/scripts/mcp.mjs');
const peer = path.join(__dirname, 'fixtures/mcp-transport-peer.cjs');

function run(mode, options = {}) {
  const spec = options.spec || { command: process.execPath, args: [peer, mode],
    startupTimeoutSeconds: 3, toolTimeoutSeconds: 3 };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridge, options.command || 'list', 'fixture',
      ...(options.command === 'call' ? ['read_status', '{}'] : [])], {
      windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SODUWORK_MCP_SERVERS_JSON: JSON.stringify({ servers: { fixture: spec } }),
        SODUWORK_MCP_JSON: '1', ...options.env },
    });
    let stdout = '', stderr = '';
    const limit = setTimeout(() => { child.kill(); reject(new Error('Bridge failed to shut down')); }, 9000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(limit); resolve({ code, stdout, stderr }); });
  });
}

test('stdio discovery returns every page and keeps opaque cursors unchanged', async () => {
  const out = await run('pagination');
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout).tools.map(item => item.name), ['tool_1', 'tool_2']);
});
test('stdio decodes UTF-8 characters split across process chunks', async () => {
  const out = await run('unicode', { command: 'call' });
  assert.equal(out.code, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).content[0].text, '中文结果🙂');
});
test('stdio rejects unsupported versions before discovery', async () => {
  const out = await run('bad-version');
  assert.notEqual(out.code, 0);
  assert.match(out.stderr, /版本/);
});
test('stdio reports early process exit immediately', async () => {
  const started = Date.now(), out = await run('exit');
  assert.notEqual(out.code, 0);
  assert.match(out.stderr, /退出|关闭/);
  assert.ok(Date.now() - started < 2500);
});
test('stdio reports spawn failure without exposing configured process details', async () => {
  const out = await run('', { spec: { command: path.join(__dirname, 'missing-fixture-secret-value.exe') } });
  assert.notEqual(out.code, 0);
  assert.match(out.stderr, /启动/);
  assert.doesNotMatch(out.stderr, /fixture-secret-value/);
});
test('stdio rejects a cyclic catalog instead of reporting a partial success', async () => {
  const out = await run('cycle');
  assert.notEqual(out.code, 0);
  assert.match(out.stderr, /分页/);
});
test('stdio has a hard byte limit before JSON parsing', async () => {
  const out = await run('flood');
  assert.notEqual(out.code, 0);
  assert.match(out.stderr, /上限|过大/);
});
test('stdio fails a wrong response ID without waiting for request timeout', async () => {
  const started = Date.now(), out = await run('wrong-id');
  assert.notEqual(out.code, 0);
  assert.match(out.stderr, /ID|请求/);
  assert.ok(Date.now() - started < 2500);
});
test('stdio rejects malformed result shape', async () => {
  const out = await run('malformed');
  assert.notEqual(out.code, 0);
  assert.match(out.stderr, /格式|对象/);
});
test('stdio does not mistake a server request with the same ID for a tool result', async () => {
  const out = await run('server-request', { command: 'call' });
  assert.equal(out.code, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).content[0].text, 'UNSUPPORTED_REJECTED');
});
test('stdio diagnostics do not echo arbitrary remote protocol errors', async () => {
  const out = await run('secret-error');
  assert.notEqual(out.code, 0);
  assert.doesNotMatch(out.stderr, /fixture-secret-value/);
  assert.match(out.stderr, /32603/);
});
test('stdio hung requests have a bounded wait and clean shutdown', async () => {
  const started = Date.now(), out = await run('hang');
  assert.notEqual(out.code, 0);
  assert.match(out.stderr, /超时/);
  assert.ok(Date.now() - started < 6500);
});
test('built-in HTTP rejects redirects and mismatched IDs without forwarding credentials', async t => {
  let mode = 'redirect', reachedOther = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/other') reachedOther += 1;
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const q = JSON.parse(raw);
      if (q.method === 'initialize') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id,
          result: { protocolVersion: '2025-11-25', capabilities: {} } }));
      }
      if (q.id === undefined) { res.writeHead(202); return res.end(); }
      if (mode === 'redirect') { res.writeHead(307, { Location: '/other' }); return res.end(); }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id + 1, result: { tools: [] } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const origin = 'http://127.0.0.1:' + server.address().port;
  const options = { spec: { type: 'http', url: origin + '/api/v1/mcp',
    headers: { Authorization: 'Bearer fixture-only' } }, env: { SODUWORK_HUB_ORIGIN: origin } };
  const redirected = await run('', options);
  assert.notEqual(redirected.code, 0);
  assert.match(redirected.stderr, /重定向/);
  assert.equal(reachedOther, 0);
  mode = 'wrong-id';
  const wrong = await run('', options);
  assert.notEqual(wrong.code, 0);
  assert.match(wrong.stderr, /ID/);
  const badHeader = await run('', { ...options, spec: { ...options.spec,
    headers: { Authorization: 'Bearer fixture-secret-value\ninvalid' } } });
  assert.notEqual(badHeader.code, 0);
  assert.match(badHeader.stderr, /请求头/);
  assert.doesNotMatch(badHeader.stderr, /fixture-secret-value/);
});
