'use strict';

/*
 * Materialize the current delivery batch into a hidden workspace cache before local
 * preview. Include output and supporting assets, exclude process evidence, deduplicate
 * names, and verify evidence_meta.sha256. Keep limits, temporary writes, and symlink
 * protections aligned with cloud-output-cache.materialize.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { fetchWithDeviceAuthRetry } = require('../device-auth-request');
const outputCache = require('../conversation/cloud-output-cache');
const deliveryContract = require('../conversation/delivery-contract');

/* Share delivery evidence labels with cloud-output-cache; verification screenshots and process artifacts are not deliverables. */
const EVIDENCE = new Set(['evidence', 'deploy_screenshot', 'screenshot', 'screen_shot',
  'screen_capture', 'verification', 'test_evidence', 'internal']);

function currentGroup(items, taskId) {
  // Group conversation deliveries by evidence_meta.identifier.
  // Round numbers restart within each delivery batch.
  // Selecting the global maximum round could select an older rejected batch.
  // Choose the identifier group with the newest created_at; legacy ungrouped data keeps the latest file per name.
  const isEvidence = row => [row?.evidenceMeta?.kind, row?.evidenceMeta?.type,
    row?.evidenceMeta?.category, row?.category]
    .some(tag => EVIDENCE.has(String(tag || '').toLowerCase().replace(/[\s-]+/g, '_')));
  const stamp = row => Number(row.createdAt || row.created_at || row.updatedAt) ||
    Date.parse(row.createdAt || row.created_at || row.updatedAt || '') || 0;
  const valid = [];
  for (const row of Array.isArray(items) ? items : []) {
    if (!row || !['output', 'supporting'].includes(String(row.role || '').toLowerCase())) continue;
    if (taskId && row.taskId && row.taskId !== taskId) throw Error('成果不属于当前任务');
    if (isEvidence(row)) continue;
    if (row.evidenceMeta?.verification?.state === 'failed') throw Error('成果尚未通过文件校验，请等待修复后重试');
    const filename = outputCache.safeName(row.filename || row.name || row.path);
    const match = String(row.url || '').match(/^\/(?:api\/v1\/)?attachments\/([^/?#]+)\?[^#]+$/);
    if (!filename || !row.id) continue;
    if (!match) throw Error('成果地址无效');
    let urlId;
    try { urlId = decodeURIComponent(match[1]); } catch (_) { continue; }
    if (urlId !== String(row.id)) throw Error('成果下载标识不匹配');
    valid.push({ ...row, filename });
  }
  const groups = new Map();
  for (const row of valid) {
    const id = String(row.evidenceMeta?.identifier || '');
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }
  let best = null;
  for (const [id, members] of groups) {
    if (!id) continue;
    const newest = Math.max(...members.map(stamp));
    if (!best || newest > best.newest) best = { members, newest };
  }
  if (!best && groups.has('')) best = { members: groups.get(''), newest: 0 };
  if (!best) return [];
  const latest = new Map();
  for (const row of best.members) {
    const key = row.filename.toLowerCase();
    if (!latest.has(key) || stamp(row) >= stamp(latest.get(key))) latest.set(key, row);
  }
  if (latest.size > 200) throw Error('成果文件过多，无法完整保存');
  return [...latest.values()];
}

const FILE_LIMIT = 64 * 1024 * 1024, TOTAL_LIMIT = 128 * 1024 * 1024;
const CACHE_DIR = '.soduwork-attachments';

function safeCacheName(value) {
  // Apply shared output-name constraints to relative path segments across platforms.
  return outputCache.safeName(String(value || ''));
}

async function ensureDirectory(root, relative = '') {
  const anchor = path.resolve(root);
  const chain = [anchor];
  for (const piece of String(relative || '').split('/').filter(Boolean)) {
    chain.push(path.join(chain[chain.length - 1], piece));
  }
  for (const folder of chain) {
    const stat = await fsp.lstat(folder).catch(error => {
      if (error.code === 'ENOENT') return null; throw error;
    });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw Error('成果缓存目录包含不安全的链接');
    }
    if (!stat) await fsp.mkdir(folder, { mode: 0o700 });
  }
  return chain[chain.length - 1];
}

async function checksum(target, limit) {
  const digest = crypto.createHash('sha256');
  let count = 0;
  for await (const chunk of fs.createReadStream(target)) {
    count += chunk.length;
    if (count > limit) throw Error('成果超出本地保存限制');
    digest.update(chunk);
  }
  return digest.digest('hex');
}

function create({ app, identityOf, sessionOf, fetch = fetchWithDeviceAuthRetry,
  ownerOf = app => require('../device-auth').localOwner(app) } = {}) {
  async function resolveScope(ref) {
    const handle = sessionOf ? sessionOf(String(ref || '')) : null;
    const cwd = handle && typeof handle.cwd === 'string' ? handle.cwd : '';
    if (!cwd) throw Error('会话已结束或属于云端环境，请刷新会话后重试');
    let real = '';
    try { real = fs.realpathSync(cwd); } catch (_) { throw Error('会话工作区不可用'); }
    const resolved = identityOf ? await identityOf(app) : null;
    if (!resolved?.hub || !resolved.session) throw Error('请先连接 SoduWork 服务并登录');
    const identity = { ...resolved }, owner = await ownerOf(app);
    const assertCurrent = async () => {
      if (sessionOf(String(ref)) !== handle || handle.cwd !== cwd) throw Error('会话已变化，请重新打开成果');
      const current = await identityOf(app);
      if (!owner || handle.deliveryOwner !== owner || await ownerOf(app) !== owner ||
          !current?.session || current.hub !== identity.hub || current.clientId !== identity.clientId) {
        throw Error('账号或服务已变化，请重新打开原会话');
      }
      if (sessionOf(String(ref)) !== handle || handle.cwd !== cwd) throw Error('会话已变化，请重新打开成果');
      // Same-account renewal may happen while a large batch is downloading.
      identity.session = current.session;
    };
    await assertCurrent();
    return { cwd: real, identity, assertCurrent };
  }

  async function listAttachments(identity, taskId) {
    const base = String(identity.hub).replace(/\/+$/, '');
    const response = await fetch(identity,
      base + '/api/v1/tasks/' + encodeURIComponent(taskId) + '/attachments',
      { redirect: 'error', signal: AbortSignal.timeout(30000) });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw Error('交付物暂时不可用（HTTP ' + response.status + '）');
    return Array.isArray(data) ? data : [];
  }

  async function downloadOne(identity, row, target, assertCurrent, checkPath) {
    await assertCurrent();
    const expected = Number(row.size);
    const base = String(identity.hub).replace(/\/+$/, '');
    const suffix = row.url.startsWith('/api/v1/') ? row.url : '/api/v1' + row.url;
    const response = await fetch(identity,
      base + suffix, { redirect: 'error', signal: AbortSignal.timeout(120000) });
    if (!response.ok || !response.body) {
      await response.body?.cancel?.().catch(() => {});
      throw Error('成果下载失败');
    }
    const temporary = target + '.' + crypto.randomUUID() + '.tmp';
    let stream = null, count = 0, complete = false;
    const digester = crypto.createHash('sha256');
    const advertised = String(row.sha256 || row.evidenceMeta?.sha256 || '').toLowerCase();
    try {
      await assertCurrent();
      const declared = response.headers?.get('content-length');
      if (declared !== null && declared !== undefined && Number(declared) !== expected) {
        throw Error('成果大小校验失败');
      }
      stream = await fsp.open(temporary, 'wx', 0o600);
      for await (const chunk of response.body) {
        count += chunk.byteLength;
        if (count > expected || count > FILE_LIMIT) throw Error('成果超出本地保存限制');
        digester.update(chunk);
        await stream.writeFile(chunk);
      }
      const actual = digester.digest('hex');
      if (count !== expected) throw Error('成果大小校验失败');
      if (advertised && actual !== advertised) throw Error('成果完整性校验失败');
      await stream.close(); stream = null;
      await assertCurrent();
      await require('../verified-file-replace.cjs').replaceFile(temporary, target, {
        expected: { size: count, sha256: actual }, check: assertCurrent,
        checkPath,
      });
      complete = true;
      return actual;
    } finally {
      await stream?.close().catch(() => {});
      if (!complete) await response.body?.cancel?.().catch(() => {});
      await fsp.unlink(temporary).catch(() => {});
    }
  }

  async function materialize({ ref, taskId, previewOnly = false } = {}) {
    if (!ref || !taskId) throw Error('这份成果缺少任务归属，请刷新会话后重试');
    if (!/^[A-Za-z0-9-]{1,64}$/.test(String(taskId))) throw Error('任务标识无效，请刷新会话后重试');
    const { cwd, identity, assertCurrent } = await resolveScope(ref);
    const batch = currentGroup(await listAttachments(identity, taskId), taskId);
    const attachments = previewOnly ? batch.filter(outputCache.canPreview) : batch;
    await assertCurrent();
    if (!attachments.length) throw Error('这份成果暂无可保存的文件');
    let total = 0;
    for (const row of attachments) {
      const expected = Number(row.size);
      if (!Number.isSafeInteger(expected) || expected < 0 || expected > FILE_LIMIT ||
          total + expected > TOTAL_LIMIT) throw Error('成果超出本地保存限制');
      total += expected;
    }
    const root = await ensureDirectory(cwd, path.posix.join(CACHE_DIR, String(taskId)));
    const artifacts = [];
    for (const row of attachments) {
      await assertCurrent();
      const relative = safeCacheName(row.filename || row.name || row.path || '');
      if (!relative) continue;
      const target = path.join(root, ...relative.split('/'));
      await ensureDirectory(root, path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative));
      const stat = await fsp.lstat(target).catch(error => {
        if (error.code === 'ENOENT') return null; throw error;
      });
      if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw Error('成果缓存包含不安全的链接');
      const advertised = String(row.sha256 || row.evidenceMeta?.sha256 || '').toLowerCase();
      if (advertised && !/^[a-f0-9]{64}$/i.test(advertised)) throw Error('成果校验摘要无效');
      // Reuse cached names only when both size and declared digest match the current batch.
      // Otherwise download and verify before replacement; failed downloads must not expose old bytes as new output.
      const reusable = stat && stat.size === Number(row.size) && advertised &&
        await checksum(target, FILE_LIMIT) === advertised;
      const verifiedHash = reusable ? advertised : await downloadOne(identity, row, target, assertCurrent,
        () => ensureDirectory(cwd, path.relative(cwd, path.dirname(target)).split(path.sep).join('/')));
      const final = fs.statSync(target);
      const kind = deliveryContract._kindOf(relative) || 'file';
      const category = String(row.evidenceMeta?.category || row.category || '').toLowerCase();
      artifacts.push({
        path: target, relative, name: path.basename(relative), size: final.size,
        at: Math.round(final.mtimeMs), sha256: verifiedHash, kind, changedInTurn: true,
        primary: row.role !== 'supporting' && !['supporting', 'internal', 'evidence'].includes(category),
        role: row.role || 'output', taskId, attachmentId: row.id,
        remoteMaterialized: true, round: Math.max(0, Number(row.evidenceMeta?.round) || 0),
      });
    }
    await assertCurrent();
    if (!artifacts.length) throw Error('成果未能保存到本地，请重试');
    return { ok: true, cwd, taskId, artifacts };
  }

  return { materialize };
}

function install({ app, ipcMain, identityOf, sessionOf, ownerOf }) {
  const controller = create({ app, identityOf, sessionOf, ownerOf });
  ipcMain.handle('attachment-materialize', async (event, payload) => {
    try {
      if (!require('../access-control/preferences').isTrusted(event)) {
        throw Error('请在 SoduWork 工作区中打开成果');
      }
      return await controller.materialize(payload || {});
    } catch (error) {
      return { ok: false, reason: String(error && error.message || error) };
    }
  });
  return controller;
}

module.exports = { create, install, CACHE_DIR, safeCacheName };
