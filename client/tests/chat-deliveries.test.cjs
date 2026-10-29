'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const code = fs.readFileSync(path.join(__dirname, '../components/panels/chat-deliveries.js'), 'utf8');

function helper(document) {
  const global = { addEventListener() {}, document };
  vm.runInNewContext(code, { window: global, globalThis: global, URL, document });
  return global.ChatDeliveries;
}

test('cloud delivery keeps same-named files from different paths', () => {
  const deliveries = helper();
  const files = [
    { taskId: 'task-1', attachmentId: 'a', artifactId: 'task-output:a', relative: 'docs/README.md', name: 'README.md', role: 'output', round: 1 },
    { taskId: 'task-1', attachmentId: 'b', artifactId: 'task-output:b', relative: 'examples/README.md', name: 'README.md', role: 'output', round: 1 },
  ];
  const rows = deliveries._groupFiles(files, 'task-1');
  assert.equal(rows.length, 2);
  assert.deepEqual(Array.from(rows, row => String(row.relative)), ['docs/README.md', 'examples/README.md']);
});

test('settled local and cloud outputs render a complete delivery card with its continuation action', () => {
  for (const remote of [false, true]) {
    const child = () => ({ textContent: '', hidden: false, classList: { toggle() {} },
      setAttribute() {}, replaceChildren() {}, querySelector: child });
    const card = { ...child(), dataset: {}, querySelector: child }, appended = [];
    const document = { createElement: () => card, createTextNode: text => ({ textContent: text }) };
    const message = { dataset: { deliveryCurrent: 'true' }, ownerDocument: document,
      querySelector: () => null, querySelectorAll: () => [], appendChild: value => appended.push(value) };
    const root = { ownerDocument: document, querySelectorAll: selector => selector === '[data-delivery]' ? [] : [message] };
    const taskId = remote ? 'cloud-task' : '';
    const file = { artifactId: 'fixture-result', name: 'index.html', title: 'Current result',
      primary: true, changedInTurn: true, kind: 'website', size: 128, role: 'output', taskId };
    const deliveries = helper(document);
    deliveries.decorate(root, [file], 'fixture-conversation', { status: 'idle',
      ...(remote ? { cloudHandoff: { taskId } } : {}) });
    assert.deepEqual(appended, [card]);
    assert.equal(card.className, 'ndelivery');
    assert.ok(card.innerHTML.includes('data-delivery-continue'));
    assert.ok(card.innerHTML.includes('M5 12h13m-5-5 5 5-5 5'));
    assert.ok(card.innerHTML.includes(remote ? '在云端继续' : '继续会话'));
  }
});

test('cloud website preview rewrites runner loopback to the selected host', () => {
  const deliveries = helper();
  const snapshot = { cloudHandoff: { target: { host: 'runner.example.com' } } };
  assert.equal(
    deliveries._artifactUrlFor('http://localhost:4173/demo/', snapshot),
    'http://runner.example.com:4173/demo/',
  );
  assert.equal(deliveries._artifactUrlFor('http://localhost:4173/demo/'), '');
  assert.equal(deliveries._artifactUrlFor('javascript:alert(1)', snapshot), '');
});
