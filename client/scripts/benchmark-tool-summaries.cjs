'use strict';
// Offline synthetic comparison, using the vendored highlighter and Diff libraries.
// Baseline is the committed HEAD implementation; no application/model is started.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const root = path.resolve(__dirname, '../..');
function make(baseline) {
  const sandbox = { console, ChatDomPatch: require('../components/panels/chat-dom-patch') };
  sandbox.window = sandbox;
  const load = (file, old = false) => vm.runInNewContext(old ? execFileSync('git', ['show', 'HEAD:' + file],
    { cwd: root, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }) : fs.readFileSync(path.join(root, file), 'utf8'), sandbox);
  for (const name of ['highlight', 'diff', 'diff2html']) load('client/vendor/markdown/' + name + '.min.js');
  for (const name of ['panels-chat-tools', 'chat-context-meter', 'chat-scroll-follow', 'chat-markdown', 'chat-message-renderer']) {
    load('client/components/panels/' + name + '.js', baseline && ['panels-chat-tools', 'chat-message-renderer'].includes(name));
  }
  const calls = { highlight: 0, diff: 0 }, highlight = sandbox.hljs.highlight, diff = sandbox.Diff.createTwoFilesPatch;
  sandbox.hljs.highlight = (...args) => { calls.highlight++; return highlight(...args); };
  sandbox.Diff.createTwoFilesPatch = (...args) => { calls.diff++; return diff(...args); };
  const ctx = { esc: sandbox.ChatTools.esc, _openTool: new Set(), _hotToolBodies: new Set() };
  return { calls, renderer: sandbox.ChatMessageRenderer.create(ctx) };
}
function measure(instance, name) {
  const before = Array.from({ length: 400 }, (_, i) => 'const variable' + i + ' = ' + i + ';').join('\n');
  const after = before.replace('variable200 = 200', 'variable200 = 300');
  const tools = Array.from({ length: 20 }, (_, i) => ({ id: name + i, name, state: 'done',
    args: { path: 'example.js', content: after, oldText: before, newText: after }, result: before }));
  const times = [];
  for (let pass = 0; pass < 7; pass++) {
    instance.calls.highlight = 0; instance.calls.diff = 0;
    const start = performance.now(); for (const tool of tools) instance.renderer._toolHtml(tool);
    if (pass) times.push(performance.now() - start);
  }
  return { medianMs: Number(times.sort((a, b) => a - b)[Math.floor(times.length / 2)].toFixed(3)), ...instance.calls };
}
const before = make(true), after = make(false);
const report = { baseline: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  scope: '20 closed cards, 400-line files; synthetic renderer only; six measured passes after warmup', cases: {} };
for (const name of ['read', 'write', 'edit']) report.cases[name] = { before: measure(before, name), after: measure(after, name) };
for (const item of Object.values(report.cases)) {
  if (item.after.highlight || item.after.diff) throw Error('Closed summaries performed body formatting');
}
const out = path.join(root, 'outputs/performance-20261016'); fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'tool-summary-benchmark.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
