'use strict';
const errors = require('./model-errors');
// This is an explicit continuation, not another dispatch or an automatic retry
// loop. The original messages, attachment context and tool results stay intact.
const PROMPT = '<soduwork-internal-output-continue>\n上一轮因模型服务临时故障中断。请从当前会话中最后一个已确认的工具结果继续完成原请求，不要从头重新执行任务，不要重复已有正文。已成功的写入、发送、提交和发布不得重复；结果不确定的操作先只读核验，无法核验时请向用户确认。\n</soduwork-internal-output-continue>';
const SUMMARY_PROMPT = '仅根据这轮会话中已经完成的工具结果，总结已确认的成果和仍未完成的工作。区分已证实的结果和不确定的事项，不要执行操作。';
function create({ beforeRetry } = {}) {
  let failed = null;
  function remember(item, result) {
    failed = null;
    const snapshot = result && result.snapshot || {};
    const completion = snapshot.completion || {};
    const modelUnavailable = result?.failureKind === 'model-unavailable' &&
      result?.retrySafe === true;
    const retryable = typeof completion.retryable === 'boolean'
      ? completion.retryable : errors.describe(completion.error).retryable;
    const authExpired = completion.authExpired === true || errors.describe(completion.error).authExpired;
    if (!item || item.options.summaryReceipt || item.options.controlled || result && (result.cancelled || result.paused || result.recovering)) return;
    if (completion.reason === 'error' && item.summaryReceipt && !retryable) {
      failed = { item, summaryReceipt: item.summaryReceipt, failedModelName: item.summaryReceipt.modelRef };
      return;
    }
    if (!modelUnavailable && (completion.reason !== 'error' || !retryable)) return;
    failed = { item, goalMode: Boolean(result.modelRecoveryGoal), authExpired, modelUnavailable,
      failedModelName: String(result.failedModelName || item.options.modelName || '') };
  }
  function view() {
    return failed ? { id: failed.item.id, taskId: failed.item.options.taskId || '', available: true,
      ...(failed.summaryReceipt ? { mode: 'text-summary' } : {}),
      requiresModelChange: Boolean(failed.modelUnavailable || failed.summaryReceipt), failedModelName: failed.failedModelName } : null;
  }
  function take(id, admit) {
    if (!failed || id !== failed.item.id) return null;
    const { item, goalMode, authExpired } = failed;
    if (failed.summaryReceipt) {
      const payload = { text: SUMMARY_PROMPT, attachments: [], options: {
        modelRecovery: true, retry: true, summaryReceipt: { ...failed.summaryReceipt,
          request: item.text, messageFrom: item.messageFrom } } };
      if (admit && !admit(payload)) return null;
      failed = null;
      return payload;
    }
    const originalBeforeTurn = item.options.modelRecovery ? item.options.recoveryBeforeTurn : item.options.beforeTurn;
    const payload = { text: PROMPT, attachments: [], options: { ...item.options,
      retry: true, modelRecovery: true, continuing: true, goalMode,
      recoveryBeforeTurn: originalBeforeTurn,
      beforeTurn: async function (...args) {
        await item.options.beforeRetry?.(...args);
        await beforeRetry?.({ authExpired });
        await originalBeforeTurn?.apply(this, args);
      },
    } };
    // Queue rejection or a synchronous admission error must keep recovery available.
    if (admit && !admit(payload)) return null;
    failed = null;
    return payload;
  }
  return { remember, view, take, summarize, clear: () => { failed = null; } };
}
// A single completion has no agent loop, plugin loadout or tool dispatcher.
async function summarize(ctx, item) {
  const receipt = item.options.summaryReceipt;
  const history = ctx.piSession.messages.slice(receipt.messageFrom);
  const end = history.findLastIndex(m => m.role === 'toolResult' && !m.isError && m.toolCallId === receipt.toolId);
  if (end < 0) return { ok: false, reason: '未找到本轮已完成的工具记录' };
  const results = history.slice(0, end + 1).filter(m => m.role === 'toolResult').map(m => ({
    tool: m.toolName, failed: Boolean(m.isError),
    result: m.content.filter(b => b.type === 'text').map(b => b.text).join('\n'),
  }));
  const controller = new AbortController();
  ctx.directModelController = controller;
  ctx.inFlight = true;
  ctx.goalEnabled = false;
  ctx._endGoalTurn();
  ctx.acc.push({ type: 'agent_start' });
  ctx._emit({ kind: 'run' });
  try {
    const ticket = await ctx.refreshModelTicketIfNeeded();
    if (!ticket.ok) throw Object.assign(new Error(ticket.reason), require('../../core/token-quota').fields(ticket));
    if (controller.signal.aborted || ctx.closed || item.stopRequested) return { ok: true, cancelled: true };
    const model = ctx.piSession.model;
    if (!model?.id || ctx.prep.model.modality === 'image' || model.id === receipt.modelRef)
      throw new Error('请先选择其他对话模型，再总结已有结果');
    const evidence = JSON.stringify({ request: receipt.request, results });
    const response = await ctx.runtime.completeSimple(model, {
      systemPrompt: SUMMARY_PROMPT, messages: [{ role: 'user', content: evidence, timestamp: Date.now() }],
    }, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]) });
    if (controller.signal.aborted || ctx.closed || item.stopRequested) return { ok: true, cancelled: true };
    const content = response.content.filter(b => b.type === 'text');
    if (response.stopReason !== 'stop' || response.content.some(b => b.type === 'toolCall') ||
        !content.some(b => b.text.trim()))
      throw new Error(response.errorMessage ? errors.forDisplay(response.errorMessage) : '模型未返回纯文本总结');
    const message = require('../conversation/native-agent-source.cjs').message({
      ...response, content, completedAt: Date.now() }, 'pi');
    const stamp = require('./usage-attribution').create(() => ctx.prep);
    stamp({ type: 'message_start', message });
    stamp({ type: 'message_end', message });
    ctx.piSession.sessionManager.appendMessage(message);
    ctx.piSession.agent.state.messages.push(message);
    ctx.acc.push({ type: 'message_end', message });
    ctx.failedLastTurn = false;
    if (ctx.turnQueue.size()) ctx.turnQueue.pause('已总结已有结果，请确认后继续队列');
    return { ok: true, summaryOnly: true };
  } catch (error) {
    if (controller.signal.aborted || ctx.closed || item.stopRequested) return { ok: true, cancelled: true };
    ctx.failedLastTurn = true;
    const reason = errors.forDisplay(error);
    ctx.acc.push({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: reason } });
    return { ok: false, reason, ...require('../../core/token-quota').fields(error) };
  } finally {
    ctx.acc.push({ type: 'agent_settled' });
    ctx.directModelController = null;
    ctx.inFlight = false;
    ctx._emit({ kind: 'turn-finished' });
  }
}
module.exports = { create, PROMPT };
