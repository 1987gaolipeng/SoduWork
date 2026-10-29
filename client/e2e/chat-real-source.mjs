// End-to-end checks against an explicitly isolated, running source desktop.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CdpPage, listPages } from './lib/cdp.mjs';
const phase = process.argv[2] || 'inspect';
const output = path.resolve('../outputs/chat-real-source');
fs.mkdirSync(output, { recursive: true });
const target = (await listPages(19223)).find(row => row.url.includes('panel=workspace'));
assert.ok(target, 'The isolated source desktop must be running');
const page = await CdpPage.connect(target);
async function click(selector) {
  const point = await page.waitFor(selector => {
    const node = document.querySelector(selector);
    if (!node || node.disabled || !node.getClientRects().length) return false;
    node.scrollIntoView({ block: 'center' });
    const r = node.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return hit && (node === hit || node.contains(hit)) ? { x, y } : false;
  }, selector, 15000);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await page.call('Input.dispatchMouseEvent', { type, ...point, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) });
}
async function fill(selector, text) {
  await click(selector);
  await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 });
  await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
  await page.call('Input.insertText', { text });
}
async function screenshot(name) {
  const result = await page.call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(result.data, 'base64'));
}
try {
  assert.equal(await page.run(() => SoduWorkAPI.hubBase()), 'http://127.0.0.1:19080');
  if (phase === 'login') {
    assert.ok(process.env.SODUWORK_E2E_PASSWORD);
    await fill('#soduWorkAuthAccount', 'e2e-owner');
    await fill('#soduWorkAuthPassword', process.env.SODUWORK_E2E_PASSWORD);
    await click('.soduwork-auth-submit');
    await page.waitFor(() => !document.querySelector('#soduWorkClientAuthGate'), null, 30000);
  } else if (phase === 'click') await click(process.argv[3]);
  else if (phase === 'pin') {
    for (const type of ['keyDown', 'keyUp']) await page.call('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape' });
    const point = await page.run(() => {
      const r = document.querySelector('[data-chat-id]')?.getBoundingClientRect();
      return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    });
    assert.ok(point);
    await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await click('.ws-chat-pin');
    await page.waitFor(() => document.querySelector('.ws-chat-pin')?.title === '取消置顶', null, 5000);
  } else if (phase === 'quit') {
    await click('#windowMenu-file');
    await click('[data-window-command="quit"]');
    console.log('Requested a normal application exit through the File menu.');
    process.exit(0);
  } else if (phase === 'process') {
    const toggle = await page.run(() => [...document.querySelectorAll('[data-turn-toggle]')].at(-1)?.dataset.turnToggle);
    assert.ok(toggle);
    const button = '[data-turn-toggle="' + toggle + '"]';
    await click(button);
    assert.equal(await page.run(selector => document.querySelector(selector).getAttribute('aria-expanded'), button), 'true');
    assert.ok(await page.run(() => [...document.querySelectorAll('.nmsg.ai > .ntext')].some(e => e.getClientRects().length && e.textContent.includes('我先核对需求和验收标准'))));
    await screenshot('expanded-real-process');
    await click(button);
    assert.equal(await page.run(selector => document.querySelector(selector).getAttribute('aria-expanded'), button), 'false');
    fs.writeFileSync(path.join(output, 'process-toggle.json'), JSON.stringify({ ok: true, realMouse: true, sourceHistoryPreserved: true }, null, 2));
  }
  else if (phase === 'send') {
    const selector = await page.run(() => document.querySelector('#nchatInput')?.getClientRects().length ? '#nchatInput' : '#cpInput');
    await fill(selector, process.argv[3] || 'E2E_CHAT_PRIMARY 请生成一份简短的交付文档，并说明结果。');
    await click(selector === '#cpInput' ? '#cpGo' : '#nchatSend');
    const live = await page.waitFor(() => {
      const visible = node => !!node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
      const prose = [...document.querySelectorAll('.nmsg.ai > .ntext')].filter(visible).find(e => e.textContent.includes('我先核对需求和验收标准'));
      return prose && document.querySelector('#nchatSend')?.title === '停止生成' ? { preambleVisible: true, crew: document.querySelectorAll('.nchat-crew').length } : false;
    }, null, 30000, 60);
    fs.writeFileSync(path.join(output, 'live.json'), JSON.stringify(live, null, 2));
    await screenshot('live-preamble');
    await page.waitFor(() => document.querySelector('#nchatSend')?.title === '发送' && document.querySelector('.nturn-summary'), null, 30000);
  } else if (phase === 'verify') {
    await page.waitFor(() => document.querySelectorAll('.nmsg.user').length > 0 &&
      document.querySelectorAll('.nturn-summary').length === document.querySelectorAll('.nmsg.user').length &&
      document.querySelector('.ndelivery'), null, 30000);
    const state = await page.run(() => {
      const visible = node => !!node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
      return {
        session: NativeChat.sessionInfo(),
        markers: [...document.querySelectorAll('.nmsg.user')].map(e => e.textContent.match(/E2E_[A-Z0-9_-]+/)?.[0]).filter(Boolean),
        users: [...document.querySelectorAll('.nmsg.user')].filter(visible).length,
        crews: [...document.querySelectorAll('.nchat-crew')].filter(visible).length,
        summaries: [...document.querySelectorAll('.nturn-summary')].filter(visible).map(e => e.innerText),
        visibleText: [...document.querySelectorAll('.nmsg.ai > .ntext')].filter(visible).map(e => e.innerText),
        hiddenPreambles: [...document.querySelectorAll('.nmsg.ai > .ntext')].filter(e => e.textContent.includes('我先核对需求和验收标准') && !visible(e)).length,
        outputs: [...document.querySelectorAll('.ndelivery [data-open-app]')].filter(visible).map(e => e.innerText),
        sidebarIcons: [...document.querySelectorAll('.ws-chat-runtime [data-agent-brand]')].map(e => e.dataset.agentBrand),
        imageErrors: [...document.querySelectorAll('.nchat-crew img,.ws-chat-runtime img')].filter(e => !e.complete || !e.naturalWidth).length,
      };
    });
    assert.ok(state.users > 0);
    assert.equal(state.crews, state.users, 'One harness identity per user turn');
    assert.equal(state.summaries.length, state.users);
    assert.ok(state.summaries.every(value => /124\s*tokens/.test(value)), 'Both real model receipts are included per turn');
    assert.ok(state.summaries.every(value => !/用时\s+0s/.test(value)), 'Persisted timings must survive reopening; fixture takes over two seconds');
    assert.equal(state.hiddenPreambles, state.users);
    assert.ok(state.visibleText.every(value => value.includes('已完成本次需求')));
    assert.ok(state.outputs.length > 0);
    assert.deepEqual(state.sidebarIcons, ['pi'], 'Repeated use is deduplicated over the conversation');
    assert.equal(state.imageErrors, 0);
    const filename = state.markers.at(-1) + '.md';
    const artifact = path.join(state.session.cwd, filename);
    assert.match(fs.readFileSync(artifact, 'utf8'), /本文件由真实 Pi 文件工具生成/);
    fs.writeFileSync(path.join(output, 'verified-' + state.users + '-turns.json'), JSON.stringify({ ok: true, state, artifact }, null, 2));
    await screenshot('completed-' + state.users + '-turns');
  }
  const snapshot = await page.run(() => ({
    text: document.body.innerText.slice(0, 8000),
    buttons: [...document.querySelectorAll('button')].filter(e => e.getClientRects().length).map(e => ({ id: e.id, text: e.innerText, title: e.title, data: { ...e.dataset } })),
    selects: [...document.querySelectorAll('select')].filter(e => e.getClientRects().length).map(e => ({ id: e.id, value: e.value, options: [...e.options].map(o => ({ value: o.value, text: o.text })) })),
    chat: window.NativeChat?.sessionInfo?.(),
  }));
  fs.writeFileSync(path.join(output, 'latest.json'), JSON.stringify(snapshot, null, 2));
  await screenshot(phase);
  console.log(JSON.stringify(snapshot));
} finally { page.close(); }
