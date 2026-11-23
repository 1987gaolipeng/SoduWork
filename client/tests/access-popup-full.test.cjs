'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function fixture(decision = 'full') {
  const window = { screenX: 10, screenY: 20, setTimeout, clearTimeout }, context = { window };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/access-controls.js'), 'utf8'), context);
  const error = { hidden: true, classList: { toggle() {} } };
  const card = { dataset: { permissionRef: 'chat-a' }, isConnected: true, hidden: false,
    setAttribute() {}, querySelector: () => error, querySelectorAll: () => [button] };
  const button = { dataset: { uiValue: decision, permissionRequest: 'request-a', permissionRevision: '2', accessRevision: '3' },
    disabled: false, closest: () => card, getBoundingClientRect: () => ({ left: 5, top: 8, width: 60, height: 30 }) };
  return { window, controls: window.AccessControls, button, card, error };
}
test('legacy requests without a scoped option keep their original decisions', () => {
  const f = fixture(); const request = { requestId: 'command-a', policyRevision: 2,
    action: 'command.execute', tool: 'bash', arguments: { command: 'echo sample' } };
  const html = f.controls.render(request, value => String(value ?? ''), { ref: 'chat-a', fullRevision: 3 });
  assert.match(html, /允许运行命令？/); assert.match(html, /echo sample/);
  assert.match(html, /data-ui-value="full"[^>]*data-access-revision="3"[^>]*>始终允许/);
  assert.deepEqual([...html.matchAll(/data-ui-value="([^"]+)"/g)].map(row => row[1]), ['deny', 'once', 'full']);
  assert.match(html, /role="group"/);
  assert.doesNotMatch(html, /data-ui-value="session"|记住这条命令|记住同一目标/);
  assert.doesNotMatch(f.controls.render(request, String), /data-ui-value="full"/);
});
test('only explicitly supported and complete requests offer a matching-operation grant', async () => {
  const f = fixture('session');
  const request = { requestId: 'request-a', policyRevision: 2, action: 'command.execute',
    allowSession: true, choices: ['deny', 'session', 'once'], arguments: { command: 'echo sample' } };
  assert.match(f.controls.render(request, String), /data-ui-value="session"/);
  for (const override of [{ allowSession: false }, { choices: ['once', 'deny'] },
    { arguments: { inputIncomplete: true } }, { arguments: { input: null } }]) {
    assert.doesNotMatch(f.controls.render({ ...request, ...override }, String), /data-ui-value="session"/);
  }
  let reply;
  await f.controls.answer(f.button, { answerUi: async (ref, value) => { reply = value; return { ok: true }; } }, 'chat-a');
  assert.deepEqual({ ...reply }, { requestId: 'request-a', policyRevision: 2, decision: 'session' });
});
test('full access uses the versioned session change API rather than granting a tool reply', async () => {
  const f = fixture(); let calls = 0;
  const api = { answerUi() { assert.fail('full is not a tool approval decision'); },
    async setAccessMode(ref, mode, revision, options) {
      calls++; assert.equal(ref, 'chat-a'); assert.equal(mode, 'full'); assert.equal(revision, 3);
      assert.equal(options.anchor.screenX, 15); assert.equal(options.anchor.screenY, 28);
      assert.equal(f.button.disabled, true); return { ok: true, effective: 'current-turn' };
    } };
  assert.equal((await f.controls.answer(f.button, api, 'chat-a')).ok, true);
  assert.equal(calls, 1); assert.equal(f.card.hidden, true);
});
test('cancelled or failed full access preserves the pending tool and re-enables all choices', async () => {
  for (const response of [{ ok: false, cancelled: true }, { ok: false, reason: 'stale revision' }]) {
    const f = fixture(); const api = { setAccessMode: async () => response };
    await f.controls.answer(f.button, api, 'chat-a');
    assert.equal(f.card.hidden, false); assert.equal(f.button.disabled, false);
    assert.equal(f.card.dataset.answerPending, 'false'); assert.equal(f.error.hidden, !!response.cancelled);
  }
  const f = fixture(); await f.controls.answer(f.button, { setAccessMode: async () => { throw Error('offline'); } }, 'chat-a');
  assert.equal(f.card.hidden, false); assert.equal(f.button.disabled, false); assert.equal(f.error.hidden, false);
});
test('approval calls that never settle time out and restore all choices', async () => {
  for (const [decision, api] of [['full', { setAccessMode: () => new Promise(() => {}) }],
    ['once', { answerUi: () => new Promise(() => {}) }]]) {
    const f = fixture(decision);
    const result = await f.controls.answer(f.button, api, 'chat-a', { timeoutMs: 10 });
    assert.equal(result.ok, false);
    assert.equal(f.card.hidden, false);
    assert.equal(f.button.disabled, false);
    assert.equal(f.card.dataset.answerPending, 'false');
    assert.equal(f.error.hidden, false);
    assert.equal(f.error.textContent, '权限确认超时，请重试');
  }
});
test('next-turn changes retain current approval, while stale chats and duplicate clicks cannot submit', async () => {
  const f = fixture(); let resolve, calls = 0;
  const api = { setAccessMode: () => { calls++; return new Promise(r => { resolve = r; }); } };
  assert.equal((await f.controls.answer(f.button, api, 'chat-b')).ok, false); assert.equal(calls, 0);
  const pending = f.controls.answer(f.button, api, 'chat-a');
  assert.equal((await f.controls.answer(f.button, api, 'chat-a')).ok, false); assert.equal(calls, 1);
  resolve({ ok: true, effective: 'next-turn' }); await pending;
  assert.equal(f.card.hidden, false); assert.equal(f.button.disabled, false);
  assert.equal(f.error.textContent, '新权限将在下一轮生效。');
});
test('allow once still sends the exact pending request and does not change session permissions', async () => {
  const f = fixture('once'); let received;
  await f.controls.answer(f.button, { answerUi: async (ref, reply) => { received = { ref, ...reply }; return { ok: true }; },
    setAccessMode() { assert.fail('ordinary reply must not escalate'); } }, 'chat-a');
  assert.equal(received.ref, 'chat-a'); assert.equal(received.decision, 'once');
  assert.equal(received.requestId, 'request-a'); assert.equal(received.policyRevision, 2);
});

test('questions present each opaque choice and cancellation without permission grants', () => {
  const { controls } = fixture();
  const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const request = { requestId: 'question-a', policyRevision: 2, action: 'native.question', title: 'Pick <one>',
    options: [{ optionId: 'q0_first', name: 'First', kind: 'allow_once' },
      { optionId: 'q0_"second', name: '<Second>', kind: 'allow_once' }, { optionId: 'skip', name: 'Skip', kind: 'reject_once' }] };
  const html = controls.render(request, escape, { ref: 'chat-a', fullRevision: 3 });
  assert.match(html, /Pick &lt;one>/); assert.match(html, /&lt;Second>/);
  assert.match(html, /data-permission-option="q0_&quot;second"/);
  assert.deepEqual([...html.matchAll(/data-ui-value="([^"]+)"/g)].map(row => row[1]), ['answer', 'answer', 'answer', 'deny']);
  assert.doesNotMatch(html, /data-ui-value="(?:once|session|full)"|始终允许|允许一次/);
  for (const options of [[], [request.options[0], request.options[0]], Array(65).fill(request.options[0]), [{ optionId: 'x', name: 'Bad', kind: 'allow_always' }]]) {
    assert.doesNotMatch(controls.render({ ...request, options }, escape), /data-ui-value="answer"/);
  }
});

test('question selection preserves the chosen ID and cancellation sends no choice', async () => {
  for (const decision of ['answer', 'deny']) {
    const f = fixture(decision), replies = [];
    f.button.dataset.permissionOption = 'q0_"second';
    const api = { answerUi: async (ref, reply) => { replies.push({ ref, ...reply }); return { ok: true }; },
      setAccessMode() { assert.fail('answering a question cannot change access mode'); } };
    await f.controls.answer(f.button, api, 'chat-a');
    assert.deepEqual(replies, [{ ref: 'chat-a', requestId: 'request-a', policyRevision: 2, decision,
      ...(decision === 'answer' ? { optionId: 'q0_"second' } : {}) }]);
    assert.equal(f.card.hidden, true);
  }
  const f = fixture('answer'); f.button.dataset.permissionOption = 'second';
  await f.controls.answer(f.button, { answerUi: async () => ({ ok: false, reason: 'stale choice' }) }, 'chat-a');
  assert.equal(f.card.hidden, false); assert.equal(f.button.disabled, false); assert.equal(f.error.textContent, 'stale choice');
});

test('localized question attributes remain plain text so chat ownership survives HTML translation wrappers', () => {
  const f = fixture(), escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  f.window.SoduWorkI18n = { t: source => source === '请选择' ? 'Choose "one"' : source,
    html: source => '<span data-i18n="' + escape(source) + '">' + escape(source) + '</span>' };
  const html = f.controls.render({ requestId: 'question-a', policyRevision: 2, action: 'native.question', title: 'Pick one',
    options: [{ optionId: 'second', name: 'Second', kind: 'allow_once' }] }, escape, { ref: 'chat-a' });
  const opening = html.slice(0, html.indexOf('>') + 1);
  assert.match(opening, /aria-label="Choose &quot;one&quot;" data-permission-ref="chat-a">$/);
  assert.match(html, /role="group" aria-label="Choose &quot;one&quot;">/);
  assert.match(html, /<b><span data-i18n="请选择">/);
  assert.doesNotMatch(opening, /<span/);
});
