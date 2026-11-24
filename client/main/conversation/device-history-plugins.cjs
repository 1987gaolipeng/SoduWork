'use strict';

const path = require('node:path').posix;
const drafts = require('../pi-session/plugin-draft-candidates');
const resources = require('../plugin-resources');
const { readRecorded } = require('./metadata-snapshot.cjs');
const BASELINE = /^jiyong-development\/[^/]+\/baseline\.json$/;

function candidate(relative) {
  const name = path.basename(relative).toLowerCase();
  return drafts.ARCHIVE.test(name) || name === drafts.DRAFT_NAME || name === 'plugin.json';
}

function resource(relative) {
  const match = /(?:^|\/)((?:templates|examples|assets|scripts|references|ui)\/.+)$/.exec(relative);
  if (!match) return false;
  try { resources.resourcePath(match[1]); return true; } catch (_) { return false; }
}

function load(root, relative, receipts, skillRuntimeEntry) {
  const dependencies = new Set([relative]), signatures = [];
  function verified(name, limit) {
    const stamp = receipts.get(name);
    if (!stamp) throw Error('此草稿引用的文件缺少本会话的本机记录');
    dependencies.add(name);
    return readRecorded(root, name, stamp, limit);
  }
  const manifest = verified(relative, drafts.MAX_BYTES);
  signatures.push(manifest.revision);
  const archive = drafts.ARCHIVE.test(relative);
  let body = archive ? require('../plugin-package-reader.cjs').readPersonalArchive(manifest.bytes)
    : drafts.parseJson(manifest.bytes.toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('插件草稿格式无效');
  if (path.basename(relative).toLowerCase() === 'plugin.json' &&
      (!['method', 'connector', 'workflow', 'app'].includes(body.template) ||
       !['name', 'description', 'instructions'].every(key => typeof body[key] === 'string' && body[key].trim()))) return null;
  if (body.resources != null) {
    if (!Array.isArray(body.resources) || body.resources.length > resources.MAX_FILES) throw Error('插件资源数量超过限制');
    let remaining = resources.MAX_BYTES;
    const rows = body.resources.map(row => {
      const name = resources.resourcePath(row?.path);
      if (Object.hasOwn(row, 'content')) return row;
      const file = verified(path.join(path.dirname(relative), name), Math.min(remaining, resources.MAX_FILE_BYTES));
      remaining -= file.bytes.length;
      signatures.push([name, file.revision]);
      return { ...row, encoding: 'base64', content: file.bytes.toString('base64') };
    });
    body = { ...body, resources: resources.normalize(rows) };
  }
  let editBaseline;
  if (body.template === 'app') {
    const editDir = /^(jiyong-development\/[^/]+)\//.exec(relative)?.[1];
    const paths = editDir ? [editDir + '/baseline.json'] : [...receipts.keys()].filter(name => BASELINE.test(name));
    for (const name of paths) {
      const value = drafts.parseJson(verified(name, 1024 * 1024).bytes.toString('utf8'));
      if (value?.key === body.key) {
        if (editBaseline) throw Error('此会话有多个同名即用修改基线');
        editBaseline = value;
      }
    }
    if (editDir && !editBaseline) throw Error('即用修改基线无法核验');
  }
  const skills = require('../pi-session/skill-package-candidate');
  const skill = skills.fromLegacy(body, { skillRuntimeEntry }, archive ? manifest.bytes : undefined);
  if (!skill) {
    const preview = require('../personal-plugins').preflight(body);
    const failed = preview.checks?.find(row => row.ok === false);
    if (!preview.ok || failed) throw Error(failed?.label || '插件静态检查未通过');
  }
  return { body, ...(skill ? skills.result(skill) : {}), editBaseline, dependencies: [...dependencies],
    revision: drafts.revisionOf(signatures), digest: manifest.revision, skillName: skill?.name };
}

function inspect(root, files, receipts, skillRuntimeEntry) {
  const cards = [];
  for (const { relative, stamp } of files) {
    let loaded, diagnostic;
    try {
      loaded = load(root, relative, receipts, skillRuntimeEntry);
      if (!loaded) continue;
    } catch (error) {
      if (path.basename(relative).toLowerCase() === 'plugin.json') continue;
      diagnostic = require('../pi-session/plugin-generation-gate.cjs').diagnostic({ relative }, error);
    }
    const revision = loaded?.revision || drafts.revisionOf(stamp);
    const dependencies = loaded?.dependencies || [];
    const revisionAt = dependencies.reduce((at, name) =>
      Math.max(at, Number(receipts.get(name)[3]) / 1e6), Number(stamp[3]) / 1e6);
    cards.push({ relative, pluginDraft: true, pluginPackage: drafts.ARCHIVE.test(relative), skillPackage: Boolean(loaded?.skillName),
      pluginKey: loaded?.skillName || loaded?.body.key || '', pluginName: loaded?.skillName || loaded?.body.name || '',
      pluginVersion: loaded?.body.version || '', pluginRevision: revision, pluginManifestDigest: loaded?.digest,
      dependencies, pluginRevisionAt: Math.round(revisionAt), pluginValidation: { state: diagnostic ? 'invalid' : 'ready',
        revision, relative, attempt: 0, ...(diagnostic ? { diagnostic } : {}) } });
  }
  return cards;
}

module.exports = { candidate, resource, inspect, load, BASELINE };
