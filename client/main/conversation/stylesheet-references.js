'use strict';

// Walk CSS tokens instead of searching inside strings, comments or data URIs.
// This is dependency discovery, not a stylesheet validator or rewriter.
function references(source) {
  const text = String(source || ''), result = [];
  let i = 0;
  const unescape = value => value.replace(/\\(?:([a-f0-9]{1,6})\s?|([^\r\n]))/gi,
    (_, hex, char) => hex ? String.fromCodePoint(Math.min(parseInt(hex, 16) || 0xfffd, 0x10ffff)) : char);
  function string() {
    const quote = text[i++], start = i;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i] === quote) { const value = text.slice(start, i); i++; return unescape(value); }
      i++;
    }
    return '';
  }
  function whitespace() { while (/\s/.test(text[i] || '') && i < text.length) i++; }
  while (i < text.length) {
    if (text.startsWith('/*', i)) { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2; continue; }
    if (text[i] === '"' || text[i] === "'") { string(); continue; }
    const token = /^(?:url\s*\(|@import\b)/i.exec(text.slice(i));
    if (!token || /[\w$.-]/.test(text[i - 1] || '')) { i++; continue; }
    i += token[0].length; whitespace();
    if (token[0][0] === '@') {
      if (text[i] === '"' || text[i] === "'") result.push(string());
      continue;
    }
    if (text[i] === '"' || text[i] === "'") result.push(string());
    else {
      const start = i;
      while (i < text.length && text[i] !== ')') { if (text[i] === '\\') i++; i++; }
      result.push(unescape(text.slice(start, i).trim()));
    }
    while (i < text.length && text[i] !== ')') i++;
    if (text[i] === ')') i++;
  }
  return result.filter(Boolean);
}

module.exports = { references };
