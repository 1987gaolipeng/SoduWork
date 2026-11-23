'use strict';

// Conversation evidence can describe an old runtime. It must never establish
// the identity, provider, model or knowledge cutoff of a future conversation.
// Match identity claims/questions, not ordinary work mentioning an AI product.
function hasRuntimeIdentity(value) {
  const text = String(value || '').replace(/[*_`]/g, '');
  return /你是谁|你是什么(?:模型|助手)|(?:你|我)(?:的)?(?:底层|底座|基础|当前|实际使用的)?(?:模型|底座|训练截止|知识截止)|(?:训练|知识|数据)(?:的)?(?:截止|截断)|who\s+are\s+you|(?:your|my)\s+(?:(?:current|underlying|base)\s+)?(?:model|runtime|provider|harness)|(?:knowledge|training|data)\s+cut[- ]?off/i.test(text)
    || /(?:我是|我使用|我基于|我由|i\s+am|i'm|i\s+(?:use|run\s+on)|powered\s+by)[^\n。.!?]{0,160}(?:qwen|千问|通义|codex|claude|deepseek|深度求索|chatgpt|openai|gemini|google|anthropic|kimi|语言模型|language\s+model)/i.test(text);
}

function contextContent(content) {
  // Remove an entire generated summary if it contains an identity claim, so
  // its heading/goal cannot survive and bias the next answer. Manual files
  // remain unchanged on disk; filter their paragraphs only at injection time.
  return String(content || '')
    .replace(/<!-- soduwork-work-memory:[a-f0-9]{64} -->[\s\S]*?<!-- \/soduwork-work-memory -->/g,
      block => hasRuntimeIdentity(block) ? '' : block)
    .split(/\r?\n\s*\r?\n/).filter(block => !hasRuntimeIdentity(block)).join('\n\n');
}

module.exports = { hasRuntimeIdentity, contextContent };
