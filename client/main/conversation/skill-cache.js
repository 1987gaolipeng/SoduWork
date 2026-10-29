/* Versioned Skill materialization for the local conversation runtime.

   The Hub owns policy and immutable packages; this process owns the execution
   node. A Skill is only reported as installed after the bundle digest, archive
   boundaries and final SKILL.md have all been verified. */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fetchWithDeviceAuthRetry } = require('../device-auth-request');
const zlib = require('zlib');
const frontmatter = require('./skill-frontmatter');

const MAX_BYTES = 30 * 1024 * 1024;
const MAX_FILES = 301;
const _syncing = new Map();

// Windows security/indexing software can briefly hold a freshly written
// staging directory. Keep the install atomic, but tolerate that short
// transient instead of surfacing a random EPERM to the first conversation.
function _sleepSync(milliseconds) {
  const slot = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(slot, 0, 0, milliseconds);
}

function _renameWithRetry(from, to, checksum) {
  let last;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return true;
    } catch (error) {
      last = error;
      const winner = _readManifest(to);
      // Another SoduWork window/process may have completed the same immutable
      // version while this one was being published.
      if (winner && winner.ready === checksum) return false;
      const transient = ['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(error && error.code);
      if (!transient || attempt === 11) throw error;
      _sleepSync(15 + attempt * 15);
    }
  }
  throw last || Error('Skill cache publish failed');
}

function _root(app) { return path.join(app.getPath('userData'), 'skill-cache'); }
function _digest(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function _safePart(value) {
  const text = String(value || '');
  return !!text && text !== '.' && text !== '..' &&
    !text.includes('/') && !text.includes(String.fromCharCode(92)) &&
    !text.includes(String.fromCharCode(0));
}
function _safeRelative(value) {
  const text = String(value || '').split(String.fromCharCode(92)).join('/');
  return !!text && !text.startsWith('/') && !/^[A-Za-z]:/.test(text) &&
    text.split('/').every(_safePart);
}

function _skillName(dir) {
  try {
    const head = fs.readFileSync(path.join(String(dir || ''), 'SKILL.md'), 'utf8').slice(0, 8000);
    const match = head.match(/^\s*---[\r\n]+([\s\S]*?)[\r\n]+---/);
    const name = match && match[1].match(/^name\s*:\s*['"]?([^'"\r\n]+)['"]?\s*$/m);
    return String(name && name[1] || path.basename(String(dir || ''))).trim().slice(0, 64);
  } catch (error) {
    return path.basename(String(dir || '')).slice(0, 64);
  }
}

function _localMap(dirs) {
  const out = new Map();
  (dirs || []).forEach((dir) => {
    const name = _skillName(dir);
    /* Directory order follows SoduWork's first-wins policy for same-name Skills. */
    if (name && !out.has(name)) out.set(name, String(dir));
  });
  return out;
}
function _entries(data) {
  if (!Buffer.isBuffer(data) || !data.length || data.length > MAX_BYTES) {
    throw new Error('Skill 包为空或超过 30MB');
  }
  const floor = Math.max(0, data.length - 65557);
  let eocd = -1;
  for (let at = data.length - 22; at >= floor; at -= 1) {
    if (data.readUInt32LE(at) === 0x06054b50) { eocd = at; break; }
  }
  if (eocd < 0) throw new Error('Skill 包不是有效的 ZIP');
  const count = data.readUInt16LE(eocd + 10);
  const offset = data.readUInt32LE(eocd + 16);
  if (!count || count > MAX_FILES || offset >= eocd) throw new Error('Skill 包目录无效');
  const out = [];
  const portablePaths = new Set();
  let cursor = offset;
  let unpacked = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > eocd || data.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('Skill 包中央目录损坏');
    }
    const flags = data.readUInt16LE(cursor + 8);
    const method = data.readUInt16LE(cursor + 10);
    const packed = data.readUInt32LE(cursor + 20);
    const size = data.readUInt32LE(cursor + 24);
    const nameLength = data.readUInt16LE(cursor + 28);
    const extraLength = data.readUInt16LE(cursor + 30);
    const commentLength = data.readUInt16LE(cursor + 32);
    const external = data.readUInt32LE(cursor + 38);
    const local = data.readUInt32LE(cursor + 42);
    if ((flags & 1) || ![0, 8].includes(method) ||
        [packed, size, local].some((value) => value === 0xffffffff)) {
      throw new Error('Skill 包使用了不支持或不安全的 ZIP 特性');
    }
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > eocd) throw new Error('Skill 包文件名越界');
    const name = data.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const mode = (external >>> 16) & 0xffff;
    const safeName = name.endsWith('/') ? name.slice(0, -1) : name;
    if (!_safeRelative(safeName) || (mode & 0xf000) === 0xa000) {
      throw new Error('Skill 包包含越界路径或符号链接');
    }
    const portablePath = safeName.replace(/\\/g, '/').normalize('NFC').toLowerCase();
    if (portablePaths.has(portablePath)) throw new Error('Skill 包包含重复或跨平台冲突的文件路径');
    portablePaths.add(portablePath);
    if (local + 30 > data.length || data.readUInt32LE(local) !== 0x04034b50) {
      throw new Error('Skill 包本地目录损坏');
    }
    const localName = data.readUInt16LE(local + 26);
    const localExtra = data.readUInt16LE(local + 28);
    const start = local + 30 + localName + localExtra;
    if (start + packed > data.length) throw new Error('Skill 包内容越界');
    let body = Buffer.alloc(0);
    if (!name.endsWith('/')) {
      const source = data.subarray(start, start + packed);
      body = method === 8 ? zlib.inflateRawSync(source, { maxOutputLength: MAX_BYTES }) : Buffer.from(source);
      if (body.length !== size) throw new Error('Skill 包文件长度校验失败');
      unpacked += body.length;
      if (unpacked > MAX_BYTES) throw new Error('Skill 包解压后超过 30MB');
    }
    out.push({ name, body, mode: mode & 0o777 });
    cursor = end;
  }
  return out;
}

function _readManifest(dir) {
  try {
    const ready = fs.readFileSync(path.join(dir, '.ready'), 'utf8').trim();
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    if (!ready || !manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.skills)) return null;
    return { ready, manifest };
  } catch (error) { return null; }
}

function _contracts(dir, manifest, bundleChecksum, app, issues) {
  const root = path.join(dir, 'skills');
  const counts = new Map();
  for (const item of manifest.skills || []) {
    const name = item && item.name;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  const contracts = [];
  for (const item of manifest.skills || []) {
    try {
      const folder = String((item && item.dir) || '');
      const name = item && item.name;
      if (!_safePart(folder) || typeof name !== 'string' || !name || name.length > 64) throw new Error('Skill 包清单包含非法目录或名称');
      if (counts.get(name) > 1) throw new Error('Skill ' + name + '：包清单包含重复名称');
      const target = path.join(root, folder);
      const file = path.join(target, 'SKILL.md');
      if (!fs.existsSync(file)) throw new Error('Skill ' + name + '：缓存不完整，缺少 SKILL.md');
      const metadata = frontmatter.parse(fs.readFileSync(file), name, app);
      contracts.push({
        id: 'skill:' + name, name,
        description: metadata.description,
        compatibility: metadata.compatibility || '',
        version: String(item.version || '').slice(0, 64),
        checksum: String(item.version || ''),
        bundleChecksum, path: target, installed: true,
      });
    } catch (error) {
      if (!issues) throw error;
      issues.push({ name: String(item && item.name || ''), version: String(item && item.version || ''), reason: error.message });
    }
  }
  return contracts;
}

function install(app, data, expected, tempToken = crypto.randomBytes(5).toString('hex')) {
  if (!/^[a-f0-9]{10,32}$/.test(tempToken)) throw new Error('Skill 缓存暂存标识无效');
  const digest = _digest(data);
  if (!/^[a-f0-9]{64}$/.test(String(expected || '')) || digest !== expected) {
    throw new Error('Skill 包完整性校验失败');
  }
  const parent = _root(app);
  const target = path.join(parent, digest);
  const current = _readManifest(target);
  if (current && current.ready === digest) {
    return _contracts(target, current.manifest, digest, app);
  }
  if (fs.existsSync(target)) throw new Error('Skill 缓存标记不完整；已保留原文件，请修复后重新发布新版本');
  const entries = _entries(data);
  const manifestEntry = entries.find((item) => item.name === 'manifest.json');
  if (!manifestEntry) throw new Error('Skill 包缺少清单');
  let manifest;
  try { manifest = JSON.parse(manifestEntry.body.toString('utf8')); }
  catch (error) { throw new Error('Skill 包清单无效'); }
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.skills) || !manifest.skills.length) {
    throw new Error('Skill 包没有可安装的 Skill');
  }
  fs.mkdirSync(parent, { recursive: true });
  const temp = target + '.tmp-' + tempToken;
  try {
    fs.mkdirSync(temp);
    entries.forEach((item) => {
      if (item.name.endsWith('/')) return;
      const destination = path.resolve(temp, ...item.name.split('/'));
      if (path.relative(temp, destination).startsWith('..')) throw new Error('Skill 包包含越界路径');
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, item.body, item.mode ? { mode: item.mode } : undefined);
    });
    _contracts(temp, manifest, digest, app);
    fs.writeFileSync(path.join(temp, '.ready'), digest, 'utf8');
    _renameWithRetry(temp, target, digest);
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { recursive: true, force: true });
  }
  return _contracts(target, manifest, digest, app);
}

function _scan(app) {
  const out = [];
  const issues = [];
  let names = [];
  try { names = fs.readdirSync(_root(app)); } catch (error) { return { contracts: out, issues }; }
  names.forEach((name) => {
    if (!/^[a-f0-9]{64}$/.test(name)) return;
    const dir = path.join(_root(app), name);
    const got = _readManifest(dir);
    if (!got || got.ready !== name) return;
    out.push(..._contracts(dir, got.manifest, name, app, issues));
  });
  return { contracts: out, issues };
}
function installed(app) { return _scan(app).contracts; }

async function _conflictReason(response, names) {
  let detail = '';
  // Error responses are untrusted too. Read at most 4KiB, retain only a short
  // first-line explanation, and never include the YAML source excerpt.
  const reader = response.body && response.body.getReader();
  if (reader) {
    try {
      const chunks = []; let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 4096) { void reader.cancel().catch(() => {}); break; }
        chunks.push(Buffer.from(part.value));
      }
      if (size <= 4096) {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8')).detail;
        if (typeof value === 'string') detail = value.split(/[\r\n]/, 1)[0];
      }
    } catch (_) { /* HTTP 409 stays blocking even without a usable detail. */ }
    finally { reader.releaseLock(); }
  }
  const clean = value => String(value).replace(/[\x00-\x1f\x7f<>\u202a-\u202e\u2066-\u2069]/g, '').trim();
  detail = clean(detail).slice(0, 240);
  const selected = (names || []).slice(0, 8).map(name => clean(name).slice(0, 64)).filter(Boolean).join('、');
  const hint = /SKILL\.md|frontmatter|YAML/i.test(detail)
    ? '请修正 Skill 文件后重新导入，再刷新能力目录重试'
    : '请刷新能力目录后重试';
  return 'Skill ' + (selected || '所选技能') + ' 未准备完成（HTTP 409）' +
    (detail ? '：' + detail : '') + '。' + hint;
}

async function fetchBundle(identity, names, timeoutMs = 10000, fetchImpl = global.fetch) {
  const hub = String((identity && identity.hub) || '').replace(/[/]+$/, '');
  if (!hub || !identity.clientId || (!identity.session && !identity.secret)) {
    return { ok: false, reason: '这台 SoduWork 尚未连接企业后台' };
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const response = await fetchWithDeviceAuthRetry(identity, hub + '/api/v1/skills/runtime', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names }),
      signal: ctl.signal,
    }, fetchImpl);
    if (response.status === 204) return { ok: true, data: null, checksum: '' };
    if (response.status === 409) return { ok: false, blocked: true, reason: await _conflictReason(response, names) };
    if (!response.ok) return { ok: false, reason: '同步 Skill 失败（HTTP ' + response.status + '）' };
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_BYTES) return { ok: false, reason: 'Skill 包超过 30MB' };
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > MAX_BYTES) return { ok: false, reason: 'Skill 包超过 30MB' };
    return { ok: true, data, checksum: String(response.headers.get('x-soduwork-skill-sha256') || '') };
  } catch (error) {
    return { ok: false, reason: error && error.name === 'AbortError' ? '同步 Skill 超时' : '暂时无法同步 Skill' };
  } finally { clearTimeout(timer); }
}

async function ensure(options) {
  const opts = options || {};
  const policy = opts.policy || { skills: [], enabled: [] };
  const requested = new Set([...(policy.enabled || []), ...(opts.names || [])].map(String));
  const local = _localMap(opts.localDirs);
  const worker = require('./skill-cache-worker');
  let scan = await worker.scan(opts.app);
  let cached = scan.contracts;
  const versions = new Set(cached.map(item => item.name + '@' + item.version));
  const remote = (policy.skills || []).filter((item) => requested.has(String(item.name || '')) &&
    item.downloadable &&
    !versions.has(String(item.name || '') + '@' + String(item.checksum || '')));
  const explicit = new Set((opts.names || []).map(String));
  const optional = item => opts.allowUnavailableDefaults && !explicit.has(item.name);
  const warnings = [];
  const sync = items => {
    const key = JSON.stringify([path.resolve(_root(opts.app)), opts.identity?.hub, opts.identity?.clientId,
      items.map(item => item.name + '@' + item.checksum).sort()]);
    if (!_syncing.has(key)) _syncing.set(key, (async () => {
      const bundle = await fetchBundle(opts.identity, items.map(item => item.name), opts.timeoutMs, opts.fetchImpl);
      if (!bundle.ok) return bundle;
      try {
        if (bundle.data) await worker.install(opts.app, bundle.data, bundle.checksum);
        return { ok: true };
      } catch (error) { return { ok: false, blocked: true, reason: String(error.message || error) }; }
    })().finally(() => _syncing.delete(key)));
    return _syncing.get(key);
  };
  const record = (items, result) => {
    if (result.ok) return;
    if (result.blocked && items.some(item => !optional(item))) throw Error(result.reason);
    warnings.push(result.reason || 'Skill 同步失败');
  };
  if (remote.length) {
    const result = await sync(remote);
    if (result.blocked && remote.length > 1 && remote.some(optional)) {
      // A malformed default must not take healthy defaults or an explicitly
      // requested Skill out with the aggregate bundle. Retry individual names
      // only on validation/conflict errors; limit concurrent downloads to three.
      let cursor = 0;
      const results = new Array(remote.length);
      await Promise.all(Array.from({ length: Math.min(remote.length, 3) }, async () => {
        while (cursor < remote.length) {
          const index = cursor++;
          results[index] = await sync([remote[index]]);
        }
      }));
      results.forEach((entry, index) => record([remote[index]], entry));
    } else record(remote, result);
    scan = await worker.scan(opts.app);
    cached = scan.contracts;
  }
  const exact = new Map();
  cached.forEach((item) => exact.set(item.name + '@' + item.version, item));
  const invalid = scan.issues.filter(issue => requested.has(issue.name) &&
    (policy.skills || []).some(item => item.name === issue.name && String(item.checksum || '') === issue.version) &&
    !exact.has(issue.name + '@' + issue.version));
  const requiredInvalid = invalid.filter(issue => !optional(issue));
  if (requiredInvalid.length) throw Error(requiredInvalid.map(issue => issue.reason).join('；'));
  warnings.push(...invalid.filter(optional).map(issue => issue.reason));
  if (!warnings.length && remote.some(item => !exact.has(item.name + '@' + item.checksum))) {
    warnings.push('Skill 发布版本已变化或未完整安装，请刷新能力目录后重试');
  }
  const warning = [...new Set(warnings)].slice(0, 8).join('；');
  const shadowed = new Set((policy.skills || []).filter((item) =>
    item.downloadable && exact.has(
      String(item.name || '') + '@' + String(item.checksum || '')))
    .map((item) => String(item.name || '')));
  const dirs = [...local.entries()]
    .filter(([name]) => !shadowed.has(name))
    .map(([, dir]) => dir);
  const contracts = [];
  (policy.skills || []).forEach((item) => {
    const name = String(item.name || '');
    const hit = exact.get(name + '@' + String(item.checksum || ''));
    if (hit) {
      contracts.push({ ...item, ...hit, installed: true });
      if (requested.has(name)) dirs.push(hit.path);
      return;
    }
    if (local.has(name) && !item.downloadable) {
      contracts.push({ ...item, path: local.get(name), installed: true });
    }
  });
  return { ok: !warning, dirs: [...new Set(dirs)], contracts, warning };
}

module.exports = {
  ensure, installed, install, fetchBundle,
  _entries, _safeRelative, _digest, _skillName, _localMap, _scan,
};
