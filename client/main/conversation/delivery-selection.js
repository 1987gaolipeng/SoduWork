'use strict';

// Select delivery roots, never delete workspace history. Dependency collection
// still owns the complete file set required to use each selected root.
const path = require('node:path');
const processRoles = new Set(['process', 'evidence', 'verification', 'input', 'internal']);
const normalize = value => String(value || '').replace(/\\/g, '/').normalize('NFC');
function text(message) {
  if (message?.role === 'assistant') {
    if (message.done === false || message.errorMessage ||
        /^(?:tool_?use|tool_?calls?|error|aborted|cancelled|canceled|length|max_tokens)$/i.test(message.stopReason || '') ||
        message.scope && !['normal', 'goal-final'].includes(message.scope)) return '';
    // Pi and Runner snapshots carry visible replies in blocks; their text
    // field can be empty. Only the final prose after the last tool call is a
    // delivery declaration, never thinking, tool arguments or progress text.
    if (Array.isArray(message.blocks) && message.blocks.length) {
      const lastTool = message.blocks.findLastIndex(block => block?.kind === 'toolcall');
      const final = message.blocks.slice(lastTool + 1).filter(block => block?.kind === 'text');
      return final.some(block => block.done === false) ? '' : final.map(block => block.text || '').join('\n');
    }
  }
  if (typeof message?.text === 'string') return message.text;
  if (typeof message?.content === 'string') return message.content;
  return Array.isArray(message?.content) ? message.content.map(part => part.text || '').join('\n') : '';
}
function turn(snapshot = {}) {
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
  const start = messages.findLastIndex(message => message.role === 'user');
  return { request: start < 0 ? '' : text(messages[start]),
    answer: start < 0 ? '' : text(messages.slice(start + 1).findLast(message => message.role === 'assistant')) };
}
function requestedExtension(request, {explicitOnly = false} = {}) {
  if (!/(?:生成|转换?|导出|另存|改成|改为|generate|convert|export|save\s+as)/i.test(request)) return '';
  const target = request.match(/(?:转(?:换)?(?:为|成)|改成|改为|导出为|另存为|\b(?:to|as)\s+)([^，。;\n]{1,40})/i)?.[1] || request;
  const formats = [
    ['.docx', /(?:\bword\b|\bdocx\b)/i], ['.pdf', /\bpdf\b/i],
    ['.md', /(?:\bmarkdown\b|\bmd\b)/i], ['.html', /(?:\bhtml\b|网页)/i],
    ['.xlsx', /(?:\bexcel\b|\bxlsx\b)/i], ['.pptx', /(?:\bpptx?\b|\bpowerpoint\b)/i],
  ].filter(([, pattern]) => pattern.test(target));
  if (formats.length !== 1) return '';
  const [extension, format] = formats[0];
  // Recognize only a complete positive conversion plus an exclusive target
  // clause. Extra instructions or negation must retain the existing manifest;
  // removing individual "keep only" phrases loses their surrounding meaning.
  const namedFormat = '(?:' + format.source + ')';
  const command = '^\\s*(?:(?:请)?(?:把(?:交付)?格式)?' +
    '(?:生成|转换?(?:为|成)?|导出(?:为)?|另存(?:为)?|改成|改为)\\s*' + namedFormat +
    '|(?:please\\s+)?(?:generate|convert(?:\\s+to)?|export(?:\\s+(?:to|as))?|save\\s+as)\\s+' + namedFormat + ')';
  const end = '\\s*(?:文件|文档|格式|版本|file|document|format|version)?\\s*[。.!！]?\\s*$';
  const exclusive = new RegExp(command +
    '\\s*(?:[，,。.;；\\n]|\\band\\b|并且|并)\\s*' +
    '(?:(?:请)?(?:只|仅|仅仅)\\s*保留\\s*(?:(?:最终|最后|最新)(?:的)?\\s*)?|' +
    '(?:please\\s+)?(?:keep\\s+only|only\\s+keep)\\s+(?:the\\s+)?(?:(?:final|latest)\\s+)?)' +
    namedFormat + end, 'i');
  if (explicitOnly && !new RegExp(command + end, 'i').test(request) && !exclusive.test(request)) return '';
  if (/(?:同时|都要|两种|两份|保留|以及|和|both|keep|alongside|as well)/i.test(request) && !exclusive.test(request)) return '';
  return extension;
}
function requestsCaptures(request) {
  return /(?:交付|提供|生成|导出|保存|附上|需要|要).{0,20}(?:截图|效果图)|(?:deliver|provide|export|save|include).{0,30}(?:screenshot|screen capture)/i.test(request) &&
    !/(?:不要|不需要|无需).{0,12}(?:截图|效果图)|(?:do not|don't|without).{0,20}screenshot/i.test(request);
}
function linkMatcher(answer, cwd) {
  let targets;
  return item => {
    if (!answer) return false;
    if (!targets) {
      targets = new Set();
      const markdown = require('../../core/markdown');
      markdown.walkTokens(markdown.lexer(answer), token => {
        if (token.type !== 'link' && token.type !== 'image') return;
        try { targets.add(normalize(decodeURIComponent(token.href))); } catch { /* Invalid URI. */ }
      });
    }
    const relative = normalize(item.relative || item.name);
    const absolute = normalize(path.resolve(cwd, relative));
    return targets.has(relative) || targets.has('./' + relative) || targets.has(absolute);
  };
}
function mentioned(answer, cwd, item) {
  return linkMatcher(answer, cwd)(item);
}
function select(cwd, delivery, snapshot) {
  const { request, answer } = turn(snapshot);
  let items = (delivery.items || []).filter(item => item.primary !== false && item.role !== 'supporting' && !processRoles.has(item.role));
  const replaced = new Set(items.flatMap(item => Array.isArray(item.replaces) ? item.replaces.map(normalize) : []));
  items = items.filter(item => !replaced.has(normalize(item.relative || item.name)));
  const extension = requestedExtension(request);
  const converted = extension ? items.filter(item => item.changedInTurn &&
    path.extname(String(item.relative || item.name || item.path || '')).toLowerCase() === extension) : [];
  if (extension && converted.length) {
    // A conversion selects its new format. Explicit requests for both formats
    // bypass this rule, and source files remain available in the inventory.
    items = converted;
  } else if (delivery.source !== 'manifest') {
    const matches = linkMatcher(answer, cwd);
    const linked = items.filter(item => item.changedInTurn && matches(item));
    if (linked.length) items = linked;
  }
  return { ...delivery, items };
}
module.exports = { select, turn, mentioned, linkMatcher, requestedExtension, requestsCaptures, processRoles };
