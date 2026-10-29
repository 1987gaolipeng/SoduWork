const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/model-capabilities.js'), 'utf8');
function load() {
  const context = vm.createContext({});
  // Match production core/store.js: const declarations are not global object properties.
  vm.runInContext('const esc = value => String(value);', context);
  vm.runInContext(source, context);
  assert.equal(context.esc, undefined);
  return context.ModelCapabilitiesUI;
}
test('model capability view renders inside a host with lexical, rather than window, helpers', () => {
  const ui = load();
  assert.match(ui.badges({ config: { imageRouting: 'native' } }), /图片输入<b>支持/);
  assert.match(ui.fields({ config: { maxOutputTokens: 8192 } }), /value="8192"/);
  assert.match(ui.report({ checkedAt: '2026-10-01T00:00:00Z', checks: { connection: { status: 'passed' } } }), /检测通过/);
});
test('capability errors and form values are escaped independently of the host helper', () => {
  const ui = load();
  const value = '<img src=x onerror="alert(1)">&\'';
  for (const html of [ui.report({ error: value }), ui.fields({ config: { maxOutputTokens: value } })]) {
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('&lt;img'));
    assert.ok(html.includes('&quot;'));
    assert.ok(html.includes('&amp;'));
    assert.ok(html.includes('&#39;'));
  }
});
