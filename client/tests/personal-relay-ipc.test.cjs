'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../main/pi-session/ipc.js'), 'utf8');
const sendSource = source.slice(source.indexOf('  async function sendConversation('),
  source.indexOf("  ipcMain.handle('pi-session-send'"));

function fixture(workflow = false) {
  let native = 0, plugins = 0;
  const submitted = () => ({ accepted: true, completion: Promise.resolve({ ok: true }) });
  const handle = { ref: 'original', sessionId: 'native-original', cwd: '/fixture',
    submit: async () => { native++; return submitted(); } };
  const modules = {
    './skill-turn': require('../main/pi-session/skill-turn'),
    '../conversation/requirement-context': { assertOwner() {} },
    '../conversation/acceptance-session': { attach: async () => {}, assertTask: () => null },
    './app-mcp-grant.cjs': { nativePluginId: () => '', guardSend() {} },
    '../app-conversation-connection.cjs': { association: () => '' },
  };
  const context = vm.createContext({ require: name => { assert.ok(modules[name], name); return modules[name]; },
    updateWorkloads: { guard: () => ({ ok: true }) }, session: { get: () => handle },
    sendIdentityOf: async () => ({}), identityOf: async () => ({}), app: {}, memories: { assertOwner() {} },
    _cloudHandoff: { guard: () => false }, path, workDir: () => '/fixture',
    attachments: { stage: async () => ({ files: [], warnings: [] }) },
    pluginDebug: { guard: () => '', submitConversation: async () => { plugins++; return workflow ? submitted() : null; } },
    BrowserWindow: {}, _publish() {}, _uiWindow: { snapshot: () => ({}) }, _contextSnapshot: () => ({}),
    _scheduleRelease() {}, console,
  });
  vm.runInContext(sendSource, context);
  return { send: guard => context.sendConversation('original', 'continue', [], {nativeRelayGuard: guard}),
    native: () => native, plugins: () => plugins };
}

test('native IPC awaits the first ownership fence before entering plugin code', async () => {
  const f = fixture(true);
  const result = await f.send(async () => { await Promise.resolve(); throw Error('account changed'); });
  assert.equal(result.ok, false); assert.equal(f.plugins(), 0); assert.equal(f.native(), 0);
});

test('native IPC rechecks after asynchronous plugin selection and before native submit', async () => {
  const f = fixture(); let checks = 0;
  const result = await f.send(async () => { if (++checks === 2) throw Error('source changed'); });
  assert.equal(checks, 2); assert.equal(result.accepted, false); assert.equal(f.native(), 0);
});

test('native IPC submits exactly once and preserves the existing plugin execution path', async () => {
  for (const workflow of [false, true]) {
    const f = fixture(workflow); let checks = 0;
    const result = await f.send(async () => { checks++; });
    assert.equal(result.ok, true); assert.equal(result.accepted, true);
    assert.equal(checks, workflow ? 1 : 2);
    assert.equal(f.native(), workflow ? 0 : 1);
    assert.equal(f.plugins(), 1);
  }
});
