/* Keep a model response complete without turning one truncated turn into an
   unbounded agent loop. Pi reports `stopReason: "length"` when the provider
   reaches its output-token ceiling; that is not a successful completion. */
const contextRecovery = require('./context-recovery');
const MARKER = '<soduwork-internal-output-continue>';
const protocolGuard = require('../agent-runtime/protocol-guard');
const handoff = require('./action-handoff');
const MAX_CONTINUATIONS = 2;

/*
 * Some providers report stop after an unfinished action handoff. Continue only narrow
 * tool-backed tails or explicit execution requests that ended before their first tool;
 * advisory answers must not start an autonomous loop.
 */
const ACTION_TAIL = /(?:让我|我(?:现在|接下来|这就|先|再)|接下来|下一步|随后|现在|继续|重新|修正|修改|检查|查看|查询|验证|执行|运行|刷新|打开|确认|处理|完成|补充|测试|排查|定位|写入|更新|结果|步骤|如下|包括)[^。！？.!?\n]{0,140}(?:查看|检查|查询|验证|修正|修改|重试|执行|运行|刷新|打开|确认|处理|完成|补充|测试|排查|定位|写入|更新|截图|加载|继续)?\s*(?:一下)?[：:]\s*$/;
const ENGLISH_ACTION_TAIL = /(?:let me|i(?:'ll| will)|next|now)[^.!?\n]{0,140}(?:check|inspect|query|verify|fix|retry|run|refresh|open|confirm|finish|continue)\s*:?\s*$/i;
const ACTION_PROMISE_TAIL = /(?:让我|让me|我(?:将|会|要|准备|接下来|这就|马上|先|再)|接下来(?:我)?(?:将|会|要)?|下一步(?:我)?(?:将|会|要)?|随后(?:我)?(?:将|会|要)?|现在(?:我)?(?:将|会|要)|继续(?:去|来)?)[^。！？.!?\n]{0,180}(?:查看|检查|查询|验证|修正|修改|重试|执行|运行|刷新|打开|确认|处理|补充|测试|排查|定位|写入|更新|截图|加载|继续|发出|抓取|读取|尝试)[^。！？.!?\n]{0,60}(?:[。.!]|…{1,2}|\.{2,})\s*$/i;
const ENGLISH_ACTION_PROMISE_TAIL = /(?:let me|i(?:'ll| will| am going to)|next i(?:'ll| will)|i(?:'m| am) going to)[^.!?\n]{0,180}(?:check|inspect|query|verify|fix|retry|run|refresh|open|confirm|finish|continue|read|write|capture|try)[^.!?\n]{0,60}[.!]\s*$/i;

function lastAssistantText(accumulator, messageFrom) {
  const messages = accumulator && accumulator.state && accumulator.state.messages;
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= Math.max(0, Number(messageFrom) || 0); i -= 1) {
    const item = messages[i];
    if (!item || item.role !== 'assistant') continue;
    return (Array.isArray(item.blocks) ? item.blocks : [])
      .filter((block) => block && block.kind === 'text')
      .map((block) => String(block.text || ''))
      .join('\n')
      .trim();
  }
  return '';
}

function hasUnansweredThinking(accumulator, messageFrom) {
  const state = accumulator?.state;
  if (state?.lastStopReason !== 'stop') return false;
  const messages = state.messages || [];
  for (let i = messages.length - 1; i >= messageFrom; i--) {
    if (messages[i]?.role !== 'assistant') continue;
    const blocks = messages[i].blocks || [];
    return blocks.some(block => block.kind === 'thinking' && String(block.text || '').trim()) &&
      !blocks.some(block => block.kind === 'text' && String(block.text || '').trim());
  }
  return false;
}

function looksSemanticallyIncomplete(accumulator, messageFrom, toolFrom, userPrompt) {
  const state = accumulator && accumulator.state;
  if (!state || state.lastStopReason !== 'stop') return false;
  if (handoff.consultation(userPrompt)) return false;
  const tools = Array.isArray(state.tools) ? state.tools : [];
  if (tools.slice(Math.max(0, Number(toolFrom) || 0)).some(tool =>
    tool.isError && /^Access denied by user or policy\./.test(String(tool.result || '')))) return false;
  const hasNewTools = tools.length > Math.max(0, Number(toolFrom) || 0);
  const text = lastAssistantText(accumulator, messageFrom);
  if (!text || !handoff.safeProse(text)) return false;
  if (!hasNewTools) {
    return text.length <= 700 && handoff.requestedExecution(userPrompt, toolFrom > 0) &&
      handoff.promisedAction(text);
  }
  const tail = text.slice(-420).trim();
  return ACTION_TAIL.test(tail) || ENGLISH_ACTION_TAIL.test(tail) ||
    ACTION_PROMISE_TAIL.test(tail) || ENGLISH_ACTION_PROMISE_TAIL.test(tail) ||
    handoff.promisedAction(tail);
}


function _normalizedText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '').slice(0, 12000);
}

/* A length continuation must not become a second autonomous loop. Treat a
   repeated action narration with no new tool event as a terminal incomplete
   turn and leave retry to an explicit user action. */
function thinkingBudgetExhausted(accumulator, messageFrom) {
  const state = accumulator?.state;
  if (state?.lastStopReason !== 'length') return false;
  for (let i = (state.messages || []).length - 1; i >= Math.max(0, Number(messageFrom) || 0); i--) {
    const message = state.messages[i];
    if (message?.role !== 'assistant') continue;
    const blocks = message.blocks || [];
    return blocks.some(block => block.kind === 'thinking' && String(block.text || '').trim()) &&
      !blocks.some(block => ['text', 'toolcall'].includes(block.kind) &&
        (String(block.text || '').trim() || block.toolCall));
  }
  return false;
}

function looksLikeOutputLoop(accumulator, messageFrom, toolFrom, previousText) {
  const state = accumulator && accumulator.state;
  if (!state) return false;
  if (state.protocolIssue && state.protocolIssue.code === protocolGuard.DEGENERATE_OUTPUT_CODE) {
    return true;
  }
  const tools = Array.isArray(state.tools) ? state.tools : [];
  if (tools.length > Math.max(0, Number(toolFrom) || 0)) return false;
  /* A length stop with a thinking-only assistant turn is a stalled planning
     turn, not a truncated answer. Re-prompting it asks the model to continue
     planning again and again, which leaves the composer showing an endless
     processing state without ever reaching a tool or a user-facing answer.
     End this turn as incomplete so the user can retry explicitly. */
  if (state.lastStopReason === 'length') {
    const messages = Array.isArray(state.messages) ? state.messages : [];
    for (let i = messages.length - 1; i >= Math.max(0, Number(messageFrom) || 0); i -= 1) {
      const message = messages[i];
      if (!message || message.role !== 'assistant') continue;
      const blocks = Array.isArray(message.blocks) ? message.blocks : [];
      const hasThinking = blocks.some(block => block?.kind === 'thinking' && String(block.text || '').trim());
      const hasAnswer = blocks.some(block => block?.kind === 'text' && String(block.text || '').trim());
      const hasToolCall = blocks.some(block => block?.kind === 'toolcall' &&
        (String(block.text || '').trim() || block.toolCall));
      if (hasThinking && !hasAnswer && !hasToolCall) return true;
      break;
    }
  }
  const text = lastAssistantText(accumulator, messageFrom);
  if (!text) return false;
  const inspected = protocolGuard.inspect(text, { final: true });
  if (inspected && inspected.code === protocolGuard.DEGENERATE_OUTPUT_CODE) return true;
  return Boolean(previousText && text.length > 20 &&
    _normalizedText(previousText) === _normalizedText(text));
}
function continuationPrompt(attempt, reason) {
  const semantic = reason === 'semantic';
  return [
    MARKER,
    reason === 'missing-answer'
      ? '上一轮只返回了思考内容，尚未提供最终答复。请继续给出原请求的最终答复，不要复述思考过程，也不要把思考或计划称作已完成的结果。'
      : semantic
      ? '上一条回复在声明下一步动作后提前结束。请立即执行刚才承诺的动作，不要再次复述计划，也不要等待用户发送“继续”。'
      : '上一条回复因为单轮输出长度上限被截断。请从中断处自然接着完成，不要重复已经说过的内容。',
    '继续完成原请求；保持原有语言、结构和精度。不要解释这条内部指令，也不要说“继续”。完成动作后给出真实结果。',
    '只执行原请求和当前权限允许的操作，不重做已经完成的操作。若工具不可用、操作被拒绝或缺少必要信息，请明确说明阻碍并停止，不要再次许诺立即执行。',
    '这是第 ' + Math.max(1, Number(attempt) || 1) + ' 次自动续写。',
    '</soduwork-internal-output-continue>',
  ].join('\n');
}

function isContinuationPrompt(value) {
  return String(value || '').includes(MARKER);
}

async function complete(session, accumulator, initialPrompt, initialOptions, hooks) {
  const cfg = hooks || {};
  const max = Number.isFinite(Number(cfg.maxContinuations))
    ? Math.max(0, Math.min(4, Number(cfg.maxContinuations))) : MAX_CONTINUATIONS;
  const stopped = () => Boolean(accumulator?.state?.aborted || accumulator?.state?.pendingUi ||
    (typeof cfg.shouldStop === 'function' && cfg.shouldStop()));
  const messageFrom = accumulator && accumulator.state && Array.isArray(accumulator.state.messages)
    ? accumulator.state.messages.length : 0;
  const toolFrom = accumulator && accumulator.state && Array.isArray(accumulator.state.tools)
    ? accumulator.state.tools.length : 0;
  const reason = () => {
    if (accumulator.state.lastStopReason === 'length') {
      return contextRecovery.silentOverflow(accumulator, session) ? 'context-full' : 'length';
    }
    if (hasUnansweredThinking(accumulator, messageFrom)) return 'missing-answer';
    if (looksSemanticallyIncomplete(accumulator, messageFrom, toolFrom, cfg.userPrompt ?? initialPrompt)) return 'semantic';
    return '';
  };
  await contextRecovery.prompt(session, accumulator, initialPrompt, initialOptions, cfg);
  let continuations = 0;
  let why = reason();
  let loopDetected = looksLikeOutputLoop(accumulator, messageFrom, toolFrom, '');
  while (!stopped() && why && why !== 'context-full' && !loopDetected && continuations < max) {
    continuations += 1;
    if (typeof cfg.onContinue === 'function') cfg.onContinue(continuations, max);
    const turnToolFrom = accumulator && accumulator.state && Array.isArray(accumulator.state.tools)
      ? accumulator.state.tools.length : 0;
    const previousText = lastAssistantText(accumulator, messageFrom);
    const previousWhy = why;
    if (stopped()) break;
    await contextRecovery.prompt(session, accumulator, continuationPrompt(continuations, why), { images: [] }, cfg);
    loopDetected = looksLikeOutputLoop(accumulator, messageFrom, turnToolFrom, previousText);
    why = reason();
    // A second promise with no actual tool progress is enough. Rephrasing
    // "I'll do it now" must not earn another autonomous retry.
    if (['semantic', 'missing-answer'].includes(previousWhy) && ['semantic', 'missing-answer'].includes(why) &&
        accumulator.state.tools.length <= turnToolFrom) loopDetected = true;
  }
  const incomplete = Boolean(why || loopDetected);
  const incompleteReason = loopDetected
    ? (thinkingBudgetExhausted(accumulator, messageFrom) ? 'reasoning-limit' : 'output-loop')
    : why === 'semantic' ? 'action-handoff'
    : why === 'missing-answer' ? 'missing-answer' : why === 'context-full' ? 'context-full' : '';
  if (!stopped()) {
    if (loopDetected && typeof cfg.onLoop === 'function') cfg.onLoop(continuations, incompleteReason);
    else if (incomplete && typeof cfg.onIncomplete === 'function') cfg.onIncomplete(continuations, max, incompleteReason);
  }
  return { continuations, incomplete, ...(incompleteReason ? { incompleteReason } : {}) };
}

function bind(session, accumulator, shouldStop, emit) {
  return (prompt, options) => complete(session, accumulator, prompt, options, {
    shouldStop,
    onContext: () => { if (typeof emit === 'function') emit({ kind: 'compaction' }); },
    onContinue: (attempt, max) => {
      if (typeof emit === 'function') emit({ kind: 'output-continuing', attempt, max });
    },
    onIncomplete: (attempts, max) => {
      if (typeof emit === 'function') emit({ kind: 'output-incomplete', attempts, max });
    },
    onLoop: (attempt) => {
      if (typeof emit === 'function') emit({ kind: 'output-loop-stopped', attempt });
    },
  });
}

module.exports = {
  MARKER, MAX_CONTINUATIONS, continuationPrompt, isContinuationPrompt,
  looksSemanticallyIncomplete, looksLikeOutputLoop, complete, bind,
};
