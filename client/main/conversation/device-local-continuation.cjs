'use strict';

// A desktop grant is process-local authority, never a renderer flag or a saved credential.
const access = require('./history-access');
const segments = require('./runtime-segments');
const grants = new WeakMap(), handles = new WeakMap();
const PRIVATE = '这条本机共享聊天不能关联账号私有资料，请新建私人会话后使用需求、记忆或项目';
function assertSelections(options = {}) {
  if (access.requestsAccountContext(options)) throw Error(PRIVATE);
}
function grant(app, row, identity, options = {}) {
  const captured = access.actor(app, identity);
  const result = access.assertDeviceReadable(app, row.id, captured, row);
  const record = segments.read(app, row.id);
  if (!result?.sharedOnDevice && !record?.deviceShared) return null;
  const local = access.classifyLocal(app, row.id, row);
  if (local.kind !== 'ordinary' || local.invalid) throw Error(PRIVATE);
  assertSelections(options);
  const original = result?.originalOwner || record?.owner || row.workOwner ||
    local.ownership(row.id).records.find(value => value.owner)?.owner;
  if (!original) throw Error('本机会话原始归属不完整，请重新打开历史');
  const token = Object.freeze({});
  grants.set(token, { app, row, captured, original, executionOwner: segments.scope(identity),
    fresh: !record?.deviceShared || record.executionOwner !== segments.scope(identity) });
  return token;
}
function assert(token, app, identity, id) {
  const value = grants.get(token);
  if (!value || value.app !== app || value.row.id !== id || segments.scope(identity) !== value.executionOwner)
    throw Error('本机续聊授权已失效，请重新打开会话');
  access.assertCurrent(app, value.captured);
  access.assertDeviceReadable(app, id, value.captured, value.row);
  const record = segments.read(app, id);
  if (record?.deviceShared && !value.fresh && record.executionOwner !== value.executionOwner)
    throw Error('执行账号已变化，请重新打开会话');
  const local = access.classifyLocal(app, id, value.row);
  if (local.kind !== 'ordinary' || local.invalid) throw Error(PRIVATE);
  return value;
}
function bind(handle, token) {
  const value = grants.get(token);
  if (value) { value.fresh = false; handles.set(handle, token); }
}
function tokenOf(handle) { return handle && handles.get(handle); }
function guard(handle, identity, options = {}) {
  const token = tokenOf(handle);
  if (!token) return false;
  const value = grants.get(token);
  assert(token, value.app, identity, handle.sessionId); assertSelections(options);
  return true;
}
// A portable transcript carries content only. Restore permissions exclusively from
// this account's original native runtime, for the same adapter and workspace.
async function nativeAccessPolicy(app, row, actor, session, adapterId, cwd) {
  if (!cwd || !access.usesDeviceChatContext(app, { chatId: row.id }, row) ||
      access.assertDeviceReadable(app, row.id, actor, row)?.sharedOnDevice) return null;
  const record = segments.read(app, row.id);
  if (record?.deviceShared) return null;
  const rules = require('../access-control/policy');
  const live = session.findBySessionId(row.id);
  if (live && !live.localReplica) {
    const owner = live.usageIdentity;
    if (live.adapterId !== adapterId || !owner || owner.accountScope !== actor.owner ||
        owner.clientId !== actor.identity?.clientId || owner.hub !== actor.identity?.hub) return null;
    const snap = live.snapshot();
    return rules.normalize(snap.nextAccessPolicy || snap.accessPolicy, cwd);
  }
  if ((record?.active.adapterId || row.adapterId || 'pi') !== adapterId) return null;
  if (adapterId === 'pi') return require('../pi-session/session').archivedAccessPolicy(app, record?.active.sessionId || row.id, cwd);
  return rules.normalize(record?.accessPolicy, cwd);
}
function matchesLiveSelection(handle, options, identity, owner) {
  const actor = handle.usageIdentity;
  if (handle.localReplica || handle.adapterId !== options.adapterId || !actor || actor.accountScope !== owner ||
      actor.hub !== identity.hub || actor.clientId !== identity.clientId) return false;
  const snap = handle.snapshot();
  const selection = snap.modelSelection;
  const mode = options.mode === 'readonly' ? 'readonly' : options.accessMode || 'standard';
  const policy = snap.nextAccessPolicy || snap.accessPolicy || snap.accessControl;
  const thinking = snap.thinking?.level || '';
  const levels = [options.reasoningEffort, options.thinkingLevel].filter(Boolean);
  return Boolean(options.modelName && selection?.name === options.modelName && selection.activeName === options.modelName &&
    !selection.pending && !selection.model?.unavailable && !selection.activeModel?.unavailable &&
    !snap.runtimeUnavailable && !snap.execution?.modelRecovery && policy?.mode === mode &&
    (levels.length ? levels.every(level => level === thinking) : !thinking || thinking === 'off'));
}
async function prepare(token, history, identity, session) {
  const value = grants.get(token);
  if (!value) throw Error('本机续聊授权无效');
  assert(token, value.app, identity, value.row.id);
  if (!value.fresh) return null;
  let recovery, nativeArchiveMissing = false;
  if (typeof history.backfill === 'function') {
    const found = await require('./native-history-opening.cjs').resolve({ app: value.app, session, history, row: value.row });
    assert(token, value.app, identity, value.row.id);
    if (found.readOnly) throw found.error;
    recovery = found.recovery;
    nativeArchiveMissing = Boolean(recovery);
    if (!recovery) {
      // A complete cache can predate a crash. Read the latest native archive
      // before retiring its execution identity; only proven absence permits fallback.
      try { await history.backfill(value.row.id); }
      catch (error) { if (error.code !== 'NATIVE_HISTORY_MISSING') throw error; nativeArchiveMissing = true; }
    }
  }
  recovery ||= await history.prepareContinuation(value.row.id);
  assert(token, value.app, identity, value.row.id);
  return { ...recovery, historyRecovery: { ...recovery.historyRecovery,
    mode: 'device-account-continuation', nativeArchiveMissing } };
}
module.exports = { grant, assert, bind, tokenOf, guard, prepare, assertSelections, nativeAccessPolicy, matchesLiveSelection };
