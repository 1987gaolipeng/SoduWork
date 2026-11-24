'use strict';

// Only the Runner knows which account home an existing native session uses.
const REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
async function list(adapterId, runtime, ref) {
  if (adapterId !== 'codex') return { ok: true, adapterId, models: [] };
  try {
    const runner = runtime || require('../runner-runtime');
    const reply = await runner.rpc('runtime.models', { key: adapterId, ...(ref ? { ref } : {}) }, 10000);
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
      return { ok: true, adapterId, models, catalogAvailable: available, retryable: reply.data.retryable === true || !available,
        source: reply.data.source === 'codex-native' ? 'codex-native' : 'codex-account-cache',
        reason: models.length ? '' : available ? '该 Agent 暂未提供可切换的模型。' : '本机 Codex 模型目录暂时无法读取，可继续使用默认模型' };
    }
  } catch (_) { /* Older or unavailable runners can still use the native default. */ }
  return { ok: false, adapterId, models: [], catalogAvailable: false, retryable: true, reason: '本机 Codex 模型目录暂时无法读取，可继续使用默认模型' };
}
module.exports = { list, REASONING_EFFORTS };
