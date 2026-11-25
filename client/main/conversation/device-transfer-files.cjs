'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const portable = require('./portable-workspace');
const { assertNoLinks } = require('../plugin-resources');
const MAX_HISTORY = 24 * 1024 * 1024;
const MAX_PACKAGE = 160 * 1024 * 1024;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => file === root || file.startsWith(root + path.sep);

async function inventory(app, cwd) {
  if (!cwd || !path.isAbsolute(cwd)) throw Error('缺少原会话工作目录');
  const root = await fs.realpath(cwd), home = await fs.realpath(os.homedir());
  const userData = await fs.realpath(app.getPath('userData'));
  if (root === path.parse(root).root || inside(root,home) || inside(root,userData) ||
      root.split(path.sep).some(name => portable.excludedName(name) || name.toLowerCase() === 'soduworklibrary') ||
      (inside(userData, root) && !inside(path.join(userData,'device-transfers','workspaces'),root)))
    throw Error('请在独立的会话工作目录中迁移文件');
  return portable.scan(root);
}
const snapshotDirectory = 'conversation-history';
const pathKey = name => name.normalize('NFC').toLowerCase();

function pathIndex() {
  const files = new Map(), directories = new Set();
  function ancestors(key) {
    const names = [];
    for (let end = key.indexOf('/'); end >= 0; end = key.indexOf('/', end + 1)) names.push(key.slice(0, end));
    return names;
  }
  function blocked(key) { return directories.has(key) || ancestors(key).some(name => files.has(name)); }
  function add(row) {
    const key = pathKey(row.path);
    if (files.has(key) || blocked(key)) throw Error('迁移文件路径冲突，请核对工作目录与历史成果');
    files.set(key, row);
    for (const name of ancestors(key)) directories.add(name);
  }
  return { files, directories, blocked, add };
}

async function review(app, cwd, retained = []) {
  let scanned;
  try { scanned = await inventory(app, cwd); }
  catch (_) {
    scanned = { root: null, files: [], excluded: [], total: 0,
      notice: '工作目录不可读取或超出文件迁移范围，本次仅迁移会话历史。' };
  }
  const work = pathIndex(), archive = pathIndex();
  for (const file of scanned.files) work.add(file);
  const identical = new Set();
  let namespace = false;
  for (const row of retained) {
    archive.add(row);
    if (!row.artifactDigest) continue;
    const key = pathKey(row.path), existing = work.files.get(key);
    if (existing?.path === row.path && existing.size === row.size &&
        hash(await portable.readStable(scanned.root, existing)) === row.artifactDigest) identical.add(key);
    else if (existing || work.blocked(key)) namespace = true;
  }
  if (namespace && (work.files.has(snapshotDirectory) || work.directories.has(snapshotDirectory) ||
      scanned.excluded.some(row => pathKey(row.path.split('/')[0]) === snapshotDirectory)))
    throw Error('工作目录已使用 conversation-history，请先移开同名文件或目录后重新预览');
  for (const row of retained) {
    const key = pathKey(row.path), existing = work.files.get(key);
    if (identical.has(key)) {
      existing.artifactDigest = row.artifactDigest;
      if (namespace) existing.historyAlias = portable.portablePath(snapshotDirectory + '/' + row.path);
      continue;
    }
    const file = namespace && row.artifactDigest
      ? { ...row, path: portable.portablePath(snapshotDirectory + '/' + row.path), historicalCopy: true } : row;
    work.add(file);
    scanned.files.push(file);
    scanned.total += file.size;
  }
  if (!scanned.root && scanned.files.length) delete scanned.notice;
  if (namespace) scanned.notice = '历史版本位于 conversation-history/。选择历史版本后，已勾选的共用文件会同时放入工作目录和历史目录。';
  return scanned;
}

function selectedFiles(preview, paths) {
  const wanted = new Set(paths), files = preview.files.filter(file => wanted.has(file.path));
  const withHistory = files.some(file => file.historicalCopy);
  const mirrors = file => Boolean(withHistory && file.historyAlias);
  return { files, mirrors,
    count: files.reduce((n, file) => n + (mirrors(file) ? 2 : 1), 0),
    bytes: files.reduce((n, file) => n + file.size * (mirrors(file) ? 2 : 1), 0) };
}

async function pack(app, cwd, preview, paths, history, retained = []) {
  if (!Array.isArray(paths) || paths.length > portable.MAX_FILES || new Set(paths).size !== paths.length)
    throw Error('请核对要迁移的文件清单');
  if (Buffer.byteLength(JSON.stringify(history)) > MAX_HISTORY) throw Error('会话历史超过迁移上限，原历史仍保留');
  if (!paths.length) return Buffer.from(JSON.stringify({ version: 1, history, files: [] }));
  const wanted = new Set(paths), before = await review(app, cwd, retained);
  const reviewed = new Map(preview.files.map(row => [row.path, row]));
  const selection = selectedFiles(before, paths), selected = selection.files;
  if (selected.length !== paths.length) throw Error('有文件已移动，请重新预览');
  if (selection.count > portable.MAX_FILES || selection.bytes > portable.MAX_BYTES) throw Error('工作文件超过迁移容量');
  const files = [];
  for (const file of selected) {
    if (JSON.stringify(file) !== JSON.stringify(reviewed.get(file.path))) throw Error('预览后文件已变化，请重新预览');
    const bytes = file.sourceRoot
      ? await require('./device-artifact-archive.cjs').readVersion(file.sourceRoot, file.relative, file.stamp)
      : await portable.readStable(before.root, file);
    if (!bytes) throw Error('预览后文件已变化，请重新预览');
    const sha256 = hash(bytes);
    if (file.sourceRoot && file.artifactDigest && file.artifactDigest !== sha256) throw Error('会话成果校验失败');
    const content = { sha256, size: bytes.length, data: bytes.toString('base64') };
    // A single explicit selection also supplies its byte-identical dependency
    // inside a selected historical tree. The complete destination paths and
    // physical byte count are covered by the signed transfer and its limits.
    if (selection.mirrors(file)) files.push({ path: file.historyAlias, ...content, artifact: true });
    files.push({ path: file.path, ...content,
      ...(file.artifactDigest === sha256 && !selection.mirrors(file) ? { artifact: true } : {}),
      ...(file.attachmentKey ? { attachmentKey: file.attachmentKey } : {}) });
  }
  const after = await review(app, cwd, retained);
  if (JSON.stringify(selected) !== JSON.stringify(after.files.filter(f => wanted.has(f.path))))
    throw Error('工作文件在迁移准备期间发生变化');
  return Buffer.from(JSON.stringify({ version: 1, history, files }));
}
function parse(bytes,row) {
  if (bytes.length !== row.bytes || hash(bytes) !== row.digest) throw Error('迁移包不完整');
  const packet = JSON.parse(bytes.toString('utf8'));
  const metadata = JSON.parse(row.meta);
  if (packet.version !== 1 || packet.history?.conversation?.id !== row.sid ||
      packet.history?.coverage?.complete !== true || Buffer.byteLength(JSON.stringify(packet.history)) > MAX_HISTORY ||
      !Array.isArray(packet.files) || packet.files.length !== metadata.fileCount || packet.files.length > portable.MAX_FILES)
    throw Error('会话或迁移清单不匹配');
  let size = 0;
  const paths = pathIndex();
  for (const f of packet.files) {
    portable.portablePath(f.path);
    if (f.path.split('/').some(portable.excludedName) || !Number.isSafeInteger(f.size) || f.size < 0 ||
        typeof f.data !== 'string' || f.data.length !== Math.ceil(f.size/3)*4) throw Error('迁移文件清单无效');
    paths.add(f); size += f.size;
    if (size > portable.MAX_BYTES) throw Error('工作文件超过迁移容量');
    const data = Buffer.from(f.data,'base64');
    if (data.length !== f.size || hash(data) !== f.sha256) throw Error('工作文件校验失败');
  }
  if (size !== metadata.totalBytes) throw Error('文件字节数与预览不一致');
  return packet;
}
function directories(root, op) {
  const staging = path.join(root, 'incoming', op);
  const workspace = path.join(root, 'workspaces', op);
  assertNoLinks(root, staging);
  assertNoLinks(root, workspace);
  return { staging, workspace, tree: path.join(staging, 'files') };
}

async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function verifyFile(root, file) {
  const target = path.join(root, ...file.path.split('/'));
  assertNoLinks(root, target);
  let stat;
  try { stat = await fs.lstat(target); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!stat.isFile() || stat.size !== file.size || hash(await fs.readFile(target)) !== file.sha256)
    throw Error('目标工作文件已变化，无法确认迁移内容');
  return true;
}

async function prepare(root, op, files) {
  const { staging, tree } = directories(root, op);
  assertNoLinks(root, tree);
  await fs.mkdir(tree, { recursive: true, mode: 0o700 });
  // An interrupted write only leaves an unpublished temporary file. The next
  // attempt can replace it without touching a user-visible workspace.
  const partial = path.join(staging, 'partial');
  assertNoLinks(root, partial);
  for (const file of files) {
    if (await verifyFile(tree, file)) continue;
    const target = path.join(tree, ...file.path.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.rm(partial, { force: true });
    const handle = await fs.open(partial, 'wx', 0o600);
    try { await handle.writeFile(Buffer.from(file.data, 'base64')); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(partial, target);
    await syncDirectory(path.dirname(target));
  }
  await syncDirectory(tree);
}

async function activate(root, op, files) {
  const { workspace, tree } = directories(root, op);
  await fs.mkdir(path.dirname(workspace), { recursive: true, mode: 0o700 });
  try { await fs.access(workspace); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await prepare(root, op, files);
    await fs.rename(tree, workspace);
    await syncDirectory(path.dirname(workspace));
  }
  for (const file of files) {
    if (!await verifyFile(workspace, file)) throw Error('目标工作文件缺失，无法确认迁移内容');
  }
  await discard(root, op);
  return workspace;
}

async function discard(root, op) {
  const { staging } = directories(root, op);
  // This is an app-private, per-operation staging directory. The published
  // workspace is a sibling and may already contain user edits.
  await fs.rm(staging, { recursive: true, force: true });
}

module.exports = { inventory, review, selectedFiles, pack, parse, prepare, activate, discard, hash, MAX_PACKAGE };
