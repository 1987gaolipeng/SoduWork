'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { replaceFileSync } = require('./verified-file-replace.cjs');
const contract = require('./model-capability-contract.cjs');
const probe = require('./model-capability-probe.cjs');
let deps, seed = crypto.randomBytes(32).toString('hex'), evidenceWriteError = false;
const active = new Map();

function configure(value) {
  for (const job of active.values()) job.controller.abort();
  active.clear(); deps = value || null; seed = crypto.randomBytes(32).toString('hex'); evidenceWriteError = false;
}
function file() { return path.join(deps.app.getPath('userData'), 'local-model-capabilities.secure.json'); }
function empty() { return { schema: 1, secret: seed, sequence: 0, targets: {} }; }
function validateState(value) {
  const object = item => item && typeof item === 'object' && !Array.isArray(item);
  const checks = rows => object(rows) && Object.entries(rows).every(([key, check]) =>
    contract.CHECKS.includes(key) && object(check) && ['passed', 'unsupported', 'inconclusive', 'failed', 'cancelled', 'skipped'].includes(check.status) &&
    typeof check.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(check.code) && typeof check.checkedAt === 'string' && Number.isFinite(Date.parse(check.checkedAt)));
  if (value.schema !== 1 || !/^[a-f0-9]{64}$/.test(value.secret) || !Number.isSafeInteger(value.sequence) ||
      value.sequence < 0 || !object(value.targets) || Object.keys(value.targets).length > 200) throw Error();
  for (const [ref, row] of Object.entries(value.targets)) {
    if (!/^local:model-[a-f0-9]{32}$/.test(ref) || !object(row) || !/^[a-f0-9]{64}$/.test(row.configRevision) ||
        !Number.isSafeInteger(row.runSequence) || row.runSequence > value.sequence || row.runSequence < 1) throw Error();
    const evidence = row.evidence;
    if (evidence == null) continue;
    if (!object(evidence) || evidence.apiFamily !== contract.API_FAMILY || evidence.configRevision !== row.configRevision || !checks(evidence.checks) ||
        evidence.verifiedChecks !== undefined && !checks(evidence.verifiedChecks) ||
        evidence.compatibility !== undefined && !object(evidence.compatibility)) throw Error();
  }
}
function secure() {
  if (!deps?.safeStorage?.isEncryptionAvailable?.() || process.platform === 'linux' && deps.safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
    throw Object.assign(Error('系统安全存储不可用，无法保存能力检测记录'), { code: 'SAFE_STORAGE_UNAVAILABLE' });
  }
}
function isUnauthenticatedLinuxNativeCipher(bytes, safeStorage) {
  if (safeStorage?.isUnauthenticatedNativeCipher?.(bytes) === true) return true;
  return process.platform === 'linux' && bytes.length >= 3 &&
    (bytes.subarray(0, 3).equals(Buffer.from('v10')) || bytes.subarray(0, 3).equals(Buffer.from('v11')));
}
function read() {
  if (!deps?.app) return empty();
  let encoded;
  try { encoded = fs.readFileSync(file(), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return empty(); throw Error('能力检测记录无法读取'); }
  secure();
  let envelope;
  try {
    envelope = JSON.parse(encoded);
    if (envelope.schema !== 1 || typeof envelope.cipher !== 'string') throw Error();
  } catch { throw Error('能力检测记录无法读取，请重新检测以重建记录'); }
  const cipherBytes = Buffer.from(envelope.cipher, 'base64');
  const unauthenticatedNative = isUnauthenticatedLinuxNativeCipher(cipherBytes, deps.safeStorage);
  let plaintext;
  try {
    plaintext = deps.safeStorage.decryptString(cipherBytes);
  } catch (error) {
    if (error?.code === 'SAFE_STORAGE_UNAVAILABLE') {
      throw Object.assign(Error('系统安全存储不可用，无法读取能力检测记录'), { code: 'SAFE_STORAGE_UNAVAILABLE' });
    }
    if (error?.code === 'SAFE_STORAGE_DECRYPT_FAILED' || unauthenticatedNative) {
      throw Object.assign(Error('能力检测记录无法解密，当前密钥与历史记录不匹配，请恢复匹配的密钥或从备份恢复'), { code: 'SAFE_STORAGE_DECRYPT_FAILED' });
    }
    throw Error('能力检测记录无法读取，请重新检测以重建记录');
  }
  try {
    const value = JSON.parse(plaintext);
    validateState(value);
    seed = value.secret; return value;
  } catch {
    if (unauthenticatedNative) {
      throw Object.assign(Error('能力检测记录无法读取，当前密钥可能不匹配，请恢复匹配的密钥或从备份恢复'), { code: 'SAFE_STORAGE_DECRYPT_FAILED' });
    }
    throw Error('能力检测记录无法读取，请重新检测以重建记录');
  }
}
function write(value) {
  secure(); validateState(value); const target = file(), temp = target + '.' + crypto.randomUUID() + '.tmp';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(temp, JSON.stringify({ schema: 1,
      cipher: deps.safeStorage.encryptString(JSON.stringify(value)).toString('base64') }), { mode: 0o600, flag: 'wx' });
    replaceFileSync(temp, target);
    evidenceWriteError = false;
  } finally { fs.rmSync(temp, { force: true }); }
}
function target(snapshot, model) {
  const provider = snapshot.providers.find(row => row.id === model.providerId);
  if (!provider || provider.authMode !== 'none' && !snapshot.keys[provider.id]) throw Error('本地模型不存在或凭据未配置');
  return { ...model, provider: provider.id, kind: provider.kind, baseUrl: provider.baseUrl,
    authMode: provider.authMode, key: provider.authMode === 'none' ? '' : snapshot.keys[provider.id] };
}
function revision(model, secret, includeEpoch = true) {
  const config = model.config || {}, params = {};
  for (const key of ['thinkingMode', 'thinkingAlwaysOn', 'thinkingFormat', 'supportsReasoningEffort', 'thinkingLevelMap',
    'reasoning', 'maxOutputTokens', 'compatibility']) if (config[key] !== undefined) params[key] = config[key];
  return crypto.createHmac('sha256', secret).update(JSON.stringify(contract.stable({ version: 2,
    ref: model.id, epoch: includeEpoch ? model.capabilityEpoch || '' : undefined,
    provider: model.provider, model: model.name, base: model.baseUrl, kind: model.kind,
    authMode: model.authMode, key: model.key, params, contextWindow: model.ctxWindow || model.advertisedContextWindow || 0 }))).digest('hex');
}
function fields(model, snapshot, state, evidenceError = false) {
  if (model.modality && model.modality !== 'chat') return {};
  state ||= read();
  let configRevision;
  try { configRevision = revision(target(snapshot, model), state.secret); }
  catch { return { ...contract.runtimeFields(model.config), capabilityCheck: null, ...(evidenceError ? { capabilityEvidenceError: true } : {}) }; }
  const record = state.targets[model.id];
  const evidence = record?.configRevision === configRevision ? contract.publicEvidence(record.evidence) : null;
  const runtime = contract.runtimeFields(model.config, evidence);
  return { ...runtime, configRevision, runtimeRevision: contract.runtimeRevision(configRevision, runtime),
    capabilityCheck: evidence || null, ...(evidenceError ? { capabilityEvidenceError: true } : {}) };
}
function enrich(snapshot) {
  let state, error = evidenceWriteError;
  try { state = read(); } catch { state = empty(); error = true; }
  return snapshot.models.map(model => {
    const { capabilityEpoch, ...visible } = model;
    return { ...visible, ...fields(model, snapshot, state, error) };
  });
}
function sameTarget(before, previous, after, next) {
  try { return revision(target(before, previous), 'compare', false) === revision(target(after, next), 'compare', false); }
  catch { return false; }
}
function changed(before, after) {
  const remaining = new Map(after.models.map(model => [model.id, model]));
  // Cancellation depends on the committed model snapshots, never on evidence I/O.
  for (const old of before.models) {
    const next = remaining.get(old.id);
    if (!next || !sameTarget(before, old, after, next) || old.capabilityEpoch !== next.capabilityEpoch) {
      active.get(old.id)?.controller.abort(new DOMException('Configuration changed', 'AbortError'));
    }
  }
  let state;
  try { state = read(); } catch { evidenceWriteError = true; return; }
  let dirty = false;
  for (const old of before.models) {
    const next = remaining.get(old.id);
    let same = false;
    try { same = next && revision(target(before, old), state.secret) === revision(target(after, next), state.secret); } catch { /* Removed credential. */ }
    if (!same) {
      active.get(old.id)?.controller.abort(new DOMException('Configuration changed', 'AbortError'));
      if (state.targets[old.id]) { delete state.targets[old.id]; dirty = true; }
    }
  }
  if (dirty) {
    // The settings snapshot is already committed. Its fingerprint invalidates stale
    // evidence even if evidence cleanup fails, so report that save truthfully.
    try { write(state); } catch { evidenceWriteError = true; }
  }
}
function validate(input) {
  if (!input || Object.keys(input).some(key => !['modelRef', 'checks', 'expectedTargetRevision', 'requestId'].includes(key)) ||
      !/^local:model-[a-f0-9]{32}$/.test(input.modelRef || '') || !Array.isArray(input.checks) || !input.checks.length ||
      input.checks.length > contract.CHECKS.length || input.checks.some(key => !contract.CHECKS.includes(key)) ||
      input.expectedTargetRevision != null && !/^[a-f0-9]{64}$/.test(input.expectedTargetRevision) ||
      input.requestId != null && !/^[A-Za-z0-9_-]{1,100}$/.test(input.requestId)) throw Error('能力检测只接受已保存的模型和有效检测项目');
}
async function check(input, options = {}) {
  validate(input);
  if (!deps?.read) throw Error('本地模型存储不可用');
  const snapshot = deps.read(), model = snapshot.models.find(row => row.id === input.modelRef);
  if (!model || model.modality !== 'chat') throw Error('本地对话模型不存在');
  const selected = target(snapshot, model);
  let state;
  try { state = read(); } catch (error) {
    if (error?.code === 'SAFE_STORAGE_UNAVAILABLE' || error?.code === 'SAFE_STORAGE_DECRYPT_FAILED') throw error;
    // Preserve unreadable encrypted bytes before an explicit recheck rebuilds evidence.
    fs.copyFileSync(file(), file() + '.corrupt-' + crypto.randomUUID() + '.bak'); state = empty();
  }
  const configRevision = revision(selected, state.secret);
  if (input.expectedTargetRevision && input.expectedTargetRevision !== configRevision) throw Error('本地模型配置已变化，请刷新后重新检测');
  const existing = active.get(model.id);
  if (existing) {
    if (existing.controller.signal.aborted) throw Error('上次检测正在取消，请稍后重新检测');
    if (existing.configRevision !== configRevision || JSON.stringify(existing.checks) !== JSON.stringify(input.checks)) throw Error('该模型正在检测，请等待当前检测完成');
    if (input.requestId) existing.requests.add(input.requestId);
    if (options.progress) existing.listeners.add(options.progress);
    return existing.promise;
  }
  if (active.size >= 2) throw Error('已有两个模型正在检测，请稍后重试');
  if (state.sequence >= Number.MAX_SAFE_INTEGER) throw Error('能力检测记录版本已达上限');
  const previous = state.targets[model.id]?.configRevision === configRevision ? state.targets[model.id].evidence : null;
  const runSequence = ++state.sequence;
  state.targets[model.id] = { configRevision, runSequence, evidence: previous };
  write(state);
  const controller = new AbortController(), job = { configRevision, checks: input.checks, controller,
    requests: new Set(input.requestId ? [input.requestId] : []), listeners: new Set(options.progress ? [options.progress] : []) };
  active.set(model.id, job);
  const beforeRuntime = fields(model, snapshot, state).runtimeRevision;
  job.promise = (async () => {
    try {
      let report = await (options.runProbe || probe.run)({ ...selected, compatibility: previous?.compatibility }, input.checks, { ...options,
        signal: controller.signal, progress: value => { for (const listener of job.listeners) { try { listener({ modelRef: model.id, ...value }); } catch { /* View closed. */ } } } });
      if (active.get(model.id) !== job) throw Error('本地模型配置在检测期间已变化，请重新检测');
      const latest = deps.read(), current = latest.models.find(row => row.id === model.id), stored = read();
      if (!current || revision(target(latest, current), stored.secret) !== configRevision ||
          stored.targets[model.id]?.runSequence !== runSequence || controller.signal.reason?.message === 'Configuration changed') {
        throw Error('本地模型配置在检测期间已变化，请重新检测');
      }
      if (controller.signal.aborted) report = { reportVersion: 3, apiFamily: contract.API_FAMILY,
        checkedAt: new Date().toISOString(), compatibility: previous?.compatibility,
        checks: Object.fromEntries(input.checks.map(key => [key, { status: 'cancelled', code: 'cancelled', checkedAt: new Date().toISOString() }])) };
      const evidence = contract.mergeEvidence(stored.targets[model.id].evidence,
        { ...report, configRevision, runSequence, providerId: model.providerId, model: current.name, localOnly: true });
      stored.targets[model.id] = { configRevision, runSequence, evidence }; write(stored);
      const runtime = fields(current, latest, stored);
      return { ...evidence, ...runtime, modelRef: model.id,
        ok: input.checks.every(key => evidence.checks[key]?.status === 'passed'),
        runtimeChanged: beforeRuntime !== runtime.runtimeRevision };
    } finally { if (active.get(model.id) === job) active.delete(model.id); }
  })();
  return job.promise;
}
function cancel(input = {}) {
  const job = active.get(input.modelRef);
  if (!job || !job.requests.has(input.requestId)) return { ok: false };
  job.controller.abort(new DOMException('User cancelled', 'AbortError'));
  return { ok: true };
}
function shutdown() { for (const job of active.values()) job.controller.abort(new DOMException('Application closed', 'AbortError')); }
module.exports = { configure, enrich, changed, check, cancel, shutdown, sameTarget };
