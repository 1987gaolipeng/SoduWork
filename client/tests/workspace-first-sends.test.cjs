'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../components/workspace/workspace-first-sends.js'), 'utf8');
function fixture({ associations, ack, fileProject, associationState, retry, hasHistory, nativeChat } = {}) {
  let scope = 'A', notify, result = Promise.resolve({ ok: true, rows: [] }), pane;
  const opened = [], retried = [], dismissed = [], routes = [];
  const document = {
    createElement(tag) {
      assert.equal(tag, 'section');
      const parts = new Map();
      return { dataset: {}, isConnected: false, append(markup) { assert.doesNotMatch(markup, /<dialog/i); },
        remove() { this.isConnected = false; },
        querySelector(key) {
          if (!parts.has(key)) parts.set(key, {});
          return parts.get(key);
        } };
    },
  };
  const host = { replaceChildren(node) { pane?.remove(); pane = node; node.isConnected = true; } };
  const copied = [];
  const window = { ChatDomPatch: { htmlFragment: markup => markup }, NativeChat: nativeChat,
    navigator: { clipboard: { writeText: async text => { copied.push(text); } } } };
  vm.runInNewContext(source, { window, document });
  const api = { firstSends: () => result, firstSendAssociations: associations, ackFirstSendAssociations: ack,
    onFirstSendsChanged(fn) { notify = fn; return () => { notify = null; }; },
    async retryFirstSend(id) { retried.push(id); return retry ? retry(id) : { ok: true }; },
    async dismissFirstSend(...args) { dismissed.push(args); return { ok: true }; } };
  const model = window.WorkspaceFirstSends.create({ api: () => api, owner: () => scope, fileProject, associationState, hasHistory,
    openRecord(id) { routes.push(id); model.mount(id, host); }, repaint() {}, openChat(row) { opened.push(row.sessionId); } });
  return { model, opened, retried, dismissed, routes, copied, list: (known = [], hidden = () => false) => model.recent(known, hidden),
    render(rows) { result = Promise.resolve({ ok: true, rows }); return model.refresh(); },
    defer(promise) { result = promise; return notify(); }, switch() { scope = 'B'; model.clear(); },
    get pane() { return pane; } };
}
test('pending first sends are actionable by intent and merge with confirmed history only by native id', async () => {
  const f = fixture(), a = { intentId: 'first-a', title: 'Same title', at: 1, status: 'opening', text: 'Request A' },
    b = { ...a, intentId: 'first-b', at: 2, status: 'failed', canRetry: true, text: 'Request B' };
  await f.render([a, b]);
  assert.deepEqual(Array.from(f.list(), row => row.localId), ['first-b', 'first-a']);
  f.model.show(b.intentId);
  assert.deepEqual(f.routes, [b.intentId]);
  assert.equal(f.model.activeId, b.intentId);
  assert.equal(f.pane.querySelector('.nbubble').textContent, b.text);
  await f.pane.querySelector('[data-send-action]').onclick();
  assert.deepEqual(f.retried, [b.intentId]);
  await f.render([a, { ...b, status: 'uncertain', canRetry: false, sessionId: 'native-b' }]);
  await f.pane.querySelector('[data-send-action]').onclick();
  assert.deepEqual(f.opened, ['native-b']); assert.deepEqual(f.retried, [b.intentId]);
  await f.render([a, { ...b, status: 'accepted', sessionId: 'native-b' }]);
  assert.equal(f.list([{ id: 'other', title: a.title }]).length, 2);
  assert.equal(f.list([{ id: 'native-b' }]).length, 1);
  assert.equal(f.list([], id => id === 'native-b').length, 1);
});
test('dismissal confirmation follows the displayed attempt and status across in-chat status updates', async () => {
  const f = fixture(), row = { intentId: 'first-a', status: 'failed', text: 'first draft' };
  await f.render([row]); f.model.show(row.intentId);
  const button = f.pane.querySelector('[data-send-dismiss]');
  await button.onclick();
  await f.render([{ ...row, attemptId: 'ui-edited', text: 'edited draft' }]);
  await button.onclick();
  assert.deepEqual(f.dismissed, []);
  await f.render([{ ...row, attemptId: 'ui-edited', status: 'uncertain' }]);
  await button.onclick();
  assert.deepEqual(f.dismissed, []);
  await f.render([{ ...row, attemptId: 'ui-edited', status: 'uncertain' }]);
  await button.onclick();
  assert.deepEqual(f.dismissed, [['first-a', 'ui-edited', 'uncertain']]);
});
test('the failed record opens the original draft for editing only after checking the same refused attempt', async () => {
  let state = 'editable', restored = 0;
  const f = fixture({ hasHistory: () => true, nativeChat: { firstSendEditState: () => state,
    restoreFirstSendForEdit() { restored++; return true; } } });
  const row = { intentId: 'i', attemptId: 'a', sessionId: 's', status: 'failed', canAttachFailed: true, canRetry: true, text: 'original' };
  await f.render([row]); f.model.show('i');
  const action = f.pane.querySelector('[data-send-action]'), copy = f.pane.querySelector('[data-send-copy]');
  assert.equal(action.textContent, '编辑后发送'); await action.onclick();
  state = 'occupied'; await f.render([row]); assert.equal(action.textContent, '打开会话'); await action.onclick();
  state = 'reselect'; await f.render([row]); assert.equal(action.hidden, true);
  assert.equal(copy.hidden, false); await copy.onclick();
  assert.deepEqual(f.copied, ['original']); assert.equal(restored, 1);
  assert.deepEqual(f.opened, ['s', 's']); assert.deepEqual(f.retried, []);
  state = 'editable'; await f.render([row]);
  let release; const checking = f.defer(new Promise(resolve => { release = resolve; }));
  const clicked = action.onclick(); f.switch(); release({ ok: true, rows: [row] }); await Promise.all([checking, clicked]);
  assert.equal(restored, 1); assert.deepEqual(f.opened, ['s', 's']);
});
test('a compacted delivery opens only a confirmed chat still in the current catalog', async () => {
  let exists = true;
  const f = fixture({ hasHistory: id => exists && id === 'native' });
  const row = { intentId: 'i', sessionId: 'native', text: 'private', status: 'sending' };
  await f.render([row]); f.model.show('i');
  const action = f.pane.querySelector('[data-send-action]');
  await f.render([{ ...row, status: 'accepted' }]); await f.render([]); assert.equal(action.hidden, true);
  await f.render([{ ...row, status: 'accepted', confirmed: true }]); await f.render([]);
  assert.equal(f.pane.querySelector('.nbubble').textContent, ''); assert.equal(action.textContent, '打开会话');
  await action.onclick(); assert.deepEqual(f.opened, ['native']);
  exists = false; await f.render([]); assert.equal(action.hidden, true);
  await action.onclick(); assert.deepEqual(f.opened, ['native']);
});
test('switching account clears open request text and ignores a late first-send list', async () => {
  const f = fixture(), row = { intentId: 'first-private', text: 'A only', at: 1, status: 'sending' };
  await f.render([row]); f.model.show(row.intentId);
  let release;
  const pending = f.defer(new Promise(resolve => { release = resolve; }));
  f.switch(); await f.render([]); release({ ok: true, rows: [row] }); await pending;
  assert.equal(f.pane.isConnected, false); assert.equal(f.list().length, 0);
});
test('removing or opening another conversation while retrying cannot repaint the new conversation', async () => {
  let finish;
  const f = fixture({ retry: () => new Promise(resolve => { finish = resolve; }) });
  const row = { intentId: 'first-x', status: 'failed', text: 'old message', canRetry: true };
  await f.render([row]); f.model.show(row.intentId);
  const original = f.pane, retrying = original.querySelector('[data-send-action]').onclick();
  original.remove();
  await f.render([{ ...row, intentId: 'first-y', text: 'other conversation' }]);
  f.model.show('first-y');
  finish({ ok: false, reason: 'late failure' }); await retrying;
  assert.deepEqual(f.opened, []);
  assert.equal(f.pane.querySelector('.nbubble').textContent, 'other conversation');
  assert.equal(f.pane.querySelector('[role="status"]').textContent, '发送失败');
  await f.render([]);
  assert.equal(f.pane.querySelector('.nbubble').textContent, '');
  assert.equal(f.pane.querySelector('[data-send-action]').hidden, true);
});
test('cold recovery waits for the catalog and acknowledges the project only after successful filing', async () => {
  const row = { intentId: 'first-1', sessionId: 'native-1', title: 'Original', sidebarProjectId: 'project-1' };
  const projects = [], acknowledgements = [];
  let ready = false, fail = true;
  const f = fixture({ associations: async () => ({ ok: true, rows: acknowledgements.length ? [] : [row] }),
    associationState: () => ready ? 'active' : 'pending',
    fileProject(value) { projects.push([value.sessionId, value.sidebarProjectId]); return !fail; },
    async ack(id, sessionId) { acknowledgements.push([id, sessionId]); return { ok: true }; } });
  await f.render([]); assert.deepEqual(projects, []);
  ready = true; await f.render([]); assert.deepEqual(acknowledgements, []);
  fail = false; await f.render([]); await f.render([]);
  assert.deepEqual(projects, [['native-1', 'project-1'], ['native-1', 'project-1']]);
  assert.deepEqual(acknowledgements, [['first-1', 'native-1']]);
});
test('a hidden session is acknowledged without putting it back in the sidebar project', async () => {
  const row = { intentId: 'first-1', sessionId: 'hidden', sidebarProjectId: 'project-1' };
  const filed = [], acknowledgements = [];
  const f = fixture({ associations: async () => ({ ok: true, rows: [row] }), associationState: () => 'hidden',
    fileProject(value) { filed.push(value); return true; }, async ack(...args) { acknowledgements.push(args); } });
  await f.render([]); assert.deepEqual(filed, []); assert.deepEqual(acknowledgements, [['first-1', 'hidden']]);
});
test('a late project association list after switching accounts cannot file or acknowledge the old session', async () => {
  let release, started;
  const first = new Promise(resolve => { started = resolve; });
  const attempts = [], acknowledgements = [];
  const row = { intentId: 'first-1', sessionId: 'native-1', sidebarProjectId: 'project-1' };
  const f = fixture({ associations() { started(); return new Promise(resolve => { release = resolve; }); },
    fileProject(value) { attempts.push(value); return true; },
    ack: async id => { acknowledgements.push(id); } });
  const pending = f.render([]);
  await first; f.switch(); release({ ok: true, rows: [row] }); await pending;
  assert.deepEqual(attempts, []); assert.deepEqual(acknowledgements, []);
});
