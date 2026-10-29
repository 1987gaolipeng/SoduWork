/*
 * Dependency-free CDP driver using Node's built-in WebSocket. Isolate reusable browsers
 * with random ports, dedicated user data, and session markers. Validate commands before
 * connecting so invalid actions cannot launch browsers or stall sessions.
 */
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { acquire, close as closeSession, heartbeat, status as sessionStatus, tabs, selectTarget } from './browser-session.mjs';

const HELP = '用法: node browser.mjs <shot|text|eval|errors|do|status|close> <url|-> [参数] --session <会话ID>';
const MAX_ACTIONS = 50;
const MAX_WAIT_MS = 30 * 1000;
const MAX_TOTAL_WAIT_MS = 2 * 60 * 1000;
const MAX_EXPRESSION_LENGTH = 50 * 1024;
const MAX_URL_LENGTH = 8192;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(HELP);
  console.log('动作：click、fill、upload、wait、eval、shot、text、goto；tabs current 列出标签页，open-tab <url> 打开发布页；--tab <id> 指定标签页；发布可用 --persistent [--headless] --session <稳定ID>，端口用 SODUWORK_PUBLISH_BROWSER_PORT 设置。');
  process.exit(0);
}

const sessionOptions = {};
for (const [flag, key] of [['--persistent', 'persistent'], ['--headless', 'headless']]) {
  const at = argv.indexOf(flag); if (at >= 0) { sessionOptions[key] = true; argv.splice(at, 1); }
}
let selectedTab = '';
const tabAt = argv.indexOf('--tab');
if (tabAt >= 0) {
  selectedTab = argv[tabAt + 1];
  if (!selectedTab || selectedTab.startsWith('--')) { console.error('失败：--tab 需要标签页 ID'); process.exit(2); }
  argv.splice(tabAt, 2);
}
const sessionAt = argv.indexOf('--session');
const explicitSession = sessionAt >= 0 ? String(argv[sessionAt + 1] || '') : '';
if (sessionAt >= 0) {
  if (!explicitSession || sessionAt !== argv.length - 2) {
    console.error('失败：--session 后必须提供最后一个非空会话 ID');
    process.exit(2);
  }
  argv.splice(sessionAt, 2);
}
const [cmd, url, arg, ...extra] = argv;
const terminalCommands = new Set(['close', 'status']);
if (!cmd || extra.length || (!url && !terminalCommands.has(cmd))) {
  console.error(HELP);
  process.exit(2);
}
if (terminalCommands.has(cmd) && url) {
  console.error('失败：status/close 不接受 URL 或其他参数');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CDP_REQUEST_TIMEOUT_MS = 30 * 1000;

let ws;
let activeSession;
let id = 0;
const pend = new Map();
const consoleErrors = [];

function send(method, params) {
  return new Promise((res, rej) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      rej(new Error('浏览器 CDP 连接未就绪'));
      return;
    }
    const i = ++id;
    const timer = setTimeout(() => {
      if (!pend.has(i)) return;
      pend.delete(i);
      rej(new Error(method + ' 超过 30 秒没有响应'));
    }, CDP_REQUEST_TIMEOUT_MS);
    timer.unref();
    pend.set(i, {
      res(value) { clearTimeout(timer); res(value); },
      rej(error) { clearTimeout(timer); rej(error); },
    });
    try {
      ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    } catch (error) {
      clearTimeout(timer);
      pend.delete(i);
      rej(error);
    }
  });
}

function rejectPending(error) {
  const reason = error instanceof Error ? error : new Error(String(error));
  for (const item of pend.values()) item.rej(reason);
  pend.clear();
}

async function connect() {
  activeSession = await acquire(explicitSession, sessionOptions);
  const target = selectedTab ? await selectTarget(activeSession, selectedTab) : activeSession.target;
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error('连接浏览器 CDP 超时')), 5000);
    timer.unref();
    ws.onopen = () => { clearTimeout(timer); resolveOpen(); };
    ws.onerror = () => { clearTimeout(timer); rejectOpen(new Error('连接浏览器 CDP 失败')); };
  });
  ws.onmessage = (ev) => {
    let message;
    try { message = JSON.parse(ev.data); } catch (error) { return; }
    if (message.id && pend.has(message.id)) {
      const pending = pend.get(message.id);
      pend.delete(message.id);
      message.error ? pending.rej(new Error(message.error.message || 'CDP 请求失败')) : pending.res(message.result);
    } else if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      if (consoleErrors.length < 200) {
        consoleErrors.push((message.params.args || []).map((item) => item.value ?? item.description ?? '').join(' '));
      }
    } else if (message.method === 'Runtime.exceptionThrown' && consoleErrors.length < 200) {
      consoleErrors.push(message.params.exceptionDetails?.exception?.description || '页面抛异常');
    }
  };
  ws.onerror = () => {
    rejectPending(new Error('浏览器 CDP 连接异常'));
  };
  ws.onclose = () => {
    rejectPending(new Error('浏览器 CDP 连接已关闭'));
  };
  await send('Page.enable');
  await send('Runtime.enable');
  heartbeat(activeSession);
}

function normalizeUrl(value) {
  if (!value || value === '-' || value === 'current') return null;
  if (value.length > MAX_URL_LENGTH) throw new Error('URL 过长');
  let parsed;
  try { parsed = new URL(value); } catch (error) { throw new Error('URL 无效'); }
  if (!['http:', 'https:', 'file:', 'about:'].includes(parsed.protocol)) {
    throw new Error('只允许 http、https、file 或 about:blank URL');
  }
  if (parsed.username || parsed.password) throw new Error('URL 不得包含账号或密码');
  if (parsed.protocol === 'about:' && parsed.href !== 'about:blank') throw new Error('只允许 about:blank');
  return parsed.href;
}

async function evalRaw(expression) {
  if (typeof expression !== 'string' || !expression.trim()) throw new Error('eval 表达式不能为空');
  if (expression.length > MAX_EXPRESSION_LENGTH) throw new Error('eval 表达式过长');
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description || '页面脚本执行失败');
  }
  return result?.result?.value;
}

async function evalJs(expression) {
  const value = await evalRaw(`(()=>{try{return JSON.stringify(${expression || 'undefined'})}catch(e){return 'ERR: '+e.message}})()`);
  if (typeof value === 'string' && value.startsWith('ERR: ')) throw new Error(value.slice(5));
  return value === undefined ? 'undefined' : value;
}

async function goto(target) {
  const address = normalizeUrl(target);
  if (!address) return;
  const navigation = await send('Page.navigate', { url: address });
  if (navigation?.errorText && navigation.errorText !== 'net::ERR_ABORTED') {
    throw new Error('页面导航失败：' + navigation.errorText);
  }
  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    await sleep(250);
    const state = await evalRaw('document.readyState');
    if (state === 'complete' || state === 'interactive') { ready = true; break; }
  }
  if (!ready) throw new Error('页面加载超过 15 秒');
  const current = await evalRaw('location.href');
  if (typeof current !== 'string' || !current || current === 'about:blank') {
    throw new Error('导航后未进入目标页面');
  }
  await sleep(200);
  heartbeat(activeSession);
}

async function shot(file) {
  const output = String(file || 'shot.png');
  mkdirSync(dirname(resolve(output)), { recursive: true });
  const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(output, Buffer.from(result.data, 'base64'));
  return output;
}

async function pageText() {
  const value = await evalRaw('(document.body && document.body.innerText || "").slice(0, 20000)');
  return typeof value === 'string' ? value : '';
}

async function click(selector) {
  if (typeof selector !== 'string' || !selector.trim() || selector.length > 512) {
    throw new Error('click 选择器无效');
  }
  const result = await evalRaw(`(()=>{
    const el=document.querySelector(${JSON.stringify(selector)});
    if(!el) return 'NOT FOUND';
    if(el.disabled || el.getAttribute('aria-disabled')==='true') return 'DISABLED';
    if(!el.getClientRects().length) return 'HIDDEN';
    el.scrollIntoView({block:'center',inline:'nearest'});
    el.focus?.();
    el.click();
    return 'clicked';
  })()`);
  if (result !== 'clicked') throw new Error('无法点击元素：' + result);
  return result;
}

async function fill(selector, value) {
  if (typeof selector !== 'string' || !selector.trim() || selector.length > 512) throw new Error('fill 选择器无效');
  if (typeof value !== 'string' || value.length > 100_000) throw new Error('fill 内容过长');
  const result = await evalRaw(`(()=>{
    const el=document.querySelector(${JSON.stringify(selector)});
    if(!el) return 'NOT FOUND';
    if(el.disabled || el.readOnly) return 'READONLY';
    el.scrollIntoView({block:'center',inline:'nearest'});
    el.focus?.();
    if(el.isContentEditable){
      document.execCommand('selectAll',false);
      document.execCommand('insertText',false,${JSON.stringify(value)});
    } else if(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement){
      const proto=el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
      Object.getOwnPropertyDescriptor(proto.prototype,'value').set.call(el,${JSON.stringify(value)});
    } else return 'UNSUPPORTED';
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return 'filled';
  })()`);
  if (result !== 'filled') throw new Error('无法填写元素：' + result);
  return result;
}

function validateUpload(value) {
  if (!value || typeof value.sel !== 'string' || !value.sel.trim() || value.sel.length > 512 ||
      !Array.isArray(value.files) || !value.files.length || value.files.length > 30 ||
      value.files.some(file => typeof file !== 'string' || !isAbsolute(file) || !statSync(file).isFile())) {
    throw new Error('upload 需要文件输入框 sel 和 1..30 个存在的本地绝对文件路径');
  }
}
async function upload(value) {
  validateUpload(value);
  const document = await send('DOM.getDocument');
  const found = await send('DOM.querySelector', { nodeId: document.root.nodeId, selector: value.sel });
  if (!found.nodeId) throw new Error('文件输入框不存在');
  await send('DOM.setFileInputFiles', { nodeId: found.nodeId, files: value.files });
  return 'uploaded ' + value.files.length + ' file(s)';
}

function parseSteps(raw) {
  let steps;
  try { steps = JSON.parse(raw || ''); } catch (error) { throw new Error('动作列表不是有效 JSON'); }
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_ACTIONS) {
    throw new Error('动作列表必须是 1..' + MAX_ACTIONS + ' 项数组');
  }
  return steps.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error(`第 ${index + 1} 项动作无效`);
    const keys = ['goto', 'click', 'fill', 'upload', 'wait', 'eval', 'shot', 'text'].filter((key) => Object.prototype.hasOwnProperty.call(step, key));
    if (keys.length !== 1) throw new Error(`第 ${index + 1} 项必须且只能包含一个动作`);
    const key = keys[0];
    if (['goto', 'click', 'eval', 'shot'].includes(key) && (typeof step[key] !== 'string' || !step[key].trim())) {
      throw new Error(`第 ${index + 1} 项 ${key} 需要非空字符串`);
    }
    if (key === 'text' && step.text !== true) throw new Error(`第 ${index + 1} 项 text 必须为 true`);
    if (key === 'goto') normalizeUrl(step.goto);
    if (key === 'upload') validateUpload(step.upload);
    if (key === 'wait') {
      const ms = Number(step.wait);
      if (!Number.isInteger(ms) || ms < 0 || ms > MAX_WAIT_MS) throw new Error(`第 ${index + 1} 项 wait 超出 0..${MAX_WAIT_MS}ms`);
    }
    if (key === 'fill' && (!step.fill || typeof step.fill !== 'object' || typeof step.fill.sel !== 'string' || typeof step.fill.value !== 'string')) {
      throw new Error(`第 ${index + 1} 项 fill 需要 sel 和 value`);
    }
    if (key === 'fill' && (!step.fill.sel.trim() || step.fill.value.length > 100_000)) throw new Error(`第 ${index + 1} 项 fill 内容无效或过长`);
    return step;
  });
}

function done(code) {
  try { ws && ws.close(); } catch (error) { /* best effort */ }
  try { activeSession && heartbeat(activeSession); } catch (error) { /* best effort */ }
  process.exitCode = code || 0;
  const exitTimer = setTimeout(() => process.exit(process.exitCode || 0), 100);
  exitTimer.unref();
}

try {
  const parsedSteps = cmd === 'do' ? parseSteps(arg) : null;
  if (cmd === 'open-tab' && !normalizeUrl(url)) throw new Error('open-tab 需要 URL');
  if (cmd === 'close') {
    console.log(JSON.stringify(await closeSession(explicitSession, sessionOptions)));
  } else if (cmd === 'status') {
    console.log(JSON.stringify(await sessionStatus(explicitSession, sessionOptions)));
  } else {
    await connect();
    if (!['tabs', 'open-tab'].includes(cmd)) await goto(url);
    if (cmd === 'tabs') {
      console.log(JSON.stringify((await tabs(activeSession)).map(({id, title, url}) => ({id, title, url}))));
    } else if (cmd === 'open-tab') {
      const address = normalizeUrl(url); if (!address) throw new Error('open-tab 需要 URL');
      console.log(JSON.stringify(await send('Target.createTarget', {url: address})));
    } else if (cmd === 'shot') {
      console.log('已截图：' + await shot(arg));
    } else if (cmd === 'text') {
      console.log(await pageText());
    } else if (cmd === 'eval') {
      console.log(await evalJs(arg || 'document.title'));
    } else if (cmd === 'errors') {
      await sleep(300);
      console.log(consoleErrors.length ? consoleErrors.join('\n') : '（没有控制台报错）');
    } else if (cmd === 'do') {
      let totalWait = 0;
      for (const step of parsedSteps) {
        if (step.goto) { await goto(step.goto); console.log('→ ' + step.goto); }
        else if (step.click) console.log('click ' + step.click + ' → ' + await click(step.click));
        else if (step.upload) console.log('upload ' + step.upload.sel + ' → ' + await upload(step.upload));
        else if (step.fill) console.log('fill ' + step.fill.sel + ' → ' + await fill(step.fill.sel, step.fill.value));
        else if (step.wait !== undefined) { totalWait += Number(step.wait); if (totalWait > MAX_TOTAL_WAIT_MS) throw new Error('动作总等待时间超过 2 分钟'); await sleep(Number(step.wait)); }
        else if (step.eval) console.log('eval → ' + await evalJs(step.eval));
        else if (step.shot) console.log('已截图：' + await shot(step.shot));
        else if (step.text) console.log('--- 页面文字 ---\n' + await pageText());
      }
    } else {
      throw new Error('不认识的命令：' + cmd);
    }
  }
  done(0);
} catch (error) {
  console.error('失败：' + (error?.message || error));
  done(1);
}
