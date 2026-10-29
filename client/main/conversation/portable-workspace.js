'use strict';

// A reviewed, immutable handoff of user-visible conversation facts and files.
// SDK databases, credentials and live processes never cross this boundary.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createEntries } = require('./zip-archive');
const SCHEMA = 'soduwork.workspace-handoff/v1';
const MAX_FILES = 4000;
const MAX_BYTES = 96 * 1024 * 1024;
const MAX_TRANSCRIPT = 2 * 1024 * 1024;
const MAX_DEPTH = 32;
const SKIP_DIRS = new Set(['.git', '.svn', '.hg', 'node_modules', '.venv', 'venv', '__pycache__',
  '.ssh', '.aws', '.azure', '.config', '.soduwork', '.pi', '.codex', '.claude', '.opencode']);
const SECRET_FILE = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|credentials(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$|\.(?:pem|p12|pfx|key)$/i;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function portablePath(value) {
  if (typeof value !== 'string' || !value || value.length > 500 || value.includes('\\')) throw Error('工作文件路径不适合跨机器传输');
  const parts = value.split('/');
  if (parts.some(x => !x || x === '.' || x === '..' || /[<>:"|?*\x00-\x1f\x7f]/.test(x) || /[. ]$/.test(x) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(x))) throw Error('工作文件包含不安全或不兼容的路径');
  return value;
}

function safeMetadata(source = {}) {
  const text = (value, max) => {
    const result = String(value || '');
    if ([...result].length > max) throw Error('会话字段超过交接上限，请先整理上下文');
    return result;
  };
  const messages = (Array.isArray(source.messages) ? source.messages : []).filter(row =>
    row && ['user', 'assistant'].includes(row.role)).map(row => ({ role: row.role,
    text: typeof row.text === 'string' && row.text ? row.text : typeof row.content === 'string' && row.content ? row.content
      : (Array.isArray(row.blocks) ? row.blocks.filter(p => p?.kind === 'text').map(p => p.text || '').join('\n')
        : Array.isArray(row.content) ? row.content.filter(p => p?.type === 'text').map(p => p.text || '').join('\n') : ''),
    at: Number.isFinite(row.at ?? row.timestamp ?? row.sentAt ?? row.completedAt)
      ? (row.at ?? row.timestamp ?? row.sentAt ?? row.completedAt) : 0,
  }));
  const metadata = { sessionId: text(source.sessionId, 160), adapterId: text(source.adapterId, 40),
    modelName: text(source.modelName, 200), title: text(source.title, 200),
    goal: text(source.goal, 16000), messages };
  if (!metadata.sessionId) throw Error('缺少原会话标识');
  if (Buffer.byteLength(JSON.stringify(metadata)) > MAX_TRANSCRIPT) throw Error('会话记录超过交接上限，请先整理上下文');
  return metadata;
}

async function scan(root, limits = {}) {
  const base = await fs.realpath(root);
  const maxFiles = Math.min(limits.maxFiles ?? MAX_FILES, MAX_FILES);
  const maxBytes = Math.min(limits.maxBytes ?? MAX_BYTES, MAX_BYTES);
  const entries = [], excluded = [], seen = new Set(); let total = 0;
  async function walk(dir, prefix, depth) {
    if (depth > MAX_DEPTH) throw Error('工作目录层级过深，无法完整交接');
    for (const item of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? prefix + '/' + item.name : item.name;
      const file = path.join(dir, item.name);
      if (item.isSymbolicLink()) { excluded.push({ path: relative, reason: 'link' }); continue; }
      if (SKIP_DIRS.has(item.name.toLowerCase())) {
        excluded.push({ path: relative, reason: 'runtime-or-credentials' }); continue;
      }
      if (SECRET_FILE.test(item.name)) { excluded.push({ path: relative, reason: 'credentials' }); continue; }
      portablePath(relative);
      const key = relative.normalize('NFC').toLowerCase();
      if (seen.has(key)) throw Error('文件名在其他系统上会冲突：' + relative);
      seen.add(key);
      if (item.isDirectory()) { await walk(file, relative, depth + 1); continue; }
      if (!item.isFile()) throw Error('不支持的工作文件类型：' + relative);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error('文件在交接准备时发生变化：' + relative);
      total += stat.size;
      if (entries.length >= maxFiles || total > maxBytes) throw Error('工作文件超过交接上限，请缩小工作目录后重试');
      entries.push({ path: relative, size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino });
    }
  }
  await walk(base, '', 0);
  return { root: base, files: entries, excluded, total };
}

async function readStable(root, row) {
  const file = path.join(root, ...row.path.split('/'));
  const resolved = await fs.realpath(file), relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Error('工作文件已移到目录之外');
  // Check every parent: a link to another directory inside the workspace is also
  // excluded, rather than exporting data the user did not review under this path.
  let current = root;
  for (const part of row.path.split('/')) { current = path.join(current, part); if ((await fs.lstat(current)).isSymbolicLink()) throw Error('工作文件已变为链接'); }
  const handle = await fs.open(file, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== row.size || before.mtimeMs !== row.mtimeMs || before.ino !== row.ino || before.dev !== row.dev) throw Error('工作文件已变化，请重新确认交接');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== row.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw Error('工作文件正在写入，请等待本轮停止后交接');
    return bytes;
  } finally { await handle.close(); }
}

async function create(root, metadata, options = {}) {
  const snapshot = await scan(root, options);
  const source = safeMetadata(metadata);
  const files = [], entries = [];
  for (const row of snapshot.files) {
    const bytes = await readStable(snapshot.root, row);
    files.push({ path: row.path, size: bytes.length, sha256: sha256(bytes) });
    entries.push({ name: 'workspace/' + row.path, bytes });
    options.onProgress?.({ files: files.length, totalFiles: snapshot.files.length });
  }
  // Catch files created, removed or changed while other files were being read.
  // The coordinator also fences local execution before entering this function.
  const after = await scan(snapshot.root, options);
  if (JSON.stringify(after.files) !== JSON.stringify(snapshot.files) ||
      JSON.stringify(after.excluded) !== JSON.stringify(snapshot.excluded)) {
    throw Error('工作目录在交接时发生变化，请重新确认交接');
  }
  const manifest = { schema: SCHEMA, source, files, excluded: snapshot.excluded };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  if (manifestBytes.length > MAX_TRANSCRIPT) throw Error('工作文件清单和会话记录超过交接上限');
  const bytes = await createEntries([{ name: 'manifest.json', bytes: manifestBytes }, ...entries]);
  if (bytes.length > MAX_BYTES + MAX_TRANSCRIPT + 1024 * 1024) throw Error('工作快照超过传输上限');
  return { bytes, sha256: sha256(bytes), manifest, total: snapshot.total };
}

module.exports = { SCHEMA, MAX_FILES, MAX_BYTES, MAX_TRANSCRIPT, portablePath, safeMetadata, scan, create };
