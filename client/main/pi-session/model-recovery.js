'use strict';
const errors = require('./model-errors');
// This is an explicit continuation, not another dispatch or an automatic retry
// loop. The original messages, attachment context and tool results stay intact.
const PROMPT = '<soduwork-internal-output-continue>\n上一轮因模型服务临时故障中断。请从当前会话中最后一个已确认的工具结果继续完成原请求，不要从头重新执行任务，不要重复已有正文。已成功的写入、发送、提交和发布不得重复；结果不确定的操作先只读核验，无法核验时请向用户确认。\n</soduwork-internal-output-continue>';
function create() {
  let failed = null;
  function remember(item, result) {
    failed = null;
    const snapshot = result && result.snapshot || {};
    const completion = snapshot.completion || {};
    const retryable = typeof completion.retryable === 'boolean'
      ? completion.retryable : errors.describe(completion.error).retryable;
    if (!item || item.options.controlled || result && (result.cancelled || result.paused || result.recovering) ||
        completion.reason !== 'error' || !retryable) return;
    failed = { item, goalMode: Boolean(result.modelRecoveryGoal) };
  }
  function view() { return failed ? { id: failed.item.id, taskId: failed.item.options.taskId || '', available: true } : null; }
  function take(id) {
    if (!failed || id !== failed.item.id) return null;
    const { item, goalMode } = failed; failed = null;
    const originalBeforeTurn = item.options.modelRecovery ? item.options.recoveryBeforeTurn : item.options.beforeTurn;
    return { text: PROMPT, attachments: [], options: { ...item.options,
      retry: true, modelRecovery: true, continuing: true, goalMode,
      recoveryBeforeTurn: originalBeforeTurn,
      beforeTurn: async () => { await item.options.beforeRetry?.(); await originalBeforeTurn?.(); },
    } };
  }
  return { remember, view, take, clear: () => { failed = null; } };
}
module.exports = { create, PROMPT };
