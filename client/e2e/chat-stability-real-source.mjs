// Real source desktop only: user input uses CDP mouse/keyboard events; reads use
// production read-only snapshot IPC. Never inject conversation or title state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CdpPage, listPages } from './lib/cdp.mjs';
const phase = process.argv[2] || 'baseline';
const dir = path.resolve('../outputs/chat-stability-real-source');
fs.mkdirSync(dir, { recursive: true });
const page = await CdpPage.connect((await listPages(19223)).find(row => row.url.includes('panel=workspace')));
async function click(selector) {
  const point = await page.waitFor(selector => {
    const node = document.querySelector(selector);
    if (!node || node.disabled || !node.checkVisibility()) return false;
    node.scrollIntoView({ block: 'center' });
    const r = node.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return hit && (hit === node || node.contains(hit)) ? { x, y } : false;
  }, selector, 15000);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await page.call('Input.dispatchMouseEvent',
    { type, ...point, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) });
}
async function read() {
  return page.run(async () => {
    const info = NativeChat.sessionInfo(), result = await soduWorkAPI.conversationSession.snapshot(info.ref);
    const snapshot = result.snapshot;
    const row = [...document.querySelectorAll('[data-chat-id]')].find(e => e.dataset.chatId === info.sessionId);
    return { at: Date.now(), sessionId: info.sessionId, title: info.title, header: document.querySelector('#nchatTitle')?.textContent,
      sidebar: row?.querySelector('.ws-chat-title')?.textContent || row?.textContent,
      summaries: [...document.querySelectorAll('.nturn-summary')].map(e => e.textContent.replace(/\s+/g, ' ').trim()),
      elapsed: (snapshot.turnMetrics || []).map(row => row.elapsedMs), metrics: snapshot.turnMetrics,
      messageCount: snapshot.messages.length, status: snapshot.status,
      markers: snapshot.messages.filter(row => row.role === 'user').map(row => row.text?.match(/E2E_[A-Z0-9_-]+/)?.[0]).filter(Boolean) };
  });
}
try {
  assert.equal(await page.run(() => SoduWorkAPI.hubBase()), 'http://127.0.0.1:19080');
  if (phase.startsWith('open')) {
    const baseline = JSON.parse(fs.readFileSync(path.join(dir, 'baseline.json'), 'utf8'));
    await click('[data-chat-id="' + baseline.sessionId + '"]');
    await page.waitFor(id => NativeChat.sessionInfo().sessionId === id && document.querySelectorAll('.nturn-summary').length > 0,
      baseline.sessionId, 15000);
  } else if (phase.startsWith('switch')) {
    const baseline = JSON.parse(fs.readFileSync(path.join(dir, 'baseline.json'), 'utf8'));
    await click('button[data-view="create"]');
    await page.waitFor(() => !NativeChat.sessionInfo().ref, null, 10000);
    await click('[data-chat-id="' + baseline.sessionId + '"]');
    await page.waitFor(id => NativeChat.sessionInfo().sessionId === id && document.querySelectorAll('.nturn-summary').length > 0,
      baseline.sessionId, 15000);
  } else if (phase === 'rename') {
    for (const type of ['keyDown', 'keyUp']) await page.call('Input.dispatchKeyEvent', { type, key: 'r', code: 'KeyR', modifiers: 3 });
    await click('input.nchat-rename-input');
    for (const type of ['keyDown', 'keyUp']) await page.call('Input.dispatchKeyEvent',
      { type, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 });
    assert.ok(await page.run(() => {
      const input = document.querySelector('input.nchat-rename-input');
      return input.selectionStart === 0 && input.selectionEnd === input.value.length;
    }), 'The native select-all shortcut must select the existing name before replacement');
    await page.call('Input.insertText', { text: 'E2E 稳定标题 · 手动命名' });
    await click('.nchat-rename-form button[type="submit"]');
    await page.waitFor(() => !document.querySelector('.nchat-rename-dialog'), null, 15000);
    await page.waitFor(() => document.querySelector('#nchatTitle')?.textContent === 'E2E 稳定标题 · 手动命名', null, 10000);
  }
  await page.waitFor(() => document.querySelector('#nchatSend')?.title === '发送' && document.querySelector('.nturn-summary'), null, 15000);
  const state = await read();
  if (phase !== 'baseline' && phase !== 'rename') {
    const baseline = JSON.parse(fs.readFileSync(path.join(dir, 'baseline.json'), 'utf8'));
    const named = phase.endsWith('renamed') ? JSON.parse(fs.readFileSync(path.join(dir, 'rename.json'), 'utf8')) : baseline;
    assert.equal(state.sessionId, baseline.sessionId);
    assert.deepEqual(state.elapsed, baseline.elapsed, 'Completed receipt milliseconds stay fixed');
    // Live and archived statistics use different span boundaries/CSS gaps.
    // Compare their rendered values without treating text-node whitespace as time.
    const values = rows => rows.map(value => value.replace(/\s+/g, ''));
    assert.deepEqual(values(state.summaries), values(baseline.summaries), 'Visible completed timings stay fixed');
    assert.equal(state.header, named.header, 'Header stays fixed');
    assert.equal(state.sidebar, named.sidebar, 'Sidebar title stays fixed');
  }
  assert.ok(state.elapsed.at(-1) >= 1500 && state.elapsed.at(-1) < 15000, 'Actual local fixture turn duration, without idle time');
  fs.writeFileSync(path.join(dir, phase + '.json'), JSON.stringify({ ...state, ok: true }, null, 2));
  const screenshot = await page.call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(dir, phase + '.png'), Buffer.from(screenshot.data, 'base64'));
  console.log(JSON.stringify({ ok: true, phase, elapsed: state.elapsed, summaries: state.summaries, header: state.header }));
} finally { page.close(); }
