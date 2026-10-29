// Continue an explicitly prepared E2E workflow through real UI approval and queue recovery.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CdpPage, listPages } from './lib/cdp.mjs';

const [targetId, taskId, runId, evidence] = process.argv.slice(2);
if (!targetId || !taskId || !runId || !evidence) throw Error('Explicit isolated target, task, run and evidence required');
const p = await CdpPage.connect((await listPages(9347)).find(x => x.id === targetId));
const report = { taskId, runId, checks: [] };
const card = '#composePanel.show [data-task-confirmation="' + taskId + '"]';
const marker = 'PLUGIN-FLOW-QUEUE-PASS';
const shot = async name => {
  const r = await p.call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(evidence, name + '.png'), Buffer.from(r.data, 'base64'));
};
async function click(selector) {
  await p.waitFor(s => {
    const e = document.querySelector(s); return e && !e.disabled && e.getClientRects().length;
  }, selector, 30000);
  const pos = await p.run(async s => {
    const e = document.querySelector(s); e.scrollIntoView({ block: 'center' });
    await new Promise(requestAnimationFrame);
    const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
    if (!e.contains(document.elementFromPoint(x, y))) throw Error('Control obscured: ' + s);
    return { x, y };
  }, selector);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await p.call('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...pos });
  }
}
async function waitingState() {
  return p.run(async ({ taskId, runId, marker }) => {
    const run = await SoduWorkAPI.taskPluginRun(runId);
    const s = (await soduWorkAPI.conversationSession.snapshot(NativeChat.sessionInfo().ref)).snapshot;
    return {
      conversationId: NativeChat.sessionInfo().sessionId,
      nodes: run.nodes.map(n => ({ key: n.key, state: n.state, error: n.error })),
      queued: (s.execution?.queue || s.queue || []).some(q => q.text.includes(marker)),
      answered: s.messages.some(m => m.role === 'assistant' && m.blocks?.some(b => b.kind === 'text' && b.text.includes(marker))),
      tools: s.tools.length, messageCount: s.messages.length,
      uniqueTools: new Set(s.tools.map(t => t.id)).size === s.tools.length,
      taskMessages: s.messages.filter(m => m.taskId === taskId).length,
      inputFiles: s.messages.find(m => m.taskId === taskId && m.role === 'user')?.attachments.map(a => a.name || a.filename),
    };
  }, { taskId, runId, marker });
}
try {
  const task = await p.run(id => SoduWorkAPI.getTask(id), taskId);
  assert.match(task.title, /^E2E/, 'Never decide a business task approval');
  const run = await p.run(id => SoduWorkAPI.taskPluginRun(id).then(r => ({
    taskId: r.taskId, plugin: r.plugin, bindingId: r.bindingId, pluginVersionId: r.pluginVersionId,
  })), runId);
  assert.equal(run.taskId, taskId);
  report.plugin = run;
  report.conversationId = (await waitingState()).conversationId;
  await p.waitFor(s => document.querySelector(s + ' [data-tfd-approval-action="approve"]'), card, 30000);
  const before = await waitingState();
  assert.ok(before.nodes.some(n => n.key === 'accept' && n.state === 'waiting_human'));
  assert.ok(!before.nodes.some(n => n.key === 'publish'));
  assert.ok(before.queued && !before.answered && before.uniqueTools);
  assert.ok(before.tools > 0 && before.taskMessages > 3);
  assert.ok(before.inputFiles.includes('meeting-source.txt'));
  await p.run(s => document.querySelector(s).scrollIntoView({ block: 'center' }), card);
  await shot('05-inline-approval');
  report.checks.push('Live ordinary-message transcript, tools and original uploaded attachment retained');

  await click(card + ' [data-tfd-approval-action="reject"]');
  assert.ok(await p.run(s => {
    const e = document.querySelector(s); return !e.querySelector('[data-tfd-approval-error]').hidden &&
      document.activeElement === e.querySelector('textarea');
  }, card));
  await p.call('Input.insertText', { text: 'E2E：已逐项核对隔离测试材料与 DOCX、XLSX，未决定的事项保留为待确认。' });
  await click(card + ' details summary');
  await click(card + ' .tfd-inline-proof summary');
  const geometry = await p.run(s => {
    const e = document.querySelector(s), r = e.getBoundingClientRect();
    return { fits: r.x >= 0 && r.right <= innerWidth + 1,
      tiny: [...e.querySelectorAll('*')].filter(x => x.textContent.trim() && x.getClientRects().length &&
        parseFloat(getComputedStyle(x).fontSize) < 12).map(x => x.className),
      modal: !!e.closest('[aria-modal="true"]') };
  }, card);
  assert.ok(geometry.fits && !geometry.modal); assert.deepEqual(geometry.tiny, []);
  await shot('06-approval-evidence');
  report.checks.push('Inline evidence expands without navigation; rejection needs a note; text >=12px');

  await p.call('Page.reload', { ignoreCache: true });
  await p.waitFor(() => window.SoduWorkAPI?.online, null, 30000);
  await click('.ws-chat[data-chat-id="' + report.conversationId + '"]');
  await p.waitFor(id => NativeChat.sessionInfo().sessionId === id, report.conversationId, 20000);
  await p.waitFor(s => document.querySelector(s + ' [data-tfd-approval-action="approve"]'), card, 30000);
  const restored = await waitingState();
  assert.ok(restored.queued && !restored.answered && restored.uniqueTools);
  assert.equal(restored.tools, before.tools);
  assert.equal(restored.messageCount, before.messageCount);
  assert.ok(restored.nodes.some(n => n.key === 'accept' && n.state === 'waiting_human'));
  assert.ok(!restored.nodes.some(n => n.key === 'publish'));
  report.checks.push('Reload and one-click chat history restore exact transcript, gate and blocked queue');

  await click(card + ' [data-tfd-approval-action="approve"]');
  await p.waitFor(async id => {
    const r = await SoduWorkAPI.taskPluginRun(id); return r.state === 'succeeded';
  }, runId, 120000);
  await p.waitFor(async marker => {
    const s = (await soduWorkAPI.conversationSession.snapshot(NativeChat.sessionInfo().ref)).snapshot;
    return !NativeChat.isBusy() && s.messages.some(m => m.role === 'assistant' &&
      m.blocks?.some(b => b.kind === 'text' && b.text.includes(marker)));
  }, marker, 90000);
  const final = await waitingState();
  assert.equal(final.conversationId, report.conversationId);
  assert.ok(final.nodes.length === 5 && final.nodes.every(n => n.state === 'succeeded'));
  assert.ok(final.answered && !final.queued && final.uniqueTools);
  report.checks.push('Only explicit approval releases publish and then the queued ordinary turn');
  await shot('07-workflow-complete');
  report.result = final;
  // Chromium diagnostics can contain signed WebSocket query parameters.
  // Evidence must never persist or print those ephemeral credentials.
  report.runtimeErrors = p.takeRuntimeErrors().map(value => String(value).replace(
    /([?&](?:session|token|ticket|secret|key|authorization)=)[^&\s'"<>]+/gi, '$1[redacted]'));
  report.connectionRecovered = await p.run(() => Boolean(SoduWorkAPI.online));
  report.pass = true;
  console.log(JSON.stringify(report));
} catch (error) {
  report.error = String(error.stack || error); await shot('workflow-ui-failure');
  console.error(report.error); process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(evidence, 'workflow-ui-results.json'), JSON.stringify(report, null, 2));
  p.close();
}
