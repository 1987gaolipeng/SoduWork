'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-auto-memory-e2e-'));
  const result = require('node:child_process').spawnSync(electron, [__filename], { stdio: 'inherit', windowsHide: true,
    env: { ...process.env, SODUWORK_MEMORY_E2E_PROFILE: profile, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined } });
  if (path.dirname(profile) === path.resolve(os.tmpdir()) && path.basename(profile).startsWith('soduwork-auto-memory-e2e-')) fs.rmSync(profile, { recursive: true, force: true });
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, ipcMain } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const memory = require('../main/conversation/session-memory');
const { identity } = require('../tests/helpers/platform-session-fixture.cjs');
const root = process.env.SODUWORK_MEMORY_E2E_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-auto-memory-e2e-'));
app.setPath('userData', root);
let win, auth = identity('one');
const checks = [], sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = code => win.webContents.executeJavaScript(code);
async function until(code) { for (let i = 0; i < 150; i++) { if (await js(code)) return; await sleep(20); } throw Error('timeout: ' + code); }
async function open() { await js('openSessionMemoryPanel()'); }
async function run() {
  // Real main-process service, real IPC/preload, real account-scoped filesystem.
  // Only model completion events are fixtures: this tests memory, not model quality.
  const service = memory.install({ app, ipcMain, identityOf: async () => auth });
  global.fetch = async () => ({ ok: false, status: 503 });
  win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: {
    preload: path.join(__dirname, '../preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  await win.loadFile(path.join(__dirname, 'fixtures/session-memory.html'));
  await until('window.ready === true');
  const initial = { ids: [], items: [], scopes: [] };
  for (const adapter of ['pi', 'codex-harness', 'opencode', 'claude', 'codex', 'qwen', 'dsh']) {
    let receive, snapshot = { status: 'idle', messages: [] };
    const session = { sessionId: 'automatic-e2e-' + adapter, ui: {}, snapshot: () => snapshot,
      on: fn => { receive = fn; return () => {}; } };
    await service.attach(session, auth, initial, [], { workspaceExplicit: false });
    snapshot = { status: 'streaming', messages: [{ role: 'user', content: 'Verify delivery ' + adapter }] };
    receive({ kind: adapter === 'pi' ? 'turn-dequeued' : 'started' });
    snapshot = { status: 'idle', messages: [{ role: 'user', content: 'Verify delivery ' + adapter },
      { role: 'assistant', blocks: [{ kind: 'thinking', text: 'DO NOT SAVE REASONING' }, { kind: 'text', text: 'Completed result for ' + adapter }] }] };
    receive({ kind: adapter === 'pi' ? 'turn-finished' : 'settled' });
    await session.ui.memorySubscription();
  }
  await open();
  await until("document.querySelector('[data-personal-content]').value.includes('Completed result for dsh')");
  const contents = await js("document.querySelector('[data-personal-content]').value");
  assert.equal((contents.match(/Completed result for/g) || []).length, 7);
  assert.doesNotMatch(contents, /<!-- soduwork-work-memory:/);
  assert.doesNotMatch(contents, /DO NOT SAVE REASONING/);
  checks.push('Seven native adapter event shapes appear in the real personal-memory editor');
  await js('closeSessionMemoryPanel()'); await open();
  await until("document.querySelector('[data-personal-content]').value.includes('Completed result for pi')");
  checks.push('Metadata-only list resolves full content after close/reopen');
  await js("const field=document.querySelector('[data-personal-content]');field.value='User agreement: verify before delivery.\\n\\n'+field.value;field.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-personal-form]').requestSubmit()");
  await until("document.querySelector('[data-message]').textContent.includes('已保存')");
  await js('closeSessionMemoryPanel()'); await win.reload();
  await until('window.ready === true'); await open();
  await until("document.querySelector('[data-personal-content]').value.includes('User agreement')");
  const next = await service.context(auth, { workspaceExplicit: false });
  assert.match(next.prompt, /User agreement/); assert.match(next.prompt, /Completed result for pi/);
  checks.push('Manual additions and automatic memory survive renderer reload and are reused in a new conversation');
  await js("const draftField=document.querySelector('[data-personal-content]');draftField.value='PRIVATE UNSAVED DRAFT';draftField.dispatchEvent(new Event('input',{bubbles:true}))");
  auth = identity('two');
  await js('closeSessionMemoryPanel()'); await open(); await sleep(180);
  assert.equal(await js("document.querySelector('[data-personal-content]').value"), '');
  assert.equal((await service.context(auth, {})).prompt, '');
  checks.push('A second account cannot see or use the first account memory');
  auth = identity('one'); await js('closeSessionMemoryPanel()'); await open();
  await until("document.querySelector('[data-personal-content]').value.includes('User agreement')");
  win.setSize(560, 750); await sleep(100);
  assert.ok(await js("[...document.querySelectorAll('.cmem-panel,.cmem-detail,.cmem-form')].every(n=>n.scrollWidth<=n.clientWidth+2)"));
  const output = path.resolve(__dirname, '../../outputs/personal-memory-automatic');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'personal-memory.png'), (await win.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: true, checks, realIpc: true, realFilesystem: true, modelCalls: false }, null, 2));
  console.log(JSON.stringify({ ok: true, checks }));
}
app.whenReady().then(run).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (win && !win.isDestroyed()) win.destroy();
  // The parent removes the isolated profile after Electron releases its locks.
  app.exit(process.exitCode || 0);
});
