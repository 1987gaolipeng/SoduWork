'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { scope, scopeMatches } = require('../platform-connections/runtime.cjs');

// A durable boundary for reusing a native conversation. These values are read
// from the authenticated Hub and the live runtime, never from renderer cwd/ids.
function location(app, sessionId) {
  if (!app?.getPath || !sessionId) throw Error('无法确认当前会话，请重新打开后再安排需求');
  return path.join(app.getPath('userData'), 'requirement-session-context',
    crypto.createHash('sha256').update(String(sessionId)).digest('hex') + '.json');
}
function read(app, sessionId) {
  try {
    const value = JSON.parse(fs.readFileSync(location(app, sessionId), 'utf8'));
    if (value?.version !== 1 || typeof value.owner !== 'string' ||
        typeof value.cwd !== 'string' || typeof value.projectId !== 'string' ||
        typeof value.repoId !== 'string' || typeof value.adapterId !== 'string') throw Error();
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw Error('会话的项目关联无法读取，请检查本地存储后重试');
  }
}
function publicContext(app, sessionId) {
  try {
    const value = read(app, sessionId);
    return value ? { projectId: value.projectId, repoId: value.repoId } : null;
  } catch (_) { return null; }
}
function decorate(app, row, identity) {
  if (!row) return row;
  if (arguments.length > 2) {
    try {
      if (!identity || !scopeMatches(read(app, row.sessionId || row.id)?.owner, identity,
        require('../device-auth').profiles(app))) return row;
    } catch (_) { return row; }
  }
  const value = publicContext(app, row.sessionId || row.id);
  return value ? { ...row, requirementContext: value } : row;
}
function cachedIdentity(app) {
  // History is an offline view: optional project metadata must not trigger a
  // device enrollment/renewal request or delay painting the conversation list.
  const auth = require('../device-auth');
  const identity = auth.identity(app);
  const session = identity && auth.session(app, identity.hub, identity.clientId);
  return session ? { ...identity, session } : null;
}
function canonical(directory) {
  let value;
  try {
    if (!directory || !path.isAbsolute(directory) || !fs.statSync(directory).isDirectory()) throw Error();
    value = fs.realpathSync(directory);
  } catch (_) { throw Error('当前会话的工作目录不可用，请检查后再安排需求'); }
  return process.platform === 'win32' ? value.toLowerCase() : value;
}
function identityMatches(handle, identity) {
  // usageIdentity records the environment at conversation opening.
  // Execution and task association require the same environment to avoid dispatching into another Hub's task store.
  const owner = handle.usageIdentity;
  if (owner && (owner.hub !== identity?.hub || owner.clientId !== identity?.clientId))
    throw Error('账号或服务已变化，请重新打开这条会话');
  return scope(identity);
}
function ownerCandidates(app, handle, identity) {
  const usage = handle && handle.usageIdentity;
  const list = [];
  if (usage && usage.hub && usage.clientId) list.push({ hub: usage.hub, clientId: usage.clientId });
  if (identity?.hub && identity?.clientId) list.push({ hub: identity.hub, clientId: identity.clientId });
  try { for (const row of require('../device-auth').profiles(app)) list.push(row); } catch (_) {}
  return list;
}
function rewriteOwner(app, sessionId, record, owner) {
  const file = location(app, sessionId);
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(temporary, JSON.stringify({ ...record, owner }), { flag: 'w', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch (_) {} }
}
function assertOwner(app, handle, identity) {
  const record = read(app, handle.sessionId);
  if (!record) return null;
  const owner = scope(identity);
  if (record.owner !== owner) {
    if (!scopeMatches(record.owner, identity, ownerCandidates(app, handle, identity)))
      throw Error('这条需求会话属于另一个账号或服务，请切回原账号');
    try { rewriteOwner(app, handle.sessionId, record, owner); } catch (_) { /* Retry convergence later if rewriting fails; do not block opening. */ }
  }
  if (record.cwd !== canonical(handle.cwd) || ![String(handle.adapterId || 'pi'), ...(handle.runtimeAdapters || [])].includes(record.adapterId))
    throw Error('这条会话的工作目录或 Agent 已变化，请重新打开原会话');
  handle.requirementContext = { projectId: record.projectId, repoId: record.repoId };
  return { ...record, owner };
}
function dimensions(task) {
  const context = task.executionContext || task.workRouting?.executionContext || {};
  return { projectId: String(task.projectId || ''),
    repoId: String(task.repoId || task.repo?.id || context.repoId || context.repo?.id || '') };
}
function same(left, right) {
  if (left.projectId !== right.projectId || left.repoId !== right.repoId)
    throw Error('这项需求与当前会话不属于同一项目或工程，请在对应会话中执行');
}
function accessible(task, identity, executing) {
  if (!task?.id || task.canViewExecution === false ||
      (executing && (task.readOnly === true || task.ownerClientId !== identity.clientId)))
    throw Error('当前账号或设备无权在此会话中执行这项需求');
}
async function repository(task, spec, runtime, request) {
  const wanted = dimensions(task);
  const selected = String(spec?.repoId || '');
  if (wanted.repoId && selected && wanted.repoId !== selected)
    throw Error('需求工程与所选工程不一致，请刷新后重试');
  wanted.repoId = wanted.repoId || selected;
  if (!wanted.repoId) {
    if (spec?.repo?.path) throw Error('这个工程缺少可验证的工程编号，暂不能沿用当前会话');
    return wanted;
  }
  const listing = await request('/repos');
  const repo = (Array.isArray(listing?.repos) ? listing.repos : []).find(row => String(row.id) === wanted.repoId);
  if (!repo || !wanted.projectId || String(repo.projectId) !== wanted.projectId)
    throw Error('当前账号无权访问该工程，或工程不属于需求项目');
  const localDir = String(repo.localDir || '').trim();
  // Hub stores a relative location, not an arbitrary local filesystem grant.
  if (!localDir || path.isAbsolute(localDir) || path.win32.isAbsolute(localDir) || /\0/.test(localDir))
    throw Error('工程尚未配置有效的本地目录，暂不能沿用当前会话');
  const root = canonical(runtime.workRoot), target = path.resolve(root, localDir);
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw Error('工程本地目录超出工作目录，暂不能沿用当前会话');
  const resolved = canonical(target), actualRelative = path.relative(root, resolved);
  if (actualRelative === '..' || actualRelative.startsWith('..' + path.sep) || path.isAbsolute(actualRelative))
    throw Error('工程本地目录指向工作目录之外，暂不能沿用当前会话');
  if (resolved !== canonical(runtime.handle.cwd))
    throw Error('当前会话不在这项需求的工程目录，请打开对应工程会话');
  return wanted;
}
function nativeOnly(task, requested, spec, handle) {
  const reselect = requested.executionChoice === 'native';
  if (reselect) {
    const idle = new Set(['', 'failed', 'cancelled', 'canceled', 'stopped', 'interrupted']);
    const receipt = task.workRouting?.conversationTurn || {}, ai = task.ai || {};
    if (task.status !== 'todo' || task.archivedAt || task.requirementStage === 'reviewing' ||
      ['intake', 'clarifying'].includes(task.triageStage) || !idle.has(String(receipt.state || '').toLowerCase()) ||
      !idle.has(String(ai.state || '').toLowerCase()) || !idle.has(String(ai.executionState || '').toLowerCase()))
      throw Error('仅待开始且没有活动执行或交付结果的需求可以重新选择执行方式');
    if (spec.mode !== 'native' || !/^local:[a-z0-9][a-z0-9._-]*$/i.test(String(spec.agentId || '')))
      throw Error('请明确选择本机 Agent 后再开始执行');
  }
  // Explicit changes replace only unexecuted methods; final preparation still atomically verifies active ownership with Hub.
  for (const value of reselect ? [spec] : [require('../pi-session/controlled-task-turn').executionSpec(task), spec]) {
    const context = value.context || {}, runner = context.runner || {};
    if (value.mode === 'workflow' || value.assigneeType === 'squad' ||
        /^runner:/.test(String(value.agentId || '')) || runner.mode === 'remote' || runner.remote === true ||
        context.location?.mode === 'remote')
      throw Error('工作流、远程执行和团队执行不能沿用本机会话，请保留原执行方式');
  }
  const agent = String(spec.agentId || '').replace(/^local:/, '');
  if (agent && agent !== String(handle.adapterId || 'pi'))
    throw Error('所选 Agent 与当前会话不同，请选择对应会话；当前上下文未更换');
  const selection = typeof handle.snapshot === 'function' ? handle.snapshot()?.modelSelection : null;
  const model = String(requested.model || '');
  const currentModels = (selection ? [selection.name, selection.model?.id]
    : [typeof handle.model === 'object' ? handle.model?.id : handle.model]).filter(Boolean);
  if (model && currentModels.length && !currentModels.includes(model))
    throw Error('所选模型与当前会话不同，请先选择相同模型的会话');
}
function save(app, handle, record) {
  const current = read(app, handle.sessionId);
  if (current) {
    if (current.owner !== record.owner || current.cwd !== record.cwd || !([record.adapterId, ...(handle.runtimeAdapters || [])].includes(current.adapterId)))
      throw Error('会话归属已变化，请重新打开后再试');
    same(current, record);
    return;
  }
  const file = location(app, handle.sessionId), temporary = file + '.' + crypto.randomUUID() + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch (_) {} }
}
async function validate({ app, handle, identity, workRoot, identityOf }, task, requested, spec, request) {
  if (!handle?.sessionId || !app) throw Error('无法确认原会话，请重新打开后再安排需求');
  const owner = identityMatches(handle, identity);
  accessible(task, identity, true);
  nativeOnly(task, requested, spec, handle);
  const wanted = await repository(task, spec, { handle, workRoot }, request);
  const current = assertOwner(app, handle, identity);
  if (current) same(current, wanted);
  else {
    // Old archives persisted task ids only. Rebuild from authorized Hub records,
    // not the renderer's mutable project selection or collaboration index.
    const previous = [...new Set([...(handle.taskIds || []), ...(handle.taskBindings || []).map(row => row.taskId),
      handle.taskRef].filter(Boolean))].filter(id => id !== task.id);
    for (let index = 0; index < previous.length; index += 6) {
      const rows = await Promise.all(previous.slice(index, index + 6).map(id => request('/tasks/' + encodeURIComponent(id))));
      for (const row of rows) { accessible(row, identity, false); same(dimensions(row), wanted); }
    }
  }
  if (identityOf && scope(await identityOf()) !== owner)
    throw Error('账号或服务已变化，本次需求没有开始执行');
  const record = { version: 1, owner, ...wanted, cwd: canonical(handle.cwd), adapterId: String(handle.adapterId || 'pi') };
  save(app, handle, record);
  handle.requirementContext = wanted;
  return wanted;
}
// Binding is metadata, but cannot change the established conversation boundary.
async function checkBinding(runtime, taskId, request) {
  // Rebinding a task is an execution action; reopen after an environment change rather than rebinding in place.
  identityMatches(runtime.handle, runtime.identity);
  const current = assertOwner(runtime.app, runtime.handle, runtime.identity);
  if (!current) return;
  const task = await request('/tasks/' + encodeURIComponent(taskId));
  accessible(task, runtime.identity, false);
  same(current, dimensions(task));
  if (runtime.identityOf && scope(await runtime.identityOf()) !== current.owner)
    throw Error('账号或服务已变化，需求关联未保存');
}
module.exports = { read, publicContext, decorate, cachedIdentity, identityMatches, assertOwner, validate, checkBinding };
