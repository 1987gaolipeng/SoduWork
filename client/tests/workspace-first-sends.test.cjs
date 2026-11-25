'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../components/workspace/workspace-first-sends.js'), 'utf8');
function fixture({ associations, ack, fileProject, associationState, hasHistory, nativeChat } = {}) {
  let scope = 'A', result = Promise.resolve({ ok: true, rows: [] }), pane;
  const opened = [], drafts = [], routes = [];
  const document = {
    createElement(tag) {
      assert.equal(tag, 'section');
      const parts = new Map();
      return { dataset: {}, isConnected: false,
        append(markup) {
          assert.doesNotMatch(markup, /<(?:dialog|button)\b/i);
          assert.match(markup, /class="nchat-content-area"/);
        },
        remove() { this.isConnected = false; },
        querySelector(key) {
          if (!parts.has(key)) parts.set(key, {});
          return parts.get(key);
        } };
    },
  };
  const host = { replaceChildren(node) { pane?.remove(); pane = node; node.isConnected = true; } };
  const navigation = { generation: 0 };
  const window = { ChatDomPatch: { htmlFragment: markup => markup }, NativeChat: nativeChat, WorkspaceNavigation: navigation };
  vm.runInNewContext(source, { window, document });
  const api = { firstSends: () => result, firstSendAssociations: associations, ackFirstSendAssociations: ack };
  const model = window.WorkspaceFirstSends.create({ api: () => api, owner: () => scope, fileProject, associationState, hasHistory,
    openRecord(id) { routes.push(id); navigation.generation++; model.mount(id, host); },
    openDraft(row) { drafts.push(row.intentId); pane.remove(); },
    openChat(row) { opened.push(row.sessionId); pane.remove(); }, repaint() {} });
  return { model, opened, drafts, routes, list: (known = [], hidden = () => false) => model.recent(known, hidden),
    render(rows) { result = Promise.resolve({ ok: true, rows }); return model.refresh(); },
    hold() { const deferred = Promise.withResolvers(); result = deferred.promise; return rows => deferred.resolve({ ok: true, rows }); },
    navigate() { navigation.generation++; }, switch() { scope = 'B'; navigation.generation++; model.clear(); },
    get pane() { return pane; } };
}
const settled = () => new Promise(resolve => setImmediate(resolve));
test('a failed first send with incomplete inputs shows selectable text and filenames inline, with no actions', async () => {
  const f = fixture(), row = { intentId: 'i', title: 'A title', status: 'failed', text: '<original>', attachmentNames: ['chart.png'], reason: 'offline' };
  await f.render([row]); f.model.show('i'); await settled();
  assert.equal(f.model.activeId, 'i'); assert.deepEqual(f.routes, ['i']); assert.deepEqual(f.opened, []);
  assert.equal(f.pane.querySelector('[data-send-title]').textContent, row.title);
  assert.equal(f.pane.querySelector('.nbubble').textContent, row.text);
  assert.equal(f.pane.querySelector('[data-send-files]').textContent, 'chart.png');
  assert.equal(f.pane.querySelector('[role="status"]').textContent, 'offline');
  await f.render([]);
  assert.equal(f.pane.querySelector('.nbubble').textContent, '');
  assert.equal(f.pane.querySelector('[data-send-title]').textContent, '');
  assert.equal(f.pane.querySelector('[role="status"]').textContent, '这条发送记录已不可用');
});
test('a delivery without a receipt merges only by native id and opens its original session without sending', async () => {
  const f = fixture(), a = { intentId: 'a', title: 'Same title', at: 1, status: 'opening', text: 'A' },
    b = { ...a, intentId: 'b', at: 2, status: 'uncertain', text: 'B' };
  await f.render([a, b]); f.model.show('b'); await settled();
  assert.deepEqual(Array.from(f.list(), row => row.localId), ['b', 'a']);
  assert.equal(f.pane.querySelector('.nbubble').textContent, 'B'); assert.deepEqual(f.opened, []);
  assert.equal(f.pane.querySelector('[role="status"]').textContent, '尚未收到这条消息的发送回执。');
  await f.render([a, { ...b, sessionId: 'native' }]);
  assert.deepEqual(f.opened, ['native']);
  await f.render([a, { ...b, status: 'accepted', sessionId: 'native' }]);
  assert.equal(f.list([{ id: 'other', title: a.title }]).length, 2);
  assert.equal(f.list([{ id: 'native' }]).length, 1);
  assert.equal(f.list([], id => id === 'native').length, 1);
});
test('one sidebar click opens a verified refusal for editing or preserves a later draft already there', async () => {
  let state = 'editable', restored = 0;
  const f = fixture({ hasHistory: () => true, nativeChat: { firstSendEditState: () => state,
    restoreFirstSendForEdit() { restored++; return true; } } });
  const row = { intentId: 'i', attemptId: 'a', sessionId: 's', status: 'failed', canAttachFailed: true, text: 'original' };
  await f.render([row]); f.model.show('i'); await settled();
  assert.deepEqual(f.opened, ['s']); assert.equal(restored, 1);
  state = 'occupied'; f.model.show('i'); await settled();
  assert.deepEqual(f.opened, ['s', 's']); assert.equal(restored, 1);
  state = 'starter'; await f.render([{ ...row, sessionId: '' }]); f.model.show('i'); await settled();
  assert.deepEqual(f.drafts, ['i']); assert.equal(restored, 1);
});
test('a superseding attempt, late navigation or account switch cannot restore or reopen the old draft', async () => {
  for (const interruption of ['attempt', 'navigate', 'switch']) {
    let restored = 0;
    const f = fixture({ nativeChat: { firstSendEditState: () => 'editable', restoreFirstSendForEdit() { restored++; return true; } } });
    const row = { intentId: 'i', attemptId: 'a', sessionId: 's', status: 'failed', text: 'private' };
    await f.render([row]); const finish = f.hold(); f.model.show('i');
    if (interruption === 'switch') f.switch();
    if (interruption === 'navigate') f.navigate(); // Another open can still be waiting for its IPC, leaving the pane connected.
    finish([interruption === 'attempt' ? { ...row, attemptId: 'b' } : row]); await settled();
    assert.deepEqual(f.opened, []); assert.equal(restored, 0);
    if (interruption === 'switch') { assert.equal(f.pane.isConnected, false); assert.equal(f.list().length, 0); }
  }
});
test('a delivery compacted between click and read opens only a confirmed session still in the catalog', async () => {
  for (const [confirmed, exists] of [[false, true], [true, false], [true, true]]) {
    const f = fixture({ hasHistory: id => exists && id === 'native' });
    const row = { intentId: 'i', sessionId: 'native', status: 'accepted', confirmed, text: 'private' };
    await f.render([row]); const finish = f.hold(); f.model.show('i'); finish([]); await settled();
    assert.deepEqual(f.opened, confirmed && exists ? ['native'] : []);
    assert.equal(f.pane.querySelector('.nbubble').textContent, '');
  }
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
