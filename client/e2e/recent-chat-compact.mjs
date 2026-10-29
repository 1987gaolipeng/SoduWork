import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CdpPage, listPages, delay } from './lib/cdp.mjs';

// Run against an isolated source-client workspace, never the user's active window.
const [targetId, outputDir] = process.argv.slice(2);
assert.ok(targetId && outputDir, 'Pass an isolated target ID and evidence directory');
const target = (await listPages(Number(process.env.CDP_PORT || 9347)))
  .find(row => row.id === targetId && row.url.includes('panel=workspace&view=create'));
assert.ok(target, 'An explicitly selected isolated workspace is required');
const page = await CdpPage.connect(target);
const checks = [];
const fixtureIds = ['normal', 'task', 'running', 'waiting', 'failed'].map(x => 'sidebar-layout-' + x);
const geometry = async () => page.run(() => [...document.querySelectorAll('.ws-chat')].map(b => {
  const title = b.querySelector('.ws-chat-title');
  const agent = b.querySelector('.ws-chat-runtime');
  const rect = b.getBoundingClientRect();
  const tr = title.getBoundingClientRect(), ar = agent.getBoundingClientRect();
  return { id: b.dataset.chatId, task: b.dataset.taskSession,
    left: tr.left - rect.left, right: rect.right - ar.right, gap: ar.left - tr.right,
    width: tr.width, height: rect.height, font: getComputedStyle(title).fontSize,
    agentFont: getComputedStyle(agent).fontSize,
    dot: getComputedStyle(b.querySelector('.st-chat')).display,
    actions: getComputedStyle(b.parentElement.querySelector('.ws-chat-actions')).opacity,
    x: rect.x, y: rect.y, rowWidth: rect.width };
}));
async function screenshot(name) {
  const clip = await page.run(() => {
    const r = document.querySelector('.ws-side').getBoundingClientRect();
    return { x:r.x, y:r.y, width:r.width, height:Math.min(innerHeight, r.height), scale:1 };
  });
  const result = await page.call('Page.captureScreenshot', { format:'png', clip });
  await fs.writeFile(path.join(outputDir, name + '.png'), Buffer.from(result.data, 'base64'));
}
async function move(x, y) {
  await page.call('Input.dispatchMouseEvent', { type:'mouseMoved', x, y });
  await delay(180);
}
try {
  await fs.mkdir(outputDir, { recursive:true });
  await page.call('Emulation.setDeviceMetricsOverride', { width:1440, height:960, deviceScaleFactor:1, mobile:false });
  await page.waitFor(() => document.querySelectorAll('.ws-chat').length > 0);
  await page.run(() => document.documentElement.style.setProperty('--ws-side-w', '280px'));
  await move(600, 100);
  const initial = await geometry();
  assert.ok(initial.every(r => r.font === '14px' && r.agentFont === '13px'));
  assert.equal(await page.run(() => document.querySelectorAll('.ws-chat-task').length), 0);
  checks.push('Actual history: title 14px, Agent 13px, no collaboration icons');
  await screenshot('01-recent-chats');

  // Actual single-click navigation: no message is sent and no history is deleted.
  const chat = await page.run(() => [...document.querySelectorAll('.ws-chat')]
    .find(b => b.dataset.taskSession === '0' && b.classList.contains('is-completed'))?.dataset.chatId);
  assert.ok(chat, 'An ordinary completed history entry is required');
  const hit = await page.run(id => {
    const b = [...document.querySelectorAll('.ws-chat')].find(b => b.dataset.chatId === id);
    b.scrollIntoView({block:'nearest'});
    const r = b.getBoundingClientRect(); return {x:r.x+40, y:r.y+r.height/2};
  }, chat);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.call('Input.dispatchMouseEvent', {type, button:'left', clickCount:1, ...hit});
  }
  await page.waitFor(id => NativeChat.sessionInfo()?.sessionId === id, chat);
  checks.push('Actual ordinary conversation opens with one click');

  // Memory-only visual states: these do not create tasks, conversations or executions.
  await page.run(ids => {
    const states = ['completed', 'completed', 'running', 'waiting', 'failed'];
    const titles = ['分析产品需求，梳理交互与验收标准', '企业网站改版：页面开发与测试', '正在生成本周项目进展报告', '发布前确认：等待补充审核意见', '接口验证未通过，查看原因'];
    ids.forEach((id,i) => WorkspaceShell.upsertChat({ id, localId:id, title:titles[i],
      state:states[i], adapterId:i === 1 ? 'codex' : i === 4 ? 'opencode' : 'pi',
      taskId:i === 1 ? 'sidebar-layout-task' : undefined, updatedAt:Date.now()+i }));
    document.querySelector('#wsChatsBox .ws-list-body').scrollTop = 0;
  }, fixtureIds);
  await move(600,100);
  const wide = (await geometry()).filter(r => fixtureIds.includes(r.id));
  assert.equal(wide.length, 5);
  const ordinary = wide.find(r => r.id === fixtureIds[0]);
  const task = wide.find(r => r.id === fixtureIds[1]);
  assert.equal(ordinary.left, task.left);
  assert.equal(task.task, '1', 'Task routing metadata must remain intact');
  assert.equal(ordinary.dot, 'none');
  assert.equal(task.dot, 'none');
  assert.ok(wide.slice().filter(r => fixtureIds.slice(2).includes(r.id)).every(r => r.dot === 'block'));
  assert.ok(wide.every(r => r.height === 38 && r.right <= 11 && Math.abs(r.gap - 8) < .01), JSON.stringify(wide));
  assert.ok(ordinary.left <= 11 && ordinary.width > 210);
  checks.push('Ordinary/task alignment, live status indicators, compact gaps and fixed row height');
  await screenshot('02-conversation-states');

  const order = await page.run(() => [...document.querySelectorAll('.ws-chat')].map(b => b.dataset.chatId));
  await move(ordinary.x + 50, ordinary.y + 19);
  const hovered = (await geometry()).find(r => r.id === ordinary.id);
  assert.equal(hovered.actions, '1');
  assert.equal(hovered.width, ordinary.width);
  assert.equal(hovered.left, ordinary.left);
  const hoverHit = await page.run(id => {
    const b = [...document.querySelectorAll('.ws-chat')].find(b => b.dataset.chatId === id);
    const pin = b.parentElement.querySelector('.ws-chat-pin');
    const r = pin.getBoundingClientRect();
    return {hit:pin.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)), size:r.width};
  }, ordinary.id);
  assert.ok(hoverHit.hit && hoverHit.size >= 24);
  await screenshot('03-hover-actions');
  await move(600,100);
  await page.run(id => {
    const b = [...document.querySelectorAll('.ws-chat')].find(b => b.dataset.chatId === id);
    b.parentElement.querySelector('.ws-chat-pin').focus();
  }, task.id);
  await delay(180);
  assert.equal((await geometry()).find(r => r.id === task.id).actions, '1');
  assert.deepEqual(await page.run(() => [...document.querySelectorAll('.ws-chat')].map(b => b.dataset.chatId)), order);
  checks.push('Hover and keyboard actions are reachable, do not reflow or reorder rows');

  await page.run(() => { document.activeElement?.blur(); document.documentElement.style.setProperty('--ws-side-w','220px'); });
  const narrow = (await geometry()).filter(r => fixtureIds.includes(r.id));
  assert.ok(narrow.every(r => r.width > 65 && r.right <= 11 && Math.abs(r.gap - 8) < .01));
  await screenshot('04-narrow-sidebar');
  checks.push('220px sidebar retains titles and Agent labels without overflow');
  const errors = page.takeRuntimeErrors();
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(outputDir,'report.json'), JSON.stringify({ checks, initial, wide, narrow, errors },null,2));
  console.log(JSON.stringify({pass:checks.length, checks, outputDir}));
} finally {
  await page.run(ids => ids.forEach(id => WorkspaceShell.removeChat(id)), fixtureIds).catch(() => {});
  page.close();
}
