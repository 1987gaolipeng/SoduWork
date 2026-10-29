// Drives an already running, explicitly isolated desktop through real UI input.
// Read-only API calls verify results; no API writes or renderer state injection.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CdpPage, listPages } from './lib/cdp.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(value => {
  const [key, ...rest] = value.replace(/^--/, '').split('=');
  return [key, rest.join('=') || '1'];
}));
const port = Number(args.port || 19222), phase = args.phase || 'inspect';
const runName = args.tag || phase;
const hub = args.hub || 'http://127.0.0.1:19080';
assert.match(hub, /^http:\/\/127\.0\.0\.1:\d+$/, 'A dedicated loopback Hub is required');
const output = path.resolve(args.output || '../outputs/requirements-real-lifecycle');
fs.mkdirSync(output, { recursive: true });
const stateFile = path.join(output, 'state.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {
  title: 'E2E 需求与对话流转 ' + Date.now().toString(36), taskId: '', steps: [],
};
if (args.task) state.taskId = args.task;
const target = (await listPages(port)).find(row => args.page ? row.id === args.page : row.url.includes('panel=workspace'));
assert.ok(target, 'The isolated workspace window must already be running');
const page = await CdpPage.connect(target);
await page.call('Page.bringToFront');
const record = { phase, startedAt: new Date().toISOString(), ok: false, actions: [] };
// Log.enable replays entries from before this phase; preserve them separately.
record.previousRuntimeErrors = page.takeRuntimeErrors();
record.networkErrors=[];
page.ws.addEventListener('message', event => {
  const message=JSON.parse(event.data),entry=message.params?.entry;
  if(message.method==='Log.entryAdded' && entry?.level==='error' && entry.source==='network') {
    record.networkErrors.push({text:entry.text,url:entry.url});
  }
});

async function pointClick(point) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await page.call('Input.dispatchMouseEvent', { type, ...point,
      ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) });
  }
}
async function click(selector) {
  const point = await page.waitFor(selector => {
    const element = document.querySelector(selector);
    if (!element || element.disabled || !element.getClientRects().length) return false;
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = element.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return hit && (element === hit || element.contains(hit)) ? { x, y } : false;
  }, selector, 20000);
  await pointClick(point); record.actions.push({ click: selector });
}
async function key(key, code = key, modifiers = 0) {
  const virtual = { a: 65, Home: 36, ArrowDown: 40, Enter: 13, Escape: 27, Tab: 9 }[key];
  const options = { key, code, modifiers, ...(virtual ? { windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual } : {}) };
  await page.call('Input.dispatchKeyEvent', { type: 'keyDown', ...options });
  await page.call('Input.dispatchKeyEvent', { type: 'keyUp', ...options });
}
async function fill(selector, value, secret = false) {
  await click(selector); await key('a', 'KeyA', 2);
  await page.call('Input.insertText', { text: String(value) });
  record.actions.push({ input: selector, value: secret ? '[test credential]' : value });
}
async function select(selector, value) {
  const custom = await page.run(selector => {
    const id=document.querySelector(selector)?.id;
    return id && document.querySelector('[data-fwd-select="'+id+'"]') ? id : '';
  }, selector);
  if (custom) {
    await click('[data-fwd-select="'+custom+'"]');
    await click('.fwd-select-option[data-value="'+value+'"]');
    assert.equal(await page.run(selector => document.querySelector(selector).value, selector), value);
    return;
  }
  const index = await page.run(({ selector, value }) => Array.from(document.querySelector(selector)?.options || [])
    .findIndex(option => option.value === value), { selector, value });
  assert.ok(index >= 0, 'Missing select option ' + value);
  await click(selector); await key('Home');
  for (let i = 0; i < index; i++) await key('ArrowDown');
  await key('Enter');
  assert.equal(await page.run(selector => document.querySelector(selector).value, selector), value);
}
async function reveal(selector) {
  for (let i = 0; i < 8; i++) {
    const point = await page.run(selector => {
      let node = document.querySelector(selector), closed = [];
      while (node) { if (node.tagName === 'DETAILS' && !node.open) closed.push(node); node = node.parentElement; }
      const summary = closed.at(-1)?.querySelector(':scope > summary');
      if (!summary) return null;
      summary.scrollIntoView({ block: 'center' }); const r = summary.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, selector);
    if (!point) return;
    await pointClick(point);
  }
  throw Error('Nested disclosure did not open: ' + selector);
}
async function shot(name) {
  const image = await page.call('Page.captureScreenshot', { format: 'png' },30000);
  fs.writeFileSync(path.join(output, name.replace(new RegExp('^'+phase),runName) + '.png'), Buffer.from(image.data, 'base64'));
}
async function truth() {
  assert.ok(state.taskId, 'A previous create phase or --task is required');
  return page.run(async id => {
    const task = await SoduWorkAPI.getTask(id);
    return { id: task.id, title: task.title, status: task.status, stage: task.requirementStage,
      assigneeUserId: task.assigneeUserId, assigneeName: task.assigneeName,
      reviewedAt: task.reviewedAt, artifactUrl: task.artifactUrl,
      routing: task.workRouting, attachmentIds: (task.attachments || []).map(item => item.id) };
  }, state.taskId);
}
async function waitTruth(field, values) {
  return page.waitFor(async ({ id, field, values }) => {
    const task = await SoduWorkAPI.getTask(id);
    return values.includes(task[field]) ? { id: task.id, status: task.status,
      stage: task.requirementStage, assigneeUserId: task.assigneeUserId, reviewedAt: task.reviewedAt } : false;
  }, { id: state.taskId, field, values }, 60000, 250);
}
async function board() {
  if (await page.run(() => !!document.querySelector('[data-collab-close]')?.getClientRects().length)) await click('[data-collab-close]');
  if (await page.run(() => !!document.querySelector('[data-act="fwd-close"]')?.getClientRects().length)) await click('[data-act="fwd-close"]');
  if (await page.run(() => !!document.querySelector('.wes-result-primary')?.getClientRects().length)) await click('.wes-result-primary');
  if (await page.run(() => !!document.querySelector('.rq-detail [data-rq-dismiss]'))) await click('.rq-detail [data-rq-dismiss]');
  await click('[data-rail-view="history"]');
  await page.waitFor(() => document.querySelector('.requirements-board'), null, 15000);
}
async function detail() {
  await board();
  if (await page.run(() => !!document.querySelector('[data-rq-scope="all"]')?.getClientRects().length)) {
    await click('[data-rq-scope="all"]');
  } else if (await page.run(() => !!document.querySelector('#rqScope')?.getClientRects().length)) await select('#rqScope', 'all');
  await fill('#hbSearch', state.title);
  const selector = '[data-rq-open="' + state.taskId + '"]';
  await page.waitFor(selector => !!document.querySelector(selector), selector, 20000);
  const collapsed = await page.run(selector => {
    const lane = document.querySelector(selector)?.closest('[data-rq-lane]');
    return lane?.querySelector('[data-rq-collapse][aria-expanded="false"]') ? lane.dataset.rqLane : '';
  }, selector);
  if (collapsed) await click('[data-rq-lane="' + collapsed + '"] [data-rq-collapse]');
  await click(selector);
  await page.waitFor(id => document.querySelector('.rq-detail .rq-detail-content')?.dataset.taskId === id && !!document.querySelector('.rq-detail-footer'), state.taskId, 20000);
}
async function conversation() {
  await detail(); await click('[data-rq-chat]');
  await page.waitFor(id => window.NativeChat?.sessionInfo?.()?.taskIds?.includes(id), state.taskId, 30000);
  state.conversation = await page.run(() => NativeChat.sessionInfo());
  await shot(phase + '-conversation');
  const selector = '[data-task-receipt="' + state.taskId + '"]';
  if (!await page.run(selector => !!document.querySelector(selector), selector)) await click('[data-queue-action="history"]');
  await page.waitFor(selector => !!document.querySelector(selector), selector, 30000);
  await reveal(selector); await click(selector);
  await page.waitFor(title => document.querySelector('#ncollabTitle')?.textContent === title, state.title, 10000);
  record.dossier = await page.run(() => ({ title:document.querySelector('#ncollabTitle').textContent,
    taskId:document.querySelector('.ncollab-anchor')?.dataset.taskId,
    state:document.querySelector('.ncollab-dossier-status')?.textContent,
    receipt:document.querySelector('.nqueue-receipt')?.textContent }));
  assert.equal(record.dossier.taskId,state.taskId);
  await click('[data-collab-tab="artifacts"]');
  await page.waitFor(() => document.querySelector('#ncollab-panel-artifacts .ncollab-evidence-row'), null, 15000);
  record.dossier.outputs=await page.run(()=>[...document.querySelectorAll('#ncollab-panel-artifacts .ncollab-evidence-row b')].map(e=>e.textContent));
  assert.ok(record.dossier.outputs.includes('E2E_LOCAL.md'));
  record.crossEntry = 'Requirement pool → bound conversation → completed task receipt → same requirement dossier and output';
}

try {
  // Reload first constructs the API with its default URL; wait for the persisted
  // isolated profile bootstrap before any interactive operation.
  const actualHub = await page.waitFor(expected => window.SoduWorkAPI?.hubBase?.() === expected
    ? window.SoduWorkAPI.hubBase() : false, hub, 15000);
  assert.equal(actualHub, hub, 'Refuse to operate on another Hub');
  if (phase === 'inspect') {
    record.snapshot = await page.run(() => ({ url: location.pathname, auth: SoduWorkAPI.clientAuthSnapshot()?.user?.name,
      headings: [...document.querySelectorAll('h1,h2,h3')].filter(e => e.getClientRects().length).map(e => e.textContent.trim()),
      buttons: [...document.querySelectorAll('button')].filter(e => e.getClientRects().length).map(e => ({ text: e.textContent.trim(), id: e.id, data: { ...e.dataset } })).slice(0, 100) }));
  } else if (phase === 'login') {
    assert.ok(args.account && process.env.SODUWORK_E2E_PASSWORD, '--account and SODUWORK_E2E_PASSWORD are required');
    await fill('#soduWorkAuthAccount', args.account);
    await fill('#soduWorkAuthPassword', process.env.SODUWORK_E2E_PASSWORD, true);
    await click('.soduwork-auth-submit');
    await page.waitFor(() => SoduWorkAPI.clientAuthSnapshot()?.user?.id, null, 30000);
    // Login schedules a document reload; wait past that boundary before observing the gate.
    await new Promise(resolve=>setTimeout(resolve,650));
    await page.waitFor(() => document.querySelector('#soduWorkClientAuthGate')?.hidden === true, null, 30000);
  } else if (phase === 'logout') {
    await page.call('Page.enable');
    const acceptDialog = event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Page.javascriptDialogOpening' && message.params.type === 'confirm') {
        void page.call('Page.handleJavaScriptDialog', { accept: true });
      }
    };
    page.ws.addEventListener('message', acceptDialog);
    try {
      if (await page.run(() => !!document.querySelector('[data-collab-close]')?.getClientRects().length)) await click('[data-collab-close]');
      if (await page.run(() => !!document.querySelector('.rq-detail [data-rq-dismiss]'))) await click('.rq-detail [data-rq-dismiss]');
      await click('#wsRailMine');
      const accountMenu = await page.waitFor(() => {
        const e = document.querySelector('.soduwork-account-menu-btn[data-menu-bound="1"]');
        if (!e?.getClientRects().length) return false;
        e.scrollIntoView({ block: 'center' }); const r=e.getBoundingClientRect();
        return { x:r.x+r.width/2,y:r.y+r.height/2 };
      }, null, 20000);
      // This account menu explicitly opens on mouseenter; a subsequent click toggles it closed.
      await page.call('Input.dispatchMouseEvent', { type:'mouseMoved', ...accountMenu });
      await click('.soduwork-account-menu-item[data-action="logout"]');
      await page.waitFor(() => document.querySelector('#soduWorkAuthAccount')?.getClientRects().length, null, 30000);
    } finally { page.ws.removeEventListener('message', acceptDialog); }
  } else if (phase === 'create') {
    assert.equal(state.taskId, '', 'Do not create a second requirement for this run');
    await board(); await click('#hbAdd');
    await fill('#cpTitle', state.title);
    await fill('#cpNote', '整理一份简短的需求流转验证报告，包含目标、执行结果与修订说明；保存为可查看的成果文件。');
    if (!await page.run(() => !!document.querySelector('#cpCheck .cp-ck-t'))) await click('#cpCkAdd');
    await fill('#cpCheck .cp-ck-t', '成果文件可打开，内容与本条需求一致，返工后保留修订说明。');
    await click('[data-selbtn="who"]'); await click('[data-selv="who|me"]');
    await click('#cpCreate');
    const created = await page.waitFor(async title => {
      const rows = (await SoduWorkAPI.getTasks()).filter(row => row.title === title);
      if (!rows.length) return false;
      return { count: rows.length, id: rows[0].id, status: rows[0].status };
    }, state.title, 30000);
    assert.equal(created.count, 1); assert.equal(created.status, 'todo'); state.taskId = created.id;
    record.created = created;
    await click('.wes-result-primary');
  } else if (phase === 'assign') {
    assert.ok(args.worker, '--worker is the visible colleague name');
    await detail();
    if (await page.run(() => !!document.querySelector('[data-rq-ready]'))) {
      await click('[data-rq-ready]');
      await page.waitFor(() => !!document.querySelector('[data-rq-assign]'), null, 20000);
    }
    await click('.rq-detail [data-rq-assign]'); await click('[data-fwdtab="mate"]');
    await fill('#fwdMateSearch', args.worker);
    await page.waitFor(() => document.querySelectorAll('[data-fwd-choice="mate"]:not([disabled])').length === 1, null, 20000);
    const assignee = await page.run(() => document.querySelector('[data-fwd-choice="mate"]:not([disabled])').dataset.aid);
    await click('[data-fwd-choice="mate"]:not([disabled])'); await click('#fwdConfirm');
    record.assigned = await waitTruth('assigneeUserId', [assignee]);
  } else if (phase === 'execute') {
    await detail(); await click('.rq-detail [data-rq-assign]');
    await page.waitFor(() => !!document.querySelector('#fwdAgentSelect') && !document.querySelector('#fwdAgentSelect').disabled, null, 20000);
    await select('#fwdAgentSelect', args.agent || 'local:pi');
    await select('#fwdSubmissionMode', 'manual'); await click('#fwdConfirm');
    await page.waitFor(id => window.NativeChat?.sessionInfo?.()?.taskIds?.includes(id), state.taskId, 30000);
    await waitTruth('status', ['doing']);
    await shot('execute-running');
  } else if (phase === 'settle') {
    await page.waitFor(id => window.NativeChat?.sessionInfo?.()?.taskIds?.includes(id) && !NativeChat.isBusy(), state.taskId, 180000, 500);
    record.outputs = await page.waitFor(id => {
      const cards = [...document.querySelectorAll('#nchatList [data-delivery], #nchatList .noutput-image, #nchatList .noutput-video, #nchatList .noutput-library-row')];
      if (!cards.length) return false;
      return cards.map(card => ({ taskId: card.closest('[data-output-task]')?.dataset.outputTask || '',
        artifactId: card.querySelector('[data-open-app]')?.dataset.openApp || '',
        title: card.querySelector('[data-delivery-title],.noutput-library-name')?.textContent || card.textContent.slice(0, 180),
        visible: !!card.getClientRects().length }));
    }, state.taskId, 45000, 250);
    assert.ok(record.outputs.some(item => item.visible), 'The completed turn must retain a visible output');
    assert.ok(record.outputs.every(item => !item.taskId || item.taskId === state.taskId), 'Another requirement output leaked into this execution conversation');
    state.conversation = await page.run(() => NativeChat.sessionInfo());
    record.outputEvidence = await page.run(async id => {
      const info=NativeChat.sessionInfo(), api=soduWorkAPI.conversationSession;
      const snapshot=(await api.snapshot(info.ref)).snapshot;
      const output=await api.outputs(info.ref);
      const attachments=await SoduWorkAPI.listAttachments(id);
      return { taskId:id, sessionId:info.sessionId, artifacts:output.artifacts,
        files:snapshot.deliverySync?.manifest?.files,
        attachments:attachments.filter(a=>a.role==='output').map(a=>({id:a.id,taskId:a.taskId,filename:a.filename,sha256:a.sha256,sourceRef:a.sourceRef,round:a.evidenceMeta?.round})) };
    }, state.taskId);
    for (const card of record.outputs.filter(item => item.artifactId)) {
      const artifact=record.outputEvidence.artifacts.find(a=>a.artifactId===card.artifactId);
      assert.ok(artifact, 'The visible file must exist in this conversation artifact index');
      const manifest=record.outputEvidence.files.find(f=>f.path===artifact.relative);
      assert.ok(manifest, 'The visible file must have a synced content hash');
      assert.ok(record.outputEvidence.attachments.some(a=>a.taskId===state.taskId && a.sourceRef==='conversation:'+state.conversation.sessionId && a.sha256===manifest.sha256), 'Visible file hash and source session must match this requirement output attachment');
    }
    if(args.version==='2') {
      record.versions=await page.run(async id=>{
        const rows=(await SoduWorkAPI.listAttachments(id)).filter(a=>a.role==='output'&&a.filename==='E2E_LOCAL.md').sort((a,b)=>(a.evidenceMeta?.round||0)-(b.evidenceMeta?.round||0));
        return Promise.all(rows.map(async a=>{const response=await fetch(new URL(a.url,SoduWorkAPI.hubBase()));if(!response.ok)throw Error('Unable to read frozen output '+a.id);return {id:a.id,round:a.evidenceMeta?.round,hash:a.sha256,text:await response.text()};}));
      },state.taskId);
      assert.ok(record.versions.length>=2,'Rework must retain the old output and create a new round');
      const first=record.versions[0],last=record.versions.at(-1);
      assert.ok(last.round>first.round);assert.notEqual(last.hash,first.hash);
      assert.ok(!first.text.includes('## 修订说明'),'The frozen first version stays unchanged');
      assert.ok(last.text.startsWith(first.text),'Rework keeps the original document');
      assert.ok(last.text.includes('## 修订说明'),'The new version contains the requested revision');
    }
  } else if (phase === 'conversation') {
    await conversation();
  } else if (phase === 'submit') {
    await detail(); await click('[data-rq-submit-review]');
    record.submitted = await waitTruth('requirementStage', ['reviewing']);
  } else if (phase === 'reject' || phase === 'approve') {
    await detail();
    await page.waitFor(() => document.querySelector('.rq-detail [data-tfd-approval-note]'), null, 20000);
    const proof = '.rq-detail [data-tfd-open="inline-approval-evidence"]';
    if (await page.run(selector => !!document.querySelector(selector), proof)) {
      await click(proof+' > summary');
      await page.waitFor(() => {
        const text=document.querySelector('.rq-detail [data-tfd-proof-body]')?.textContent || '';
        return text && !text.includes('展开后加载') && !text.includes('正在加载') ? text : false;
      },null,20000);
      record.approvalEvidence=await page.run(()=>document.querySelector('.rq-detail [data-tfd-proof-body]').textContent);
      await shot(phase+'-evidence');
    }
    await reveal('[data-tfd-approval-note]');
    await fill('[data-tfd-approval-note]', phase === 'reject'
      ? '请在现有成果末尾补充“修订说明”，写明本轮核对结论，并保留原有内容。'
      : '已核对成果和修订说明，完成标准全部满足。');
    if (phase==='approve' && await page.run(()=>!!document.querySelector('.rq-detail [data-tfd-approval-verify]'))) await click('.rq-detail [data-tfd-approval-verify]');
    await click('[data-tfd-approval-action="' + phase + '"]');
    record.decision = phase === 'reject' ? await page.waitFor(async id => { const t=await SoduWorkAPI.getTask(id); return t.reviewRejected && t.workRouting?.reworkPending?.ref ? {id:t.id,status:t.status,stage:t.requirementStage,reworkPending:t.workRouting.reworkPending} : false; },state.taskId,60000)
      : await page.waitFor(async id => { const t = await SoduWorkAPI.getTask(id); return t.reviewedAt ? {id:t.id,status:t.status,reviewedAt:t.reviewedAt} : false; }, state.taskId, 60000);
    if (phase === 'reject') {
      assert.equal(record.decision.reworkPending.ref, 'conversation:' + state.conversation.sessionId);
      assert.ok(record.decision.reworkPending.feedback.includes('修订说明'));
    }
  } else if (phase === 'rework') {
    record.beforeRework = await truth();
    await detail(); await click('[data-rq-rework]');
    await page.waitFor(id => NativeChat.sessionInfo()?.taskIds?.includes(id), state.taskId, 30000);
    await page.waitFor(() => document.querySelector('#nchatInput')?.value.includes('修订说明'), null, 20000);
    record.reworkDraft = await page.run(() => document.querySelector('#nchatInput').value);
    assert.ok(record.reworkDraft.includes(record.beforeRework.routing.reworkPending.feedback));
    await shot(phase + '-prefilled');
    await click('#nchatSend');
  } else if (phase === 'evaluate') {
    await detail(); await click('[data-rq-execution] > summary');
    await page.waitFor(() => document.querySelector('[data-tev-start]'), null, 20000);
    await reveal('[data-tev-start]'); await click('[data-tev-start]');
    await fill('[data-tev-form] [name="summary"]', '真实界面完成创建、承接、交付、打回、返工和通过，同一需求保留完整证据。');
    await reveal('[data-tev-form] [name="reusableLesson"]');
    await fill('[data-tev-form] [name="reusableLesson"]', '验收意见应指向现有交付的具体修改，返工保留同一需求和成果来源。');
    await click('[data-tev-form] button[type="submit"]');
    record.evaluation = await page.waitFor(async id => { const trace = await SoduWorkAPI.taskTrace(id); return trace.evolution?.myEvaluation || trace.evolution?.evaluation || false; }, state.taskId, 20000);
    await page.waitFor(summary => document.querySelector('.rq-detail .tev-evaluation')?.textContent.includes(summary), record.evaluation.summary, 20000);
  } else if (phase === 'verify-final') {
    const expected = state.steps.findLast(step => step.phase === 'evaluate' && step.ok)?.evaluation;
    assert.ok(expected, 'A saved UI evaluation must precede final verification');
    await detail();
    record.detailText = await page.run(() => document.querySelector('.rq-detail').textContent);
    assert.ok(record.detailText.includes('已完成'));
    await click('[data-rq-execution] > summary');
    await page.waitFor(summary => document.querySelector('.rq-detail .tev-evaluation')?.textContent.includes(summary), expected.summary, 20000);
    await reveal('.rq-detail .tev-evaluation');
    record.evaluationText = await page.run(() => document.querySelector('.rq-detail .tev-evaluation').textContent);
    assert.ok(record.evaluationText.includes(expected.reusableLesson));
    record.evaluation = await page.run(async id => (await SoduWorkAPI.taskTrace(id)).evolution.myEvaluation, state.taskId);
    assert.equal(record.evaluation.id, expected.id);
    await shot(phase + '-completed-stage');
    await page.run(() => document.querySelector('.rq-detail .tev-evaluation').scrollIntoView({ block:'center' }));
    await shot(phase + '-evaluation-reopened');
    await conversation();
    assert.ok(record.dossier.state.includes('已完成'));
    const final = await truth();
    assert.equal(final.status, 'done'); assert.equal(final.stage, 'delivered');
    assert.equal(final.assigneeUserId, state.steps.find(step => step.phase === 'assign' && step.ok).assigned.assigneeUserId);
    record.finalOutputs = await page.run(async id => (await SoduWorkAPI.listAttachments(id))
      .filter(a => a.role === 'output').map(a => ({ id:a.id, hash:a.sha256, round:a.evidenceMeta?.round, sourceRef:a.sourceRef })), state.taskId);
    const expectedOutputs = state.steps.findLast(step => step.phase === 'settle' && step.ok && step.versions)?.versions;
    assert.deepEqual(record.finalOutputs.map(a=>[a.id,a.hash]), expectedOutputs.map(a=>[a.id,a.hash]));
  } else throw Error('Unknown phase: ' + phase);
  if (state.taskId && !['inspect', 'login', 'logout'].includes(phase)) record.truth = await truth();
  await shot(phase + '-complete');
  record.ok = true;
} catch (error) {
  record.error = error.stack; process.exitCode = 1;
  await shot(phase + '-failed').catch(() => {});
} finally {
  record.runtimeErrors = page.takeRuntimeErrors();
  if (['login', 'logout'].includes(phase)) {
    record.authBoundaryNetworkErrors = record.runtimeErrors.filter(row => row === 'Failed to load resource: the server responded with a status of 401 (Unauthorized)');
    record.runtimeErrors = record.runtimeErrors.filter(row => !record.authBoundaryNetworkErrors.includes(row));
  }
  if (record.runtimeErrors.length && phase !== 'inspect') {
    record.ok = false; process.exitCode = 1;
    record.error ||= 'Runtime errors: ' + record.runtimeErrors.join('\n');
  }
  record.finishedAt = new Date().toISOString();
  state.steps.push(record); fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  fs.writeFileSync(path.join(output, runName + '-report.json'), JSON.stringify(record, null, 2));
  page.close(); console.log(JSON.stringify({phase,ok:record.ok,taskId:state.taskId,error:record.error,output}));
}
