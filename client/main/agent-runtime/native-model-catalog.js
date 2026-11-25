'use strict';

// Only the Runner knows which account home an existing native session uses.
const REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
async function list(adapterId, runtime, ref, ensureCompatible = false) {
  if (adapterId !== 'codex') return { ok: true, adapterId, models: [] };
  try {
    const runner = runtime || require('../runner-runtime');
    const reply = await runner.rpc('runtime.models', { key: adapterId, ...(ref ? { ref } : {}),
      ...(ensureCompatible ? { ensureCompatible: true } : {}) }, 10000);
    if (reply?.ok && reply.data?.ok && Array.isArray(reply.data.models)) {
      const models = reply.data.models.filter(row => typeof row?.id === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(row.id) && !row.hidden && row.visibility !== 'hide')
        .map(row => ({
          id: row.id, label: String(row.label || row.id).slice(0, 120),
          reasoningLevels: [...new Set((Array.isArray(row.reasoningLevels) ? row.reasoningLevels : [])
            .filter(level => REASONING_EFFORTS.has(level)))],
          defaultReasoning: REASONING_EFFORTS.has(row.defaultReasoning) ? row.defaultReasoning : '',
        }));
      const available = reply.data.catalogAvailable === true;
      const upgradeState = reply.data.upgradeState;
      const upgradeReason = {
        'update-required': 'Codex CLI 版本过低，请到 Agent 管理更新。',
        updating: 'Codex CLI 版本过低，正在自动更新。更新完成后将重新加载模型。',
        'update-failed': 'Codex CLI 更新后仍无法读取模型目录，请到 Agent 管理检查并重试。',
      }[upgradeState];
      return { ok: true, adapterId, models, catalogAvailable: available, retryable: reply.data.retryable === true || !available,
        ...(upgradeReason ? { upgradeState, cliVersion: reply.data.cliVersion } : {}),
        source: reply.data.source === 'codex-native' ? 'codex-native' : 'codex-account-cache',
        reason: models.length ? '' : upgradeReason || (available ? '该 Agent 暂未提供可切换的模型。' : '本机 Codex 模型目录暂时无法读取，请刷新重试。') };
    }
  } catch (_) { /* A disconnected Runner has no authoritative catalog. */ }
  return { ok: false, adapterId, models: [], catalogAvailable: false, retryable: true, reason: '本机 Codex 模型目录暂时无法读取，请刷新重试。' };
}
module.exports = { list, REASONING_EFFORTS };
