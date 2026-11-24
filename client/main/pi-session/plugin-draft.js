/* Find the newest plugin draft produced by an active SoduWork conversation.

   This deliberately works from the active session registry and each session's
   bounded output snapshot. The renderer never supplies a path, so this helper
   cannot become an arbitrary local-file reader. */
const fs = require('fs');
const path = require('path');
const outputs = require('./outputs');
const resources = require('../plugin-resources');
const candidates = require('./plugin-draft-candidates');
const { continuedPlugins } = require('../conversation/runtime-artifacts.cjs');

const { DRAFT_NAME, MAX_BYTES } = candidates;

function passiveHistory(handle) {
  return handle?.historyPreview || handle?.historyArtifacts || (handle?.localReplica && handle.readOnly);
}

function _candidate(handle, snapshot) {
  if (!handle || !handle.cwd || passiveHistory(handle)) return null;
  if (!snapshot) {
    if (typeof handle.outputSnapshot !== 'function') return null;
    try { snapshot = handle.outputSnapshot(); } catch (_) { return null; }
  }
  const recorded = continuedPlugins(handle);
  return newest(handle, candidates.collect(handle.cwd, recorded ? { ...snapshot, excludedDrafts: recorded.paths } : snapshot));
}

function newest(handle, matches) {
  matches.sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
  const file = matches[0];
  return file ? { handle, file, at: Number(file.at || handle.startedAt || 0) } : null;
}

function findRecent(handles) {
  const rows = (Array.isArray(handles) ? handles : []).map(handle => _candidate(handle)).filter(Boolean);
  rows.sort((a, b) => b.at - a.at);
  return rows[0] || null;
}

function readRecent(handles, app) {
  const found = findRecent(handles);
  if (!found) return { ok: false, reason: '最近的活动会话里还没有可安装的插件草稿' };
  return readCandidate(found, app);
}

async function readRecentAsync(handles, app) {
  const rows = (await Promise.all((Array.isArray(handles) ? handles : []).map(async handle => {
    try {
      if (passiveHistory(handle)) return null;
      const snapshot = typeof handle?.outputSnapshotAsync === 'function'
        ? await handle.outputSnapshotAsync() : handle?.outputSnapshot?.();
      const recorded = continuedPlugins(handle);
      return snapshot && handle.cwd ? newest(handle, await candidates.collectAsync(handle.cwd,
        recorded ? { ...snapshot, excludedDrafts: recorded.paths } : snapshot)) : null;
    } catch (_) { return null; }
  }))).filter(Boolean).sort((a, b) => b.at - a.at);
  return rows.length ? readCandidate(rows[0], app)
    : { ok: false, reason: '最近的活动会话里还没有可安装的插件草稿' };
}

function readSession(handle, target, indexed, app) {
  if (!handle) return { ok: false, reason: '请重新打开制作插件的会话后安装' };
  if (passiveHistory(handle)) return { ok: false, reason: '这份插件草稿不属于当前会话成果，请刷新后重试' };
  if (typeof handle.inFlight === 'function' && handle.inFlight()) {
    return { ok: false, reason: '插件还在制作中，请等本轮完成后安装' };
  }
  const runtime = require('../conversation/artifact-runtime');
  const snapshot = indexed || runtime.snapshot(handle);
  const files = [...snapshot.items, ...(snapshot.got.files || [])];
  let file = files.find(item => String(item.artifactId || item.path || '') === String(target || ''));
  const recorded = continuedPlugins(handle);
  if (recorded?.paths.includes(file?.path)) return { ok: false, reason: '请通过会话安装卡片核验历史插件' };
  const described = file && candidates.describe(handle.cwd, file);
  if (!file || !file.path || !described ||
      !outputs.inside(handle.cwd, file.path)) {
    return { ok: false, reason: '这份插件草稿不属于当前会话成果，请刷新后重试' };
  }
  // Resolve stale history cards only within the current conversation and with the same actual plugin key.
  // Matching display names or filenames cannot authorize installation of another plugin.
  const identity = file.pluginIdentity || candidates.candidateIdentity(described);
  const replacements = snapshot.items.filter(item => item.pluginDraft && !item.pluginSuperseded &&
    item.pluginIdentity === identity && item.path !== file.path);
  // Do not use old delivery entries to recover packages whose merged manifest no longer marks them as plugin drafts.
  if (file.pluginSuperseded || (!file.pluginDraft && replacements.length)) {
    const current = replacements.find(item => !recorded?.paths.includes(item.path) && described.pluginKey &&
      candidates.describe(handle.cwd, item)?.pluginKey === described.pluginKey);
    if (!current || !outputs.inside(handle.cwd, current.path)) {
      return { ok: false, reason: '这份插件草稿已有新稿，请刷新后安装最新稿' };
    }
    file = current;
  }
  return readCandidate({ handle, file, at: Number(file.at || 0) }, app);
}

async function readHistoryPlugin(handle, history, file, app, identityOf) {
  if (!file?.pluginDraft || file.pluginSuperseded || file.pluginValidation?.state !== 'ready')
    return { ok: false, reason: '这份插件草稿不属于当前会话成果，请刷新后重试' };
  const checked = await history.readPlugin(file);
  if (!checked.revision || checked.revision !== file.pluginRevision) return { ok: false, reason: '成果文件已改变或无法读取' };
  let body;
  if (checked.kind !== 'skill') {
    const access = require('../plugin-source-access').authorizer({ app, identityOf,
      read: require('../personal-plugins')._read, normalizeBody: value => value });
    body = await access.body(checked.body);
  }
  await history.authorize();
  if (!await history.verifyPlugin(file)) return { ok: false, reason: '成果文件已改变或无法读取' };
  const source = { sessionId: handle.sessionId, relative: file.relative, at: file.at };
  if (checked.kind === 'skill') return { ok: true, kind: 'skill', skillPackage: checked.skillPackage, source };
  body = require('../jiyong-edit-source.cjs').historicalBody(app, body, checked.editBaseline, candidates.ARCHIVE.test(file.relative));
  return { ok: true, body, source };
}

async function readSessionAsync(handle, target, app, identityOf) {
  const history = handle?.historyArtifacts;
  if (history) {
    // Each passive reader is restricted to the exact recorded file versions.
    const { items } = await history.snapshotAsync();
    const file = items.find(item => item.artifactId === target);
    if (!file?.pluginDraft || file.pluginSuperseded || file.pluginValidation?.state !== 'ready') {
      return { ok: false, reason: '这份插件草稿不属于当前会话成果，请刷新后重试' };
    }
    if (!candidates.SKILL_ARCHIVE.test(file.relative)) return readHistoryPlugin(handle, history, file, app, identityOf);
    if (!file.skillPackage) return { ok: false, reason: '这份插件草稿不属于当前会话成果，请刷新后重试' };
    const { bytes, revision } = await history.readSkill(file);
    if (!revision || revision !== file.pluginManifestDigest) return { ok: false, reason: '成果文件已改变或无法读取' };
    const skills = require('./skill-package-candidate');
    const skill = skills.read(bytes, app);
    await history.authorize();
    if (!history.verify(file.path)) return { ok: false, reason: '成果文件已改变或无法读取' };
    return skills.result(skill, { sessionId: handle.sessionId, relative: file.relative, at: file.at });
  }
  if (!handle || passiveHistory(handle)) return readSession(handle, target);
  const indexed = await require('../conversation/artifact-runtime').snapshotAsync(handle);
  const recorded = continuedPlugins(handle);
  const file = indexed.items.find(item => item.artifactId === target);
  if (recorded?.paths.includes(file?.path)) {
    if (handle.inFlight?.()) return { ok: false, reason: '插件还在制作中，请等本轮完成后安装' };
    return readHistoryPlugin(handle, recorded.view, file, app, identityOf);
  }
  return readSession(handle, target, indexed, app);
}

function readCandidate(found, app, options = {}) {
  let json;
  try {
    if (!options.staticValidation && typeof found.handle.inFlight === 'function' && found.handle.inFlight()) {
      return { ok: false, reason: '插件还在制作中，请等本轮完成后安装' };
    }
    resources.assertNoLinks(path.resolve(found.handle.cwd), path.resolve(found.file.path));
    const stat = fs.statSync(found.file.path);
    if (!stat.isFile()) return { ok: false, reason: '插件草稿已经不在了' };
    if (stat.size > MAX_BYTES) return { ok: false, reason: '插件草稿超过 24MB，无法安全读取' };
    const bytes = resources.readSized(found.file.path, stat.size);
    const verify = options.staticValidation && found.file.pluginManifestDigest;
    const changed = () => Object.assign(Error('Draft or resource bytes changed during validation'), { code: 'EAGAIN' });
    if (verify && candidates.hash(bytes) !== found.file.pluginManifestDigest) throw changed();
    const source = { sessionId: String(found.handle.sessionId || ''),
      relative: String(found.file.relative || DRAFT_NAME), at: found.at };
    const skillPackages = require('./skill-package-candidate');
    if (candidates.SKILL_ARCHIVE.test(found.file.path)) return skillPackages.result(skillPackages.read(bytes, app), source);
    let body;
    if (candidates.ARCHIVE.test(found.file.path)) {
      body = require('../plugin-package-reader.cjs').readPersonalArchive(bytes);
    } else {
      json = bytes.toString('utf8');
      body = candidates.parseJson(json);
    }
    if (!body || Array.isArray(body) || typeof body !== 'object') {
      return { ok: false, reason: '插件草稿不是有效的 JSON 对象' };
    }
    const collected = resources.collect(body, found.file.path, found.handle.cwd);
    if (verify && !candidates.ARCHIVE.test(found.file.path)) {
      const digests = new Map((collected.resources || []).map(row => [row.path, row.sha256]));
      const signatures = [found.file.pluginManifestDigest, ...(body.resources || [])
        .filter(row => !Object.hasOwn(row, 'content')).map(row => [row.path, digests.get(row.path)])];
      if (candidates.revisionOf(signatures) !== found.file.pluginRevision) throw changed();
    }
    const skill = skillPackages.fromLegacy(collected, app, candidates.ARCHIVE.test(found.file.path) ? bytes : undefined);
    if (skill) return skillPackages.result(skill, source);
    return {
      ok: true,
      body: options.staticValidation ? collected : require('../jiyong-edit-source.cjs').reconcile({app,cwd:found.handle.cwd,file:found.file.path,
        body:collected}),
      source,
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      const location = /position (\d+)/i.exec(error.message);
      let line, column;
      if (json !== undefined && (location || /unexpected end/i.test(error.message))) {
        const source = json.replace(/^\uFEFF/, '');
        const prefix = location ? source.slice(0, Number(location[1])) : source;
        const lines = prefix.split('\n'); line = lines.length; column = lines.at(-1).length + 1;
      }
      return { ok: false, reason: '\u8bfb\u53d6\u63d2\u4ef6\u8349\u7a3f\u5931\u8d25\uff1aInvalid JSON syntax', diagnostic: { field: 'JSON', line, column, message: 'Invalid JSON syntax' } };
    }
    return { ok: false, retryable: ['EBUSY','EACCES','EPERM','EMFILE','ENFILE','EIO','EAGAIN'].includes(error.code),
      reason: '读取插件草稿失败：' + String((error && error.message) || error) };
  }
}

function installIpc(ipcMain, session, app, identityOf) {
  ipcMain.handle('pi-session-recent-plugin-draft', () => readRecentAsync(session.list(), app));
  ipcMain.handle('pi-session-plugin-draft', async (event, ref, target) => {
    if (!require('../platform-connections/index.cjs').trustedSender(event)) {
      return { ok: false, reason: '只允许 SoduWork 客户端安装会话插件' };
    }
    try { return await readSessionAsync(session.get(ref), target, app, identityOf); }
    catch (error) { return { ok: false, reason: '插件草稿读取失败：' + error.message }; }
  });
}

module.exports = { installIpc, readRecent, readRecentAsync, readSession, readSessionAsync, readCandidate, findRecent, DRAFT_NAME, MAX_BYTES, _candidate };
