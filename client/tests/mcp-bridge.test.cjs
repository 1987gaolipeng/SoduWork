const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { writeFileSync, mkdtempSync, rmSync } = require('node:fs');
const { spawn } = require('node:child_process');

// Unit tests run before PyInstaller creates client/runner. The recipe's shared
// skill input graph is checked by smoke_runner_release; exercise that source.
const script = path.join(__dirname, '..', '..', 'skills',
  'mcp-tools', 'scripts', 'mcp.mjs');

function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...env }, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('built-in HTTP MCP bridge is same-origin and expands only runtime credentials', async (t) => {
  const seen = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk.toString(); });
    request.on('end', () => {
      const rpc = JSON.parse(body || '{}');
      seen.push({ method: rpc.method, authorization: request.headers.authorization });
      const result = rpc.method === 'tools/list'
        ? { tools: [
          { name: 'task_list', description: 'List tasks', inputSchema: { properties: {} } },
          { name: 'task_delete', description: 'Delete task', inputSchema: { properties: {} } },
        ] }
        : rpc.method === 'tools/call'
          ? { content: [{ type: 'text', text: 'x'.repeat(20000) }] }
        : rpc.method === 'initialize'
          ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'soduwork' } }
          : {};
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const config = JSON.stringify({ servers: { soduwork: {
    type: 'http', url: origin + '/api/v1/mcp',
    headers: { Authorization: 'Bearer $SODUWORK_MCP_KEY', 'X-Ignore-Me': 'not-forwarded' },
  } } });
  const good = await run(['list', 'soduwork'], {
    SODUWORK_MCP_SERVERS_JSON: config,
    SODUWORK_HUB_ORIGIN: origin,
    SODUWORK_MCP_KEY: 'purpose-bound-mcp-ticket',
  });
  assert.equal(good.code, 0, good.stderr);
  assert.match(good.stdout, /task_list/);
  assert.deepEqual(seen.map((item) => item.method),
    ['initialize', 'notifications/initialized', 'tools/list']);
  assert.ok(seen.every((item) => item.authorization === 'Bearer purpose-bound-mcp-ticket'));

  const restricted = JSON.stringify({ servers: { soduwork: {
    type: 'http', url: origin + '/api/v1/mcp', allowedTools: ['task_list'],
    soduWorkPolicy: { timeoutSeconds: 10, maxResultChars: 1000 },
    headers: { Authorization: 'Bearer purpose-bound-mcp-ticket' },
  } } });
  const filtered = await run(['list', 'soduwork'], {
    SODUWORK_MCP_SERVERS_JSON: restricted,
    SODUWORK_HUB_ORIGIN: origin,
  });
  assert.equal(filtered.code, 0, filtered.stderr);
  assert.match(filtered.stdout, /task_list/);
  assert.doesNotMatch(filtered.stdout, /task_delete/);
  const callsBeforeBlocked = seen.length;
  const denied = await run(['call', 'soduwork', 'task_delete', '{}'], {
    SODUWORK_MCP_SERVERS_JSON: restricted,
    SODUWORK_HUB_ORIGIN: origin,
  });
  assert.equal(denied.code, 3);
  assert.match(denied.stderr, /没有被当前插件绑定批准/);
  assert.equal(seen.length, callsBeforeBlocked);

  const bounded = await run(['call', 'soduwork', 'task_list', '{}'], {
    SODUWORK_MCP_SERVERS_JSON: restricted,
    SODUWORK_HUB_ORIGIN: origin,
  });
  assert.equal(bounded.code, 0, bounded.stderr);
  assert.match(bounded.stdout, /"truncated":true/);
  assert.ok(bounded.stdout.length < 1400, bounded.stdout.length);

  for (const budgets of [
    { soduworkPolicy: { timeoutSeconds: 10, maxResultChars: 1000 } },
    { soduworkPolicy: { maxResultChars: 1000 }, soduWorkPolicy: { maxResultChars: 5000 } },
    { soduworkPolicy: { maxResultChars: 5000 }, soduWorkPolicy: { maxResultChars: 1000 } },
  ]) {
    const compatible = await run(['call', 'soduwork', 'task_list', '{}'], {
      SODUWORK_MCP_SERVERS_JSON: JSON.stringify({ servers: { soduwork: {
        type: 'http', url: origin + '/api/v1/mcp', allowedTools: ['task_list'], ...budgets,
      } } }),
      SODUWORK_HUB_ORIGIN: origin,
    });
    assert.equal(compatible.code, 0, compatible.stderr);
    assert.equal(JSON.parse(compatible.stdout).preview.length, 1000,
      'old policy keys remain effective and conflicting aliases preserve the tighter limit');
  }

  const scopedRoot = mkdtempSync(path.join(os.tmpdir(), 'soduwork-mcp-turn-'));
  t.after(() => rmSync(scopedRoot, { recursive: true, force: true }));
  const scopedFile = path.join(scopedRoot, 'turn.json');
  writeFileSync(scopedFile, JSON.stringify({ servers: { scoped: {
    type: 'http', url: origin + '/api/v1/mcp',
    headers: { Authorization: 'Bearer one-turn-ticket' },
  } } }), 'utf8');
  const explicit = await run(['--config', scopedFile, 'list', 'scoped'], {
    SODUWORK_MCP_SERVERS_JSON: JSON.stringify({ servers: { inherited: {
      type: 'http', url: origin + '/api/v1/mcp',
      headers: { Authorization: 'Bearer wrong-global-ticket' },
    } } }),
    SODUWORK_HUB_ORIGIN: origin,
  });
  assert.equal(explicit.code, 0, explicit.stderr);
  assert.match(explicit.stdout, /task_list/);
  assert.equal(seen.at(-1).authorization, 'Bearer one-turn-ticket');

  const blocked = await run(['list', 'soduwork'], {
    SODUWORK_MCP_SERVERS_JSON: config,
    SODUWORK_HUB_ORIGIN: 'http://127.0.0.1:1',
    SODUWORK_MCP_KEY: 'purpose-bound-mcp-ticket',
  });
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /SoduWork/);
});
