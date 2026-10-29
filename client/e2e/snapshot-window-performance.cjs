'use strict';

// CPU/transport-size comparison of real projection entry points. Synthetic
// transcripts only; no Electron instance, account, model or persistent session.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const stream = require('../main/pi-session/event-stream');
const root = path.resolve(__dirname, '../..');
function loadProjector(relative, fromGit) {
  const filename = path.join(root, relative);
  const source = fromGit ? execFileSync('git', ['show', 'HEAD:' + relative], { cwd: root, encoding: 'utf8', windowsHide: true })
    : fs.readFileSync(filename, 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, require: createRequire(filename) }, { filename });
  return module.exports;
}
const baselineNative = loadProjector('client/main/pi-session/event-snapshot.js', true);
const baselineExternal = loadProjector('client/main/pi-session/snapshot-window.js', true);
const fixedNative = loadProjector('client/main/pi-session/event-snapshot.js', false);
const fixedExternal = loadProjector('client/main/pi-session/snapshot-window.js', false);
const context = { SCOPES: stream.SCOPES, deriveStatus: stream.deriveStatus, statusText: stream.statusText };
const native = module => state => module.snapshot(state, { messageLimit: 80, toolLimit: 160 }, context);
const external = module => state => module.limitSnapshot(state, { messageLimit: 80, toolLimit: 160 });
function stateOf(messages, tools, oldRunning = 0) {
  const state = stream._blank();
  state.messages = Array.from({ length: messages }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user',
    done: true, text: 'User ' + index, blocks: [{ index: 0, kind: 'text', done: true,
      text: 'Complete answer ' + index + ' ' + 'readable text '.repeat(80) }] }));
  state.tools = Array.from({ length: tools }, (_, index) => ({ id: 'call-' + index, name: 'read',
    state: index < oldRunning ? 'running' : 'done', after: index < oldRunning ? 0 : messages - 1,
    args: { path: 'synthetic-' + index + '.txt' }, result: 'receipt-' + index + ' ' + 'line\n'.repeat(2000) }));
  return state;
}
function measure(project, state) {
  const firstAt = performance.now();
  let result = project(state);
  const coldMs = performance.now() - firstAt;
  const samples = [];
  for (let turn = 0; turn < 40; turn++) {
    const start = performance.now(); result = project(state); samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return { coldMs: +coldMs.toFixed(3), medianMs: +samples[20].toFixed(3), p95Ms: +samples[38].toFixed(3),
    messages: result.messages.length, tools: result.tools.length,
    uniqueTools: new Set(result.tools.map(tool => tool.id)).size,
    serializedBytes: Buffer.byteLength(JSON.stringify(result)) };
}
const report = { isolated: true, realModel: false,
  boundary: 'Actual snapshot projectors, synthetic histories, 40 repeated projections; CPU timings and serialized payload bytes, not physical display FPS.', cases: [] };
for (const [label, before, after, counts] of [
  ['native-many-turns', native(baselineNative), native(fixedNative), [20000, 10000, 0]],
  ['external-long-tool-turn', external(baselineExternal), external(fixedExternal), [2000, 10000, 0]],
  ['native-saturated-running', native(baselineNative), native(fixedNative), [2000, 10000, 160]],
]) {
  const oldState = stateOf(...counts), newState = stateOf(...counts);
  const originalText = newState.messages.at(-1).blocks[0].text;
  const beforeResult = measure(before, oldState), afterResult = measure(after, newState);
  assert.equal(afterResult.messages, 80);
  assert.equal(afterResult.tools, 160);
  assert.equal(afterResult.uniqueTools, 160);
  assert.equal(newState.messages.length, counts[0]);
  assert.equal(newState.tools.length, counts[1]);
  assert.equal(after(newState).messages.at(-1).blocks[0].text, originalText);
  report.cases.push({ label, sourceMessages: counts[0], sourceTools: counts[1], before: beforeResult, after: afterResult });
}
const output = path.join(root, 'outputs/chat-performance-20261023/snapshot-window.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
