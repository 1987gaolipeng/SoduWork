import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CdpPage, listPages } from './lib/cdp.mjs';

const port = Number(process.env.SODUWORK_E2E_CDP || 9345);
const evidence = process.env.SODUWORK_E2E_EVIDENCE;
if (!evidence) throw new Error('Set SODUWORK_E2E_EVIDENCE to a dedicated screenshot directory');
const p = await CdpPage.connect((await listPages(port)).find(x => x.url.includes('panel=workspace')));
const token = Date.now();
const records = [];
const ids = [];
const step = async (name, fn) => { const result = await fn(); records.push({ name, result }); console.log('PASS ' + name + ' ' + JSON.stringify(result)); return result; };
async function shot(name) {
  const image = await p.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(evidence + '/' + name + '.png', Buffer.from(image.data, 'base64'));
}
async function send(text, initial = false) {
  await p.run(({ text, initial }) => {
    const input = document.querySelector(initial ? '#cpInput' : '#nchatInput');
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector(initial ? '#cpGo' : '#nchatSend').click();
  }, { text, initial });
}
async function createTask(suffix, note) {
  const title = 'E2E serial ' + token + ' ' + suffix;
  await send('/创建任务 创建一个简单的回归验证任务，只返回指定标记。');
  await p.waitFor(() => document.querySelector('#workEntryLayer.show #wesTaskDraft #cpTitle'), null, 90000);
  await p.run(({title,note}) => {
    const host = document.querySelector('#wesTaskDraft');
    host.querySelector('[data-selbtn="who"]').click();
    host.querySelector('[data-selv="who|me"]').click();
    for (const [selector,value] of [['#cpTitle',title],['#cpNote',note]]) {
      const input = host.querySelector(selector);
      input.value = value; input.dispatchEvent(new Event('input',{bubbles:true}));
    }
    // A generated checklist is editable, and must match this isolated smoke test.
    host.querySelectorAll('.cp-ck-t').forEach(input => {
      input.value = 'Return the specified marker in the current conversation.';
      input.dispatchEvent(new Event('input',{bubbles:true}));
    });
  }, {title,note});
  await shot('draft-' + suffix);
  await p.run(() => document.querySelector('#wesTaskDraft #cpCreate').click());
  const task = await p.waitFor(async title => {
    const matches = (await SoduWorkAPI.getTasks()).filter(t => t.title === title);
    if (matches.length !== 1) return false;
    const t = matches[0];
    return NativeChat.sessionInfo().taskIds.includes(t.id) && !document.querySelector('#workEntryLayer.show')
      ? {id:t.id,title:t.title,status:t.status,conversationId:NativeChat.sessionInfo().sessionId} : false;
  }, title, 20000);
  ids.push(task.id);
  return task;
}
async function startPin(id) {
  await p.run(id => document.querySelector('[data-collab-task-select="' + id + '"]').click(), id);
  await p.waitFor(() => document.querySelector('[data-collab-dossier] [data-collab-action="start"]'), null, 5000);
  await p.run(() => document.querySelector('[data-collab-dossier] [data-collab-action="start"]').click());
  await p.waitFor(() => document.querySelector('#nchatTaskAgent'), null, 8000);
  await p.run(() => {
    const select = document.querySelector('#nchatTaskAgent');
    const option = [...select.options].find(o => /:pi$/.test(o.value));
    if (!option) throw new Error('Pi unavailable');
    select.value = option.value;
    document.querySelector('[data-task-start-dispatch]').click();
  });
}
try {
  await p.call('Page.reload',{ignoreCache:true});
  await p.waitFor(() => document.querySelector('.ws-nav-item[data-view="create"]'), null, 15000);
  await p.run(() => document.querySelector('.ws-nav-item[data-view="create"]').click());
  await step('ordinary-real-chat', async () => {
    const count = await p.run(async () => (await SoduWorkAPI.getTasks()).length);
    await send('Reply exactly SODUWORK-CHAT-PASS. Do not use tools.', true);
    await p.waitFor(() => document.querySelector('#nchatList')?.innerText.includes('SODUWORK-CHAT-PASS') &&
      document.querySelector('#nchatList .nmsg.ai'), null, 90000);
    const info = await p.run(async () => ({...NativeChat.sessionInfo(),taskCount:(await SoduWorkAPI.getTasks()).length}));
    assert.equal(info.collaboration,false); assert.equal(info.taskCount,count);
    await shot('ordinary-real-chat'); return {conversationId:info.sessionId};
  });
  const original = records[0].result.conversationId;
  const first = await step('ordinary-upgraded-with-task', () => createTask('A',
    'For this isolated smoke test only: use the terminal once to wait 25 seconds (PowerShell Start-Sleep -Seconds 25), then reply exactly SODUWORK-SERIAL-A. Do not modify files, use network, or perform other work.'));
  assert.equal(first.conversationId,original);
  const second = await step('second-task-same-conversation', () => createTask('B',
    'Reply exactly SODUWORK-SERIAL-B. Do not use tools, modify files, or access network.'));
  assert.equal(second.conversationId,original);
  await startPin(first.id);
  await p.waitFor(async id => {
    const run=await SoduWorkAPI.aiSession(id,0); return run.ok && run.startedAt && !run.finishedAt;
  }, first.id,20000);
  await startPin(second.id);
  await step('second-task-queued', async () => {
    await p.waitFor(id => document.querySelector('[data-collab-task-select="'+id+'"] .is-queued'),second.id,7000);
    const r=await p.run(async id=>{const r=await SoduWorkAPI.aiSession(id,0);return {started:!!r.startedAt};},second.id);
    assert.equal(r.started,false); await shot('serial-queued'); return r;
  });
  await step('serial-execution-completed', async () => {
    await p.waitFor(async ids => {
      const runs=await Promise.all(ids.map(id=>SoduWorkAPI.aiSession(id,0)));
      return runs.every(r=>r.ok&&r.finishedAt)&&document.querySelector('#nchatList')?.innerText.includes('SODUWORK-SERIAL-B');
    },ids,100000);
    const runs=await p.run(async ids=>Promise.all(ids.map(async id=>{const r=await SoduWorkAPI.aiSession(id,0);return {taskId:id,status:r.status,startedAt:r.startedAt,finishedAt:r.finishedAt,workflowRunId:r.workflowRunId,ref:r.ref};})),ids);
    assert.ok(Date.parse(runs[1].startedAt)>=Date.parse(runs[0].finishedAt),'second run overlapped the first');
    assert.ok(runs.every(r=>!r.workflowRunId),'explicit direct unexpectedly became a workflow');
    await shot('serial-completed'); return runs;
  });
  await step('refresh-and-single-click-restore',async()=>{
    await p.call('Page.reload',{ignoreCache:true});
    await p.waitFor(()=>window.NativeChat&&document.querySelector('.workspace-shell'),null,15000);
    await p.waitFor(id=>[...document.querySelectorAll('[data-chat-id]')].some(n=>n.dataset.chatId===id),original,15000);
    await p.run(id=>[...document.querySelectorAll('[data-chat-id]')].find(n=>n.dataset.chatId===id).click(),original);
    await p.waitFor(ids=>ids.every(id=>document.querySelector('[data-collab-task-select="'+id+'"]'))&&document.querySelector('#nchatList')?.innerText.includes('SODUWORK-SERIAL-B'),ids,25000);
    await shot('serial-restored');return {conversationId:original,taskIds:ids};
  });
} catch(error) {
  console.error('FAIL '+error.message);
  await shot('live-failure').catch(()=>{});
  process.exitCode=1;
} finally {
  const cleaned = [];
  for (const id of ids) {
    try {
      const removed = await p.run(async ({ id, prefix }) => {
        const task = await SoduWorkAPI.getTask(id);
        if (!task?.title?.startsWith(prefix)) return false;
        const run = await SoduWorkAPI.aiSession(id, 0);
        if (run.ok && run.startedAt && !run.finishedAt) return false;
        if (Store.tasks.some(t => t.id === id)) {
          Store.removeTask(id, 0);
          await Store._flushTaskOps();
        }
        if ((await SoduWorkAPI.getTasks()).some(t => t.id === id)) await SoduWorkAPI.deleteTask(id);
        Store.dropTask(id);
        return !(await SoduWorkAPI.getTasks()).some(t => t.id === id);
      }, { id, prefix: 'E2E serial ' + token + ' ' });
      if (removed) cleaned.push(id);
    } catch (_) { /* Never delete unrelated tasks or hide a cleanup failure. */ }
  }
  fs.mkdirSync(evidence,{recursive:true});
  fs.writeFileSync(evidence+'/live-results.json',JSON.stringify({token,ids,cleaned,records},null,2));
  if (ids.length !== cleaned.length) {
    console.error('Cleanup incomplete: inspect this run before repeating');
    process.exitCode = 1;
  }
  p.close();
}
