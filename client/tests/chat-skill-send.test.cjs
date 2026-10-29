'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs'), vm = require('node:vm');
const window = {};
for (const file of ['panels-compose-skills.js', 'panels-chat-tools.js'])
  vm.runInNewContext(fs.readFileSync(require.resolve('../components/panels/' + file), 'utf8'), { window });

test('selected skill is a sendable payload even without text while a reply is running', () => {
  const root = { dataset: { skillCount: '1' }, querySelector: () => ({ value: '' }) };
  assert.equal(window.ChatTools.composerHasPayload(root, { names: () => [] }), true);
});

test('only picked skills enter the send contract, while nonempty task text stays unchanged', () => {
  const prepare = window.ComposeSkills.submission;
  const only = prepare('', ['company-research']);
  assert.equal(only.text, '#company-research');
  assert.deepEqual(Array.from(only.skills), ['company-research']);
  const mixed = prepare('#company-research 核对报告', ['company-research', 'web-audit', 'web-audit']);
  assert.equal(mixed.text, '#company-research 核对报告');
  assert.deepEqual(Array.from(mixed.skills), ['company-research', 'web-audit']);
  assert.equal(prepare('普通对话', []).text, '普通对话');
  assert.equal(prepare('', []).text, '');
});

for (const body of [
  '#1 帮我写一篇500字的作文\n#2 帮我去AI味',
  '#web-audit 请分析页面',
  '#skill:web-audit 分析正文 /skill:company-research',
  '/skill:company-research 这是文档中的命令示例',
  '#fff #000 Markdown编号 #3',
  '```js\n#web-audit\n```\n“#company-research” \\#web-audit',
]) test('unselected body markers remain ordinary text: ' + body.slice(0, 45), () => {
  const prepared = window.ComposeSkills.submission(body, []);
  assert.equal(prepared.text, body);
  assert.deepEqual(Array.from(prepared.skills), []);
  assert.deepEqual(Array.from(window.ComposeSkills.namesFromText(body)), []);
});

test('picked metadata is independent of numbered and known-name markers in the body', () => {
  const prepared = window.ComposeSkills.submission('#1 写作文\n#2 去AI味\n#web-audit 仅举例', ['company-research']);
  assert.equal(prepared.text, '#1 写作文\n#2 去AI味\n#web-audit 仅举例');
  assert.deepEqual(Array.from(prepared.skills), ['company-research']);
});

test('selected skills preserve the original request including whitespace and line endings', () => {
  const text = '  #1 原文\r\n' + '正文'.repeat(900) + '\n  ';
  assert.equal(window.ComposeSkills.submission(text, ['company-research']).text, text);
});
