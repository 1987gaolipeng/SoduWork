const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname,
  '../components/panels/task-execution-stream.js'), 'utf8');
const ChatTools = {
  phaseNarrative: () => '',
  render(tool) {
    return {
      summaryOnly: tool.name === 'bash',
      title: tool.name === 'bash' ? '运行了命令' : '执行操作',
      sub: '',
      tip: '',
      body: '<pre>' + String(tool.result || '') + '</pre>',
    };
  },
};
const window = { ChatTools, ExecutionToolArgs: require('../components/shared/execution-tool-args'), addEventListener() {} };
vm.runInNewContext(source, {
  window, ChatTools,
  esc: (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;'),
  setTimeout, clearTimeout, console,
}, { filename: 'task-execution-stream.js' });

const stream = window.TaskExecutionStream;
const events = [
  { seq: 1, kind: 'step', text: '第 1 步 · 正在想...' },
  { seq: 2, kind: 'step', text: '第 2 步 · 分析项目结构' },
  { seq: 21, kind: 'out', tool: 'progress', text: '\u7b2c 3 \u6b65 \u00b7 \u6821\u9a8c\u4ea7\u7269' },
  { seq: 3, kind: 'say', text: '我先检查现有实现，再完成修复。' },
  { seq: 4, kind: 'do', tool: 'bash', text: 'npm test' },
  { seq: 5, kind: 'out', tool: 'bash', text: 'all tests passed' },
];
const rows = stream.rows(events, 'running');
const html = stream.rowsHtml(events, 'running');

assert.equal(rows.some((row) => row.key && row.key.includes('step')), false,
  'runtime step boundaries must never be projected into visible conversation rows');
assert.doesNotMatch(html, /第\s*[123]\s*步|正在想|分析项目结构/,
  'internal step labels must not leak into the user-facing conversation');
assert.equal(stream.isProtocolStep(events[2]), true,
  'legacy runners may label a step heartbeat as generic output; it must still stay hidden');
assert.equal(stream.isProtocolStep({ kind: 'say', text: '\u7b2c 1 \u6b65\uff1a\u6211\u5148\u8bf4\u660e\u65b9\u6848' }), false,
  'a real assistant reply that happens to mention a numbered step must remain visible');
assert.match(html, /我先检查现有实现，再完成修复。/,
  'assistant narrative remains normal conversation text');
assert.match(html, /运行了命令/, 'command status remains in the transcript');
assert.doesNotMatch(html, /npm test|data-dks-tool="tool-2"/);
assert.equal(rows.find(row => row.type === 'tool').model.name, 'bash');
assert.match(html, /正在执行/,
  'one live status remains at the end while work is running');

console.log('task session conversation contract: 7 assertions passed');
