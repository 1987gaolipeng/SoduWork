const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const chatJs = fs.readFileSync(path.join(root, 'components/panels/panels-chat.js'), 'utf8');
const chatStatusJs = fs.readFileSync(path.join(root, 'components/panels/panels-chat-status.js'), 'utf8');
const thinkingSource = chatJs + '\n' + chatStatusJs;
const chatCss = fs.readFileSync(path.join(root, 'components/panels/panels-chat.css'), 'utf8');

test('thinking status exposes elapsed time and live token feedback', () => {
  assert.match(thinkingSource, /data-thinking-elapsed/);
  assert.match(thinkingSource, /data-thinking-tokens/);
  assert.match(thinkingSource, /function turnMessages/);
  assert.match(thinkingSource, /function tokenInfo/);
  assert.match(thinkingSource, /setInterval\(refreshThinkingUi,\s*1000\)/);
});

test('thinking status keeps metrics subtle and promo copy integrated', () => {
  assert.match(thinkingSource, /< 12000/);
  assert.match(thinkingSource, /14000/);
  assert.match(thinkingSource, /function displayText/);
  assert.match(thinkingSource, /const promos =/);
  assert.match(chatCss, /\.nturn-metrics/);
  assert.match(chatCss, /\.nturn-metrics \.nstatus-divider,\.nturn-metrics \.nstatus-divider \+ \.nstatus-metric\{display:none\}/,
    'conversation footer keeps only elapsed time visible');
  assert.doesNotMatch(chatCss, /\.nstatus-metric i/);
  assert.doesNotMatch(chatJs, /data-thinking-promo/);
  assert.doesNotMatch(chatCss, /\.nstatus-promo/);
  assert.match(chatCss, /prefers-reduced-motion:reduce/);
});

test('thinking clock is stopped on reset and slow copy targets status text', () => {
  assert.match(chatJs, /function reset\(\)[\s\S]*?_stopThinkingClock\(\)/);
  assert.match(chatStatusJs, /runtime-status"\]\s*\.nstatus-copy/);
  assert.doesNotMatch(chatJs, /runtime-status"\]\s*span:last-child/);
});

test('expanded execution cards keep their chevrons pinned to the right edge', () => {
  assert.match(chatCss, /\.ntool-batch-caret\{[^}]*margin-left:auto/);
  assert.match(chatCss, /\.ntool-caret\{[^}]*margin-left:auto/);
});
