'use strict';
const path = require('path');
const { scope } = require('../platform-connections/runtime.cjs');
const resources = require('../access-control/resource-read-scope');
const MAX_SKILLS = 20;

function names(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_SKILLS) throw Error('本轮技能选择无效，请重新选择');
  const result = [];
  for (const name of value) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(name))
      throw Error('技能名称无效，请从技能列表重新选择');
    if (!result.includes(name)) result.push(name);
  }
  return result;
}

function failure(error) {
  return { ok: false, failureKind: 'skill-selection', retrySafe: true,
    reason: '技能没能在发送前准备好：' + String(error?.message || error).slice(0, 500) };
}

function resolver({ app, identityOf, identity, skillDirs, fetchPolicy, ensure }) {
  // Capture the owning account while its opening token is fresh. A long-lived
  // conversation must not compare the expiry of that old token on later turns.
  let owner, ownerError;
  try { owner = scope(identity); } catch (error) { ownerError = error; }
  const currentIdentity = async () => {
    if (ownerError) throw ownerError;
    const current = await identityOf(app);
    if (!current || current.hub !== identity.hub || current.clientId !== identity.clientId || scope(current) !== owner)
      throw Error('账号或服务已变化，请重新打开这条对话');
    return current;
  };
  return async selected => {
    const wanted = names(selected);
    if (!wanted.length) return { items: [] };
    const current = await currentIdentity();
    const policy = await (fetchPolicy || require('../conversation/capabilities').fetchPolicy)(current, undefined, undefined, true);
    if (!policy?.ok) throw Error(policy?.reason || '无法确认当前技能授权');
    const revoked = new Set(policy.revoked || []);
    const available = new Set((policy.skills || []).map(row => row.name));
    const missing = wanted.filter(name => !available.has(name) || revoked.has(name));
    if (missing.length) throw Error('技能已撤回或当前账号不可用：' + missing.join('、'));
    const synced = await (ensure || require('../conversation/skill-cache').ensure)({ app, identity: current,
      policy: { ...policy, enabled: [] }, localDirs: await skillDirs(), names: wanted });
    if (!synced?.ok) throw Error(synced?.warning || '技能包同步失败');
    await currentIdentity();
    const items = wanted.map(name => (synced.contracts || []).find(row => row.name === name));
    if (items.some(row => !row?.path || !row.installed)) throw Error('所选技能没有完整安装，请刷新技能列表后重试');
    return { items };
  };
}

async function prepare(options, turn, sdk) {
  try {
    const selected = names(turn?.skills);
    if (!selected.length) return { ok: true, names: [], dirs: [], skills: [], prompt: '', readScope: undefined };
    if (typeof options?.resolveSkills !== 'function') throw Error('当前会话没有技能授权解析器，请重新打开会话');
    const resolved = await options.resolveSkills(selected);
    const items = selected.map(name => resolved?.items?.find(row => row.name === name));
    if (items.some(row => !row?.path)) throw Error('有技能在发送前已失效，请重新选择');
    const dirs = items.map(row => path.resolve(row.path));
    if (!sdk) require('../windows-fs-watch-guard.cjs').install();
    const engine = sdk || await import('@earendil-works/pi-coding-agent');
    const loaded = engine.loadSkills({ cwd: options.cwd, agentDir: options.cwd,
      skillPaths: dirs, includeDefaults: false });
    require('./session-resources').verifySkills(dirs, loaded);
    const selectedSkills = selected.map(name => loaded.skills.find(row => row.name === name));
    if (selectedSkills.some(row => !row)) throw Error('技能包声明的名称与所选技能不一致');
    return { ok: true, names: selected, dirs, skills: selectedSkills,
      readScope: resources.fromSkills(selectedSkills),
      prompt: ['【本轮明确选用的技能】', '请先读取以下 SKILL.md，按技能要求处理本轮请求；技能不扩大当前工具权限。',
        ...selectedSkills.map(row => '- ' + JSON.stringify(row.name) + '：' + JSON.stringify(row.filePath))].join('\n') };
  } catch (error) { return failure(error); }
}

// Non-Pi adapters run in main but must not import the Pi SDK just to parse a
// selected skill. Authorization stays with the trusted main-process resolver;
// only copied names and installed paths go to the dedicated runtime loader.
async function prepareRunner(options, turn, runtime) {
  try {
    const selected = names(turn?.skills);
    if (!selected.length) return { ok: true, names: [], dirs: [], skills: [], prompt: '' };
    if (typeof options?.resolveSkills !== 'function') throw Error('当前会话没有技能授权解析器，请重新打开会话');
    const resolved = await options.resolveSkills(selected);
    const items = selected.map(name => resolved?.items?.find(row => row.name === name));
    if (items.some(row => !row?.path)) throw Error('有技能在发送前已失效，请重新选择');
    return await (runtime || require('../agent-runtime/process-session')).prepareSkills(options.app, {
      cwd: options.cwd, names: selected, items: items.map(row => ({ name: row.name, path: path.resolve(row.path) })),
    });
  } catch (error) { return failure(error); }
}

// Implement the public ResourceLoader interface for one idle-to-settled turn.
// Refreshing the existing tool names rebuilds Pi's prompt without loading
// extensions or replacing its session/history/model/access policy.
function installPi(session, currentResources, prepared) {
  if (!prepared.skills.length) return () => {};
  const loader = currentResources.resourceLoader, original = loader.getSkills;
  const originalAppend = loader.getAppendSystemPrompt;
  const previousNames = currentResources.skills;
  const base = original.call(loader), byName = new Map(base.skills.map(row => [row.name, row]));
  prepared.skills.forEach(row => byName.set(row.name, row));
  const skills = [...byName.values()];
  loader.getSkills = () => ({ ...base, skills });
  loader.getAppendSystemPrompt = () => [...originalAppend.call(loader), prepared.prompt];
  currentResources.skills = Object.freeze(skills.map(row => row.name));
  let released = false;
  const restore = () => {
    if (released) return;
    released = true;
    loader.getSkills = original; loader.getAppendSystemPrompt = originalAppend;
    currentResources.skills = previousNames;
    session.setActiveToolsByName(session.getActiveToolNames());
  };
  try { session.setActiveToolsByName(session.getActiveToolNames()); }
  catch (error) { restore(); throw error; }
  return restore;
}

function runnerRows(base, prepared) {
  const byName = new Map(base.map(row => [row.name, row]));
  prepared.skills.forEach(row => byName.set(row.name,
    { name: row.name, description: row.description, path: row.baseDir }));
  return [...byName.values()];
}

// A preparation failure has sent nothing to the agent. The user's explicit
// resubmission may run first; preserve all later queued turns and never retry
// the failed receipt automatically or resume an unrelated runtime failure.
function resumeRetry(queue, item, previousFailure) {
  if (!previousFailure || queue.active() || item.settled || !queue.find(item.id)) return false;
  queue.prioritize(item.id); queue.resume(); return true;
}

module.exports = { names, failure, resolver, prepare, prepareRunner, installPi, runnerRows, resumeRetry };
