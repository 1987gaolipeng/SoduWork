'use strict';

// Discovery is independent of the model's delivery manifest. Only known package
// names or a structurally identifiable SoduWork manifest become install actions.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const resources = require('../plugin-resources');
const { epoch } = require('../conversation/message-time');

const DRAFT_NAME = 'soduwork-plugin-draft.json';
const DRAFT_NAMES = [DRAFT_NAME];
const MAX_BYTES = 24 * 1024 * 1024;
const ARCHIVE = /\.soduwork-plugin$/i;
const SKILL_ARCHIVE = /\.skill$/i;
const skillPackages = require('./skill-package-candidate');
const metadataCache = new Map();
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const revisionOf = signatures => hash(JSON.stringify(signatures));

function parseJson(bytes) {
  // Windows shell writers commonly include a UTF-8 BOM.
  return JSON.parse(String(bytes).replace(/^\uFEFF/, ''));
}

function metadata(file, bytes, digest, archive) {
  const key = file + ':' + digest;
  if (metadataCache.has(key)) return metadataCache.get(key);
  let body = null;
  if (bytes) {
    try {
      if (SKILL_ARCHIVE.test(file)) {
        const skill = skillPackages.read(bytes);
        body = { name: skill.name, key: skill.name, skillPackage: true };
      } else {
        const parsed = archive
          ? require('../plugin-package-reader.cjs').readPersonalArchive(bytes)
          : parseJson(bytes.toString('utf8'));
        if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') {
          // Cache discovery metadata only, never the potentially large embedded resources.
          body = Object.fromEntries(['name', 'key', 'version', 'template', 'description', 'instructions']
            .map(key => [key, typeof parsed[key] === 'string' ? parsed[key].slice(0, 256) : '']));
          body.resourcePaths = !archive && Array.isArray(parsed.resources) && parsed.resources.length <= resources.MAX_FILES
            ? parsed.resources.filter(item => item && !Object.hasOwn(item, 'content')).map(item => item.path).filter(value => typeof value === 'string' && value.length <= 240) : [];
          const skill = skillPackages.legacy(parsed, undefined, archive ? bytes : undefined);
          if (skill) Object.assign(body, { name: skill.name, key: skill.name, skillPackage: true });
        }
      }
    } catch (_) { /* Keep malformed drafts discoverable for host validation and diagnostics. */ }
  }
  if (metadataCache.size >= 64) metadataCache.delete(metadataCache.keys().next().value);
  const result = body && !Array.isArray(body) && typeof body === 'object' ? body : null;
  metadataCache.set(key, result);
  return result;
}

function revision(cwd, target, digest, body, at) {
  let updatedAt = Number(at) || 0;
  const signatures = [digest];
  let remaining = resources.MAX_BYTES;
  // Resource-only repairs belong to their own completed turn. Keep the manifest's
  // ownership boundary unchanged so a new chat cannot inherit another chat's draft.
  for (const value of body?.resourcePaths || []) {
    try {
      const relative = resources.resourcePath(value);
      const file = path.resolve(path.dirname(target), relative);
      resources.assertNoLinks(path.resolve(cwd), file);
      const current = fs.statSync(file);
      if (!current.isFile()) continue;
      const permitted = current.size <= Math.min(resources.MAX_FILE_BYTES, remaining);
      remaining = Math.max(0, remaining - current.size);
      signatures.push([relative, permitted
        ? crypto.createHash('sha256').update(resources.readSized(file, current.size)).digest('hex') : ['oversized', current.size]]);
      updatedAt = Math.max(updatedAt, Math.round(current.mtimeMs), Math.round(current.ctimeMs));
    } catch (_) { signatures.push([value, 'unavailable']); }
  }
  return { pluginRevision: revisionOf(signatures), pluginManifestDigest: digest,
    pluginRevisionAt: updatedAt };
}

function describe(cwd, file) {
  if (!cwd || !file || !file.path) return null;
  const target = path.resolve(file.path), name = path.basename(target);
  const canonical = DRAFT_NAMES.includes(name.toLowerCase());
  const archive = ARCHIVE.test(name);
  const skillArchive = SKILL_ARCHIVE.test(name);
  if (!canonical && !archive && !skillArchive && name.toLowerCase() !== 'plugin.json') return null;
  let stat, fileIdentity;
  try {
    resources.assertNoLinks(path.resolve(cwd), target);
    const actual = fs.statSync(target, { bigint: true });
    if (!actual.isFile()) return null;
    stat = { size: Number(actual.size), mtimeMs: Number(actual.mtimeNs) / 1e6 };
    fileIdentity = actual.ino ? actual.dev + ':' + actual.ino + ':' + actual.birthtimeNs : '';
  } catch (_) { return null; }
  let bytes;
  try { bytes = stat.size <= MAX_BYTES ? resources.readSized(target, stat.size) : null; }
  catch (error) {
    if (error.code === 'ENOENT' || !(canonical || archive || skillArchive)) return null;
    return { ...file, path: target, name, relative: path.relative(cwd, target).split(path.sep).join('/'),
      at: Math.round(stat.mtimeMs), pluginRevision: 'unreadable:' + stat.size + ':' + stat.mtimeMs,
      pluginDraft: true, pluginPackage: archive, skillPackage: skillArchive, unavailable: true };
  }
  const digest = bytes ? hash(bytes) : 'oversized:' + stat.size;
  const body = metadata(target, bytes, digest, archive);
  if (!canonical && !archive && !skillArchive && !(body && ['method', 'connector', 'workflow'].includes(body.template) &&
      ['name', 'description', 'instructions'].every(key => typeof body[key] === 'string' && body[key].trim()))) return null;
  return { ...file, path: target, name, fileIdentity,
    relative: path.relative(cwd, target).split(path.sep).join('/'),
    size: stat.size, at: file.at == null ? Math.round(stat.mtimeMs) : file.at,
    ...revision(cwd, target, digest, body, file.at == null ? Math.round(stat.mtimeMs) : file.at),
    pluginDraft: true, pluginPackage: archive, skillPackage: skillArchive || body?.skillPackage === true,
    pluginName: body && typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '',
    pluginKey: body && typeof body.key === 'string' ? body.key.trim().slice(0, 64) : '',
    pluginVersion: body && typeof body.version === 'string' ? body.version.trim().slice(0, 40) : '',
  };
}

function withinSnapshot(file, snapshot) {
  const since = Number(snapshot && (snapshot.pluginSince ?? snapshot.since)) || 0;
  if (!since) return true;
  // Match the output inventory's millisecond precision so an indexed boundary
  // draft cannot disappear before validation. Recheck the actual file time.
  try { return Math.round(fs.statSync(file.path).mtimeMs) >= since; } catch (_) { return false; }
}

function sessionSince(manager) {
  try {
    const headerAt = epoch(manager?.getHeader?.()?.timestamp);
    if (headerAt) return headerAt;
  } catch (_) { /* Older session implementations may not expose a header. */ }
  try {
    const times = (manager?.getEntries?.() || []).filter(entry => entry?.type === 'message')
      .map(entry => epoch(entry.timestamp) || epoch(entry.message?.sentAt) || epoch(entry.message?.timestamp))
      .filter(Boolean);
    if (times.length) return times.reduce((first, at) => Math.min(first, at), Infinity);
  } catch (_) { /* Undated legacy history retains its existing recovery scope. */ }
  return 0;
}

function packageName(name) {
  return DRAFT_NAMES.includes(name.toLowerCase()) || name.toLowerCase() === 'plugin.json' ||
    ARCHIVE.test(name) || SKILL_ARCHIVE.test(name);
}

// A truncated display index cannot determine whether a later directory has a draft.
function collectOverflow(dir, depth, files) {
  if (depth > 6) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name.startsWith('~$')) continue;
    const target = path.join(dir, entry.name);
    if (entry.isFile() && packageName(entry.name)) files.push({ path: target });
    if (entry.isDirectory() && !['skills', 'node_modules', '__pycache__', 'node-compile-cache'].includes(entry.name))
      collectOverflow(target, depth + 1, files);
  }
}

function collect(cwd, snapshot) {
  const got = snapshot || {};
  const files = [...(got.delivery && got.delivery.items || []), ...(got.files || [])];
  // A resource-heavy plugin can exceed the general 60-output inventory. Recover
  // its root manifest only with the scan's trusted conversation time boundary;
  // a trial/new chat may deliberately reuse the author's working directory.
  if (cwd && typeof got.since === 'number' && Number.isFinite(got.since)) {
    for (const name of [...DRAFT_NAMES, 'plugin.json']) files.push({ path: path.join(cwd, name) });
  }
  const found = new Map();
  if (cwd && got.truncated) collectOverflow(cwd, 0, files);
  for (const file of files) {
    const key = file && file.path ? path.resolve(file.path) : '';
    if (!key || found.has(key)) continue;
    const item = describe(cwd, file);
    if (item && withinSnapshot(item, got)) found.set(key, item);
  }
  return mergePluginCandidates([...found.values()]);
}

async function collectAsync(cwd, snapshot = {}) {
  const indexed = new Map();
  for (const file of [...(snapshot.delivery?.items || []), ...(snapshot.files || [])]) {
    if (file?.path && packageName(path.basename(file.path)) && !indexed.has(path.resolve(file.path)))
      indexed.set(path.resolve(file.path), file);
  }
  const files = [...indexed.values()].map(({ path, at }) => ({ path, at }));
  if (!files.length && !snapshot.truncated && snapshot.pluginSince === undefined &&
      Array.isArray(snapshot.files) && Number.isFinite(snapshot.since)) return [];
  const candidates = await require('../app-resource-cache.cjs').request({ action: 'draft-candidates', cwd,
    snapshot: { files, since: snapshot.since, pluginSince: snapshot.pluginSince, truncated: snapshot.truncated } })
    .catch(error => { throw Object.assign(error, { retryable: true }); });
  return candidates.map(file => ({ ...indexed.get(file.path), ...file }));
}

/* Conversation cards speak the user's unit — one plugin — while discovery
   naturally sees files: the manifest, plus an archive the turn may also have
   produced, plus earlier turns' copies in other directories. Collapse those
   into one current candidate per plugin identity so a revision never stacks a
   second install card on top of the first one (rendered cards stay file-keyed;
   this merge is what keeps the set they dedupe against single-valued). */
const NAME_DASHES = /[^a-z0-9\u4e00-\u9fa5]+/g;
const TRIM_DASHES = /^-+|-+$/g;
// Package files follow the maker's own naming (slug(name)-version); strip the
// trailing version segment before comparing against a manifest's slug.
const PACKAGE_VERSION_TAIL = /[-_.]v?\d+\.\d+(?:\.\d+)?(?:[-+][0-9a-z.-]+)?$/i;

function slugName(value) {
  return String(value || '').trim().toLowerCase().replace(NAME_DASHES, '-')
    .replace(TRIM_DASHES, '');
}

function packageSlug(row) {
  const stem = String(row && row.name || '').replace(/\.soduwork-plugin$/i, '');
  return slugName(stem.replace(PACKAGE_VERSION_TAIL, ''));
}

function candidateIdentity(row) {
  const key = String(row.pluginKey || '').trim();
  if (row.skillPackage) return key ? 'skill:' + key : 'skill-file:' + row.path.toLowerCase();
  if (key) return 'key:' + key;
  if (row.pluginPackage) {
    const slug = packageSlug(row);
    return slug ? 'name:' + slug : 'file:' + row.path.toLowerCase();
  }
  const slug = slugName(row.pluginName);
  return slug ? 'name:' + slug : 'file:' + row.path.toLowerCase();
}

function mergePluginCandidates(rows) {
  // Same directory: the archive the turn packaged alongside its manifest is
  // that manifest's installable artifact, never a second candidate. A package
  // only survives alone when no same-directory manifest claims its key (or
  // legacy filename slug when package metadata is unavailable).
  const byDir = new Map();
  rows.forEach(row => {
    const dir = path.dirname(row.path).toLowerCase() + '\0' + (row.skillPackage ? 'skill' : 'plugin');
    if (!byDir.has(dir)) byDir.set(dir, { manifests: [], packages: [] });
    (row.pluginPackage ? byDir.get(dir).packages : byDir.get(dir).manifests).push(row);
  });
  const kept = [];
  byDir.forEach(group => {
    kept.push(...group.manifests);
    const manifestKeys = new Set(group.manifests.map(row => row.pluginKey).filter(Boolean));
    const manifestSlugs = new Set(group.manifests.map(row => slugName(row.pluginName)).filter(Boolean));
    group.packages.forEach(row => {
      const slug = packageSlug(row);
      // Stable package metadata takes precedence over display names or filenames.
      // Keep the filename fallback for legacy/unreadable archives only.
      const matched = row.pluginKey ? manifestKeys.has(row.pluginKey) : slug && manifestSlugs.has(slug);
      if (!matched) kept.push(row);
    });
  });
  // Across directories the newest copy of one identity stays current; older
  // copies stay openable in the workspace but stop soliciting installs. Equal
  // timestamps keep scan order, which puts delivery-declared rows first.
  const byIdentity = new Map();
  kept.forEach(row => {
    row.pluginIdentity = candidateIdentity(row);
    if (!byIdentity.has(row.pluginIdentity)) byIdentity.set(row.pluginIdentity, []);
    byIdentity.get(row.pluginIdentity).push(row);
  });
  byIdentity.forEach(group => {
    group.sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
    for (let i = 1; i < group.length; i++) group[i].pluginSuperseded = true;
  });
  return kept;
}

module.exports = { DRAFT_NAME, MAX_BYTES, ARCHIVE, SKILL_ARCHIVE, parseJson, hash, revisionOf, describe, collect, collectAsync, withinSnapshot, sessionSince,
  mergePluginCandidates, slugName, packageSlug, candidateIdentity };
