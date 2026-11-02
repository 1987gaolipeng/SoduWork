'use strict';

// Authorized attachment bytes stay in an account/task-specific cache. This is
// not a workspace import: archives are opaque files and are never extracted.
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { replaceFile } = require('../verified-file-replace.cjs');
const { fetchWithDeviceAuthRetry } = require('../device-auth-request');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const FILE_LIMIT = 64 * 1024 * 1024, TOTAL_LIMIT = 128 * 1024 * 1024;
const URL_PATTERN = /^\/(?:api\/v1\/)?attachments\/([^/?#]+)\?[^#]+$/i;
const EVIDENCE = new Set(['evidence', 'deploy_screenshot', 'screenshot', 'screen_shot', 'screen_capture', 'verification', 'test_evidence', 'internal']);
// Browser-readable results and their assets may be cached for inline preview.
// Office documents, archives and unknown binaries require an explicit action.
const PREVIEW_EXTENSIONS = /\.(?:html?|md|markdown|txt|pdf|png|jpe?g|gif|webp|svg|bmp|avif|ico|mp4|m4v|webm|mov|ogv|css|js|mjs|json|woff2?|ttf|otf)$/i;
const canPreview = row => PREVIEW_EXTENSIONS.test(row.filename || row.name || row.path || '');
const VERSION_KEYS = ['size', 'mtimeMs', 'ctimeMs', 'ino', 'birthtimeMs'];
const projections = new WeakMap();
const native = handle => handle?.[Symbol.for('soduwork.agent-runtime.native-handle')] || handle;
function bind(handle, resolver) { projections.set(native(handle), resolver); }
async function project(handle) { return projections.get(native(handle))?.() || handle; }

function safeName(value) {
  const raw = String(value || '').normalize('NFC').replace(/\\/g, '/');
  if (!raw || raw !== raw.trim() || raw.length > 500) return '';
  const parts = raw.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' ||
      /[\x00-\x1f\x7f<>:"|?*]/.test(part) || /[. ]$/.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) ||
      /^(?:\.git|\.pi|\.soduwork|\.soduwork-inputs|\.env(?:\..*)?)$/i.test(part))) return '';
  return parts.join('/');
}

function rows(value, taskId) {
  const items = Array.isArray(value) ? value : value?.attachments || value?.items || [];
  const roundOf = row => Math.max(0, Number(row?.evidenceMeta?.round) || 0);
  const isEvidence = row => [row?.evidenceMeta?.kind, row?.evidenceMeta?.type, row?.evidenceMeta?.category, row?.category]
    .some(tag => EVIDENCE.has(String(tag || '').toLowerCase().replace(/[\s-]+/g, '_')));
  const candidates = items.filter(row => row && ['output', 'supporting'].includes(String(row.role || '').toLowerCase()) && !isEvidence(row));
  const batchOf = row => String(row?.sourceRef || row?.evidenceMeta?.identifier || row?.evidenceMeta?.conversationId || 'legacy');
  const stampOf = (row, index) => {
    const raw = row?.createdAt || row?.created_at || row?.updatedAt || row?.at || '';
    const parsed = typeof raw === 'number' ? raw : Date.parse(String(raw));
    return Number.isFinite(parsed) ? parsed : index;
  };
  const batches = new Map();
  candidates.forEach((row, index) => {
    const key = batchOf(row), old = batches.get(key) || {stamp: -1, index: -1};
    old.stamp = Math.max(old.stamp, stampOf(row, index)); old.index = Math.max(old.index, index); batches.set(key, old);
  });
  const latestBatch = [...batches.entries()].sort((a, b) => a[1].stamp - b[1].stamp || a[1].index - b[1].index).at(-1)?.[0] || 'legacy';
  const currentRound = Math.max(0, ...candidates.filter(row => batchOf(row) === latestBatch).map(roundOf));
  const hasVersionedBatch = candidates.some(row => roundOf(row) > 0 || batchOf(row) !== 'legacy');
  const latest = new Map();
  for (const row of items) {
    if (!row || !['output', 'supporting'].includes(String(row.role || '').toLowerCase())) continue;
    if (taskId && row.taskId && row.taskId !== taskId) throw Error('云端成果不属于当前任务');
    const meta = row.evidenceMeta || {};
    if (isEvidence(row)) continue;
    if (hasVersionedBatch && batchOf(row) !== latestBatch) continue;
    if (hasVersionedBatch && currentRound && roundOf(row) !== currentRound && !(roundOf(row) === 0 &&
        (row.role === 'supporting' || meta.category === 'supporting' || row.category === 'supporting'))) continue;
    if (meta.verification?.state === 'failed') throw Error('云端成果尚未通过文件校验，请等待修复后重试');
    const filename = safeName(row.filename || row.name || row.path);
    const match = String(row.url || '').match(URL_PATTERN);
    if (!filename || !row.id || !match) continue;
    let urlId;
    try { urlId = decodeURIComponent(match[1]); } catch (_) { continue; }
    if (urlId !== String(row.id)) throw Error('云端成果下载标识不匹配');
    const key = filename.toLowerCase();
    const stamp = item => Number(item.createdAt || item.created_at || item.updatedAt) ||
      Date.parse(item.createdAt || item.created_at || item.updatedAt || '') || 0;
    if (!latest.has(key) || stamp(row) >= stamp(latest.get(key))) latest.set(key, { ...row, filename });
  }
  if (latest.size > 200) throw Error('云端成果文件过多，无法完整保存');
  return [...latest.values()];
}

function directory(app, record) {
  if (!record?.owner || !record?.sessionId || !record?.taskId) throw Error('云端成果归属不完整');
  return path.join(app.getPath('userData'), 'cloud-results', hash(record.owner),
    hash(JSON.stringify([record.sessionId, record.transferId, record.taskId])));
}

function index(app, record) {
  const cwd = directory(app, record), contract = require('./delivery-contract');
  const files = [];
  let realRoot;
  try {
    const anchor = path.resolve(app.getPath('userData'));
    let cursor = anchor;
    for (const piece of path.relative(anchor, cwd).split(path.sep)) {
      cursor = path.join(cursor, piece);
      if (syncFs.lstatSync(cursor).isSymbolicLink()) return { files: [], cloudOutputs: [] };
    }
    realRoot = syncFs.realpathSync(cwd);
  } catch (_) { return { files: [], cloudOutputs: [] }; }
  for (const [id, saved] of Object.entries(record.materializedOutputs || {})) {
    const relative = safeName(saved.path);
    if (!relative) continue;
    const target = path.join(cwd, ...relative.split('/'));
    try {
      const real = syncFs.realpathSync(target), rel = path.relative(realRoot, real);
      const stat = syncFs.lstatSync(target);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !stat.isFile() || stat.isSymbolicLink() || stat.size !== saved.size ||
          !saved.version || VERSION_KEYS.some(key => stat[key] !== saved.version[key])) continue;
      const kind = contract._kindOf(relative) || 'file';
      files.push({ path: target, relative, name: path.basename(relative), size: stat.size,
        at: Math.round(stat.mtimeMs), changedInTurn: true, kind,
        artifactId: contract._artifactId(kind, relative),
        primary: record.deliveryPresentation !== 'summary' && saved.primary !== false, role: saved.role || 'output',
        preview: ['website', 'image', 'video', 'pdf'].includes(kind),
        actions: ['preview', 'open', 'reveal'],
        remoteMaterialized: true, cloudTaskId: record.taskId, remoteAttachmentId: id });
    } catch (_) { /* Missing or replaced files need materialization again. */ }
  }
  return { files, truncated: false, cloudOutputs: files.map(file => ({
    taskId: file.cloudTaskId, attachmentId: file.remoteAttachmentId, relative: file.relative,
    size: file.size, artifactId: file.artifactId })),
    delivery: { schemaVersion: 1, source: 'manifest', presentation: record.deliveryPresentation || 'artifacts',
      summary: '', items: record.deliveryPresentation === 'summary' ? [] : files, warnings: [] } };
}

async function directories(root, relative = '', trustedRoot = root) {
  const anchor = path.resolve(trustedRoot), base = path.resolve(root);
  const rel = path.relative(anchor, base);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw Error('云端成果目录越界');
  const chain = [anchor];
  for (const piece of [...rel.split(path.sep), ...relative.split('/')].filter(Boolean)) chain.push(path.join(chain.at(-1), piece));
  for (const folder of chain) {
    const stat = await fs.lstat(folder).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw Error('云端成果目录包含不安全的链接');
    if (!stat) await fs.mkdir(folder, { mode: 0o700 });
  }
}

async function checksum(target, limit) {
  const digest = crypto.createHash('sha256');
  let count = 0;
  for await (const chunk of syncFs.createReadStream(target)) {
    count += chunk.length;
    if (count > limit) throw Error('云端成果超出本地保存限制');
    digest.update(chunk);
  }
  return digest.digest('hex');
}
const version = stat => Object.fromEntries(VERSION_KEYS.map(key => [key, stat[key]]));

function create({ app, fetch = fetchWithDeviceAuthRetry, fileLimit = FILE_LIMIT, totalLimit = TOTAL_LIMIT }) {
  async function materialize(record, current, value, assertCurrent = async () => {}, { previewOnly = false } = {}) {
    const all = rows(value, record.taskId), cwd = directory(app, record);
    const attachments = previewOnly ? all.filter(canPreview) : all;
    const previous = record.materializedOutputs || {}, materialized = {};
    if (previewOnly) for (const row of all) {
      // Keep current manual-download receipts without fetching those bytes again.
      // The index still checks the on-disk version before exposing any file.
      const known = previous[String(row.id)], digest = row.sha256 || row.evidenceMeta?.sha256;
      if (known?.path === row.filename && known.size === Number(row.size) &&
          (!digest || String(digest).toLowerCase() === known.sha256)) materialized[String(row.id)] = known;
    }
    let total = 0;
    for (const row of attachments) {
      const expected = Number(row.size);
      if (!Number.isSafeInteger(expected) || expected < 0 || expected > fileLimit || total + expected > totalLimit) {
        throw Error('云端成果超出本地保存限制');
      }
      total += expected; // Include already-cached files in the collection limit.
    }
    if (!attachments.length) return { cwd, files: 0, materializedOutputs: materialized };
    await directories(cwd, '', app.getPath('userData'));
    for (const row of attachments) {
      await assertCurrent();
      const expected = Number(row.size), relative = row.filename;
      const target = path.join(cwd, ...relative.split('/'));
      await directories(cwd, path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative), app.getPath('userData'));
      const stat = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw Error('云端成果文件包含不安全的链接');
      const advertised = row.sha256 || row.evidenceMeta?.sha256 || '';
      if (advertised && !/^[a-f0-9]{64}$/i.test(advertised)) throw Error('云端成果校验摘要无效');
      const known = previous[String(row.id)];
      const metadata = { role: row.role, primary: row.primary !== false && row.role !== 'supporting' &&
        !['supporting', 'internal', 'evidence'].includes(row.evidenceMeta?.category || row.category) };
      const digest = String(advertised || known?.sha256 || '').toLowerCase();
      if (stat?.size === expected && known?.path === relative && known?.size === expected && digest &&
          await checksum(target, fileLimit) === digest) {
        materialized[String(row.id)] = { ...known, ...metadata, sha256: digest, version: version(stat) }; continue;
      }
      const suffix = row.url.startsWith('/api/v1/') ? row.url : '/api/v1' + row.url;
      const response = await fetch(current, String(current.hub).replace(/\/+$/, '') + suffix, {
        redirect: 'error', signal: AbortSignal.timeout(120000),
      });
      if (!response.ok || !response.body) { await response.body?.cancel?.().catch(() => {}); throw Error('云端成果下载失败'); }
      const temporary = target + '.' + crypto.randomUUID() + '.tmp';
      let stream, count = 0, complete = false;
      const digester = crypto.createHash('sha256');
      try {
        const declared = response.headers?.get('content-length');
        if (declared !== null && declared !== undefined && Number(declared) !== expected) throw Error('云端成果大小校验失败');
        stream = await fs.open(temporary, 'wx', 0o600);
        for await (const chunk of response.body) {
          count += chunk.byteLength;
          if (count > expected || count > fileLimit) throw Error('云端成果超出本地保存限制');
          await assertCurrent();
          digester.update(chunk);
          await stream.writeFile(chunk);
        }
        const actual = digester.digest('hex');
        if (count !== expected || (advertised && actual !== advertised.toLowerCase())) throw Error('云端成果完整性校验失败');
        await stream.close(); stream = null;
        await assertCurrent();
        // Recheck ancestors after download; a cache must never follow a link
        // into the user's source workspace or another account's directory.
        await directories(cwd, path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative), app.getPath('userData'));
        await replaceFile(temporary, target, { expected: { size: count, sha256: actual }, check: assertCurrent,
          checkPath: () => directories(cwd, path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative), app.getPath('userData')) });
        complete = true;
        materialized[String(row.id)] = { path: relative, size: count, sha256: actual,
          version: version(await fs.stat(target)), ...metadata };
      } finally {
        await stream?.close().catch(() => {});
        if (!complete) await response.body?.cancel?.().catch(() => {});
        await fs.unlink(temporary).catch(() => {});
      }
    }
    await assertCurrent();
    return { cwd, files: attachments.length, materializedOutputs: materialized };
  }
  return { materialize };
}

module.exports = { create, directory, index, rows, safeName, bind, project, canPreview };
