'use strict';

/*
 * Local Markdown memory.
 *
 * Personal summaries live in Electron's userData/memory directory. Project
 * and workspace summaries live beside the worktree in .soduwork/*.md. This
 * module deliberately has no Hub dependency: local memory is a document, not
 * a database record. The caller must provide the current worktree when it
 * wants to read or edit .soduwork files.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const learning = require('./personal-learning');
const { redact } = require('./import-redaction');

const MAX_BYTES = 256 * 1024;
// A consolidated personal document can contain several legacy documents.
// Keep a separate bound, and reject a migration that exceeds it instead of
// quietly discarding the end of the user's memory.
const MAX_PERSONAL_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 256;
const MAX_SUMMARY = 320;
// Personal memory is one logical document per account.  Older releases
// allowed arbitrary Markdown files in this directory; the canonical file is
// used for new writes and consolidation hides those legacy files from the
// user-facing list without deleting them.
const PERSONAL_MEMORY_FILE = 'personal.md';
const PERSONAL_STATE_FILE = '.personal-state.json';
const SCOPES = new Set(['personal', 'workspace', 'project']);
const PROJECT_FILES = new Set(['memory.md', 'decisions.md', 'project-memory.md', 'soduwork-project-memory.md']);
const WORKSPACE_FILES = new Set(['context.md', 'conventions.md', 'workspace-memory.md', 'soduwork-workspace-memory.md']);

function configuredWorkdir(app) {
  try {
    const file = path.join(app.getPath('userData'), 'chat-config.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return String(data && data.workDir || '').trim() || path.join(app.getPath('documents'), 'SoduWork');
  } catch (_) {
    try { return path.join(app.getPath('documents'), 'SoduWork'); } catch (_) { return ''; }
  }
}

function resolveCwd(app, cwd) { return cleanRoot(cwd) || cleanRoot(configuredWorkdir(app)); }

function cleanRoot(value) {
  const text = String(value || '').trim();
  return text ? path.resolve(text) : '';
}

function realRoot(value) {
  const root = cleanRoot(value);
  if (!root) return '';
  try {
    const stat = fs.lstatSync(root);
    return stat.isDirectory() && !stat.isSymbolicLink() ? fs.realpathSync(root) : '';
  } catch (_) { return ''; }
}

function relativeSafe(root, candidate) {
  const rel = path.relative(root, candidate);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return '';
  return rel;
}

function inside(root, candidate) {
  return Boolean(root && relativeSafe(root, candidate));
}

function userMemoryRoot(app, owner = '') {
  if (!app || typeof app.getPath !== 'function') throw Error('应用数据目录不可用');
  const root = realRoot(app.getPath('userData'));
  if (!root) throw Error('应用数据目录不可用');
  const memory = path.join(root, 'memory');
  try {
    const stat = fs.lstatSync(memory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error('本地记忆目录无效');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(memory, { recursive: true, mode: 0o700 });
  }
  if (!owner) return realRoot(memory);
  if (!/^[a-f0-9]{32}$/.test(owner)) throw Error('Invalid memory owner');
  let owned = memory;
  for (const name of ['accounts', owner]) {
    owned = path.join(owned, name);
    try {
      const stat = fs.lstatSync(owned);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Invalid memory directory');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.mkdirSync(owned, { mode: 0o700 });
    }
  }
  return realRoot(owned);
}

function workspaceRoot(cwd) {
  const root = realRoot(cwd);
  if (!root) return '';
  // Keep the established .soduwork layout, but preserve the Markdown memory
  // library used by earlier SoduWork/Workbuddy workspaces as a local source.
  // Do not scan the whole project tree or ordinary documentation.
  const candidates = [path.join(root, '.soduwork'), path.join(root, '.workbuddy', 'memory')];
  for (const candidate of candidates) {
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isDirectory() && !stat.isSymbolicLink()) return fs.realpathSync(candidate);
    } catch (_) { /* try the next supported local memory root */ }
  }
  return '';
}
function scopeForFile(file, kind) {
  if (kind === 'personal') {
    if (path.basename(path.dirname(file)).toLowerCase() === 'sessions') return 'session';
    return 'personal';
  }
  const base = path.basename(file).toLowerCase();
  if (PROJECT_FILES.has(base)) return 'project';
  if (WORKSPACE_FILES.has(base) || /^soduwork-workspace-memory-auto\.md$/.test(base)) return 'workspace';
  return 'project';
}

function idFor(kind, root, relative) {
  // IDs cross the renderer IPC boundary and are also stored in session
  // bindings.  Keep them opaque and ASCII-only: a Markdown filename may
  // contain spaces, CJK or punctuation, none of which should make a valid
  // local document impossible to select later.
  const namespace = kind === 'personal' ? 'personal' :
    'workspace:' + crypto.createHash('sha256').update(root).digest('hex').slice(0, 24);
  const digest = crypto.createHash('sha256')
    .update(kind + '\0' + root + '\0' + relative.replace(/\\/g, '/'))
    .digest('hex').slice(0, 48);
  return namespace + ':' + digest;
}

function legacyIdFor(kind, root, relative) {
  const namespace = kind === 'personal' ? 'personal' :
    'workspace:' + crypto.createHash('sha256').update(root).digest('hex').slice(0, 24);
  return namespace + ':' + relative.replace(/\\/g, '/');
}

function decode(buffer, file) {
  if (buffer.includes(0)) throw Error('记忆文档包含无效字符：' + path.basename(file));
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

function summaryOf(content) {
  const lines = String(content || '').split(/\r?\n/).map(line =>
    line.replace(/^\s{0,3}#{1,6}\s*/, '').trim()).filter(Boolean);
  return (lines[0] || '').replace(/\s+/g, ' ').slice(0, MAX_SUMMARY);
}

function record(kind, root, file, content, bytes) {
  const relative = relativeSafe(root, file);
  if (!relative) return null;
  const item = {
    id: idFor(kind, root, relative),
    scope: scopeForFile(file, kind),
    title: path.basename(file, path.extname(file)),
    fileName: path.basename(file),
    relativePath: relative.replace(/\\/g, '/'),
    summary: summaryOf(content), content, bytes,
    revision: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
    filePath: file, directory: path.dirname(file),
    ...(kind === 'personal' && scopeForFile(file, kind) === 'personal' ? { editableContent: learning.displayContent(content) } : {}),
    source: 'local-markdown', writable: true,
  };
  // Keep old bindings resolvable after the ID format migration without
  // exposing the path-shaped compatibility value to the renderer.
  Object.defineProperty(item, 'legacyId', {
    value: legacyIdFor(kind, root, relative), enumerable: false,
  });
  return item;
}

function readRecord(kind, root, file, strict = false) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !inside(root, file) || !inside(root, fs.realpathSync(file)) ||
        !/\.(md|markdown)$/i.test(file)) {
      if (strict) throw Error('记忆文档路径无效：' + path.basename(file));
      return null;
    }
    const maxBytes = kind === 'personal' && scopeForFile(file, kind) === 'personal' ? MAX_PERSONAL_BYTES : MAX_BYTES;
    if (stat.size > maxBytes) throw Error('记忆文档超过可读取大小，原文件已保留：' + path.basename(file));
    const buffer = fs.readFileSync(file);
    if (buffer.byteLength > maxBytes) throw Error('记忆文档超过可读取大小，原文件已保留：' + path.basename(file));
    return record(kind, root, file, decode(buffer, file), buffer.byteLength);
  } catch (error) {
    if (strict && error.code !== 'ENOENT') throw error;
    return null;
  }
}

function scanPersonalFiles(root) {
  const found = [];
  let bytes = 0;
  const walk = current => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { if (!['sessions', 'accounts'].includes(entry.name.toLowerCase())) walk(file); continue; }
      if (!entry.isFile() || !/\.(md|markdown)$/i.test(entry.name)) continue;
      if (file === path.join(root, PERSONAL_MEMORY_FILE)) continue;
      const item = readRecord('personal', root, file, true);
      if (item) {
        bytes += item.bytes;
        if (bytes > MAX_PERSONAL_BYTES) throw Error('个人记忆旧文件总量超过 16 MiB，请先整理后重试；原文件均已保留');
        found.push(item);
        if (found.length > MAX_FILES) throw Error('个人记忆旧文件超过 ' + MAX_FILES + ' 份，请先整理后重试；原文件均已保留');
      }
    }
  };
  walk(root);
  return found;
}

function personalState(root) {
  const file = path.join(root, PERSONAL_STATE_FILE);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw Error('个人记忆迁移状态无效');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!state || state.version !== 1 || !Array.isArray(state.aliases) ||
        state.aliases.some(alias => typeof alias !== 'string' || alias.length > 320)) throw Error('个人记忆迁移状态无效');
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function withPersonalAliases(item, state) {
  if (!item) return [];
  Object.defineProperty(item, 'aliases', { value: state.aliases, enumerable: false });
  return [item];
}

function consolidatePersonal(root) {
  if (!root) return [];
  const canonicalFile = path.join(root, PERSONAL_MEMORY_FILE);
  const state = personalState(root);
  const canonical = readRecord('personal', root, canonicalFile, true);
  // This marker makes the canonical document authoritative even when it is
  // deleted. Original Markdown files remain recoverable, but cannot resurrect
  // personal memory on the next list call or application restart.
  if (state) return withPersonalAliases(canonical, state);
  const legacy = scanPersonalFiles(root);
  if (!canonical && !legacy.length) return [];
  let content = canonical ? canonical.content : '';
  for (const item of legacy) {
    // An earlier release may already have merged these sources. Do not append
    // an identical copy, but always preserve any content not yet represented.
    if (content.includes(item.content)) continue;
    const heading = String(item.title || item.fileName || '记忆')
      .replace(/[\r\n#]/g, ' ').trim().slice(0, 160) || '记忆';
    content = content ? content + '\n\n## ' + heading + '\n\n' + item.content : item.content;
    if (Buffer.byteLength(content, 'utf8') > MAX_PERSONAL_BYTES) {
      throw Error('个人记忆合并后超过 16 MiB，请先整理后重试；原文件均已保留，未截断内容');
    }
  }
  if (!canonical || content !== canonical.content) {
    atomicWrite(canonicalFile, content, 0o600);
  }
  const nextState = { version: 1, aliases: [...new Set(legacy.flatMap(item => [item.id, item.legacyId]).filter(id => id.length <= 320))] };
  atomicWrite(path.join(root, PERSONAL_STATE_FILE), JSON.stringify(nextState), 0o600);
  return withPersonalAliases(readRecord('personal', root, canonicalFile, true), nextState);
}

function scanWorkspace(root) {
  if (!root) return [];
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return []; }
  return entries.filter(entry => entry.isFile() && !entry.isSymbolicLink() &&
    /\.(md|markdown)$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => readRecord('workspace', root, path.join(root, entry.name))).filter(Boolean);
}

function allRecords(app, cwd, owner = '') {
  const personal = userMemoryRoot(app, owner);
  const workspace = workspaceRoot(resolveCwd(app, cwd));
  let personalRows = consolidatePersonal(personal);
  if (owner) { learning.reconcile({ root: personal, write: atomicWrite, backfill: true }); personalRows = consolidatePersonal(personal); }
  return { personal: personalRows, workspace: scanWorkspace(workspace),
    personalRoot: personal, workspaceRoot: workspace };
}

function list({ app, owner = '', cwd = '', scope = '' } = {}) {
  if (scope && !SCOPES.has(scope)) throw Error('记忆范围无效');
  const rows = allRecords(app, cwd, owner);
  const items = [...rows.personal, ...rows.workspace]
    .filter(item => item.scope !== 'session' && (!scope || item.scope === scope))
    .map(({ content, editableContent, ...item }) => item);
  return { ok: true, accountKey: owner, items, hasMore: false };
}

function get({ app, owner = '', cwd = '', id } = {}) {
  if (!id || typeof id !== 'string' || id.length > 320 || /[\r\n]/.test(id)) throw Error('记忆标识无效');
  const rows = allRecords(app, cwd, owner);
  const item = [...rows.personal, ...rows.workspace].find(row => row.id === id || row.legacyId === id || row.aliases?.includes(id));
  if (!item) throw Error('本地记忆不存在');
  return { ok: true, item };
}

function atomicWrite(file, content, mode) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx', mode: mode || 0o600 });
    try {
      for (let attempt = 0; ; attempt++) {
        try { fs.renameSync(temp, file); break; }
        catch (error) {
          // Windows scanners can briefly hold a just-written memory file.
          // Retry the atomic rename; retain the old document on lasting errors.
          if (process.platform !== 'win32' || attempt === 7 ||
              !['EPERM', 'EACCES', 'EBUSY'].includes(error && error.code)) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
        }
      }
    } catch (error) {
      // Filesystem filters may report EXDEV for same-directory rename.
      // Use the copy-and-unlink fallback when rename is unavailable.
      if (error && (error.code === 'EXDEV' || /cross-device/i.test(String(error && error.message)))) {
        fs.copyFileSync(temp, file);
        fs.unlinkSync(temp);
      } else { throw error; }
    }
  } finally { try { fs.unlinkSync(temp); } catch (_) {} }
}

function safeFileName(title) {
  const name = String(title || 'memory').replace(/[\r\n\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 96);
  return name || 'memory';
}

function createPersonal({ app, owner = '', title = '', content = '' } = {}) {
  if (typeof content !== 'string') throw Error('个人记忆内容必须是文本');
  if (Buffer.byteLength(content, 'utf8') > MAX_PERSONAL_BYTES) throw Error('个人记忆内容超过 16 MiB');
  const root = userMemoryRoot(app, owner);
  const existing = consolidatePersonal(root)[0];
  if (existing) return { ok: true, created: false, item: existing };
  const base = safeFileName(title) || '个人记忆';
  const file = path.join(root, PERSONAL_MEMORY_FILE);
  if (!inside(root, file)) throw Error('记忆文档路径无效');
  atomicWrite(file, content || '# ' + base + '\n', 0o600);
  // No legacy discovery is needed for a newly created canonical document.
  if (!personalState(root)) atomicWrite(path.join(root, PERSONAL_STATE_FILE), JSON.stringify({ version: 1, aliases: [] }), 0o600);
  const item = readRecord('personal', root, file);
  if (!item) throw Error('无法读取新建的记忆文档');
  return { ok: true, created: true, item };
}

function metadata({ app, owner = '', cwd = '' } = {}) {
  const personal = userMemoryRoot(app, owner);
  const resolved = resolveCwd(app, cwd);
  const workspace = workspaceRoot(resolved);
  return {
    ok: true,
    personalDirectory: personal,
    personalFile: path.join(personal, PERSONAL_MEMORY_FILE),
    personalMaxBytes: MAX_PERSONAL_BYTES,
    workspaceDirectory: workspace || path.join(resolved, '.soduwork'),
    scopes: { personal: true, workspace: Boolean(workspace), project: Boolean(workspace), session: false },
  };
}

function update({ app, owner = '', cwd = '', id, content, revision = '' } = {}) {
  if (typeof content !== 'string') throw Error('记忆内容必须是文本');
  const bytes = Buffer.byteLength(content, 'utf8');
  const result = get({ app, owner, cwd, id });
  const item = result.item;
  if (!bytes) throw Error('记忆文档大小无效');
  const maxBytes = item.scope === 'personal' ? MAX_PERSONAL_BYTES : MAX_BYTES;
  if (bytes > maxBytes) throw Error(item.scope === 'personal' ? '个人记忆内容超过 16 MiB' : '记忆文档大小无效');
  if (revision && revision !== item.revision) throw Error('记忆文档已在其他位置修改，请重新加载后再保存');
  if (item.scope === 'personal') {
    content = learning.restoreMarkers(item.content, content);
    if (Buffer.byteLength(content, 'utf8') > MAX_PERSONAL_BYTES) throw Error('个人记忆内容超过 16 MiB');
  }
  const root = item.scope === 'personal' || item.scope === 'session' ? userMemoryRoot(app, owner) : workspaceRoot(resolveCwd(app, cwd));
  const file = path.resolve(root, item.relativePath);
  const extension = path.extname(file).toLowerCase();
  if (!inside(root, file) || !['.md', '.markdown'].includes(extension)) throw Error('记忆文档路径无效');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('记忆文档路径无效');
  atomicWrite(file, content, item.scope === 'personal' || item.scope === 'session' ? 0o600 : undefined);
  const next = readRecord(item.scope === 'personal' || item.scope === 'session' ? 'personal' : 'workspace', root, file);
  if (!next) throw Error('记忆文档写入后无法读取');
  return { ok: true, item: next };
}

function generatedMarkdown(digest, scope, key) {
  const fields = digest && digest.fields && typeof digest.fields === 'object' ? digest.fields : {};
  const title = String(digest && digest.title || 'SoduWork session memory').replace(/[\r\n#]/g, ' ').trim().slice(0, 240) || 'SoduWork session memory';
  const lines = ['# ' + title, ...(typeof digest?.completed === 'boolean' ? ['<!-- soduwork-memory-outcome=' + (digest.completed ? 'completed' : 'incomplete') + ' -->'] : []), '<!-- soduwork-managed-memory scope=' + scope + ' key=' + crypto.createHash('sha256').update(key).digest('hex') + ' -->', ''];
  const labels = { summary: 'Summary', goal: 'Goal', decisions: 'Decisions', constraints: 'Constraints', pending: 'Pending', outcomes: 'Outcomes' };
  for (const name of Object.keys(labels)) {
    // Session/project files are generated content and enter the injection
    // context verbatim, so they get the same credential/path scrubbing as the
    // canonical personal memory. Existing files keep their original bytes.
    const value = redact(String(fields[name] || '').trim());
    if (value) lines.push('## ' + labels[name], value, '');
  }
  let content = lines.join('\n');
  while (Buffer.byteLength(content, 'utf8') > MAX_BYTES - 256) content = content.slice(0, Math.floor(content.length * 0.9));
  return content;
}

function localFileForScope(app, cwd, scope, key, owner = '') {
  if (scope === 'session') {
    const root = userMemoryRoot(app, owner);
    const dir = path.join(root, 'sessions');
    try {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Invalid session memory directory');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.mkdirSync(dir, { mode: 0o700 });
    }
    return path.join(dir, crypto.createHash('sha256').update(String(key)).digest('hex') + '.md');
  }
  const root = workspaceRoot(resolveCwd(app, cwd)); if (!root) return '';
  const name = scope === 'workspace' ? 'soduwork-workspace-memory.md' : 'soduwork-project-memory.md';
  return path.join(root, name);
}

function signedMarkdown(content) {
  return '<!-- soduwork-generated-sha256=' + crypto.createHash('sha256').update(content).digest('hex') + ' -->\n' + content;
}

function canReplaceGenerated(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) return false;
    const text = fs.readFileSync(file, 'utf8');
    const match = /^<!-- soduwork-generated-sha256=([a-f0-9]{64}) -->\n([\s\S]*)$/.exec(text);
    return Boolean(match && crypto.createHash('sha256').update(match[2]).digest('hex') === match[1]);
  } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

function saveDigest({ app, owner = '', cwd = '', digest, scopes = [] } = {}) {
  if (!digest || !Array.isArray(scopes)) return { ok: true, saved: [], skipped: [] };
  const saved = [], skipped = [];
  for (const item of scopes.slice(0, 3)) {
    const scope = String(item && item.scope || '');
    if (!['session', 'workspace', 'project'].includes(scope)) continue;
    const key = String(item && item.key || '').trim(); if (!key) continue;
    let file = localFileForScope(app, cwd, scope, key, owner); if (!file) continue;
    const root = scope === 'session' ? userMemoryRoot(app, owner) : workspaceRoot(resolveCwd(app, cwd));
    if (!root || !inside(root, file)) continue;
    // A manual edit invalidates the checksum. Preserve that document and write
    // to a separate managed companion; never replace a hand-edited Markdown file.
    if (!canReplaceGenerated(file)) file = file.replace(/\.md$/, '-auto.md');
    if (!canReplaceGenerated(file)) { skipped.push({ scope, key, reason: 'manual-edit' }); continue; }
    const content = signedMarkdown(generatedMarkdown(digest, scope, key));
    atomicWrite(file, content, scope === 'session' ? 0o600 : undefined);
    saved.push({ scope, key, fileName: path.basename(file) });
  }
  const session = scopes.find(item => item?.scope === 'session' && item.key);
  if (owner && session && digest.completed === true) {
    const root = userMemoryRoot(app, owner);
    consolidatePersonal(root);
    learning.reconcile({ root, write: atomicWrite, digest, key: session.key, backfill: true });
  }
  return { ok: true, saved, skipped };
}

function context({ app, owner = '', cwd = '', scopes = [] } = {}) {
  const rows = owner ? allRecords(app, cwd, owner).personal : [];
  for (const item of Array.isArray(scopes) ? scopes.slice(0, 3) : []) {
    const scope = String(item && item.scope || ''); const key = String(item && item.key || '').trim();
    if (scope === 'session' && key) {
      const file = localFileForScope(app, cwd, scope, key, owner); const root = userMemoryRoot(app, owner);
      const row = file && root && inside(root, file) ? readRecord('personal', root, file) : null;
      if (row) rows.push({ ...row, scope: 'session' });
      continue;
    }
    if (scope === 'workspace' || scope === 'project') {
      const candidates = list({ app, owner, cwd, scope }).items;
      for (const candidate of candidates) {
        try { rows.push(get({ app, owner, cwd, id: candidate.id }).item); } catch (_) { /* file changed during scan */ }
      }
    }
  }
  const unique = rows.filter((row, i, all) => all.findIndex(other => other.id === row.id) === i);
  const prompt = unique.map(row => '--- ' + row.fileName + ' ---\n' + blockAwareSlice(row.content, 12000)).join('\n\n').slice(0, 28000);
  return { ok: true, items: unique.map(({ content, editableContent, ...row }) => row), prompt };
}

// Budget-aware injection slice. A naive character cut can split a generated
// memory block mid-sentence; cutting at the last complete block boundary keeps
// every retained block whole (user-authored head content always survives).
function blockAwareSlice(content, max) {
  const text = String(content || '');
  if (text.length <= max) return text;
  const finish = text.lastIndexOf('<!-- /soduwork-work-memory -->', max);
  if (finish > 0) return text.slice(0, finish + '<!-- /soduwork-work-memory -->'.length);
  return text.slice(0, max);
}

function contextIds({ app, owner = '', cwd = '', ids = [] } = {}) {
  const root = userMemoryRoot(app, owner); const items = [];
  for (const raw of Array.isArray(ids) ? ids.slice(0, 3) : []) {
    const id = String(raw || '').trim();
    if (!/^[A-Za-z0-9._:-]{1,320}$/.test(id)) continue;
    // Explicit personal/workspace/project documents use their stable id.
    // Imported session evidence uses a private hashed key in sessions/.
    try {
      const direct = get({ app, owner, cwd, id }).item;
      items.push(direct.scope === 'session' ? { ...direct, scope: 'session' } : direct);
      continue;
    } catch (_) { /* fall through to the hidden session store */ }
    const file = localFileForScope(app, cwd, 'session', id, owner);
    const row = readRecord('personal', root, file);
    if (row) items.push({ ...row, scope: 'session' });
  }
  const unique = items.filter((row, i, all) => all.findIndex(other => other.id === row.id) === i);
  return { ok: true, items: unique, prompt: unique.map(row => '--- ' + row.fileName + ' ---\n' + row.content).join('\n\n').slice(0, 28000) };
}

function remove({ app, owner = '', cwd = '', id } = {}) {
  const row = get({ app, owner, cwd, id }).item;
  const root = row.scope === 'personal' || row.scope === 'session' ? userMemoryRoot(app, owner) : workspaceRoot(resolveCwd(app, cwd));
  const file = path.resolve(root, row.relativePath);
  if (!inside(root, file)) throw Error('记忆文档路径无效');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('记忆文档路径无效');
  if (row.scope === 'personal') learning.forget(root, atomicWrite);
  fs.unlinkSync(file); return { ok: true };
}


function archive({ app, owner = '', cwd = '', id } = {}) {
  const row = get({ app, owner, cwd, id }).item;
  return { ok: true, item: { ...row, archived: false } };
}

function install(app, ownerOf = () => '') {
  // Resolve the current owner at call time so account switches cannot leak Markdown.
  const optionsFor = async options => ({ ...(options || {}), app, owner: await ownerOf() });
  return {
    list: async options => list(await optionsFor(options)),
    get: async options => get(await optionsFor(options)),
    create: async options => createPersonal(await optionsFor(options)),
    metadata: async options => metadata(await optionsFor(options)),
    update: async options => update(await optionsFor(options)),
    delete: async options => remove(await optionsFor(options)),
    archive: async options => archive(await optionsFor(options)),
    context: async options => context(await optionsFor(options)),
    contextIds: async options => contextIds(await optionsFor(options)),
    saveDigest: async options => saveDigest(await optionsFor(options)),
  };
}

function migrateAccount(app, fromOwner, toOwner) {
  // Migrate personal memory to the new ownership fingerprint after a same-account environment change.
  // Treat missing directories, existing targets, and filesystem errors as nonblocking migration failures.
  if (!/^[a-f0-9]{32}$/.test(String(fromOwner || '')) ||
      !/^[a-f0-9]{32}$/.test(String(toOwner || '')) || fromOwner === toOwner) return;
  let accounts;
  try { accounts = path.join(realRoot(app.getPath('userData')), 'memory', 'accounts'); }
  catch (_) { return; }
  const from = path.join(accounts, fromOwner), to = path.join(accounts, toOwner);
  // Merge directory trees instead of skipping a whole entry when the target
  // already contains a directory with the same name.  Account migrations can
  // happen after a partial login, so `to/imports` may already exist while the
  // old account still contains additional imported memories.  Keep existing
  // target files authoritative, but move every non-conflicting descendant.
  const merge = (source, target) => {
    let sourceStat;
    try { sourceStat = fs.lstatSync(source); } catch (_) { return; }
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) return;
    try {
      const targetStat = fs.lstatSync(target);
      if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) return;
    } catch (error) {
      if (error.code !== 'ENOENT') return;
      try { fs.mkdirSync(target, { recursive: true, mode: 0o700 }); } catch (_) { return; }
    }
    let entries;
    try { entries = fs.readdirSync(source, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const sourceEntry = path.join(source, entry.name);
      const targetEntry = path.join(target, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        let targetStat;
        try { targetStat = fs.lstatSync(targetEntry); } catch (error) {
          if (error.code !== 'ENOENT') continue;
        }
        if (targetStat && targetStat.isDirectory() && !targetStat.isSymbolicLink()) {
          merge(sourceEntry, targetEntry);
        } else if (!targetStat) {
          try { fs.renameSync(sourceEntry, targetEntry); } catch (_) { /* keep source for a later retry */ }
        }
        continue;
      }
      // Existing files remain untouched; a missing destination receives the
      // old file. Never follow a source symlink during migration.
      let targetExists = false;
      try { fs.lstatSync(targetEntry); targetExists = true; } catch (error) {
        if (error.code !== 'ENOENT') continue;
      }
      if (!targetExists) {
        try { fs.renameSync(sourceEntry, targetEntry); } catch (_) { /* keep source for a later retry */ }
      }
    }
    try { if (!fs.readdirSync(source).length) fs.rmdirSync(source); } catch (_) {}
  };
  merge(from, to);
}

module.exports = {
  MAX_BYTES, MAX_PERSONAL_BYTES, MAX_FILES, PERSONAL_MEMORY_FILE, SCOPES, userMemoryRoot, workspaceRoot,
  scopeForFile, list, get, createPersonal, metadata, update, saveDigest, context, contextIds, remove, archive, install, migrateAccount, blockAwareSlice,
};
