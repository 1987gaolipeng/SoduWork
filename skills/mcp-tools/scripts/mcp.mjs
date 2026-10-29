/*
 * Dependency-free MCP command bridge using newline-delimited JSON-RPC 2.0 over stdio.
 * Usage: node mcp.mjs servers; node mcp.mjs list <server>; node mcp.mjs call <server>
 * <tool> '<json>'. Read server commands and arguments from adjacent servers.json or the
 * path in SODUWORK_MCP_SERVERS.
 */
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const cliArgs = process.argv.slice(2);
let configArg = '';
if (cliArgs[0] === '--config') {
  configArg = String(cliArgs[1] || '');
  cliArgs.splice(0, 2);
} else if (String(cliArgs[0] || '').startsWith('--config=')) {
  configArg = String(cliArgs.shift()).slice('--config='.length);
}
const [cmd, name, tool, argsJson] = cliArgs;
const CFG = configArg || process.env.SODUWORK_MCP_SERVERS || join(HERE, '..', 'servers.json');

function expandEnv(value) {
  if (value && typeof value === 'object' && value.command === 'soduwork-api') return value;
  if (Array.isArray(value)) return value.map(expandEnv);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandEnv(item)]));
  }
  if (typeof value !== 'string') return value;
  return value.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (_all, braced, plain) => process.env[braced || plain] || '');
}

function loadServers() {
  /* An explicit per-turn config is an authorization boundary. It must win over
     inherited process-wide MCP variables, otherwise concurrent conversations
     could silently use another turn's connectors. */
  if (!configArg && process.env.SODUWORK_MCP_SERVERS_JSON) {
    try { return expandEnv(JSON.parse(process.env.SODUWORK_MCP_SERVERS_JSON).servers || {}); }
    catch (e) { console.error('环境里的 MCP 配置不是合法 JSON，请检查配置格式'); return {}; }
  }
  if (!existsSync(CFG)) return {};
  try { return expandEnv(JSON.parse(readFileSync(CFG, 'utf8')).servers || {}); }
  catch (e) { console.error('servers.json 读取失败，请检查文件和配置格式'); return {}; }
}

function toolSet(spec, key) {
  if (!Object.prototype.hasOwnProperty.call(spec || {}, key)) return null;
  return new Set((Array.isArray(spec[key]) ? spec[key] : [])
    .map((item) => String(item || '').trim()).filter(Boolean));
}

function toolAllowed(spec, name) {
  const tool = String(name || '');
  const granted = toolSet(spec, 'allowedTools');
  const enabled = toolSet(spec, 'enabledTools');
  const disabled = toolSet(spec, 'disabledTools');
  if (granted !== null && !granted.has(tool)) return false;
  if (enabled !== null && enabled.size && !enabled.has(tool)) return false;
  return disabled === null || !disabled.has(tool);
}

function runtimePolicy(spec, method = 'tools/call') {
  // Accept persisted pre-rename configs and mixed Hub/Runner versions. If both
  // keys are present, neither alias can relax the other key's execution budget.
  const policies = [spec?.soduWorkPolicy, spec?.soduworkPolicy]
    .filter(value => value && typeof value === 'object' && !Array.isArray(value));
  const configured = method === 'initialize'
    ? Math.min(120, Math.max(3, Number(spec && spec.startupTimeoutSeconds) || 10))
    : Math.min(300, Math.max(3, Number(spec && spec.toolTimeoutSeconds) || 60));
  // Video and other media plugins can legitimately take several minutes.
  // Hub still applies the signed per-turn deadline, so the bridge must not
  // impose a shorter 60-second timeout in front of that server-side limit.
  const timeoutSeconds = Math.min(configured, ...policies.map(raw => Number(raw.timeoutSeconds) > 0
    ? Math.min(300, Math.max(3, Number(raw.timeoutSeconds))) : configured));
  const maxResultChars = Math.min(500000, ...policies.map(raw =>
    Math.max(1000, Number(raw.maxResultChars) || 500000)));
  return { timeoutSeconds, timeoutMs: Math.round(timeoutSeconds * 1000), maxResultChars };
}

function boundedOutput(value, spec) {
  const text = String(value == null ? '' : value);
  const { maxResultChars } = runtimePolicy(spec);
  if (text.length <= maxResultChars) return text;
  return JSON.stringify({
    truncated: true,
    preview: text.slice(0, maxResultChars),
    message: 'MCP 返回内容过大，已截断；请缩小查询范围或分页获取',
  });
}

/*
 * Run one operation per session: start the server, initialize, execute, and shut down.
 * Each CLI command opens a fresh stateful MCP session.
 */
const SUPPORTED_VERSIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
const MAX_PROTOCOL_BYTES = 2_000_000;

function replyResult(message, expectedId) {
  if (!message || typeof message !== 'object' || Array.isArray(message) ||
      message.jsonrpc !== '2.0' || Object.hasOwn(message, 'method')) {
    throw new Error('MCP 响应格式不合法');
  }
  if (message.id !== expectedId) throw new Error('MCP 响应 ID 与请求不一致');
  if (Object.hasOwn(message, 'error') === Object.hasOwn(message, 'result')) {
    throw new Error('MCP 响应必须包含且仅包含 result 或 error');
  }
  if (message.error) {
    const code = message.error.code;
    throw new Error('MCP 服务返回协议错误（' + (Number.isInteger(code) ? code : '格式不合法') + '）');
  }
  if (!message.result || typeof message.result !== 'object' || Array.isArray(message.result)) {
    throw new Error('MCP 结果必须是 JSON 对象');
  }
  return message.result;
}

function checkVersion(result) {
  if (!SUPPORTED_VERSIONS.has(result && result.protocolVersion)) {
    throw new Error('MCP 协议版本不受支持');
  }
}

async function readHttpBody(response) {
  if (!response.body) return '';
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PROTOCOL_BYTES) throw new Error('MCP 返回内容超过安全上限');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    try { await reader.cancel(); } catch { /* connection already closed */ }
    reader.releaseLock();
  }
}

async function soduWorkHttpSession(spec, fn) {
  const url = new URL(String(spec.url || ''));
  if (url.username || url.password) throw new Error('MCP 地址不能包含账号凭据，请使用连接授权配置');
  const expected = String(process.env.SODUWORK_HUB_ORIGIN || '');
  // App connections are scoped by a per-turn revocable loopback proxy. Only an
  // explicit grant file may select this transport; inherited configs stay Hub-only.
  // Older running clients omit appLease but issue the same nonce-protected lease.
  const appLease = spec.appLease !== false && !!configArg && url.protocol === 'http:' &&
    url.hostname === '127.0.0.1' && !!url.port && url.pathname === '/mcp' &&
    !url.search && !url.hash && /^Bearer [a-f0-9]{64}$/.test(spec.headers?.Authorization || '');
  if (!appLease && (!expected || url.origin !== expected || !/^\/api\/v1\/mcp\/?$/.test(url.pathname))) {
    throw new Error('这座内置桥只允许连接当前 SoduWork 后台的任务工具');
  }
  let id = 0, protocolVersion = '';
  const send = async (method, params, notification = false) => {
    const ctl = new AbortController();
    const runtime = runtimePolicy(spec, method);
    const timer = setTimeout(() => ctl.abort(), runtime.timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const body = { jsonrpc: '2.0', method, params: params || {} };
      if (!notification) body.id = ++id;
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json',
        Authorization: String((spec.headers || {}).Authorization || '') };
      if ([...headers.Authorization].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c.charCodeAt(0) > 255)) {
        throw new Error('MCP 请求头格式不合法，请检查连接授权');
      }
      if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion;
      const res = await fetch(url, {
        method: 'POST', signal: ctl.signal, redirect: 'manual',
        headers, body: JSON.stringify(body),
      });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        throw new Error('MCP 地址发生重定向，已拒绝转发凭据');
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error('MCP 调用被拒绝（HTTP ' + res.status + '）');
      }
      // Consume a bounded body; do not expose arbitrary server diagnostics.
      const raw = await readHttpBody(res);
      if (notification) return {};
      if (res.status === 202) throw new Error('MCP 仅确认受理，未返回结果；未自动重试');
      let reply;
      try { reply = JSON.parse(raw); }
      catch { throw new Error('后台返回的不是合法 JSON'); }
      return replyResult(reply, body.id);
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new Error('等 ' + method + ' 超时（' + runtime.timeoutSeconds + ' 秒），未自动重试');
      }
      throw error;
    } finally { clearTimeout(timer); }
  };
  const initialized = await send('initialize', {
    protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'soduwork', version: '1.0' },
  });
  checkVersion(initialized);
  protocolVersion = initialized.protocolVersion;
  await send('notifications/initialized', {}, true);
  return fn((method, params) => send(method, params, false));
}

async function session(spec, fn) {
  if (spec.command === 'soduwork-api') return (await import('../connectors/api-runtime.cjs')).default.session(spec, fn);
  if (spec.command === 'soduwork-connector') {
    const {default: connector} = await import('../connectors/runtime.cjs');
    return connector.session(spec, fn);
  }
  if (spec.type === 'http') return soduWorkHttpSession(spec, fn);
  const shim = (process.platform === 'win32' &&
    /^(npx|npm|pnpm|yarn|uvx|uv|deno|bunx)$/i.test(spec.command)) || /\.(cmd|bat)$/i.test(spec.command);
  const child = spawn(spec.command, spec.args || [], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, ...(spec.env || {}) },
    shell: shim, detached: process.platform !== 'win32',
  });
  let id = 0, buf = '', totalBytes = 0, stderrBytes = 0, fatal = null, stopping = false;
  const decoder = new StringDecoder('utf8'), pend = new Map();
  const closed = new Promise(resolve => child.once('close', resolve));
  function fail(error) {
    if (!fatal) fatal = error;
    for (const entry of pend.values()) { clearTimeout(entry.timer); entry.reject(fatal); }
    pend.clear();
  }
  function write(message) {
    if (fatal) throw fatal;
    child.stdin.write(JSON.stringify(message) + '\n', error => {
      if (error && !stopping) fail(new Error('MCP 进程输入流已关闭'));
    });
  }
  child.on('error', () => fail(new Error('MCP 进程启动失败，请检查连接配置和运行依赖')));
  child.on('exit', (code, signal) => {
    if (!stopping) fail(new Error('MCP 进程已退出（' + (signal || code) + '），未获得完整结果'));
  });
  child.stdin.on('error', () => {
    if (!stopping) fail(new Error('MCP 进程输入流已关闭'));
  });
  child.stdout.on('error', () => fail(new Error('MCP 进程输出流已关闭')));
  child.stderr.on('error', () => {});
  child.stderr.on('data', d => { stderrBytes = Math.min(MAX_PROTOCOL_BYTES, stderrBytes + d.length); });
  child.stdout.on('data', d => {
    if (fatal) return;
    totalBytes += d.length;
    if (totalBytes > MAX_PROTOCOL_BYTES) return fail(new Error('MCP 返回内容超过安全上限'));
    buf += decoder.write(d);
    let at;
    while ((at = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, at).trim();
      buf = buf.slice(at + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); }
      catch {
        // Retain compatibility with peers that log plain text, but cap all bytes.
        if (line.startsWith('{') || line.startsWith('[')) fail(new Error('MCP 返回的 JSON 格式不合法'));
        continue;
      }
      if (!m || typeof m !== 'object' || Array.isArray(m) || m.jsonrpc !== '2.0') {
        fail(new Error('MCP 消息格式不合法')); return;
      }
      if (Object.hasOwn(m, 'method')) {
        if (Object.hasOwn(m, 'id')) {
          // IDs in each direction are independent. Never settle a pending call
          // with a server request (even if its ID collides).
          try {
            write({ jsonrpc: '2.0', id: m.id, ...(m.method === 'ping'
              ? { result: {} } : { error: { code: -32601, message: 'Unsupported client method' } }) });
          } catch (error) { fail(error); }
        }
        continue;
      }
      const entry = pend.get(m.id);
      if (!entry) { fail(new Error('MCP 响应 ID 与请求不一致')); return; }
      pend.delete(m.id);
      clearTimeout(entry.timer);
      try { entry.resolve(replyResult(m, m.id)); } catch (error) { entry.reject(error); }
    }
  });

  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (fatal) return reject(fatal);
    const requestId = ++id, runtime = runtimePolicy(spec, method);
    const timer = setTimeout(() => {
      if (!pend.has(requestId)) return;
      // Cancellation is advisory. It never authorizes a replay of a tool call.
      try { write({ jsonrpc: '2.0', method: 'notifications/cancelled',
        params: { requestId, reason: 'Request deadline exceeded' } }); } catch {}
      fail(new Error('等 ' + method + ' 超时（' + runtime.timeoutSeconds + ' 秒），未自动重试'));
    }, runtime.timeoutMs);
    pend.set(requestId, { resolve, reject, timer });
    try { write({ jsonrpc: '2.0', id: requestId, method, params: params || {} }); }
    catch (error) { fail(error); }
  });
  const waitClosed = ms => new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), ms);
    closed.then(() => { clearTimeout(timer); resolve(true); });
  });
  try {
    const initialized = await rpc('initialize', {
      protocolVersion: '2025-11-25', capabilities: {},
      clientInfo: { name: 'soduwork', version: '1.0' },
    });
    checkVersion(initialized);
    write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return await fn(rpc);
  } finally {
    stopping = true;
    fail(new Error('MCP 连接已关闭'));
    try { child.stdin.end(); } catch {}
    if (!await waitClosed(250) && child.pid) {
      if (process.platform === 'win32') {
        const killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => { try { child.kill(); } catch {} });
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      }
      if (!await waitClosed(500)) {
        try {
          if (process.platform === 'win32') child.kill();
          else process.kill(-child.pid, 'SIGKILL');
        } catch {}
        // Release inherited pipes even if a broken peer keeps descendants alive.
        child.stdout.destroy(); child.stderr.destroy();
      }
    }
    if (stderrBytes && process.env.SODUWORK_MCP_DEBUG) {
      console.error('[MCP stderr] ' + stderrBytes + ' bytes（内容已省略，避免输出凭据）');
    }
  }
}

async function listTools(rpc) {
  const tools = [], seen = new Set(), names = new Set();
  let cursor = '';
  for (let page = 0; page < 20; page += 1) {
    const out = await rpc('tools/list', cursor ? { cursor } : {});
    if (!Array.isArray(out?.tools)) throw new Error('MCP 工具目录格式不合法');
    for (const item of out.tools) {
      if (!item || typeof item !== 'object' || typeof item.name !== 'string' ||
          !item.name.trim() || item.name.length > 200 || names.has(item.name)) {
        throw new Error('MCP 分页工具目录有无效或重复名称');
      }
      names.add(item.name);
      tools.push(item);
    }
    if (tools.length > 500) throw new Error('MCP 工具目录超过分页安全上限');
    const next = out.nextCursor;
    if (next == null) return { tools };
    if (typeof next !== 'string' || !next || next.length > 2000) {
      throw new Error('MCP 分页游标格式不合法');
    }
    if (seen.has(next)) throw new Error('MCP 分页游标循环，未返回不完整目录');
    seen.add(next);
    cursor = next;
  }
  throw new Error('MCP 工具目录超过分页安全上限，未返回不完整目录');
}

const servers = loadServers();

function need(n) {
  const s = servers[n];
  if (!s) {
    console.error('没有叫「' + n + '」的 MCP server。已配好的：' +
      (Object.keys(servers).join('、') || '（一个都没有，去 servers.json 里加）'));
    process.exit(2);
  }
  return s;
}

try {
  if (cmd === 'servers' || !cmd) {
    const names = Object.keys(servers);
    console.log(names.length
      ? names.map((n) => '- ' + n + '：' + (servers[n].description || servers[n].command)).join('\n')
      : '还没有配任何 MCP server（servers.json 是空的）。');
  } else if (cmd === 'list') {
    const spec = need(name);
    const out = await session(spec, listTools);
    const tools = (out.tools || []).filter((item) => toolAllowed(spec, item && item.name));
    if (process.env.SODUWORK_MCP_JSON === '1') console.log(JSON.stringify({ tools }));
    else {
      const rendered = tools.length
        ? tools.map((t) => '## ' + t.name + '\n' + (t.description || '（没写说明）') +
            '\n入参：' + JSON.stringify(t.inputSchema || {
              type: 'object', properties: {},
            })).join('\n\n')
        : '这个 server 没有暴露工具。';
      console.log(boundedOutput(rendered, spec));
    }
  } else if (cmd === 'health') {
    const {default: health} = await import(need(name).command === 'soduwork-api' ? '../connectors/api-runtime.cjs' : '../connectors/health.cjs');
    console.log(JSON.stringify(await health.probe(need(name))));
  } else if (cmd === 'call') {
    if (!tool) { console.error('要调哪个工具？先 `list` 看看有哪些。'); process.exit(2); }
    const spec = need(name);
    if (!toolAllowed(spec, tool)) {
      console.error('这个工具没有被当前插件绑定批准：' + tool);
      process.exit(3);
    }
    let args = {};
    const rawArgs = argsJson || (process.env.SODUWORK_MCP_ARGS_STDIN === '1'
      ? readFileSync(0, 'utf8') : '');
    if (rawArgs) {
      try { args = JSON.parse(rawArgs); }
      catch (e) { console.error('参数不是合法 JSON，请检查输入格式'); process.exit(2); }
    }
    const out = await session(spec, (rpc) => rpc('tools/call', { name: tool, arguments: args }));
    if (process.env.SODUWORK_MCP_JSON === '1') console.log(JSON.stringify(out));
    else {
      const parts = (out.content || []).map((c) => (c.type === 'text' ? c.text : '[' + c.type + ']')).join('\n');
      console.log(boundedOutput(parts || JSON.stringify(out), spec));
    }
    if (out.isError) process.exit(1);
  } else {
    console.error('用法: mcp.mjs [--config <file>] servers | list <server> | call <server> <tool> \'<json>\'');
    process.exit(2);
  }
  /* Let HTTP/Undici release its handles before exit. An immediate process.exit()
     can trip libuv's closing-handle assertion on Windows after a successful call. */
  process.exitCode = 0;
} catch (e) {
  console.error('失败：' + e.message);
  process.exitCode = 1;
}
