'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const run = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
const { app, BrowserWindow, ipcMain } = electron;
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {}); // Finish cleanup and emit the awaited receipt before exit.
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { create } = require('../main/conversation/cloud-handoff');
const report = { ok: false, checks: [], errors: [] };
let win, root;
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('Absolute evidence directory required');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = source => win.webContents.executeJavaScript(source, true);
async function until(source) { for (let i = 0; i < 160; i++) { if (await js('Boolean(' + source + ')')) return; await delay(40); } throw Error(source); }
async function click(selector) {
  const point = await js('(()=>{const r=document.querySelector(' + JSON.stringify(selector) + ').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
  await delay(80);
}
async function key(keyCode) {
  keyCode = ({ ArrowDown: 'Down', ArrowUp: 'Up' })[keyCode] || keyCode;
  for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode });
  await delay(60);
}
async function chooseLocation(location) {
  if (await js('document.querySelector("[data-execution-menu]").getAttribute("aria-expanded")') !== 'true') await click('[data-execution-menu]');
  await until('!document.querySelector(".wc-execution-pop").hidden');
  await click('[data-chat-execution=' + location + ']');
}
app.whenReady().then(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-cloud-electron-')); app.setPath('userData', path.join(root, 'profile'));
  const cwd = path.join(root, 'workspace'); await fs.mkdir(cwd); await fs.writeFile(path.join(cwd, '研究报告.md'), '# Initial research\n');
  await fs.writeFile(path.join(cwd, '.env'), 'DO_NOT_TRANSFER');
  let starts = 0, stops = 0, uploads = 0, previews = 0, failCommit = true, receipt = null, targetsAvailable = false, sameAgentAvailable = false, running = true;
  const messages = [{ role: 'user', text: 'Finish the report' }];
  const handle = { sessionId: 'fixture-session', adapterId: 'opencode', ref: 'fixture-ref', cwd, ui: {},
    inFlight: () => running, snapshot: () => ({ status: running ? 'streaming' : 'idle', messages, queue: [], modelSelection: { name: 'local-model' } }),
    historyRow: () => ({ title: '本地研究任务' }), bindTask: async () => ({ ok: true }), cancel() { stops++; running = false; }, close() {},
    appendTaskMessage(role, text, files, tid, key) { if (!messages.some(row => row.taskOutputKey === key)) messages.push({ role, text, taskOutputKey: key }); },
    appendTaskTool() {} };
  const now = Math.floor(Date.now() / 1000), identity = { hub: 'http://localhost:18989', clientId: 'local',
    session: Buffer.from(JSON.stringify({ typ: 'device', cid: 'local', uid: 'user', iat: now - 1, exp: now + 3600 })).toString('base64url') + '.' + 'b'.repeat(64) };
  const controller = create({ app, identityOf: async () => identity, interval: 60000,
    notify: h => { if (win && !win.isDestroyed()) win.webContents.send('cloud-fixture-state', controller.view(h, h.snapshot())); },
    request: async (_identity, route, options = {}) => {
      if (route.split('?')[0].endsWith('/targets')) {
        const agent = new URL('http://fixture' + route).searchParams.get('agentId');
        return { ok: true, handoffCapabilities: { piFallback: true }, targets: targetsAvailable && (agent === 'pi' || sameAgentAvailable) ? [{ id: 'runner:remote:' + agent, agentId: agent, name: '云端 ' + agent, runnerName: '研究执行机', modelMode: 'managed' }] : [] };
      }
      if (route.includes('ai-session')) return { ref: 'run-1', status: 'running', last: 1, items: [{ seq: 1, kind: 'say', text: 'Cloud execution started' }] };
      if (route.endsWith('/commit')) { if (receipt.phase !== 'committed') starts++; receipt.phase = 'committed'; receipt.ref = 'run-1';
        if (failCommit) throw Error('连接暂时中断，等待核对回执'); return receipt; }
      if (options.body instanceof FormData) {
        uploads++; assert.equal(running, false);
        const optionsValue = JSON.parse(options.body.get('options'));
        assert.equal(optionsValue.assigneeId, undefined); assert.equal(optionsValue.agentId, 'pi');
        assert.deepEqual(optionsValue.agentFallback, { fromAgentId: 'opencode', toAgentId: 'pi', accepted: true });
        assert.equal(optionsValue.model, '');
        assert.ok((await options.body.get('file').arrayBuffer()).byteLength > 0);
        receipt = { ok: true, transferId: route.split('/').at(-1), taskId: 'task-cloud', phase: 'prepared', sha256: optionsValue.sha256,
          target: { id: "runner:remote:pi", agentId: "pi" } }; return receipt;
      }
      return receipt;
    } });
  for (const action of ['preview', 'confirm', 'recover', 'abort']) ipcMain.handle('cloud-fixture-' + action, async (_event, ref, input) => {
    assert.equal(ref, handle.ref);
    if (action === 'preview') previews++;
    try { return await controller[action](handle, input || {}); } catch (error) { return { ok: false, reason: error.message }; }
  });
  win = new BrowserWindow({ show: false, width: 1100, height: 860, webPreferences: { offscreen: true, sandbox: true,
    contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'fixtures/cloud-handoff-preload.cjs') } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) report.errors.push(message); });
  await win.loadFile(path.join(__dirname, 'fixtures/cloud-handoff.html')); await until('window.fixtureReady');
  assert.equal(await js('document.querySelector("[data-execution-menu]").disabled'), false);
  assert.equal(await js('document.querySelector("[data-chat-cloud]").hidden'), false);
  assert.equal(await js('document.querySelectorAll("[data-execution-menu]").length'), 1);
  assert.equal(await js('document.querySelectorAll(".wc-execution-pop [role=menuitemradio]").length'), 2);
  assert.equal(await js('[...document.querySelectorAll("[data-execution-menu] svg")].filter(icon=>getComputedStyle(icon).display!=="none").length'), 1);
  await js('fixtureRef=null;ChatChrome.resume("新对话")');
  assert.equal(await js('document.querySelector("[data-execution-menu]").disabled'), true);
  assert.equal(await js('document.querySelector("[data-execution-menu]").disabled'), true);
  await js('fixtureRef="fixture-ref";ChatChrome.identify("fixture-session")');
  assert.equal(await js('document.querySelector("[data-execution-menu]").disabled'), false);
  await click('[data-execution-menu]');
  assert.equal(await js('document.querySelector("[data-execution-menu]").getAttribute("aria-expanded")'), 'true');
  assert.equal(await js('document.querySelector("[data-chat-execution=local]").getAttribute("aria-checked")'), 'true');
  assert.equal(previews, 0); assert.equal(stops, 0); assert.equal(uploads, 0); assert.equal(starts, 0);
  await key('Escape');
  assert.equal(await js('document.querySelector(".wc-execution-pop").hidden'), true);
  assert.equal(await js('document.activeElement.matches("[data-execution-menu]")'), true);
  await key('ArrowDown');
  await until('!document.querySelector(".wc-execution-pop").hidden');
  await key('End');
  assert.equal(await js('document.activeElement.dataset.chatExecution'), 'cloud');
  await key('Home');
  assert.equal(await js('document.activeElement.dataset.chatExecution'), 'local');
  await click('[data-chat-menu]');
  assert.equal(await js('document.querySelector(".wc-execution-pop").hidden'), true);
  await click('[data-chat-menu]');
  assert.equal(previews, 0); assert.equal(stops, 0); assert.equal(uploads, 0); assert.equal(starts, 0);
  report.checks.push('Single icon opens only the location menu; dismissing and keyboard navigation do not request or start a handoff');
  await fs.mkdir(output, { recursive: true });
  for (const width of [1100, 620, 390]) {
    win.setSize(width, 860); await delay(100);
    const geometry = await js('(()=>{const b=document.querySelector("[data-execution-menu]"),r=b.getBoundingClientRect();return{left:r.left,right:r.right,width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,display:getComputedStyle(b).display,menuDisplay:getComputedStyle(document.querySelector("[data-chat-cloud]")).display}})()');
    assert.ok(geometry.left >= 0 && geometry.right <= geometry.width && !geometry.overflow, JSON.stringify(geometry));
    assert.notEqual(geometry.display, 'none');
    await click('[data-execution-menu]');
    const menuGeometry = await js('(()=>{const r=document.querySelector(".wc-execution-pop").getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight}})()');
    assert.ok(menuGeometry.left >= 0 && menuGeometry.right <= menuGeometry.width && menuGeometry.top >= 0 && menuGeometry.bottom <= menuGeometry.height, JSON.stringify(menuGeometry));
    win.webContents.invalidate(); await delay(150);
    await fs.writeFile(path.join(output, 'entry-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
    await key('Escape');
  }
  win.setSize(1100, 860); await delay(100);
  assert.equal(starts, 0);
  report.checks.push('Local chat has one icon and an accessible location menu at 390, 620 and 1100px; unsent chat disables it');
  await chooseLocation('cloud'); await until('document.querySelector("[data-cloud-configure]")');
  assert.equal(await js('document.querySelector(".ncloud-dialog [type=submit]").disabled'), true);
  assert.equal(stops, 0); assert.equal(uploads, 0); assert.equal(running, true);
  await click('[data-cloud-close]');
  report.checks.push('No destination disables transfer and leaves local execution running');
  targetsAvailable = true;
  sameAgentAvailable = true;
  await chooseLocation('cloud'); await until('document.querySelector("[data-cloud-instruction]")');
  assert.match(await js('document.querySelector("[data-cloud-auto]").textContent'), /继续使用 OpenCode/);
  assert.equal(await js('document.querySelector(".ncloud-dialog [type=submit]").textContent'), '转到云端继续');
  await click('[data-cloud-close]'); sameAgentAvailable = false;
  await chooseLocation('cloud'); await until('document.querySelector("[data-cloud-instruction]")');
  assert.match(await js('document.querySelector("[data-cloud-auto]").textContent'), /改用 Pi/);
  await click('footer [data-cloud-close]'); await until('!document.querySelector("dialog")');
  assert.equal(stops, 0); assert.equal(uploads, 0); assert.equal(running, true);
  report.checks.push('Same-Agent preference and rejecting Pi fallback do not interrupt the local job');
  await click('[data-chat-menu]'); await click('[data-chat-cloud]');
  await until('document.querySelector("[data-cloud-instruction]")');
  for (const width of [1100, 620, 390]) {
    win.setSize(width, 860); await delay(100);
    const geometry = await js('(()=>{const r=document.querySelector("dialog").getBoundingClientRect();return{left:r.left,right:r.right,width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth}})()');
    assert.ok(geometry.left >= 15 && geometry.right <= geometry.width - 15 && !geometry.overflow, JSON.stringify(geometry));
    await fs.writeFile(path.join(output, 'fallback-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  win.setSize(1100, 860); await delay(100);
  assert.equal(await js('document.querySelector(".ncloud-dialog [type=submit]").textContent'), '同意改用 Pi 并转到云端');
  await click('.ncloud-dialog [type=submit]');
  await until('document.querySelector(".ncloud-receipt strong") && !document.querySelector(".ncloud-dialog form").hasAttribute("aria-busy")');
  assert.equal(stops, 1); assert.equal(uploads, 1);
  assert.equal(starts, 1); assert.equal(controller.guard(handle).phase, 'committing');
  await until('!document.querySelector("[data-execution-menu]").disabled');
  assert.equal(await js('document.querySelector(".ncloud-dialog [type=submit]").disabled'), false);
  assert.equal(await js('document.querySelector("[data-cloud-abort]").hidden'), true);
  report.checks.push('Explicit Pi acceptance stops locally once, uploads files once, and keeps the uncertain transfer fenced');
  await fs.mkdir(output, { recursive: true });
  for (const width of [1100, 620, 390]) {
    win.setSize(width, 860); await delay(100);
    const geometry = await js('(()=>{const r=document.querySelector("dialog").getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth}})()');
    assert.ok(geometry.left >= 15 && geometry.right <= geometry.width - 15 && !geometry.overflow, JSON.stringify(geometry));
    const receiptLayout = await js('(()=>{const card=document.querySelector(".ncloud-receipt-card"),target=card.querySelector(".ncloud-target"),note=card.querySelector(".ncloud-muted"),box=card.getBoundingClientRect();return {border:getComputedStyle(card).borderTopWidth,padding:getComputedStyle(card).paddingTop,overflow:card.scrollWidth>card.clientWidth,ordered:target.getBoundingClientRect().bottom<=note.getBoundingClientRect().top,contained:box.right<=document.querySelector("dialog").getBoundingClientRect().right}})()');
    assert.deepEqual(receiptLayout, {border:'1px',padding:'16px',overflow:false,ordered:true,contained:true});
    await fs.writeFile(path.join(output, 'handoff-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  report.checks.push('Dialog fits 1100, 620 and 390px without horizontal overflow');
  failCommit = false; await click('.ncloud-dialog [type=submit]');
  await until('document.querySelector(".ncloud-receipt strong").textContent==="云端会话"');
  assert.equal(starts, 1); assert.equal(controller.guard(handle).phase, 'committed');
  assert.equal(await js('document.querySelector("#ncloudTitle").textContent'), '云端会话');
  report.checks.push('Lost start receipt keeps fence; real retry button recovers the same execution without duplicating');
  await click('[data-cloud-close]'); await until('!document.querySelector("dialog")');
  assert.equal(await js('document.querySelector("[data-execution-menu]").dataset.location'), 'cloud');
  assert.equal(await js('document.querySelector("[data-execution-menu]").disabled'), false);
  await click('[data-execution-menu]');
  assert.equal(await js('document.querySelector("[data-chat-execution=local]").disabled'), true);
  assert.equal(await js('document.querySelector("[data-chat-execution=cloud]").getAttribute("aria-checked")'), 'true');
  await click('[data-chat-execution=local]');
  assert.equal(await js('document.querySelector("dialog")'), null);
  assert.equal(starts, 1);
  await chooseLocation('cloud'); await until('document.querySelector(".ncloud-receipt strong")');
  report.checks.push('Original chat retains its cloud execution entry after closing and reopening the dialog');
  await click('[data-cloud-close]'); await until('!document.querySelector("dialog")');
  // Returning uses an explicit independent local conversation. The original
  // cloud conversation remains cloud-owned; no false in-place migration.
  await js("window.fixtureOwner='owner-a';window.fixtureBusy=false;window.localOpens=[];window.modeNotices=[];window.SoduWorkAPI={taskStorageKey:()=>fixtureOwner};window.NativeChat={sessionInfo:()=>({ref:fixtureRef}),isBusy:()=>fixtureBusy};window.WorkspaceHost={open:async(...args)=>{localOpens.push(args);return true}};window.ChatDeliveries={localContinuation:()=>''};window.petSay=text=>modeNotices.push(text);snapshot={status:'idle',cloudHandoff:{phase:'committed'}};ChatCloudHandoff.sync(host,snapshot,{ref:fixtureRef});void 0");
  await chooseLocation('local'); await until('document.querySelector("#ncloudLocalTitle")');
  assert.match(await js('document.querySelector(".ncloud-dialog").textContent'), /新的本机会话/);
  assert.equal(await js('document.querySelector("[data-chat-execution=cloud]").getAttribute("aria-checked")'), 'true');
  await click('footer [data-local-close]'); await until('!document.querySelector("dialog")');
  assert.equal(await js('localOpens.length'), 0);
  await chooseLocation('local'); await click('.ncloud-dialog [type=submit]');
  await until('!document.querySelector("dialog")');
  assert.equal(await js('localOpens.length'), 1);
  assert.equal(await js('localOpens[0][0]'), 'create');
  assert.equal(await js('localOpens[0][1].newSession'), true);
  assert.equal(controller.guard(handle).phase, 'committed');
  await chooseLocation('local'); await until('document.querySelector("#ncloudLocalTitle")');
  await js('fixtureBusy=true;void 0'); await click('.ncloud-dialog [type=submit]');
  assert.equal(await js('localOpens.length'), 1);
  if (await js('!!document.querySelector("[data-local-close]")')) await click('[data-local-close]');
  await js('fixtureBusy=false;void 0');
  await chooseLocation('local'); await until('document.querySelector("#ncloudLocalTitle")');
  await js("fixtureOwner='owner-b';window.dispatchEvent(new Event('soduwork-data-scope-changed'));void 0");
  if (await js('!!document.querySelector(".ncloud-dialog [type=submit]")')) await click('.ncloud-dialog [type=submit]');
  assert.equal(await js('localOpens.length'), 1);
  report.checks.push('Cloud-to-local requires explicit new conversation, rechecks busy/owner, and leaves original cloud ownership intact');
  // Exercise the real delivery registry and DOM, not a mocked group ID contract.
  await js(await fs.readFile(path.join(__dirname, '../components/panels/chat-deliveries.js'), 'utf8'));
  await js("fixtureOwner='owner-a';fixtureRef='fixture-ref';fixtureBusy=false;window.deliveryCalls={materialize:0,copy:0};window.buildModeDelivery=(ref,taskId)=>{const root=document.createElement('section');root.innerHTML='<article class=\"nmsg ai\"></article>';document.body.append(root);ChatDeliveries.decorate(root,[{taskId,attachmentId:'attachment-'+taskId,cloudPending:true,name:'report.md',role:'output',size:10,at:1}],ref,{status:'idle',cloudHandoff:{phase:'committed',taskId}});return root.querySelector('[data-delivery]')};window.currentDelivery=buildModeDelivery(fixtureRef,'task-current');window.foreignDelivery=buildModeDelivery('foreign-ref','task-foreign');window.deliveryApi={cloud:{materialize:async(ref,input)=>{deliveryCalls.materialize++;return new Promise(resolve=>window.finishMaterialization=()=>resolve({ok:true,artifacts:[{artifactId:'local-artifact',remoteAttachmentId:'attachment-'+input.taskId,cloudTaskId:input.taskId,name:'report.md'}]}))}},continueLocalDelivery:async(ref,ids)=>{deliveryCalls.copy++;return{ok:true,sessionId:'copied-'+ref,artifactIds:ids}}};void 0");
  const originalOpens = await js('localOpens.length');
  assert.equal(await js('ChatDeliveries.localContinuation(fixtureRef)'), await js('currentDelivery.dataset.delivery'));
  assert.notEqual(await js('ChatDeliveries.localContinuation(fixtureRef)'), await js('foreignDelivery.dataset.delivery'));
  assert.equal(await js("ChatDeliveries.continueLocal(fixtureRef,foreignDelivery.dataset.delivery,deliveryApi).then(()=>false,()=>true)"), true);
  assert.equal(await js('deliveryCalls.materialize'), 0);
  await js('window.modeContinueOne=ChatDeliveries.continueLocal(fixtureRef,currentDelivery.dataset.delivery,deliveryApi);window.modeContinueTwo=ChatDeliveries.continueLocal(fixtureRef,currentDelivery.dataset.delivery,deliveryApi);void 0');
  await until('window.finishMaterialization');
  assert.equal(await js('deliveryCalls.materialize'), 1);
  await js('finishMaterialization();void 0');
  assert.deepEqual(await js('Promise.all([modeContinueOne,modeContinueTwo])'), [true, true]);
  assert.equal(await js('deliveryCalls.copy'), 1);
  assert.equal(await js('localOpens.length'), originalOpens + 1);
  assert.equal(await js('localOpens.at(-1)[1].source'), 'cloud-result');
  assert.equal(await js('localOpens.at(-1)[1].fileOpen.artifactIds[0]'), 'local-artifact');
  // The existing result-card action keeps working with the same registry.
  assert.equal(await js('ChatDeliveries.handle(currentDelivery.querySelector("[data-delivery-local]"),deliveryApi)'), true);
  assert.equal(await js('deliveryCalls.copy'), 2);
  assert.equal(await js('localOpens.length'), originalOpens + 2);
  await js('fixtureBusy=true;void 0');
  assert.equal(await js('ChatDeliveries.continueLocal(fixtureRef,currentDelivery.dataset.delivery,deliveryApi).then(()=>false,()=>true)'), true);
  assert.equal(await js('deliveryCalls.copy'), 2);
  await js('fixtureBusy=false;void 0');
  // A session change during materialization cannot create or open a local copy.
  await js("window.pendingDelivery=buildModeDelivery(fixtureRef,'task-pending');window.lateModeContinue=ChatDeliveries.continueLocal(fixtureRef,pendingDelivery.dataset.delivery,deliveryApi).then(()=>false,()=>true);void 0");
  await until('deliveryCalls.materialize === 2');
  await js("fixtureRef='different-ref';finishMaterialization();void 0");
  assert.equal(await js('lateModeContinue'), true);
  assert.equal(await js('deliveryCalls.copy'), 2);
  assert.equal(await js('localOpens.length'), originalOpens + 2);
  // A changed identity during the final copy must not open its result either.
  await js("fixtureRef='fixture-ref';deliveryApi.continueLocalDelivery=async()=>{deliveryCalls.copy++;return new Promise(resolve=>window.finishLocalCopy=resolve)};window.lateCopy=ChatDeliveries.continueLocal(fixtureRef,currentDelivery.dataset.delivery,deliveryApi).then(()=>false,()=>true);void 0");
  await until('window.finishLocalCopy');
  await js("fixtureOwner='owner-b';window.dispatchEvent(new Event('soduwork-data-scope-changed'));finishLocalCopy({ok:true,sessionId:'old-account-copy'});void 0");
  assert.equal(await js('lateCopy'), true);
  assert.equal(await js('localOpens.length'), originalOpens + 2);
  assert.equal(await js('ChatDeliveries.localContinuation(fixtureRef)'), '');
  report.checks.push('Real delivery metadata selects only current results, deduplicates continuation, preserves legacy result actions and fences late materialization/copies');
  assert.equal(report.errors.length, 0, JSON.stringify(report.errors)); report.ok = true;
  handle.close();
}).catch(error => { report.failure = error.stack || String(error); process.exitCode = 1; }).finally(async () => {
  await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (win && !win.isDestroyed()) win.destroy();
  if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
});
