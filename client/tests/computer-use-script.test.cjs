'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const cp = require('node:child_process');
const background = require('../main/pi-session/background-process');
const helper = path.resolve(__dirname, '../../skills/computer-use/scripts/desktop-control.ps1');
const screen = path.resolve(__dirname, '../../skills/computer-use/scripts/screen.ps1');
const win = process.platform === 'win32';
const quotePS = value => "'" + String(value).replaceAll("'", "''") + "'";
function powershell(command, env = {}, input) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from('[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); ' + command, 'utf16le').toString('base64')],
    { windowsHide: true, env: { ...process.env, SODUWORK_DESKTOP_CONTROL_ENDPOINT: '', SODUWORK_DESKTOP_CONTROL_SCOPE: '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(Error('PowerShell fixture timed out')); }, 12000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}
async function bridge(t, dispatch) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-desktop-lease-'));
  const calls = [], token = 'b'.repeat(64);
  const server = http.createServer((req, res) => {
    let text = ''; req.setEncoding('utf8'); req.on('data', chunk => { text += chunk; });
    req.on('end', async () => {
      const body = JSON.parse(text); calls.push({ route: req.url, body });
      assert.equal(req.headers.authorization, 'Bearer ' + token);
      try {
        const result = await dispatch(req.url, body, calls);
        if (result === 'disconnect') return req.socket.destroy();
        res.writeHead(result?.status || 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result?.body || result || { ok: true }));
      } catch (error) { res.writeHead(500); res.end(JSON.stringify({ ok: false })); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = path.join(temp, 'endpoint.json');
  fs.writeFileSync(endpoint, JSON.stringify({ url: 'http://127.0.0.1:' + server.address().port, token }));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(temp, { recursive: true, force: true }); });
  return { calls, endpoint, env: { SODUWORK_DESKTOP_CONTROL_ENDPOINT: endpoint, SODUWORK_DESKTOP_CONTROL_SCOPE: 'pi:fixture:turn-1' } };
}
const prologue = "$ErrorActionPreference='Stop'; . " + quotePS(helper) + "; ";

test('Pi children retain per-turn ownership across concurrent scopes and nested async calls', { skip: !win }, async () => {
  const before = process.env.SODUWORK_DESKTOP_CONTROL_SCOPE;
  const run = scope => background.run(async () => {
    await new Promise(resolve => setTimeout(resolve, scope.endsWith('1') ? 30 : 5));
    const inherited = background.run(() => cp.execFileSync(process.execPath,
      ['-p', 'process.env.SODUWORK_DESKTOP_CONTROL_SCOPE'], { encoding: 'utf8', env: { ...process.env, soduwork_desktop_control_scope: 'stale' } }).trim());
    const result = await new Promise((resolve, reject) => cp.execFile(process.execPath,
      ['-p', 'process.env.SODUWORK_DESKTOP_CONTROL_SCOPE'], (error, out) => error ? reject(error) : resolve(out.trim())));
    return [inherited, result];
  }, { desktopScope: scope });
  assert.deepEqual(await Promise.all([run('pi:a:1'), run('pi:b:2')]), [['pi:a:1', 'pi:a:1'], ['pi:b:2', 'pi:b:2']]);
  assert.equal(process.env.SODUWORK_DESKTOP_CONTROL_SCOPE, before);
});

test('real PowerShell waits for begin ACK then sends ownership and heartbeats, ending idempotently', { skip: !win }, async t => {
  let acknowledged = false;
  const b = await bridge(t, async route => {
    if (route === '/begin') { await new Promise(resolve => setTimeout(resolve, 80)); acknowledged = true; return { ok: true, leaseId: 'lease-1', scope: 'pi:fixture:resolved', cancelled: false }; }
    assert.ok(acknowledged);
    return { ok: true, cancelled: false };
  });
  const result = await powershell(prologue + "try { Start-DesktopControl 'batch'; Wait-DesktopControl 470; Write-Output 'completed' } finally { Stop-DesktopControl; Stop-DesktopControl }", b.env);
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /completed/);
  assert.deepEqual(b.calls.map(x => x.route), ['/begin', '/status', '/status', '/status', '/end']);
  assert.equal(b.calls[0].body.scope, 'pi:fixture:turn-1'); assert.ok(b.calls[0].body.pid > 0);
  for (const call of b.calls.slice(1)) assert.deepEqual(call.body, { scope: 'pi:fixture:resolved', leaseId: 'lease-1' });
});

test('real script batch stops after cancellation and cannot run its next action', { skip: !win }, async t => {
  let statuses = 0;
  const b = await bridge(t, route => route === '/begin' ? { ok: true, leaseId: 'lease-2', cancelled: false }
    : { ok: true, cancelled: route === '/status' && ++statuses >= 3 });
  // Wait-only fixture: no physical keyboard, mouse, screenshot or user window interaction.
  const result = await powershell('& ' + quotePS(screen) + " batch stdin", b.env, JSON.stringify([{ cmd: 'wait', ms: 5000 }, { cmd: 'not-a-real-action' }]));
  assert.notEqual(result.code, 0); assert.doesNotMatch(result.stdout, /batch complete/);
  assert.doesNotMatch(result.stderr, /unsupported batch action/);
  assert.match(result.stderr, /Desktop operation cancelled/); assert.equal(b.calls.at(-1).route, '/end');
});

test('configured bridge refusal or disconnection fails closed before any simulated input', { skip: !win }, async t => {
  for (const failure of ['denied', 'disconnect']) {
    const b = await bridge(t, route => failure === 'disconnect' ? 'disconnect' : { status: 409, body: { ok: false, cancelled: true } });
    const result = await powershell(prologue + "try { Start-DesktopControl 'click'; Write-Output 'INPUT-MUST-NOT-HAPPEN' } finally { Stop-DesktopControl }", b.env);
    assert.notEqual(result.code, 0); assert.doesNotMatch(result.stdout, /INPUT-MUST-NOT-HAPPEN/);
  }
});

test('loss of heartbeat stops a granted operation instead of silently continuing', { skip: !win }, async t => {
  const b = await bridge(t, route => route === '/begin' ? { ok: true, leaseId: 'lease-3', cancelled: false } : route === '/status' ? 'disconnect' : { ok: true });
  const result = await powershell(prologue + "try { Start-DesktopControl 'batch'; Assert-DesktopControl; Write-Output 'INPUT-MUST-NOT-HAPPEN' } finally { Stop-DesktopControl }", b.env);
  assert.notEqual(result.code, 0); assert.doesNotMatch(result.stdout, /INPUT-MUST-NOT-HAPPEN/);
  assert.equal(b.calls.at(-1).route, '/end');
});

test('headless script remains usable and literal text escaping does not send shortcut syntax', { skip: !win }, async () => {
  const result = await powershell(prologue + "Start-DesktopControl 'batch'; Wait-DesktopControl 10; Stop-DesktopControl; ConvertTo-DesktopKeys '+^%~(){}[]hello'");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), '{+}{^}{%}{~}{(}{)}{{}{}}{[}{]}hello');
});

test('invalid endpoint is rejected locally without contacting remote hosts', { skip: !win }, async t => {
  const b = await bridge(t, () => { throw Error('must not contact'); });
  const config = JSON.parse(fs.readFileSync(b.endpoint));
  fs.writeFileSync(b.endpoint, JSON.stringify({ ...config, url: 'http://192.0.2.1:88' }));
  const result = await powershell(prologue + "Start-DesktopControl 'click'; Write-Output 'INPUT-MUST-NOT-HAPPEN'", b.env);
  assert.notEqual(result.code, 0); assert.doesNotMatch(result.stdout, /INPUT-MUST-NOT-HAPPEN/);
  assert.equal(b.calls.length, 0);
});

test('long literal typing is split into cancellable Unicode-safe chunks without real input', { skip: !win }, async () => {
  const fake = "Add-Type -TypeDefinition 'namespace System.Windows.Forms { public static class SendKeys { public static System.Collections.Generic.List<string> Calls = new System.Collections.Generic.List<string>(); public static void SendWait(string value) { Calls.Add(value); } } }'; ";
  const result = await powershell(prologue + fake +
    "$script:checks=0; function Assert-DesktopControl { $script:checks++ }; " +
    "$value=('x'*15) + [char]::ConvertFromUtf32(128512) + ('a'*18); Send-DesktopText $value; " +
    "@{checks=$script:checks; calls=@([System.Windows.Forms.SendKeys]::Calls)} | ConvertTo-Json -Compress");
  assert.equal(result.code, 0, result.stderr);
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.checks, 3);
  assert.equal(parsed.calls.join(''), 'x'.repeat(15) + '😀' + 'a'.repeat(18));
  assert.equal(parsed.calls[0], 'x'.repeat(15) + '😀');
});

test('Runner desktop scopes match only the local session and its current or just-dispatched round', async t => {
  const { createRunnerRuntimeAdapter, getRunnerSessionDetails } = require('../main/agent-runtime/runner-adapter');
  let polls = 0;
  const adapter = createRunnerRuntimeAdapter({
    modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'fixture', key: 'fixture' } }) },
    runnerRuntime: { rpc: async (op, payload) => op === 'job.session' && payload.limit !== 1
      ? (++polls, { ok: true, data: { round: 3, status: 'running', items: [] } })
      : { ok: true, data: { ok: true } } }
  });
  const session = await adapter.resumeSession({ native: { runner: { openOptions: { cwd: os.tmpdir(), resumePath: 'desktop-owner' } } } });
  t.after(() => session.dispose());
  const handle = getRunnerSessionDetails(session).handle;
  for (let i = 0; i < 100 && handle.desktopControlScope !== 'runner:desktop-owner:3'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(polls > 0, 'the full session poll publishes the current round after the resume credential probe');
  assert.equal(handle.desktopControlScope, 'runner:desktop-owner:3');
  assert.equal(handle.ownsDesktopControlScope('runner:desktop-owner:3'), true);
  assert.equal(handle.ownsDesktopControlScope('runner:desktop-owner:4'), true, 'new child can beat the next UI poll');
  for (const value of ['runner:another:3', 'runner:desktop-owner:2', 'runner:desktop-owner:5', 'runner:desktop-owner:03', 'runner:desktop-owner:3junk']) {
    assert.equal(handle.ownsDesktopControlScope(value), false, value);
  }
});

test('scoped tools with a custom environment still use this client desktop bridge', { skip: !win }, () => {
  const previous = process.env.SODUWORK_DESKTOP_CONTROL_ENDPOINT;
  try {
    process.env.SODUWORK_DESKTOP_CONTROL_ENDPOINT = 'D:/isolated/desktop-endpoint.json';
    const result = background.run(() => cp.execFileSync(process.execPath,
      ['-p', 'JSON.stringify({scope:process.env.SODUWORK_DESKTOP_CONTROL_SCOPE,endpoint:process.env.SODUWORK_DESKTOP_CONTROL_ENDPOINT})'],
      { encoding: 'utf8', env: { soduwork_desktop_control_endpoint: 'stale' } }), { desktopScope: 'pi:custom-env:1' });
    assert.deepEqual(JSON.parse(result), { scope: 'pi:custom-env:1', endpoint: process.env.SODUWORK_DESKTOP_CONTROL_ENDPOINT });
  } finally {
    if (previous === undefined) delete process.env.SODUWORK_DESKTOP_CONTROL_ENDPOINT;
    else process.env.SODUWORK_DESKTOP_CONTROL_ENDPOINT = previous;
  }
});
