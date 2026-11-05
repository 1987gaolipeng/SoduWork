'use strict';
// Real automation receipt worker + disk journal + schedule renderer. Model
// transport and authenticated Hub responses are isolated controlled fixtures.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2), '--disable-gpu'],
    { env, windowsHide: true, stdio: 'inherit', timeout: 90000 });
  if (child.error) console.error(child.error.message);
  process.exit(child.status ?? 1);
}
const { app, BrowserWindow, ipcMain } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
const { createWorker, diskJournal } = require('../main/automation-conversations');
const client = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-schedule-settlement-'));
const out = path.resolve(process.argv.slice(2).find(value => !value.startsWith('--')) ||
  path.join(client, '../outputs/schedule-run-settlement'));
const onlyCase = process.argv.find(value => value.startsWith('--case='))?.slice(7) || '';
fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(temp, 'profile'));
app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
const report = { ok: false, cases: [], phases: [], network: [],
  boundary: 'Production receipt worker and temporary disk journal feed controlled Hub records to actual desktop-ordered schedule UI. No live automation, model, account or business data.' };
const clone = value => JSON.parse(JSON.stringify(value));
let win, page, worker, records, finishes, actor, historyCalls, acknowledgements, sends;
let historyFailure = false, delayHistory = false, pendingHistory = null;
const js = code => win.webContents.executeJavaScript(code, true)
  .catch(error => { throw Error(error.message + '\nScript: ' + code); });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const end = Date.now() + 7000;
  while (Date.now() < end) { if (await check()) return; await wait(25); }
  throw Error('Timed out: ' + label);
}
async function click(selector) {
  const point = await js(`(() => { const node=document.querySelector(${JSON.stringify(selector)});
    if(!node||node.disabled)throw Error('Missing action '+${JSON.stringify(selector)});
    node.scrollIntoView({block:'nearest'});const r=node.getBoundingClientRect();
    const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);
    if(!node.contains(document.elementFromPoint(x,y)))throw Error('Action occluded');return{x,y};})()`);
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
  await wait(40);
}
async function phase(name) {
  await js("Promise.all(document.getAnimations().filter(animation=>Number.isFinite(animation.effect.getTiming().iterations)).map(animation=>animation.finished.catch(()=>{})))");
  const state = await js(`({states:[...document.querySelectorAll('.sch-run-state')].map(node=>node.textContent),
    chatLinks:document.querySelectorAll('[data-run-chat]').length,
    text:document.querySelector('#schRunContent')?.innerText||'',cache:structuredClone(_schRunRows),errors:errors.slice()})`);
  report.phases.push({ name, ...state, historyCalls: clone(historyCalls), acknowledgements: clone(acknowledgements), sends });
  fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); return state;
}
function buildPage() {
  const original = fs.readFileSync(path.join(__dirname, 'fixtures/schedule-card-actions.html'), 'utf8');
  const folder = path.join(__dirname, 'fixtures'), desk = fs.readFileSync(path.join(client, 'desk.html'), 'utf8');
  const required = new Set([...original.matchAll(/<script src="([^"]+)"><\/script>/g)]
    .map(match => path.relative(client, path.resolve(folder, match[1])).replace(/\\/g, '/')));
  required.add('core/localized-text.js');
  const scripts = [...desk.matchAll(/<script src="([^"]+)"><\/script>/g)].map(match => match[1]).filter(file => required.has(file));
  assert.equal(scripts.length, required.size);
  page = path.join(temp, 'schedules.html');
  fs.writeFileSync(page, original.replace(/<link rel="stylesheet" href="([^"]+)">/g,
    (_, file) => '<link rel="stylesheet" href="' + pathToFileURL(path.resolve(folder, file)).href + '">')
    .replace(/<script src="([^"]+)"><\/script>/g, '')
    .replace('<script>openSchedulePanel();</script>', scripts.map(file => '<script src="' + pathToFileURL(path.join(client, file)).href + '"></script>').join('') + `<script>
      window.calls.history=[];window.rows=[{...rows[0],title:'自动化回执回归',lastRunAt:new Date().toISOString()}];
      SoduWorkAPI.listScheduleRuns=async sid=>{calls.history.push(sid);return fixtureRuns.list(sid);};
      window.openedChats=[];window.WorkspaceHost={open:(view,options)=>openedChats.push({view,options})};
      window.pageReady=openSchedulePanel();
    </script>`));
}
function addRun(owner = actor, id = 'run-1') {
  records.set(owner + ':' + id, { id, owner, scheduleId: 'schedule-0', state: 'starting',
    conversationTitle: owner === 'owner-a' ? '本轮自动化' : '新账号自动化', trigger: 'manual',
    startedAt: new Date(Date.now() - 1000).toISOString(), receipt: { executionMode: 'soduwork.automation-conversation/v1' } });
}
async function setup() {
  worker?.stop(); records = new Map(); finishes = new Map(); actor = 'owner-a';
  historyCalls = []; acknowledgements = []; sends = 0; historyFailure = false; delayHistory = false; pendingHistory = null;
  addRun();
  worker = createWorker({ identityOf: async () => ({ hub: 'https://fixture.invalid', clientId: actor }),
    journal: diskJournal(fs.mkdtempSync(path.join(temp, 'journal-'))), catalog: async () => [],
    request: async (identity, route, body) => {
      if (route.endsWith('/inbox')) return { items: [...records.values()].filter(row => row.owner === identity.clientId &&
        ['starting', 'running', 'waiting'].includes(row.state)).map(row => ({ id: row.id })) };
      const id = route.split('/').at(-2), row = records.get(identity.clientId + ':' + id);
      assert.ok(row, 'receipt stays inside its owner and occurrence');
      if (route.endsWith('/claim')) return { ok: true, input: { runId: id, text: '隔离自动化输入', adapterId: 'pi' } };
      assert.equal(route.endsWith('/state'), true); acknowledgements.push({ owner: identity.clientId, id, ...clone(body) });
      if (!['succeeded', 'failed', 'cancelled'].includes(row.state)) {
        Object.assign(row, { state: body.state, conversationId: body.conversationId, error: body.error });
        if (['succeeded', 'failed', 'cancelled'].includes(row.state)) row.durationSeconds = 1;
      }
      return { ok: true, state: row.state };
    }, conversation: {
      open: async (_options, identity) => ({ ok: true, sessionId: 'chat-' + identity.clientId, ref: 'ref-' + identity.clientId }),
      send: async ref => { sends++; return { ok: true, completion: new Promise(resolve => finishes.set(ref, resolve)) }; },
      find: () => ({ status: () => 'idle' }),
    } });
  await worker.tick(); await win.loadFile(page); await js('pageReady');
}
async function settle(result) {
  finishes.get('ref-' + actor)(result); await Promise.resolve(); await worker.tick();
}
const runButton = '.sch-item[data-sid="schedule-0"] [data-act="runs"]';
async function openRuns() {
  await click(runButton); await until(() => js("!_schRunLoading['schedule-0']"), 'run history response');
}
async function check(name, action) {
  if (onlyCase && !name.includes(onlyCase)) return;
  try { await setup(); await action(); assert.deepEqual(await js('errors'), []); report.cases.push({ name, ok: true }); }
  catch (error) { report.cases.push({ name, ok: false, error: error.stack,
    ui: await js('document.body.innerText').catch(() => ''), historyCalls: clone(historyCalls) }); }
  finally { await js('closeSchedulePanel();void 0;').catch(() => {}); worker?.stop(); }
}
app.whenReady().then(async () => {
  const preload = path.join(temp, 'preload.cjs');
  fs.writeFileSync(preload, "require('electron').contextBridge.exposeInMainWorld('fixtureRuns',{list:sid=>require('electron').ipcRenderer.invoke('fixture-schedule-runs',sid)});");
  ipcMain.handle('fixture-schedule-runs', (_event, sid) => {
    const owner = actor; historyCalls.push({ owner, sid });
    const rows = clone([...records.values()].filter(row => row.owner === owner && row.scheduleId === sid).reverse());
    if (delayHistory) { delayHistory = false; return new Promise(resolve => { pendingHistory = () => resolve(rows); }); }
    if (historyFailure) throw Error('模拟执行记录暂时无法读取');
    return rows;
  });
  win = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: {
    preload, sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (request, callback) => { report.network.push(request.url); callback({ cancel: true }); });
  buildPage();
  for (const [name, result, expected, label] of [
    // The Hub conversation contract projects cancelled occurrences onto failed.
    ['completed', { ok: true }, 'succeeded', '完成'], ['failed', { ok: false }, 'failed', '失败'],
    ['cancelled', { ok: true, cancelled: true }, 'failed', '失败'],
    ['paused', { ok: true, paused: true }, 'failed', '失败'],
  ]) await check('close then ' + name + ' receipt then reopen reads authoritative state', async () => {
    await openRuns(); assert.deepEqual((await phase(name + '-running')).states, ['执行中']);
    await click('[data-run-chat]'); assert.equal(await js('openedChats.length'), 1);
    await settle(result); assert.equal(records.get(actor + ':run-1').state, expected);
    await js('openSchedulePanel()'); await openRuns(); const state = await phase(name + '-reopened');
    assert.deepEqual(state.states, [label]); assert.equal(sends, 1, 'viewing history never resends the automation');
    assert.equal(state.chatLinks, expected === 'succeeded' ? 1 : 0,
      'failed and cancelled history has no conversation navigation');
  });
  await check('an unaccepted trigger shows pending state without a fabricated chat entry', async () => {
    const row = records.get(actor + ':run-1');
    row.state = 'running'; delete row.conversationId; row.receipt.phase = 'device';
    await openRuns(); const state = await phase('unaccepted-trigger');
    assert.deepEqual(state.states, ['待执行']); assert.equal(state.chatLinks, 0);
    assert.match(state.text, /触发不代表已开始执行/);
    assert.match(state.text, /触发与执行记录/);
  });
  await check('a previously visible chat button cannot navigate after the cached receipt fails', async () => {
    await openRuns();
    await js("_schRunRows['schedule-0'][0].state='failed';void 0");
    await click('[data-run-chat]'); assert.equal(await js('openedChats.length'), 0);
    await js('_schRenderRunDrawer(false)');
    const state = await phase('stale-button-blocked');
    assert.deepEqual(state.states, ['失败']); assert.equal(state.chatLinks, 0);
  });
  await check('reopened cached pending receipt resumes polling without inferring completion from idle', async () => {
    await openRuns(); await click('[data-run-close]'); await worker.tick();
    assert.equal(records.get(actor + ':run-1').state, 'running', 'an idle handle does not prove completion');
    await openRuns(); const before = historyCalls.length;
    await settle({ ok: true });
    await until(() => historyCalls.length > before && js("document.querySelector('.sch-run-state')?.textContent==='完成'"), 'reopened pending history polls the terminal receipt');
    await phase('pending-poll-restored'); assert.equal(sends, 1);
  });
  await check('pending in-chat approval stays running until the original completion arrives', async () => {
    // An active approval keeps its turn promise pending; a resolved pause is
    // terminal for this occurrence and is covered separately above.
    await openRuns(); await click('[data-run-close]');
    await worker.tick(); await openRuns();
    assert.deepEqual((await phase('waiting-reopened')).states, ['执行中']);
    assert.equal(records.get(actor + ':run-1').state, 'running'); assert.equal(sends, 1);
    await settle({ ok: true });
    await until(() => js("document.querySelector('.sch-run-state')?.textContent==='完成'"), 'approval completion reaches history');
    assert.equal(records.get(actor + ':run-1').state, 'succeeded'); assert.equal(sends, 1);
  });
  await check('reopen failure retains cached state and exposes a working retry', async () => {
    await openRuns(); await click('[data-run-close]'); await settle({ ok: true }); historyFailure = true;
    await openRuns(); const failed = await phase('refresh-failed');
    assert.deepEqual(failed.states, ['执行中']); assert.match(failed.text, /记录暂时没有加载成功/);
    historyFailure = false; await click('[data-run-retry]');
    await until(() => js("document.querySelector('.sch-run-state')?.textContent==='完成'"), 'explicit retry reads completion');
    await phase('refresh-retried');
  });
  await check('late previous-account history cannot replace the new account receipt', async () => {
    delayHistory = true; await click(runButton); await until(() => !!pendingHistory, 'old account request held');
    const release = pendingHistory; actor = 'owner-b'; addRun(); await worker.tick(); await settle({ ok: false });
    await js("dispatchEvent(new Event('soduwork-data-scope-changed'));openSchedulePanel()"); await openRuns();
    release(); await wait(80); const state = await phase('account-changed');
    assert.deepEqual(state.states, ['失败']); assert.match(state.text, /新账号自动化/); assert.doesNotMatch(state.text, /本轮自动化/);
  });
  assert.deepEqual(report.network, []); report.ok = report.cases.length > 0 && report.cases.every(row => row.ok);
}).catch(error => { report.error = error.stack; }).finally(() => {
  worker?.stop(); pendingHistory?.(); win?.destroy();
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, cases: report.cases, error: report.error, report: path.join(out, 'report.json') }));
  app.exit(report.ok ? 0 : 1);
});
