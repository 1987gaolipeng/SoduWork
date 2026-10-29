'use strict';
// Isolate Electron presentation tests from real accounts, Hub, and models.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename, '--disable-gpu'], {
    env, windowsHide: true, stdio: 'inherit', timeout: 60000,
  });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = electron;
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-plugin-window-'));
app.setPath('userData', root);
app.setPath('sessionData', path.join(root, 'session'));
app.disableHardwareAcceleration();
let win;
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  await win.loadURL('data:text/html,<html><body></body></html>');
  const client = path.resolve(__dirname, '..');
  const desktop = fs.readFileSync(path.join(client, 'desk.html'), 'utf8');
  const scripts = [...desktop.matchAll(/<script src="(components\/panels\/chat-(?:dom-patch|decorate-carry|plugin-draft-placement|output-links)\.js)"><\/script>/g)];
  if (scripts.length !== 4) throw Error('Desktop plugin script set must be complete');
  for (const [, file] of scripts) {
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(client, file), 'utf8'));
  }
  const cases = await win.webContents.executeJavaScript(`(() => {
    const check = (value, message) => { if (!value) throw Error(message); };
    const cases = [];
    const html = '<div class="nmsg user" data-chat-node="message:0">用户一</div>' +
      '<div class="nmsg ai" data-chat-node="message:1" data-delivery-current="false" data-delivery-final="false">处理中</div>' +
      '<div class="nmsg ai" data-chat-node="message:2" data-delivery-current="false" data-delivery-final="true">生成完成</div>' +
      '<div class="nmsg user" data-chat-node="message:3">用户二</div>' +
      '<div class="nmsg ai" data-chat-node="message:4" data-delivery-current="false" data-delivery-final="true">后续回复</div>';
    const files = [{ artifactId: 'art_draft', name: 'soduwork-plugin-draft.json', pluginDraft: true,
      pluginName: '测试插件', pluginIdentity: 'name:test', at: 130 }];
    const snapshot = { messages: [{ role: 'user', sentAt: 100 }, { role: 'assistant', completedAt: 120 },
      { role: 'assistant', completedAt: 140 }, { role: 'user', sentAt: 200 }, { role: 'assistant', completedAt: 240 }],
      history: { messageIndices: [0, 1, 2, 3, 4] } };
    const create = () => { const root = document.createElement('div'); root.innerHTML = html; return root; };
    const original = create();
    ChatOutputLinks.pluginDrafts(original, files, 'session-a', snapshot);
    check(original.querySelector('.nplugin-draft').dataset.pluginDraftOwner === '2', 'absolute owner captured');
    const shifted = { messages: snapshot.messages.map(item => ({ role: item.role })),
      history: { messageIndices: [10, 11, 12, 13, 14] } };
    const settled = document.createElement('div');
    settled.innerHTML = ChatOutputLinks.decorate(html, files, 'session-a', shifted, original);
    check(settled.querySelectorAll('.nplugin-draft').length === 1, 'settled keeps one historical entry');
    check(!settled.querySelector('.nplugin-draft').closest('.nmsg'), 'settled never copies into a reused local reply');
    cases.push('settled window slide');

    const captured = ChatDecorateCarry.capture(original);
    const streaming = create();
    ChatDecorateCarry.reconcile(streaming, files, captured, shifted);
    check(streaming.querySelectorAll('.nplugin-draft').length === 0, 'streaming never reattaches to a reused local reply');
    ChatDecorateCarry.reconcile(streaming, files, captured, snapshot);
    check(streaming.querySelectorAll('.nplugin-draft').length === 1, 'same absolute owner is retained');
    ChatDecorateCarry.reconcile(streaming, files, new Map(), shifted);
    check(streaming.querySelectorAll('.nplugin-draft').length === 0, 'in-place preserved stale card is removed');
    cases.push('streaming clone and in-place carry');

    const legacy = create();
    ChatOutputLinks.pluginDrafts(legacy, files, 'session-a', { messages: snapshot.messages });
    const legacyCaptured = ChatDecorateCarry.capture(legacy), rebuilt = create();
    ChatDecorateCarry.reconcile(rebuilt, files, legacyCaptured, { messages: snapshot.messages });
    check(rebuilt.querySelectorAll('.nplugin-draft').length === 1, 'legacy snapshots retain stable local ownership');
    cases.push('legacy snapshots without history');

    const first = ChatOutputLinks.decorate(html, files, 'memo-case', snapshot);
    const moved = ChatOutputLinks.decorate(html, files, 'memo-case', { ...snapshot, history: shifted.history });
    check(first.includes('data-plugin-draft-owner="2"') && moved.includes('data-plugin-draft-owner="12"'), 'memo observes history index changes');
    cases.push('settled memo invalidation');
    return cases;
  })()`);
  console.log(JSON.stringify({ ok: true, electron: process.versions.electron, cases }));
  app.exit(0);
}).catch(error => { console.error(error.stack || error); app.exit(1); });
