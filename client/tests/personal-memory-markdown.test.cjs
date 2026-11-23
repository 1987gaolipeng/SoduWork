'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/panels-session-memory.js'), 'utf8');
function renderer(deps = {}) {
  const window = { ...deps };
  vm.runInNewContext(source.replace('  const api =', '  global.renderMemoryForTest = memoryMarkdown;\n  const api ='), { window });
  return window.renderMemoryForTest;
}
test('memory preview parses Markdown and passes all generated HTML through a restricted sanitizer', () => {
  const marked = require('../core/markdown.js');
  let calls = 0;
  const render = renderer({ marked, DOMPurify: { sanitize(html, options) {
    calls++;
    assert.match(html, /<h1>Personal<\/h1>/);
    assert.match(html, /<strong>Report<\/strong>/);
    assert.match(html, /<li>Complete<\/li>/);
    assert.equal(options.ALLOWED_TAGS.includes('img'), false);
    assert.equal(options.ALLOWED_TAGS.includes('script'), false);
    assert.equal(options.ALLOWED_ATTR.length, 0);
    return '<p>sanitized result</p>';
  } } });
  assert.equal(render('# Personal\n\n**Report**\n\n- Complete'), '<p>sanitized result</p>');
  assert.equal(calls, 1);
});
test('missing or failed Markdown dependencies fall back to escaped text, never raw HTML', () => {
  for (const deps of [{}, { marked: { parse() { throw Error('bad parser'); } }, DOMPurify: { sanitize() {} } }]) {
    const result = renderer(deps)('<img src=x onerror="alert(1)"><script>bad()</script>');
    assert.doesNotMatch(result, /<img|<script/);
    assert.match(result, /&lt;img/);
  }
});
