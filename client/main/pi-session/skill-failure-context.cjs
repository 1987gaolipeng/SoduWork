'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { redact } = require('../conversation/import-redaction');
const { readScope } = require('../conversation/history-access');

const { assertNoLinks } = require('../plugin-resources');
const bound = new WeakMap();
const MAX_TURNS = 128;
const MAX_FIELD = 3000;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function fileFor(app, scope, sessionId) {
  if (!scope || !sessionId) return '';
  return path.join(app.getPath('userData'), 'skill-failure-context', hash(JSON.stringify([scope, sessionId])) + '.json');
}

function bind(app, handle, identity) {
  if (!handle || handle.localReplica || handle.cloudProxy || !app?.getPath) return;
  const file = fileFor(app, readScope(identity), handle.sessionId);
  if (!file) { bound.delete(handle); return; }
  if (bound.get(handle)?.file === file) return;
  const root = app.getPath('userData');
  let data = {};
  try {
    assertNoLinks(root, file);
    if (fs.statSync(file).size <= 4 * 1024 * 1024) data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) { /* A new session has no local context. */ }
  bound.set(handle, { file, root, turns: new Map(Array.isArray(data?.turns) ? data.turns.slice(-MAX_TURNS).filter(row => Array.isArray(row) && Array.isArray(row[1])) : []),
    saved: data?.saved || null });
}

function save(state) {
  const dir = path.dirname(state.file);
  assertNoLinks(state.root, state.file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = state.file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify({ turns: [...state.turns], saved: state.saved }), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, state.file);
  } finally { fs.rmSync(temp, { force: true }); }
}

function remove(app, scope, ids) {
  for (const id of ids) {
    const file = fileFor(app, scope, id);
    if (file && fs.existsSync(file)) {
      assertNoLinks(app.getPath('userData'), file);
      fs.rmSync(file, { force: true });
    }
  }
}

// Record only package identity at execution time. Prompts and tool output already
// belong to the local transcript and are read only when the user requests a report.
function prepared(handle, submissionId, items) {
  const state = handle && bound.get(handle);
  if (!state || !submissionId || !items?.length) return;
  const skills = items.slice(0, 20).map(row => ({ name: String(row.name).slice(0, 128),
    version: String(row.version || row.checksum || '').slice(0, 80) }));
  state.turns.set(submissionId, skills);
  if (state.turns.size > MAX_TURNS) state.turns.delete(state.turns.keys().next().value);
  try { save(state); } catch (_) { /* Keep the live receipt available on a read-only volume. */ }
}

function failure(state, snapshot, id) {
  const tools = snapshot?.tools || [], messages = snapshot?.messages || [];
  for (let i = tools.length - 1; i >= 0; i--) {
    const tool = tools[i];
    if ((!tool.isError && tool.state !== 'error' && tool.state !== 'failed') || (id && tool.id !== id)) continue;
    if (!Number.isInteger(tool.after) || tool.after < 0 || tool.after >= messages.length) continue;
    let index = tool.after;
    while (index >= 0 && messages[index]?.role !== 'user') index--;
    const user = messages[index];
    const skills = state.turns.get(user?.submissionId);
    if (skills) return { tool, user, skills };
  }
  return null;
}

function summary(handle, snapshot) {
  const state = bound.get(handle);
  if (!state) return null;
  const hit = state.turns.size && failure(state, snapshot);
  return hit ? { id: hit.tool.id } : state.saved ? { id: state.saved.id } : null;
}

function clean(value, cwd) {
  let text = String(value ?? '');
  if (cwd) text = text.split(cwd).join('<cwd>');
  text = text.replace(/(--(?:token|password|api[-_]key|secret)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s]+)/gi, '$1[redacted]')
    .replace(/((?:authorization|cookie|set-cookie)\s*:\s*)[^\r\n]+/gi, '$1[redacted]');
  text = redact(text.replace(/(\b(?:token|auth_token|client_secret)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[redacted]'));
  return text.length > MAX_FIELD ? text.slice(0, MAX_FIELD) + '…' : text;
}

function safeArgs(value, cwd, depth = 0, budget = { remaining: 96 }) {
  if (--budget.remaining < 0) return '…';
  if (value == null || typeof value !== 'object') return typeof value === 'string' ? clean(value, cwd) : value;
  if (depth >= 4) return '…';
  if (Array.isArray(value)) return value.slice(0, 16).map(item => safeArgs(item, cwd, depth + 1, budget));
  return Object.fromEntries(Object.entries(value).slice(0, 24).map(([key, item]) => [
    clean(key, cwd), /token|password|passwd|secret|authorization|cookie|api.?key|credential|^env(?:ironment)?$/i.test(key)
      ? '[redacted]' : safeArgs(item, cwd, depth + 1, budget)]));
}

async function runtimeVersion(commands, pattern) {
  for (const command of commands) {
    const version = await new Promise(resolve => execFile(command, ['--version'], {
      cwd: path.dirname(process.execPath), timeout: 1500, maxBuffer: 1024, windowsHide: true,
    }, (err, out, stderr) => resolve(!err && pattern.exec(out || stderr)?.[1])));
    if (version) return version;
  }
  return '';
}

function displayCwd(cwd) {
  const tempRelative = path.relative(os.tmpdir(), cwd);
  if (tempRelative && !tempRelative.startsWith('..' + path.sep) && tempRelative !== '..' && !path.isAbsolute(tempRelative)) {
    return clean('<temp>/' + tempRelative.split(path.sep).join('/'));
  }
  const home = os.homedir();
  const relative = path.relative(home, cwd);
  if (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) {
    return clean(relative ? '~/' + relative.split(path.sep).join('/') : '~');
  }
  return cwd.replace(/([\\/]Users[\\/]|^\/home\/)[^\\/]+/i, '$1<user>').slice(0, 500);
}

function handler({ session, BrowserWindow }) {
  return async (event, ref, id) => {
    const handle = typeof ref === 'string' && session.get(ref);
    const state = handle && bound.get(handle);
    const win = BrowserWindow.fromWebContents(event.sender);
    const current = () => handle && session.get(ref) === handle && !handle.detached && handle.attachedWindow === win &&
      win && !win.isDestroyed() && (!event.senderFrame || event.senderFrame === event.sender.mainFrame);
    if (!state || typeof id !== 'string' || !id || !current()) return { ok: false };
    if (state.saved?.id === id && !state.unsaved) return { ok: true, report: state.saved };
    const hit = failure(state, handle.snapshot(), id);
    if (!hit) return { ok: false };
    const full = handle.toolDetail ? await handle.toolDetail(id) : hit.tool;
    if (!full || !current()) return { ok: false };
    const cwd = String(handle.cwd || '');
    const [node, python] = await Promise.all([
      runtimeVersion([process.platform === 'win32' ? 'node.exe' : 'node'], /^v(\d+\.\d+\.\d+)/),
      runtimeVersion(process.platform === 'win32' ? ['python.exe', 'py.exe'] : ['python3', 'python'], /\bPython (\d+\.\d+(?:\.\d+)?)/),
    ]);
    const report = { id, skills: hit.skills, prompt: clean(hit.user.text, cwd),
      files: (hit.user.attachments || []).slice(0, 16).map(a => clean(path.basename(String(a.name || a.label || '')), cwd)).filter(Boolean),
      tool: clean(full.name, cwd), input: String(JSON.stringify(safeArgs(full.args, cwd), null, 2) ?? '').slice(0, MAX_FIELD),
      output: clean(full.result, cwd), system: os.type() + ' ' + os.release() + ' (' + os.arch() + ')',
      node, python, cwd: cwd ? displayCwd(cwd) : '' };
    if (!current()) return { ok: false };
    state.saved = report;
    try { save(state); state.unsaved = false; return { ok: true, report }; }
    catch (_) { state.unsaved = true; return { ok: true, report, unsaved: true }; }
  };
}

module.exports = { bind, prepared, summary, handler, remove };
