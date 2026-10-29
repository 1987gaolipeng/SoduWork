'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/chat-context-meter.js'), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(source, sandbox);
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function render(used, known = true, label = 'Test model') {
  return sandbox.window.ChatContextMeter.create({ esc,
    _snap: { contextUsage: { input: used } },
    _model: { label, contextWindow: 100000, contextWindowKnown: known },
  })._ctxHtml();
}
function renderUsage(usage, model = { contextWindow: 100000, contextWindowKnown: true }) {
  return sandbox.window.ChatContextMeter.create({ esc,
    _snap: { contextUsage: usage, messages: [] }, _model: model,
  })._ctxHtml();
}
function renderContext(contextUsage, contextWindow = 100000, known = true, usage = null) {
  return sandbox.window.ChatContextMeter.create({ esc,
    _snap: { contextUsage, contextWindow, contextWindowKnown: known, usage, messages: [] },
    _model: { contextWindow: 0, contextWindowKnown: false },
  })._ctxHtml();
}
test('context ring uses a transparent SVG with a top-origin arc and retained usage details', () => {
  const html = render(28000);
  assert.match(html, /viewBox="0 0 18 18" fill="none"/);
  assert.match(html, /class="nctx-track"/);
  assert.match(html, /stroke-dasharray="28\.0 100" transform="rotate\(-90 9 9\)"/);
  assert.match(html, /28% 已用/);
  assert.match(html, /已用 28,000 标记，共 100,000/);
  assert.match(html, /class="nctx-pop"/);
  assert.match(html, /role="tooltip"/);
  assert.doesNotMatch(html, /title=|nctx-ring[^>]*title/);
  assert.doesNotMatch(html, /<i><\/i>|conic-gradient/);
});
test('zero usage stays empty while an unknown provider uses a safe estimated window', () => {
  assert.doesNotMatch(render(0), /class="nctx-value"/);
  assert.match(render(28000, false), /class="nctx-value"/);
  assert.match(render(28000, false), /估算上限/);
  assert.match(render(28000, false), /% 已用|，共/);
  assert.match(render(0), />0% 已用</);
});
test('usage thresholds and upper clamping remain unchanged', () => {
  assert.doesNotMatch(render(59999), /nctx-ring (warm|hot)/);
  assert.match(render(60000), /nctx-ring warm/);
  assert.match(render(85000), /nctx-ring hot/);
  assert.match(render(150000), /stroke-dasharray="100\.0 100"/);
  assert.match(render(1), /不到 1%/);
});
test('compact tooltip does not expose model metadata', () => {
  const html = render(28000, true, '<img src=x onerror="boom">');
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /onerror|boom|Test model/);
});
test('context usage accepts provider field variants and explains missing usage', () => {
  assert.match(renderUsage({ input_tokens: 56000 }), /已用 56,000 标记/);
  assert.match(renderUsage({ prompt_tokens: 42000 }), /已用 42,000 标记/);
  assert.match(renderUsage(null), /暂无用量数据/);
  assert.match(renderUsage(null), /本轮尚未返回用量数据/);
});
test('runner context watermark takes precedence over cumulative usage', () => {
  const html = renderContext({ input: 56000, output: 8000, total: 64000 }, 100000, true,
    { input: 900000, output: 10000, total: 910000 });
  assert.match(html, /已用 56,000 标记/);
  assert.match(html, /56% 已用/);
  assert.doesNotMatch(html, /900,000/);
});
test('runner still shows current tokens when the provider does not report a window', () => {
  const html = renderContext({ input: 56000 }, 0, false);
  assert.doesNotMatch(html, /上限未知/);
  assert.match(html, /估算上限/);
  assert.match(html, /已用 56,000 标记/);
  assert.doesNotMatch(html, /暂无用量数据/);
});
