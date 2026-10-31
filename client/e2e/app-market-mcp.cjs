'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 90000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, safeStorage } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const http = require('node:http'), assert = require('node:assert/strict');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-market-e2e-'));
  app.setPath('userData', root);
  let python, server, resolved;
  const report = { ok: false, cases: [], boundary: 'Isolated Electron main-process connection/store/grant/proxy and real loopback Hub APIs, package review, catalog and installation; authentication fixture only; no model, production profile or business service.' };
  app.whenReady().then(async () => {
    let businessCalls = 0;
    server = http.createServer((req, res) => {
      assert.equal(req.url, '/mcp');
      assert.equal(req.headers.authorization, 'Bearer fixture-app-credential');
      businessCalls++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const origin = 'http://127.0.0.1:' + server.address().port;
    python = require('node:child_process').spawn(path.resolve(__dirname, '../../hub-backend/.venv/Scripts/python.exe'),
      [path.join(__dirname, 'fixtures/market-app-hub.py'), origin], {
        cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, AUTH_SECRET: 'isolated-market-e2e-secret-000000000000000000',
          ADMIN_PASS: 'isolated-market-password', DATABASE_URL: 'sqlite+aiosqlite:///:memory:',
          CLUSTER_REDIS_URL: '', SODUWORK_ENV: 'development', PYTHONIOENCODING: 'utf-8' },
      });
    let diagnostics = '';
    python.stderr.on('data', data => { diagnostics += data.toString(); });
    const hub = await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(Error('Fixture startup timeout: ' + diagnostics)), 30000);
      python.once('error', reject);
      python.once('exit', code => { clearTimeout(timer); reject(Error('Fixture exited ' + code + ': ' + diagnostics)); });
      python.stdout.on('data', data => {
        out += data.toString();
        if (out.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(out.split('\n')[0]).hub); }
      });
    });
    let metadata;
    for (let i = 0; i < 200; i++) {
      try { const response = await fetch(hub + '/fixture/ready'); if (response.ok) { metadata = await response.json(); break; } } catch (_) {}
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(metadata?.pluginId, diagnostics);
    const identityOf = async () => ({ hub, clientId: 'fixture-device', session: 'fixture-session' });
    const headers = { Authorization: 'Device fixture-session', 'Content-Type': 'application/json' };
    const install = await fetch(hub + '/api/v1/plugins/' + metadata.pluginId + '/installation', {
      method: 'PUT', headers, body: JSON.stringify({ enabled: true, expectedVersionId: metadata.versionId }),
    });
    assert.equal(install.status, 200, await install.text());
    const store = require('../main/app-settings-store.cjs');
    store.configure({ app, safeStorage, ownerOf: () => 'fixture-account' });
    store.update({ pluginId: metadata.pluginId, origin }, {
      values: { ukey: 'fixture-app-credential' }, secretKeys: ['ukey'],
    });
    const connection = require('../main/work-preview-app-connection.cjs');
    const item = { appBridge: { appId: 'plugin:' + metadata.pluginId, contributionId: 'main', origin },
      view: { webContents: { isDestroyed: () => false, getURL: () => origin + '/' } } };
    const deps = { app, identityOf };
    assert.equal((await connection.connect({ item }, { server: 'fixture-business', url: origin + '/mcp', credentialKey: 'ukey' }, deps)).connected, true);
    resolved = await require('../main/pi-session/plugin-grant').resolve({ ...deps, cwd: root,
      pluginIds: [metadata.pluginId], appContext: { pluginId: metadata.pluginId,
        requiresMcp: true, connection: connection.resolve(item, deps) } });
    const spec = JSON.parse(fs.readFileSync(resolved.grant.configFile)).servers['fixture-business'];
    assert.equal(spec.appLease, true);
    assert.deepEqual(resolved.grant.servers, ['fixture-business']);
    const call = () => fetch(spec.url, { method: 'POST', headers: spec.headers, body: '{}' });
    assert.equal((await call()).status, 200);
    assert.equal(businessCalls, 1);
    report.cases.push('Real approved market package installs with on_install policy and no company MCP; production native bridge and turn resolver reach owned MCP.');
    const uninstalled = await fetch(hub + '/fixture/uninstall', { method: 'POST', headers });
    assert.equal(uninstalled.status, 200);
    assert.equal((await call()).status, 401);
    assert.equal(businessCalls, 1);
    report.cases.push('Uninstall revokes an existing application lease before another business call.');
    report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); }).finally(async () => {
    resolved?.grant?.cleanup();
    if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
    if (python && python.exitCode === null) {
      const exited = new Promise(r => python.once('exit', r));
      python.kill(); await exited;
    }
    console.log(JSON.stringify(report));
    app.exit(report.ok ? 0 : 1);
  });
}
