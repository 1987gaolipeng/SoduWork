'use strict';

// Reviewed imports are account-local evidence, separate from the single
// learned personal document. One atomic record owns revision and archive state.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const local = require('./local-memory');
const { redact } = require('./import-redaction');
const LIMITS = { summary: 6000, goal: 3000, decisions: 3000, constraints: 3000, pending: 3000, outcomes: 3000 };
const MAX_BYTES = 8 * 1024 * 1024;

function missing() { const error = Error('导入记忆不存在或已删除'); error.status = 404; return error; }
function directory(app, owner) {
  const dir = path.join(local.userMemoryRoot(app, owner), 'imports');
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('导入记忆目录无效');
  } catch (error) { if (error.code !== 'ENOENT') throw error; fs.mkdirSync(dir, { mode: 0o700 }); }
  return dir;
}
function fileFor(app, owner, id) {
  if (!/^[a-f0-9]{32}$/.test(String(id))) throw missing();
  return path.join(directory(app, owner), id + '.json');
}
function read(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw Error('导入记忆文件无效');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function write(file, item) {
  const content = JSON.stringify(item);
  if (Buffer.byteLength(content) > MAX_BYTES) throw Error('导入记忆内容过大');
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, content, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch (_) {} }
}
function fields(raw = {}) {
  const result = {};
  for (const [name, limit] of Object.entries(LIMITS)) {
    const value = raw[name] ?? '';
    if (typeof value !== 'string' || value.length > limit) throw Error('记忆字段过长或格式无效');
    result[name] = redact(value.trim());
  }
  if (!result.summary) throw Error('请填写会话摘要');
  return result;
}
function changes(raw) {
  const title = String(raw.title || '').trim();
  if (!title || title.length > 240) throw Error('请填写有效的记忆标题');
  const links = {};
  for (const name of ['projectId', 'repoId', 'taskId']) {
    const value = String(raw[name] || '');
    if (value.length > 320 || /[\r\n]/.test(value)) throw Error('记忆关联无效');
    links[name] = value;
  }
  return { title: redact(title), fields: fields(raw.fields), ...links };
}
function legacyRecord(app, owner, id) {
  // Reading through the personal-document catalog also runs automatic learning.
  // Imports must remain explicit context, so inspect only their exact old file.
  const root = local.userMemoryRoot(app, owner), dir = path.join(root, 'sessions');
  const file = path.join(dir, crypto.createHash('sha256').update(id).digest('hex') + '.md');
  try {
    const directoryStat = fs.lstatSync(dir), stat = fs.lstatSync(file);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() ||
        !stat.isFile() || stat.isSymbolicLink() || stat.size > local.MAX_BYTES) throw Error('旧导入记忆文件无效');
    const relative = path.relative(root, fs.realpathSync(file));
    if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Error('旧导入记忆路径无效');
    const bytes = fs.readFileSync(file);
    if (bytes.length > local.MAX_BYTES) throw Error('旧导入记忆文件过大');
    const content = redact(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      .replace(/^<!--[^\n]*-->\r?\n/gm, '');
    return { content, title: /^#\s+(.+)$/m.exec(content)?.[1]?.trim() || '导入会话', fileName: path.basename(file) };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function get({ app, owner, id }) {
  const file = fileFor(app, owner, id);
  let item = read(file);
  if (!item) {
    // Older clients wrote reviewed imports as private Markdown. Retain that
    // summary on first access rather than replacing it with a fresh extraction.
    const legacy = legacyRecord(app, owner, id);
    if (!legacy) throw missing();
    const content = legacy.content;
    const mapped = {};
    for (const name of Object.keys(LIMITS)) {
      const label = name[0].toUpperCase() + name.slice(1);
      mapped[name] = new RegExp('^## ' + label + '\\r?\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))', 'm').exec(content)?.[1]?.trim() || '';
    }
    // Preserve non-standard edits in the evidence even when no section exists.
    if (!mapped.summary) mapped.summary = content.slice(0, LIMITS.summary);
    item = { id, scope: 'private', title: legacy.title || '导入会话', fields: mapped,
      events: [{ role: 'assistant', id: 'legacy', text: redact(content) }], warnings: [],
      sourceMeta: { fileName: legacy.fileName }, archived: false, revision: 1, updatedAt: new Date().toISOString() };
    write(file, item);
  }
  if (item.deleted) throw missing();
  if (item.id !== id || !item.fields || !Number.isInteger(item.revision)) throw Error('导入记忆记录损坏');
  return { ok: true, item };
}
function save({ app, owner, draft, edits }) {
  const seed = draft.sourceSessionId || draft.sourceHash;
  if (!seed) throw Error('导入文件缺少来源标识');
  const id = crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 32);
  try { return { ...get({ app, owner, id }), duplicate: true }; }
  catch (error) { if (error.status !== 404) throw error; }
  const item = { id, scope: 'private', ...changes(edits), revision: 1, archived: false,
    events: draft.events || [], warnings: draft.warnings || [], sourceMeta: draft.sourceMeta || {},
    source: draft.source, sourceHash: draft.sourceHash, updatedAt: new Date().toISOString() };
  write(fileFor(app, owner, id), item);
  return { ok: true, duplicate: false, item };
}
function act({ app, owner, id, action, body = {} }) {
  const item = get({ app, owner, id }).item;
  const file = fileFor(app, owner, id);
  if (action === 'delete') {
    // A content-free tombstone prevents old Markdown from resurrecting on reopen.
    write(file, { id, deleted: true });
    return { ok: true };
  }
  if (action === 'update') {
    if (body.revision !== item.revision) throw Error('记忆已在其他位置修改，请重新打开后保存');
    Object.assign(item, changes(body));
  } else if (action === 'archive' || action === 'restore') item.archived = action === 'archive';
  else throw Error('不支持的记忆操作');
  item.revision++;
  item.updatedAt = new Date().toISOString();
  write(file, item);
  return { ok: true, item };
}
function context(options) {
  const items = [], unavailable = [];
  for (const id of options.ids || []) {
    try { const item = get({ ...options, id }).item; if (item.archived) unavailable.push(id); else items.push(item); }
    catch (error) { if (error.status !== 404) throw error; unavailable.push(id); }
  }
  return { items, unavailable, prompt: items.map(item => '--- ' + item.title + ' ---\n' +
    Object.entries(item.fields).filter(([, value]) => value).map(([name, value]) => name + ': ' + value).join('\n')).join('\n\n').slice(0, 28000) };
}
module.exports = { get, save, act, context };
