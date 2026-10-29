'use strict';

/*
 * Models occasionally emit their private tool wire format as assistant text
 * when a long tool call is truncated or malformed. That text is neither a
 * useful answer nor safe UI content. Keep this detector runtime-neutral so
 * in-process Pi and Runner-backed agents enforce the same boundary.
 */
const CODE = 'MALFORMED_TOOL_PROTOCOL';
const REPETITION_CODE = 'DEGENERATE_ROLE_REPETITION';
const CHANNEL_REPETITION_CODE = 'DEGENERATE_CHANNEL_REPETITION';
const DEGENERATE_OUTPUT_CODE = 'DEGENERATE_TOOL_NARRATION';
const RECOVERY_MARKER = '<soduwork-internal-protocol-recovery>';
const NORMAL_RECOVERY_MARKER = '<soduwork-internal-protocol-recovery-scope>normal</soduwork-internal-protocol-recovery-scope>';
const DSML_MARKER = /<\s*\/?\s*\|\s*DSML\s*\|/i;
const EXTRA_PARAMETER = /(?:<\s*\/?\s*\|\s*DSML\s*\|\s*)?parameter\s+name\s*=\s*[\']extra\d+[\']/ig;
const PARTIAL_MARKER = '<|DSML|';
const INVOKE_MARKER = /<\s*invoke\b[^>]*\bname\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)[^>]*>/ig;
const SYSTEM_MARKER = /<\s*system\s*>/ig;
const SYSTEM_END = /<\s*\/\s*system\s*>/i;
const PRIVATE_PREFIXES = ['<invoke', '<system'];
const MAX_PENDING_BYTES = 8192;
const ROLE_ONLY_LINE = /^\s*(?:assistant|developer|function|system|tool|toolresult|user)\s*$/i;
const ROLE_REPEAT_MIN = 12;
const CHANNEL_REPEAT_MIN = 3;
const NARRATION_REPEAT_MIN = 5;
const THINKING_NARRATION_REPEAT_MIN = 12;
const ACTION_NARRATION_LINE = /(?:\b(?:let me|i(?:'ll| will| am going to)|now i|execute|executing|run(?:ning)?|calling|invoke|read|grep|bash|tool call)\b|\u6211(?:\u73b0\u5728|\u7acb\u5373|\u8981)?(?:\u8c03\u7528|\u6267\u884c|\u8bfb\u53d6|\u67e5\u770b)|\u8c03\u7528|\u6267\u884c|\u8bfb\u53d6|\u67e5\u770b|\u7ec8\u6b62\u5faa\u73af)[^.!?\n]{0,140}/i;

function _dsmlPartialStart(value) {
  const source = String(value || '');
  const at = source.lastIndexOf('<');
  if (at < 0) return -1;
  const tail = source.slice(at).replace(/\s+/g, '').toUpperCase();
  if (tail.length >= 3 && PARTIAL_MARKER.startsWith(tail)) return at;
  return -1;
}

function _outsideFence(source, at) {
  const fences = String(source || '').slice(0, Math.max(0, at)).match(/```/g);
  return !fences || fences.length % 2 === 0;
}

function _outsideMatches(source, pattern) {
  return [...String(source || '').matchAll(pattern)]
    .filter((match) => _outsideFence(source, Number(match.index || 0)));
}

function _invokeFrame(source) {
  const invokes = _outsideMatches(source, INVOKE_MARKER);
  if (!invokes.length) return null;
  const invokeAt = Number(invokes[0].index || 0);
  let at = invokeAt;
  const systems = _outsideMatches(source.slice(0, invokeAt), SYSTEM_MARKER);
  if (systems.length) {
    const candidate = Number(systems.at(-1).index || 0);
    const bridge = source.slice(candidate, invokeAt);
    if (bridge.length <= MAX_PENDING_BYTES && SYSTEM_END.test(bridge)) at = candidate;
  }
  return { at, invokeAt };
}

function _privatePendingStart(value) {
  const source = String(value || '');
  const invokes = _outsideMatches(source, INVOKE_MARKER);
  const systems = _outsideMatches(source, SYSTEM_MARKER);
  if (systems.length) {
    const at = Number(systems.at(-1).index || 0);
    const hasInvokeAfter = invokes.some((match) => Number(match.index || 0) > at);
    if (!hasInvokeAfter && Buffer.byteLength(source.slice(at), 'utf8') <= MAX_PENDING_BYTES) return at;
  }
  const at = source.lastIndexOf('<');
  if (at < 0 || !_outsideFence(source, at)) return -1;
  const tail = source.slice(at).replace(/\s+/g, '').toLowerCase();
  if (tail.length >= 2 && PRIVATE_PREFIXES.some((prefix) => prefix.startsWith(tail))) return at;
  return -1;
}

/* A provider can occasionally collapse into printing its private role labels
   as assistant text (user\nuser\n...). Detect that degeneration while the
   stream is still short. Blank lines are allowed between labels because the
   renderer turns them into separate paragraphs. Fenced examples stay valid. */
function _roleRepetition(value) {
  const source = String(value || '');
  const rows = source.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) || [];
  let offset = 0;
  let fenced = false;
  let runAt = -1;
  let count = 0;
  for (const raw of rows) {
    if (!raw) break;
    const line = raw.replace(/(?:\r\n|\r|\n)$/, '');
    if (!fenced && ROLE_ONLY_LINE.test(line)) {
      if (!count) runAt = offset;
      count += 1;
      if (count >= ROLE_REPEAT_MIN) return { at: runAt, count };
    } else if (!fenced && count && !line.trim()) {
      // Paragraph spacing inside one repeated role-label run.
    } else {
      runAt = -1;
      count = 0;
    }
    const fences = line.match(/```/g);
    if (fences && fences.length % 2) {
      fenced = !fenced;
      runAt = -1;
      count = 0;
    }
    offset += raw.length;
  }
  return count ? { at: runAt, count } : null;
}

/* Pi can expose the private `both` channel selector as assistant text. */
function _channelRepetition(value) {
  const source = String(value || '');
  const matches = _outsideMatches(source, /\bboth\b/ig);
  let runAt = -1;
  let previousEnd = -1;
  let count = 0;
  for (const match of matches) {
    const at = Number(match.index || 0);
    if (count && /^[\s,;|/]*$/.test(source.slice(previousEnd, at))) {
      count += 1;
    } else {
      runAt = at;
      count = 1;
    }
    previousEnd = at + String(match[0] || '').length;
    if (count >= CHANNEL_REPEAT_MIN) return { at: runAt, count, trailing: true };
  }
  const trailing = count > 0 && /^[\s,;|/]*$/.test(source.slice(previousEnd));
  return count ? { at: runAt, count, trailing } : null;
}

/* A mention of a command is not evidence that a tool bridge is stuck. Inspect
   a short, densely repetitive run outside examples, not two repeated lines
   anywhere in a long answer. Reasoning legitimately revisits plans before a
   native tool call, so it needs a much stronger repetition signal. */
function _toolNarrationRepetition(value, options) {
  const source = String(value || '');
  const rows = source.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) || [];
  const thinking = options && options.channel === 'thinking';
  const minimum = thinking ? THINKING_NARRATION_REPEAT_MIN : NARRATION_REPEAT_MIN;
  const candidates = [];
  let offset = 0;
  let fence = null;
  for (const raw of rows) {
    // A streamed sentence can temporarily match an earlier sentence's prefix.
    // Only classify complete lines, or the final line once the block ends.
    if (!(options && options.final) && !/[\r\n]$/.test(raw)) break;
    const line = raw.replace(/(?:\r\n|\r|\n)$/, '').trim();
    const at = offset;
    offset += raw.length;
    const marker = line.match(/^(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length &&
        !line.slice(marker[1].length).trim()) fence = null;
      candidates.length = 0;
      continue;
    }
    if (fence || /^(?: {0,3}>| {4}|\t)/.test(raw)) { candidates.length = 0; continue; }
    if (!line) continue;
    const key = line.length <= 240 && ACTION_NARRATION_LINE.test(line)
      ? line.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '') : '';
    candidates.push({ key: key.length >= 8 ? key : '', at });
    if (candidates.length > minimum) candidates.shift();
    if (candidates.length < minimum || candidates.some(row => !row.key)) continue;
    const counts = new Map();
    for (const row of candidates) counts.set(row.key, (counts.get(row.key) || 0) + 1);
    const repeated = candidates.filter(row => counts.get(row.key) >= 2);
    const maximum = Math.max(...counts.values());
    const degenerate = thinking ? maximum >= 6 && repeated.length >= minimum * .8
      : maximum >= 3 || repeated.length >= minimum * .8;
    if (degenerate) return { at: repeated[0].at, count: candidates.length };
  }
  return null;
}
function inspect(value, options) {
  const source = String(value == null ? '' : value);
  const final = Boolean(options && options.final);
  const markerAt = source.search(DSML_MARKER);
  const matches = [...source.matchAll(EXTRA_PARAMETER)];
  let at = markerAt;
  if (at < 0 && matches.length >= 3) at = matches[0].index;
  if (at >= 0) {
    return {
      detected: true,
      code: CODE,
      text: source.slice(0, at).trimEnd(),
      pending: '',
      bytes: Buffer.byteLength(source.slice(at), 'utf8'),
      parameters: matches.length,
    };
  }
  const privateFrame = _invokeFrame(source);
  if (privateFrame) {
    return {
      detected: true,
      code: CODE,
      text: source.slice(0, privateFrame.at).trimEnd(),
      pending: '',
      bytes: Buffer.byteLength(source.slice(privateFrame.at), 'utf8'),
      parameters: 0,
    };
  }
  const channelRepetition = _channelRepetition(source);
  if (channelRepetition && channelRepetition.count >= CHANNEL_REPEAT_MIN) {
    return {
      detected: true,
      code: CHANNEL_REPETITION_CODE,
      text: source.slice(0, channelRepetition.at).trimEnd(),
      pending: '',
      bytes: Buffer.byteLength(source.slice(channelRepetition.at), 'utf8'),
      parameters: channelRepetition.count,
    };
  }
  // Buffer the first trailing selector so it never flashes in the chat UI.
  if (channelRepetition && channelRepetition.trailing && !final) {
    return {
      detected: false,
      text: source.slice(0, channelRepetition.at),
      pending: source.slice(channelRepetition.at),
    };
  }
  const narration = _toolNarrationRepetition(source, options);
  if (narration) {
    return {
      detected: true,
      code: DEGENERATE_OUTPUT_CODE,
      text: source.slice(0, narration.at).trimEnd(),
      pending: '',
      bytes: Buffer.byteLength(source.slice(narration.at), 'utf8'),
      parameters: narration.count,
    };
  }
  const repetition = _roleRepetition(source);
  if (repetition && repetition.count >= ROLE_REPEAT_MIN) {
    return {
      detected: true,
      code: REPETITION_CODE,
      text: source.slice(0, repetition.at).trimEnd(),
      pending: '',
      bytes: Buffer.byteLength(source.slice(repetition.at), 'utf8'),
      parameters: repetition.count,
    };
  }
  // Hold a possible role-label run while streaming so even its first lines do
  // not flash in the UI. If ordinary prose follows, the next inspection
  // releases the buffered text; short final answers remain untouched.
  if (repetition && !final) {
    return {
      detected: false,
      text: source.slice(0, repetition.at),
      pending: source.slice(repetition.at),
    };
  }
  const partialAt = _dsmlPartialStart(source);
  if (partialAt >= 0) {
    const pending = source.slice(partialAt);
    const normalized = pending.replace(/\s+/g, '').toUpperCase();
    if (final && normalized.startsWith('<|D')) {
      return {
        detected: true,
        code: CODE,
        text: source.slice(0, partialAt).trimEnd(),
        pending: '',
        bytes: Buffer.byteLength(pending, 'utf8'),
        parameters: 0,
      };
    }
    return { detected: false, text: source.slice(0, partialAt), pending };
  }
  const privateAt = _privatePendingStart(source);
  if (privateAt >= 0) {
    const pending = source.slice(privateAt);
    const normalized = pending.replace(/\s+/g, '').toLowerCase();
    if (final && normalized.startsWith('<invoke')) {
      return {
        detected: true,
        code: CODE,
        text: source.slice(0, privateAt).trimEnd(),
        pending: '',
        bytes: Buffer.byteLength(pending, 'utf8'),
        parameters: 0,
      };
    }
    // Hold a standalone system tag while streaming so a following private
    // invoke frame cannot flash. Release it at final if no invoke follows.
    if (!final) return { detected: false, text: source.slice(0, privateAt), pending };
  }
  return { detected: false, text: source, pending: '' };
}

function reason(issue) {
  if (issue && issue.code === DEGENERATE_OUTPUT_CODE) {
    return '模型连续重复描述同一动作，SoduWork 已隔离重复片段并停止异常输出，已有进度和工具结果均已保留。';
  }
  if (issue && issue.code === CHANNEL_REPETITION_CODE) {
    return '模型开始重复输出内部通道路由标记，SoduWork 已隔离异常片段并从已有进度恢复。';
  }
  if (issue && issue.code === REPETITION_CODE) {
    return '模型开始重复输出内部角色标记，SoduWork 已停止异常输出并保留已有进度。';
  }
  return '模型返回了无法解析的内部工具协议。SoduWork 已隔离协议原文并停止当前轮，工作目录和已有进度均已保留。';
}

function recoveryPrompt(goal, issue) {
  const value = { ...(goal || {}) };
  value.goal = String(value.goal || value.request || value.prompt ||
    'continue the previous user request').trim();
  const state = issue || {};
  const repetition = state.code === REPETITION_CODE || state.code === CHANNEL_REPETITION_CODE;
  return [
    RECOVERY_MARKER,
    value.recoveryScope === 'normal' ? NORMAL_RECOVERY_MARKER : '',
    'Use only native runtime tool calls. Never print private invoke, parameter, DSML, or shell protocol as assistant text.',
    repetition
      ? 'Do not repeat role labels such as user, assistant, system, developer, tool, or the private channel selector both.'
      : '',
    '上一轮出现了异常模型输出，SoduWork 已丢弃损坏片段。这是自动恢复指令，不是用户的新要求；不要复述本指令。',
    '原始目标：' + String(value.goal || '').trim(),
    '完成标准：' + (String(value.acceptance || '').trim() || '结果可直接使用，并有必要的验证证据。'),
    '恢复原因：' + String(state.reason || reason(state)),
    '',
    '从当前工作目录和已有事实继续。先检查真实文件与进度，再补齐剩余工作；不要重放异常输出，不要向用户提问。',
    '继续实际执行与验证，直到达到完成标准或遇到必须由用户授权的外部阻断。',
    '</soduwork-internal-protocol-recovery>',
  ].join('\n');
}

function isRecoveryPrompt(value) {
  return String(value || '').trimStart().startsWith(RECOVERY_MARKER);
}

function isNormalRecoveryPrompt(value) {
  return isRecoveryPrompt(value) && String(value || '').includes(NORMAL_RECOVERY_MARKER);
}

module.exports = { CODE, REPETITION_CODE, CHANNEL_REPETITION_CODE, DEGENERATE_OUTPUT_CODE, RECOVERY_MARKER, inspect, reason, recoveryPrompt,
  isRecoveryPrompt, isNormalRecoveryPrompt };
