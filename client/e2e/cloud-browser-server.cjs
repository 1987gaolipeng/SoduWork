'use strict';
// Human browser E2E bridge: production cloud coordinator, isolated HTTP Hub
// and independent Runner. Only vendor model processes are synthetic.
const http = require('node:http'), path = require('node:path'), os = require('node:os');
const fs = require('node:fs/promises'), sync = require('node:fs');
const { spawn } = require('node:child_process');
const { create } = require('../main/conversation/cloud-handoff');
const catalog = require('../main/agent-runtime/runtime-catalog');
const repo = path.resolve(__dirname, '../..'), client = path.join(repo, 'client');
const output = path.resolve(process.argv[2] || path.join(repo, 'outputs/cloud-browser-20261004'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const views = new Map();
let root, backend, log, server, cloud, identity, stopped = false;
async function until(fn, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; await pause(100); }
  throw Error('Timed out: ' + label);
}
async function jsonBody(request) {
  const parts = []; let size = 0;
  for await (const part of request) {
    size += part.length; if (size > 32 * 1024 * 1024) throw Error('Fixture request too large');
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
}
async function hub(route, options = {}) {
  const response = await fetch(identity.hub + route, { ...options,
    headers: { Authorization: 'Device ' + identity.session, ...options.headers } });
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const error = Error(typeof data.detail === 'string' ? data.detail : 'Isolated Hub request failed');
    error.status = response.status; throw error;
  }
  return contentType.includes('application/json') ? response.json() : Buffer.from(await response.arrayBuffer());
}
async function view(sessionId) {
  if (!views.has(sessionId)) {
    const current = await cloud.reopen(sessionId, 'browser-' + sessionId);
    if (!current) throw Error('Cloud conversation not found');
    views.set(sessionId, current);
  }
  return views.get(sessionId);
}
async function handle(request, response) {
  const origin = 'http://' + request.headers.host, url = new URL(request.url, origin);
  const send = (status, data) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(data)); };
  try {
    if (request.headers.origin && request.headers.origin !== origin) return send(403, { ok: false, reason: 'Same-origin fixture only' });
    if (url.pathname === '/api/runtime/catalog') return send(200, { ok: true, runtimes: catalog.runtimes() });
    if (url.pathname === '/api/cloud/targets') return send(200, await cloud.targets(url.searchParams.get('agentId') || 'pi'));
    if (url.pathname === '/api/cloud/history') return send(200, await cloud.history());
    if (url.pathname === '/api/cloud/start' && request.method === 'POST') {
      const body = await jsonBody(request);
      body.attachments = (body.attachments || []).map(item => ({ name: item.name, type: item.type,
        data: Buffer.from(item.base64 || '', 'base64') }));
      return send(200, await cloud.start(body));
    }
    if (url.pathname === '/api/cloud/snapshot') return send(200, (await view(url.searchParams.get('sessionId'))).snapshot());
    if (url.pathname === '/api/cloud/send' && request.method === 'POST') {
      const body = await jsonBody(request);
      return send(200, await cloud.send(await view(body.sessionId), body.text, [], { submissionId: body.submissionId }));
    }
    if (url.pathname === '/api/cloud/recover' && request.method === 'POST') {
      const body = await jsonBody(request); return send(200, await cloud.recover(await view(body.sessionId)));
    }
    if (url.pathname === '/api/cloud/close' && request.method === 'POST') {
      const body = await jsonBody(request); views.get(body.sessionId)?.close(); views.delete(body.sessionId); return send(200, { ok: true });
    }
    if (url.pathname === '/api/fixture/state' && request.method === 'POST') {
      return send(200, await hub('/__fixture/state', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(await jsonBody(request)) }));
    }
    if (url.pathname.startsWith('/api/hub/')) {
      const route = url.pathname.slice('/api/hub'.length) + url.search;
      if (!/^\/(cloud-environments(?:\/[^/]+)?|tasks\/[^/]+\/attachments(?:\/[^/]+)?|attachments\/[^/]+(?:\/download)?)\b/.test(route)) return send(404, { ok: false });
      const body = ['POST', 'PATCH', 'DELETE'].includes(request.method) ? JSON.stringify(await jsonBody(request)) : undefined;
      const data = await hub('/api/v1' + route, { method: request.method, ...(body ? { body, headers: { 'Content-Type': 'application/json' } } : {}) });
      if (Buffer.isBuffer(data)) { response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' }); return response.end(data); }
      return send(200, data);
    }
    if (url.pathname.startsWith('/client/')) {
      const file = path.resolve(client, decodeURIComponent(url.pathname.slice('/client/'.length)));
      const relative = path.relative(client, file), ext = path.extname(file).toLowerCase();
      const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
      if (relative.startsWith('..') || path.isAbsolute(relative) || !types[ext]) return send(404, { ok: false });
      const data = await fs.readFile(file);
      response.writeHead(200, { 'Content-Type': types[ext], 'Cache-Control': 'no-store' }); return response.end(data);
    }
    return send(404, { ok: false, reason: 'Unknown fixture route' });
  } catch (error) { send(error.status || 400, { ok: false, reason: error.message }); }
}
async function stop() {
  if (stopped) return; stopped = true;
  for (const current of views.values()) current.close(); views.clear();
  server?.closeAllConnections(); server?.close();
  if (root) await fs.writeFile(path.join(root, 'stop'), '');
  if (backend) await until(() => backend.exitCode !== null, 'fixture stop', 20000).catch(() => backend.kill());
  if (log !== undefined) sync.closeSync(log);
  process.exitCode ||= 0;
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-cloud-browser-'));
  log = sync.openSync(path.join(output, 'hub.log'), 'w');
  const venvPython = path.join(repo, 'hub-backend/.venv/Scripts/python.exe');
  /* The development checkout may use the system Python instead of a local
     virtualenv. Keep the fixture runnable in both layouts so a missing venv
     cannot masquerade as a cloud-browser product failure. */
  const python = process.env.SODUWORK_PYTHON || (sync.existsSync(venvPython) ? venvPython : 'python');
  backend = spawn(python, [path.join(repo, 'hub-backend/tests/handoff_http_fixture.py'), root, '--browser'],
    { cwd: path.join(repo, 'hub-backend'), windowsHide: true, stdio: ['ignore', log, log] });
  await until(() => sync.existsSync(path.join(root, 'ready.json')), 'isolated Hub');
  identity = JSON.parse(await fs.readFile(path.join(root, 'ready.json'), 'utf8'));
  cloud = create({ app: { getPath: () => path.join(root, 'profile') }, identityOf: async () => identity, interval: 100 });
  server = http.createServer((request, response) => { void handle(request, response); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const info = { url: 'http://127.0.0.1:' + server.address().port, modelBoundary: 'synthetic-vendor-process' };
  await fs.writeFile(path.join(output, 'server.json'), JSON.stringify(info, null, 2));
  process.stdout.write(JSON.stringify(info) + '\n');
  const timer = setInterval(() => { if (sync.existsSync(path.join(output, 'stop'))) { clearInterval(timer); void stop(); } }, 500);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { clearInterval(timer); void stop(); });
})().catch(async error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; await stop(); });
