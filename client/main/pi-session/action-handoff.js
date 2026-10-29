'use strict';

// This is a completion check, never permission to execute an operation. A
// recovered turn still uses the original tools, policy and approval broker.
const ACTION = '(?:补检索|检索|搜索|查看|检查|查询|验证|修正|修改|重试|执行|运行|刷新|打开|确认|处理|完善|补充|测试|排查|定位|写入|更新|截图|读取|抓取|继续)';
const PROMISE = new RegExp('(?:^|[。！？.!?\\n])\\s*(?:(?:好的|好|抱歉)[，,：:]\\s*)?' +
  '(?:让我|我(?:来|将|会|要|准备|现在|接下来|这就|马上|先|再)|现在(?:我)?(?:立即|立刻|直接|马上|就)?|' +
  '马上(?:开始)?|立刻|立即|接下来|下一步|随后|先|再|继续|补检索)' +
  '[^。！？.!?\\n]{0,180}' + ACTION + '[^。！？.!?\\n]{0,80}[。.!：:…]*\\s*$');
const ENGLISH_PROMISE = /(?:^|[.!?\n])\s*(?:let me|i(?:'ll| will| am going to)|next i(?:'ll| will)|now i(?:'ll| will))[^.!?\n]{0,180}\b(?:check|inspect|search|query|verify|fix|retry|run|refresh|open|confirm|finish|continue|read|write|capture|try)\b[^.!?\n]{0,80}[.!:]*\s*$/i;
const SEARCH_HANDOFF = /(?:^|[。！？.!?\n])\s*(?:补检索|重新检索)[^。！？.!?\n]{0,120}[：:]\s*$/;
const CONSULTATION = /(?:只(?:需|要)?(?:说明|解释|分析|建议|回答|讨论)|不要(?:执行|操作|修改|运行)|先(?:别|不要)(?:执行|操作|修改|运行)|如何|怎么(?:做|操作|实现)|解释(?:一下)?|什么意思|翻译|举例|示例|(?:advice|explanation|example) only|do not (?:execute|run|change)|don'?t (?:execute|run|change)|\b(?:how (?:do|can|to)|explain|translate|summari[sz]e)\b)/i;
const BLOCKED = /(?:等待(?:用户|你|您|审批|授权|确认)|(?:需要|请先|请)(?:你|您)?(?:提供|补充|确认|批准|授权)|(?:尚未|未获|没有)(?:授权|权限)|(?:不能|无法|不可)(?:执行|运行|继续|访问)|(?:缺少|缺乏|缺失)(?:信息|参数|权限|工具)|(?:如果|假如|除非|待你|待您)|\b(?:if you|once you|after you|waiting for|need (?:your|approval|permission)|please (?:provide|confirm|approve)|cannot (?:run|execute|continue)|can'?t (?:run|execute|continue))\b)/i;

function visiblePrompt(value) {
  let text = String(value || '');
  // Ignore generated resource instructions and attachment contents when
  // determining what the user actually requested.
  text = text.replace(/<soduwork-(input-attachments|conversation-plugins|vision-observation)>[\s\S]*?<\/soduwork-\1>/g, '');
  if (text.trimStart().startsWith('<soduwork-normal-followup>')) {
    text = text.match(/<soduwork-user-message>\r?\n([\s\S]*?)\r?\n<\/soduwork-user-message>/)?.[1] || '';
  }
  return text.trim();
}

function safeProse(value) {
  const text = String(value || '').trim();
  // Quoted examples, code and questions are not executable promises. Keep
  // uncertainty conservative rather than continuing advice or a request for input.
  return Boolean(text && !/```|~~~|`|[“”「」『』"]|^\s*(?:>|[-*+] |\d+[.)] )/m.test(text) &&
    !/[?？]/.test(text) && !BLOCKED.test(text));
}

function requestedExecution(value, hasHistoryTools) {
  const text = visiblePrompt(value);
  if (!safeProse(text) || CONSULTATION.test(text)) return false;
  if (/^(?:继续(?:吧|执行|完成)?|接着(?:做|执行)?|继续一下|(?:please )?(?:continue|go ahead|proceed))[。.!！\s]*$/i.test(text)) {
    return Boolean(hasHistoryTools);
  }
  return new RegExp('^(?:(?:请|请你|请帮我|帮我|麻烦|可以|能否|你可以)\\s*)?(?:先|现在|立即|立刻|重新|再)?\\s*' + ACTION).test(text) ||
    /^(?:please\s+)?(?:check|inspect|search|query|verify|fix|retry|run|refresh|open|finish|read|write|capture|implement|update)\b/i.test(text);
}

function consultation(value) { return CONSULTATION.test(visiblePrompt(value)); }

function promisedAction(value) {
  const text = String(value || '').trim();
  return safeProse(text) && (PROMISE.test(text) || ENGLISH_PROMISE.test(text) || SEARCH_HANDOFF.test(text));
}

module.exports = { visiblePrompt, safeProse, requestedExecution, promisedAction, consultation };
