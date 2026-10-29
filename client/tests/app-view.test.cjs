'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { inspect } = require('../main/work-preview-app-inspect.cjs');
const proxy = require('../main/pi-session/app-mcp-proxy.cjs');
const script = path.resolve(__dirname, '../../skills/mcp-tools/scripts/app-view.mjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
function cli(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, windowsHide: true, env: process.env });
    let out = '', err = ''; child.stdout.on('data', c => out += c); child.stderr.on('data', c => err += c);
    child.on('error', reject); child.on('close', code => resolve({ code, out, err }));
  });
}
test('current app inspection binds the original view, reads visible text and screenshot, rejects origin/identity changes', async () => {
  let url = 'https://app.example/home.html', allowed = true, calls = 0;
  const wc = { isDestroyed: () => false, getURL: () => url,
    executeJavaScriptInIsolatedWorld: async (_world, scripts) => {
      assert.doesNotMatch(scripts[0].code, /localStorage|sessionStorage|cookie|\.value/);
      calls++; return { title: 'Signed-in app', url: 'https://app.example/home.html', text: 'Visible series' };
    }, capturePage: async () => ({ getSize: () => ({ width: 400, height: 300 }), toPNG: () => png }) };
  const item = { view: { webContents: wc }, appBridge: { origin: 'https://app.example' } };
  const guard = () => { if (!allowed) throw Error('revoked'); };
  assert.equal((await inspect(item, 'inspect', guard)).text, 'Visible series');
  assert.equal(Buffer.from((await inspect(item, 'shot', guard)).png, 'base64').compare(png), 0);
  url = 'https://other.example/'; await assert.rejects(inspect(item, 'inspect', guard), /来源变化/);
  assert.equal(calls, 2);
  url = 'https://app.example/home.html'; allowed = false; await assert.rejects(inspect(item, 'shot', guard), /revoked/);
  await assert.rejects(inspect(item, 'eval', () => {}), /仅支持/);
});
test('app-view CLI uses only explicit loopback app lease, writes a new local PNG, revokes on account change', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-view-'));
  let current = { token: 'fixture-private-ukey', revision: 1 }, views = 0, revokeDuring = false;
  const lease = await proxy.create({ ...current, url: 'http://127.0.0.1:1/mcp', readCurrent: () => current,
    inspect: async action => { views++; if (revokeDuring) current = { token: 'other', revision: 2 };
      return { ok: true, source: 'current-application', text: 'series fixture', ...(action === 'shot' ? { png: png.toString('base64') } : {}) }; } });
  t.after(() => { lease.cleanup(); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, 'lease.json'), config = { servers: { app: { appLease: true, url: lease.url, headers: { Authorization: 'Bearer ' + lease.token } } } };
  fs.writeFileSync(file, JSON.stringify(config)); const args = ['--config', file, 'app'];
  const result = await cli([...args, 'inspect'], root); assert.equal(result.code, 0, result.err);
  assert.equal(JSON.parse(result.out).text, 'series fixture'); assert.doesNotMatch(result.out, /fixture-private-ukey/);
  const shot = await cli([...args, 'shot', 'app.png'], root); assert.equal(shot.code, 0, shot.err);
  assert(fs.readFileSync(path.join(root, 'app.png')).equals(png)); assert.doesNotMatch(shot.out, /iVBOR|fixture-private-ukey/);
  assert.notEqual((await cli([...args, 'shot', 'app.png'], root)).code, 0, 'never overwrite an existing artifact');
  assert.notEqual((await cli([...args, 'shot', '../outside.png'], root)).code, 0, 'cannot write outside cwd');
  const endpoint = lease.url.replace('/mcp', '/app-view/inspect'), headers = { Authorization: 'Bearer ' + lease.token };
  assert.equal((await fetch(endpoint)).status, 403);
  assert.equal((await fetch(endpoint, { headers: { ...headers, Origin: 'https://other.example' } })).status, 403);
  assert.equal((await fetch(endpoint, { headers, method: 'POST' })).status, 403);
  assert.equal((await fetch(endpoint + '?eval=1', { headers })).status, 403);
  const before = views; revokeDuring = true;
  assert.equal((await fetch(endpoint, { headers })).status, 409);
  assert.equal((await fetch(endpoint, { headers })).status, 401); assert.equal(views, before + 1);
  config.servers.app.url = 'https://app.example/mcp'; fs.writeFileSync(file, JSON.stringify(config));
  assert.notEqual((await cli([...args, 'inspect'], root)).code, 0);
});
test('a transient compositor failure retries only capture and rechecks ownership before retry',async()=>{
  let calls=0,allowed=true;
  const wc={isDestroyed:()=>false,getURL:()=>'https://app.example/home.html',executeJavaScriptInIsolatedWorld:async()=>({title:'App',url:'https://app.example/home.html',text:'fixture'}),
    capturePage:async()=>{calls++;if(calls===1)throw Error('UnknownVizError');return{getSize:()=>({width:1,height:1}),toPNG:()=>png}}};
  const item={view:{webContents:wc},appBridge:{origin:'https://app.example'}},guard=()=>{if(!allowed)throw Error('revoked')};
  assert((await inspect(item,'shot',guard)).png);assert.equal(calls,2);
  wc.capturePage=async()=>{allowed=false;throw Error('UnknownVizError')};
  await assert.rejects(inspect(item,'shot',guard),/revoked/);
});
