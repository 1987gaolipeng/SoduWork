/* Isolated, reusable Chrome/Edge sessions for Browser Use.

   A marker tab proves that the CDP endpoint belongs to this exact SoduWork
   session. The work tab, profile and login state survive individual commands;
   a detached watchdog removes idle sessions so browsers cannot leak forever. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(tmpdir(), 'soduwork-browser-sessions');
const PERSISTENT_ROOT = join(process.env.SODUWORK_PUBLISH_BROWSER_ROOT || process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'SoduWork', 'publishing-browser');
const IDLE_MS = 20 * 60 * 1000;
const START_LOCK_TIMEOUT_MS = 20 * 1000;
const START_LOCK_STALE_MS = 60 * 1000;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function safeId(value) {
  const clean = String(value || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return clean.slice(0, 64);
}
export function sessionId(explicit = '') {
  const chosen = safeId(explicit || process.env.SODUWORK_BROWSER_SESSION);
  if (chosen) return chosen;
  return createHash('sha256').update(resolve(process.cwd())).digest('hex').slice(0, 24);
}
function persistent(id) { return id.startsWith('persistent-'); }
function chosenId(explicit, options = {}) { const id = sessionId(explicit); return options.persistent && !persistent(id) ? 'persistent-' + id : id; }
function sessionDir(id) { return join(persistent(id) ? PERSISTENT_ROOT : ROOT, id); }
function stateFile(id) { return join(sessionDir(id), 'state.json'); }
function startLockFile(id) { return join(ROOT, id + '.start.lock'); }

function browserCandidates() {
  const envPath = process.env.SODUWORK_BROWSER;
  const candidates = [
    ...(envPath ? [envPath] : []),
    ...(process.platform === 'win32'
    ? [
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      ]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
       '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']),
  ];
  const seen = new Set();
  return candidates.filter((item) => {
    const key = String(item || '').toLowerCase();
    if (!key || seen.has(key) || !existsSync(item)) return false;
    seen.add(key);
    return true;
  });
}
function readState(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value && value.schemaVersion === 1 && Number.isInteger(value.port) &&
        value.port > 0 && value.port <= 65535 && Number.isInteger(value.pid) &&
        value.pid > 0 && typeof value.token === 'string' && /^[a-f0-9]{32}$/i.test(value.token)) return value;
  } catch (error) { /* missing/corrupt means stale */ }
  return null;
}
function saveState(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = file + '.tmp-' + randomBytes(4).toString('hex');
  writeFileSync(temp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
  try { renameSync(temp, file); }
  catch (error) {
    writeFileSync(file, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    rmSync(temp, { force: true });
  }
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return false; }
}
function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true,
    });
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch (error) {
    try { process.kill(pid, 'SIGTERM'); } catch (ignored) { /* already gone */ }
  }
}
async function targetList(port) {
  const response = await fetch('http://127.0.0.1:' + port + '/json/list', {
    signal: AbortSignal.timeout(1200),
  });
  if (!response.ok) throw new Error('CDP target list returned HTTP ' + response.status);
  const value = await response.json();
  return Array.isArray(value) ? value : [];
}
async function newTarget(port, address = 'about:blank') {
  const response = await fetch(
    'http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(address),
    { method: 'PUT', signal: AbortSignal.timeout(1200) },
  );
  if (!response.ok) throw new Error('CDP target creation returned HTTP ' + response.status);
  const value = await response.json();
  return value && typeof value.webSocketDebuggerUrl === 'string' ? value : null;
}
async function ownsEndpoint(port, token) {
  const response = await fetch('http://127.0.0.1:' + port + '/json/version', {signal: AbortSignal.timeout(1200)});
  const version = await response.json();
  if (!version.webSocketDebuggerUrl) return false;
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  try {
    return await new Promise((done) => {
      const timer = setTimeout(() => done(false), 1500);
      const finish = value => {clearTimeout(timer);done(value);};
      socket.onopen = () => socket.send(JSON.stringify({id: 1, method: 'Browser.getBrowserCommandLine'}));
      socket.onmessage = event => {
        let data;try {data=JSON.parse(event.data);} catch (_) {return;}
        if (data.id === 1) finish(Array.isArray(data.result?.arguments) && data.result.arguments.includes('--soduwork-browser-token=' + token));
      };
      socket.onerror = socket.onclose = () => finish(false);
    });
  } finally {try {socket.close();} catch (_) {}}
}
async function verify(state, { createTarget = true } = {}) {
  if (!state || !pidAlive(state.pid)) return null;
  try {
    const list = await targetList(state.port);
    const marker = 'about:blank#soduwork-' + state.token;
    if (!list.some((item) => item.type === 'page' && item.url === marker)) return null;
    let work = list.find((item) => item.type === 'page' && item.id === state.targetId);
    if (!work && createTarget) work = await newTarget(state.port);
    return work && work.webSocketDebuggerUrl ? work : null;
  } catch (error) { return null; }
}

async function acquireStartLock(id) {
  mkdirSync(ROOT, { recursive: true });
  const file = startLockFile(id);
  const deadline = Date.now() + START_LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let fd;
    try {
      fd = openSync(file, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 'utf8');
      return () => {
        try { closeSync(fd); } catch (error) { /* already closed */ }
        try { rmSync(file, { force: true }); } catch (error) { /* best effort */ }
      };
    } catch (error) {
      let stale = false;
      try {
        const lock = JSON.parse(readFileSync(file, 'utf8'));
        stale = Date.now() - Number(lock.startedAt || 0) > START_LOCK_STALE_MS;
      } catch (ignored) { stale = true; }
      if (stale) {
        try { rmSync(file, { force: true }); } catch (ignored) { /* another starter owns it */ }
      }
      await sleep(100);
    }
  }
  throw new Error('等待浏览器会话启动锁超时');
}
async function checkPort(port) {
  if (!port) return;
  await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error('专用浏览器端口已占用；不会连接或关闭其他浏览器，请修改 SODUWORK_PUBLISH_BROWSER_PORT')));
    server.listen(port, '127.0.0.1', () => server.close(resolvePort));
  });
}
async function start(id, options = {}) {
  const keep = persistent(id);
  const port = Number(options.port ?? (keep ? process.env.SODUWORK_PUBLISH_BROWSER_PORT || 9337 : 0));
  if (!Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535))) throw new Error('专用浏览器端口必须为 1024..65535 或 0');
  await checkPort(port);
  const candidates = browserCandidates();
  if (!candidates.length) {
    throw new Error('这台机器上没找到 Chrome/Edge。请安装浏览器或设置 SODUWORK_BROWSER。');
  }
  const dir = sessionDir(id);
  if (!keep) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const profile = join(dir, 'profile');
  const token = randomBytes(16).toString('hex');
  for (const executable of candidates) {
    if (!keep) rmSync(profile, { recursive: true, force: true });
    const child = spawn(executable, [
      '--remote-debugging-port=' + port,
      '--remote-debugging-address=127.0.0.1',
      '--enable-automation', '--soduwork-browser-token=' + token,
      '--user-data-dir=' + profile,
      ...((options.headless ?? !keep) ? ['--headless=new'] : []), '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      ...(!keep ? ['--remote-allow-origins=*'] : []), '--window-size=1280,900',
      ...(!keep ? ['--no-proxy-server'] : []),
    ], { stdio: 'ignore', detached: true, windowsHide: true });
    child.unref();
    const state = {
      schemaVersion: 1, id, token, port, pid: child.pid, profile, persistent: keep,
      browser: basename(executable),
      targetId: '', startedAt: Date.now(), touchedAt: Date.now(),
    };
    let healthFailures = 0;
    for (let wait = 0; wait < 40; wait += 1) {
      await sleep(250);
      try {
        if (!state.port) {
          const active = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split(String.fromCharCode(10));
          state.port = Number(String(active[0] || '').trim());
        }
        if (!state.port) continue;
        if (!await ownsEndpoint(state.port, token)) continue;
        const list = await targetList(state.port);
        const marker = 'about:blank#soduwork-' + token;
        // Only add a marker after verifying our random launch token; another
        // instance may have won the fixed port after checkPort released it.
        let markerTarget = list.find((item) => item.type === 'page' && item.url === marker);
        if (!markerTarget) markerTarget = await newTarget(state.port, marker);
        if (!markerTarget || markerTarget.url !== marker) continue;
        let work = list.find((item) => item.type === 'page' && item.id !== markerTarget.id);
        if (!work) work = await newTarget(state.port);
        if (!work || !work.webSocketDebuggerUrl) continue;
        state.markerId = markerTarget.id;
        state.targetId = work.id;
        saveState(stateFile(id), state);
        if (!keep) { const watcher = spawn(process.execPath, [
          fileURLToPath(import.meta.url), '--watch', stateFile(id), String(child.pid),
        ], { stdio: 'ignore', detached: true, windowsHide: true });
        watcher.unref(); }
        return { state, target: work, reused: false };
      } catch (error) {
        if (state.port && ++healthFailures >= 3) break;
      }
    }
    killTree(child.pid);
  }
  throw new Error('浏览器已启动，但隔离的 CDP 会话没有响应');
}

export async function acquire(explicit = '', options = {}) {
  const id = chosenId(explicit, options);
  const file = stateFile(id);
  let state = readState(file);
  const target = await verify(state);
  if (target) {
    state = { ...state, targetId: target.id, touchedAt: Date.now() };
    saveState(file, state);
    return { id, state, target, reused: true };
  }
  const release = await acquireStartLock(id);
  try {
    // Another command may have completed startup while this process waited.
    state = readState(file);
    const concurrentTarget = await verify(state);
    if (concurrentTarget) {
      state = { ...state, targetId: concurrentTarget.id, touchedAt: Date.now() };
      saveState(file, state);
      return { id, state, target: concurrentTarget, reused: true };
    }
    if (state && persistent(id) && pidAlive(state.pid)) throw new Error('专用浏览器身份标记丢失；请先手动关闭该窗口再重试');
    if (state && !persistent(id)) killTree(state.pid);
    return { id, ...(await start(id, options)) };
  } finally {
    release();
  }
}
export function heartbeat(session) {
  if (!session || !session.state) return;
  const next = { ...session.state, touchedAt: Date.now() };
  session.state = next;
  try { saveState(stateFile(session.id), next); } catch (error) { /* watchdog still has TTL */ }
}
export async function close(explicit = '', options = {}) {
  const id = chosenId(explicit, options);
  const file = stateFile(id);
  const state = readState(file);
  if (state && persistent(id)) {
    const target = await verify(state, { createTarget: false });
    if (!target && pidAlive(state.pid)) throw new Error('浏览器身份无法核实，不会关闭该进程');
    if (target) {
      // Browser.close flushes the dedicated profile's cookies before process exit.
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((done) => {
        const timer = setTimeout(done, 2000);
        socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
        socket.onclose = socket.onerror = () => { clearTimeout(timer); done(); };
      });
      try { socket.close(); } catch (_) {}
      for (let i = 0; i < 30 && pidAlive(state.pid); i++) await sleep(100);
      if (pidAlive(state.pid)) killTree(state.pid);
    }
  } else if (state) killTree(state.pid);
  try { rmSync(file, { force: true }); } catch (error) { /* no state */ }
  await sleep(250);
  if (!persistent(id)) try { rmSync(sessionDir(id), { recursive: true, force: true }); } catch (error) { /* scanner lock */ }
  return { id, closed: !!state };
}
export async function status(explicit = '', options = {}) {
  const id = chosenId(explicit, options);
  const state = readState(stateFile(id));
  const target = await verify(state, { createTarget: false });
  return {
    id, running: !!target, pid: target ? state.pid : 0,
    ...(persistent(id) ? {persistent: true, port: target ? state.port : 0} : {}),
    browser: target ? String(state.browser || '') : '',
    idleMs: target ? Math.max(0, Date.now() - Number(state.touchedAt || 0)) : 0,
  };
}


export async function tabs(session) {
  if (!await verify(session?.state, { createTarget: false })) throw new Error('浏览器会话身份验证失败');
  heartbeat(session);
  return (await targetList(session.state.port)).filter(item => item.type === 'page' && item.id !== session.state.markerId);
}
export async function selectTarget(session, targetId) {
  const target = (await tabs(session)).find(item => item.id === targetId);
  if (!target) throw new Error('标签页不属于当前受管浏览器');
  return target;
}

async function watch(file, expectedPid) {
  const expected = Number(expectedPid || 0);
  while (true) {
    await sleep(15000);
    const state = readState(file);
    if (!state || state.pid !== expected) return;
    if (!pidAlive(expected)) {
      try { rmSync(dirname(file), { recursive: true, force: true }); } catch (error) {}
      return;
    }
    if (Date.now() - Number(state.touchedAt || 0) >= IDLE_MS) {
      try { rmSync(file, { force: true }); } catch (error) {}
      killTree(expected);
      await sleep(300);
      try { rmSync(dirname(file), { recursive: true, force: true }); } catch (error) {}
      return;
    }
  }
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url)) &&
    process.argv[2] === '--watch') {
  await watch(String(process.argv[3] || ''), process.argv[4]);
}
