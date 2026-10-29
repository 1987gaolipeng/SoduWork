'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
async function run({ mode, fixture, handle, js, until, click, win, report, out }) {
  async function compose(text) {
    await js(`(()=>{const i=document.querySelector('#nchatInput');i.value=${JSON.stringify(text)};i.dispatchEvent(new Event('input',{bubbles:true}));i.focus()})()`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until('document.querySelector("#nchatInput").value===""', 'input cleared');
  }
  await js('SoduWorkI18n.setLocale("zh-CN")');
  const nativeId = handle.sessionId;
  let summaryClosed;
  if (mode === 'compaction') summaryClosed = require('./fixtures/steering-lifecycle.cjs').holdCompaction(fixture);
  else fixture.reply((_body, count) => count === 1 ? { tool: 'web_search', args: { query: 'slow-tool-once' } } : { text: '本轮补充要求已完成。' });
  await compose('请检索隔离样本并完成。');
  await until(() => mode === 'compaction' ? fixture.requests.length === 3 && fixture.runtime.isCompacting
    : fs.existsSync(fixture.executed), mode + ' ready');
  await compose('页面风格保持宝石红红色主题');
  await compose('交付标准可以直接发布');
  const selected = await until(() => handle.snapshot().execution.queue.find(row => row.text === '交付标准可以直接发布'), 'selected queue id');
  const selector = '[data-queue-action="send-now"][data-queue-id="' + selected.id + '"]';
  await until(`Boolean(document.querySelector(${JSON.stringify(selector)}))&&!document.querySelector(${JSON.stringify(selector)}).disabled`, 'steer enabled');
  const started = Date.now(); await click(selector);
  if (mode === 'slowTool') {
    await until(fixture.toolAborted, 'real tool received abort');
    await until(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-busy')==='true'`, 'guide pending');
    assert.equal(await js("Boolean(document.querySelector('[data-chat-node=runtime-error].show'))"), false, 'normal stopping must not become a red runtime error');
    assert.equal(await js("Array.from(document.querySelectorAll('[data-queue-action=send-now]')).every(b=>b.disabled)"), true);
    fs.writeFileSync(path.join(out, 'steer-slow-tool-pending.png'), (await win.webContents.capturePage()).toPNG());
    // Exercise the actual production 30-second bound; do not shorten the
    // runtime timer or pretend an unresponsive tool has already stopped.
    await until(() => !handle.snapshot().execution.queueImmediate.pending, 'bounded stop timeout', 35000);
    await until(`!document.querySelector(${JSON.stringify(selector)})?.hasAttribute('aria-busy')`, 'UI leaves guiding state');
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual(handle.snapshot().execution.queue.map(row => row.text), ['页面风格保持宝石红红色主题', '交付标准可以直接发布']);
    assert.equal(handle.snapshot().execution.turnQueue.paused, true);
    await until('document.body.innerText.includes("停止尚未确认，排队消息已保留，请重试引导")', 'timeout explains retained messages');
    await js('SoduWorkI18n.setLocale("en-US")');
    await until('document.body.innerText.includes("Stopping is not confirmed")', 'timeout translated');
    fixture.releaseTool();
    await until(() => !handle.snapshot().execution.running && fixture.runtime.isIdle, 'old tool/turn actually settled');
    assert.equal(fixture.requests.length, 1, 'late finish cannot secretly send a timed-out guide');
    assert.equal(handle.snapshot().execution.turnQueue.paused, true, 'timeout guidance stays visible after a late stop');
    await until('document.body.innerText.includes("Stopping is not confirmed")', 'pause remains explained after late stop');
    await until(`!document.querySelector(${JSON.stringify(selector)}).disabled`, 'explicit retry available');
    await click(selector);
    report.cases.push('Real slow extension tool: native mouse Steer sends abort, keeps neutral progress, locks duplicate clicks, ends guiding after the actual 30s bound, preserves original queue order, translates the failure, and only dispatches after explicit retry and confirmed tool settlement.');
  }
  await until(() => fixture.requests.length === (mode === 'compaction' ? 5 : 3) && !handle.inFlight(), 'selected and later messages completed');
  if (summaryClosed) await until(summaryClosed, 'native summary connection closed');
  assert.equal(handle.sessionId, nativeId);
  assert.equal(handle.snapshot().execution.queue.length, 0);
  assert.equal(handle.snapshot().execution.turnQueue.paused, false);
  assert.equal(handle.snapshot().execution.queueImmediate.pending, false);
  assert.match(JSON.stringify(fixture.requests.at(-2).messages), /交付标准可以直接发布/);
  assert.match(JSON.stringify(fixture.requests.at(-1).messages), /页面风格保持宝石红红色主题/);
  assert.equal(fs.readFileSync(fixture.executed, 'utf8').trim().split('\n').length, 1);
  await until("!document.querySelector('[data-queue-action=send-now][aria-busy=true]')", 'no stuck guide');
  assert.equal(await js("Boolean(document.querySelector('[data-chat-node=runtime-error].show'))"), false);
  fs.writeFileSync(path.join(out, 'steer-' + mode + '-complete.png'), (await win.webContents.capturePage()).toPNG());
  if (mode === 'compaction') report.cases.push('Real native context-overflow summary interrupted by mouse Steer: summary connection closes, original queued prompts execute once in selected-first order, one completed tool preserved, same session, no error or stuck guiding. Completed in ' + (Date.now() - started) + 'ms.');
}
module.exports = { run };
