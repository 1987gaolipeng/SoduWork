import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CdpPage, listPages } from './lib/cdp.mjs';
const dir = process.env.SODUWORK_E2E_EVIDENCE;
if (!dir) throw Error('SODUWORK_E2E_EVIDENCE required');
fs.mkdirSync(dir, { recursive: true });
const p = await CdpPage.connect((await listPages(Number(process.env.SODUWORK_CDP_PORT || 9346))).find(x =>
  process.env.SODUWORK_E2E_TARGET_ID ? x.id === process.env.SODUWORK_E2E_TARGET_ID : x.url.includes('panel=workspace')));
const results = [];
async function click(selector) {
  const point = await p.run(selector => {
    const el = document.querySelector(selector); if (!el) throw Error('Missing ' + selector);
    el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, selector);
  await p.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await p.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
}
async function shot(name) {
  const image = await p.call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(dir, name + '.png'), Buffer.from(image.data, 'base64'));
}
async function send(text, initial = false) {
  await p.run(({ text, initial }) => { const e = document.querySelector(initial ? '#cpInput' : '#nchatInput');
    if (!e) throw Error('Composer missing'); e.value = text; e.dispatchEvent(new Event('input', { bubbles: true }));
  }, { text, initial });
  await click(initial ? '#cpGo' : '#nchatSend');
}
const snapshot = () => p.run(async () => (await soduWorkAPI.conversationSession.snapshot(NativeChat.sessionInfo().ref)).snapshot);
async function idle() { return p.waitFor(() => NativeChat.hasSession() && !NativeChat.isBusy(), null, 150000); }
async function geometry() {
  return p.run(() => {
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, right: r.right, bottom: r.bottom }; };
    const fonts = [...document.querySelectorAll('#nchatQueue *,#nchatModel *,#nchatMeta *')].filter(e =>
      e.getBoundingClientRect().height && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())).map(e => parseFloat(getComputedStyle(e).fontSize));
    return { input: rect('#nchatInput'), box: rect('.nbox'), model: rect('#nchatModel'), ring: rect('#nchatMeta'),
      minFont: Math.min(...fonts), overflow: document.documentElement.scrollWidth > innerWidth };
  });
}
try {
  await p.waitFor(() => window.NativeChat && window.SoduWorkAPI?.online, null, 20000);
  if (await p.run(() => NativeChat.isBusy())) throw Error('User session busy; test cancelled');
  await click('.ws-nav-item[data-view="create"]');
  await send('这是独立的界面回归测试。只回复“普通对话测试通过”。不使用工具、不修改文件。', true);
  await p.waitFor(() => NativeChat.sessionInfo().ref, null, 45000);
  await idle();
  let snap = await snapshot();
  assert.ok(snap.messages.some(m => m.role === 'assistant'));
  assert.equal(snap.modelSelection.name !== undefined, true);
  const info = await p.run(() => NativeChat.sessionInfo());
  fs.writeFileSync(path.join(dir, 'test-session.json'), JSON.stringify({ sessionId: info.sessionId, ref: info.ref }));
  results.push({ name: 'ordinary-chat', sessionId: info.sessionId, passed: true });
  console.log('PASS ordinary conversation');
  await p.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await shot('01-empty-queue');
  let g = await geometry();
  assert.ok(g.ring.right <= g.model.x + 1); assert.ok(g.minFont >= 12); assert.equal(g.overflow, false);
  results.push({ name: 'empty-geometry', ...g });
  await click('#nchatModel>.nmodel-button');
  await p.waitFor(() => document.querySelectorAll('[data-model-name]').length > 1, null, 15000);
  await shot('02-model-selector');
  const modelNames = await p.run(() => [...document.querySelectorAll('[data-model-name]')].map(e => e.dataset.modelName));
  const selected = modelNames.find(name => name && name !== snap.modelSelection.activeModel.id);
  assert.ok(selected);
  await click('[data-model-close]');
  // A real tool turn creates enough time to inspect and reorder several follow-ups.
  await send('仅执行一次 node -e "setTimeout(()=>console.log(\'WAIT-DONE\'),45000)"，等待结束后只回复 WAIT-DONE。不要读写文件。');
  await p.waitFor(async () => {
    const s = (await soduWorkAPI.conversationSession.snapshot(NativeChat.sessionInfo().ref)).snapshot;
    return s.tools.some(t => t.state === 'running') || s.runtimeError;
  }, null, 60000);
  snap = await snapshot();
  assert.ok(snap.tools.some(t => t.state === 'running'), 'real tool should run');
  await send('只回复 QUEUE-FIRST，不使用工具。');
  await send('只回复 QUEUE-SECOND，不使用工具。');
  await send('这条会被移除，不要执行。');
  await p.waitFor(async () => (await soduWorkAPI.conversationSession.snapshot(NativeChat.sessionInfo().ref)).snapshot.execution.queue.length === 3, null, 10000);
  let queued = (await snapshot()).execution.queue;
  const first = queued[0].id, second = queued[1].id, removed = queued[2].id;
  await click('[data-queue-action="remove"][data-queue-id="' + removed + '"]');
  await click('[data-queue-action="edit"][data-queue-id="' + first + '"]');
  await p.run(() => { document.querySelector('#nqueueEditText').value = '只回复 QUEUE-FIRST-EDITED，不使用工具。'; });
  await click('[data-queue-action="save-edit"]');
  await p.waitFor(async () => (await soduWorkAPI.conversationSession.snapshot(NativeChat.sessionInfo().ref)).snapshot.execution.queue[0]?.text.includes('EDITED'), null, 5000);
  const points = await p.run(({ first, second }) => {
    const a = document.querySelector('[data-queue-row="' + second + '"] .nqueue-grip').getBoundingClientRect();
    const b = document.querySelector('[data-queue-row="' + first + '"]').getBoundingClientRect();
    return { from: { x: a.x + a.width / 2, y: a.y + a.height / 2 }, to: { x: a.x + a.width / 2, y: b.y + 5 } };
  }, { first, second });
  await p.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...points.from });
  await p.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...points.from });
  for (let n = 1; n <= 12; n++) await p.call('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1,
    x: points.from.x, y: points.from.y + (points.to.y - points.from.y) * n / 12 });
  await p.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', ...points.to });
  await p.waitFor(async second => (await soduWorkAPI.conversationSession.snapshot(NativeChat.sessionInfo().ref)).snapshot.execution.queue[0]?.id === second, second, 6000);
  await shot('03-dragged-queue');
  results.push({ name: 'real-drag-edit-remove', passed: true, order: (await snapshot()).execution.queue.map(row => row.id) });
  console.log('PASS real drag, edit and removal');
  await click('[data-queue-action="add"]');
  await p.waitFor(() => document.querySelector('[data-collab-search]'), null, 10000);
  await click('[data-collab-picker-close]');
  await click('#nchatModel>.nmodel-button');
  await p.waitFor(() => document.querySelectorAll('[data-model-name]').length > 1, null, 10000);
  await click('[data-model-name="' + selected + '"]');
  await p.waitFor(() => document.querySelector('.nmodel-pop').hidden, null, 15000);
  assert.notEqual((await snapshot()).modelSelection.activeName, selected, 'current turn must not switch mid-stream');
  await click('#nchatMeta');
  await shot('04-context-usage');
  g = await geometry(); assert.ok(g.minFont >= 12); assert.equal(g.overflow, false);
  await click('#nchatMeta');
  await p.call('Emulation.setDeviceMetricsOverride', { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
  await shot('05-compact-layout');
  g = await geometry(); assert.ok(g.minFont >= 12); assert.equal(g.overflow, false);
  await p.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await idle();
  snap = await snapshot();
  const userTurns = snap.messages.filter(m => m.role === 'user').map(m => m.text || '');
  assert.ok(userTurns.indexOf('只回复 QUEUE-SECOND，不使用工具。') < userTurns.indexOf('只回复 QUEUE-FIRST-EDITED，不使用工具。'));
  assert.equal(userTurns.includes('这条会被移除，不要执行。'), false);
  results.push({ name: 'execution-order', passed: true });
  console.log('PASS execution order');
  await shot('06-completed');
  await send('模型切换验证：仅回复 MODEL-SWITCH-PASS，不使用工具，不创建任务。');
  await p.waitFor(async selected => (await soduWorkAPI.conversationSession.snapshot(NativeChat.sessionInfo().ref)).snapshot.modelSelection.activeName === selected, selected, 15000);
  await idle();
  snap = await snapshot();
  assert.ok(snap.messages.some(m => m.role === 'assistant' && JSON.stringify(m.blocks || m.text).includes('MODEL-SWITCH-PASS')));
  assert.equal((await p.run(() => NativeChat.sessionInfo())).sessionId, info.sessionId);
  results.push({ name: 'different-model-same-conversation', selected, passed: true });
  console.log('PASS different model, same conversation and history');
  const sessionId = info.sessionId;
  await p.call('Page.reload', { ignoreCache: true });
  await p.waitFor(() => window.NativeChat, null, 15000);
  await p.waitFor(id => document.querySelector('.ws-chat[data-chat-id="' + id + '"]'), sessionId, 15000);
  await click('.ws-chat[data-chat-id="' + sessionId + '"]');
  await p.waitFor(id => NativeChat.sessionInfo().sessionId === id, sessionId, 20000);
  assert.equal((await snapshot()).modelSelection.name, selected);
  results.push({ name: 'reload-model-and-history', passed: true });
  await shot('07-restored');
  await click('[data-queue-action="add"]');
  await p.waitFor(() => document.querySelector('[data-collab-search]'), null, 10000);
  await shot('08-add-task');
  await click('[data-collab-picker-close]');
  results.push({ name: 'add-task-picker', passed: true });
  const errors = p.takeRuntimeErrors();
  results.push({ name: 'runtime-errors', errors });
  console.log(JSON.stringify(results));
} catch (error) {
  results.push({ error: String(error.stack || error) }); await shot('failure').catch(() => {}); process.exitCode = 1;
  console.error(error.message);
} finally {
  await p.call('Emulation.clearDeviceMetricsOverride').catch(() => {});
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(results, null, 2)); p.close();
}
