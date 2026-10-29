'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const source = fs.readFileSync(path.join(__dirname, '../main/pi-session/ipc.js'), 'utf8');
const handler = source.slice(source.indexOf('  async function openConversation('), source.indexOf("  ipcMain.handle('pi-session-open',"));

test('maintenance permits authenticated reattachment but blocks new and archived runtimes', async () => {
  let attached = 0, deniedOwner = false;
  const live = { ref: 'live-ref', sessionId: 'existing' };
  const frame = {}, event = { senderFrame: frame, sender: { mainFrame: frame,
    isDestroyed: () => false, getURL: () => pathToFileURL(path.resolve(__dirname, '../desk.html')).href } };
  const emptyStorage = path.join(require('node:os').tmpdir(), 'soduwork-update-reattach-' + require('node:crypto').randomUUID());
  const context = vm.createContext({ app: { getPath: () => emptyStorage }, identityOf: async () => ({ hub: 'hub', clientId: 'device' }),
    _cloudHandoff: { observe() {} },
    require: name => {
      if (['../work-preview', '../conversation/app-surfaces.cjs', './app-mcp-grant.cjs'].includes(name)) {
        return require(path.join(__dirname, '../main/pi-session', name));
      }
      assert.ok(['./task-access', '../access-control/preferences', '../access-control/automation-access', '../conversation/requirement-context', '../conversation/acceptance-session'].includes(name));
      return require(path.join(__dirname, '../main/pi-session', name));
    },
    updateWorkloads: { guard: () => ({ ok: false, maintenance: true }) },
    memories: { assertOwner: () => { if (deniedOwner) throw Error('wrong owner'); } },
    session: { findBySessionId: id => id === 'existing' ? live : null },
    _bindUsage() {}, _attach(handle) { assert.equal(handle, live); attached++; }, _wire() {},
    BrowserWindow: { fromWebContents: () => ({}) }, _openReply: handle => ({ ok: true, ref: handle.ref }),
  });
  vm.runInContext(handler, context);
  assert.equal((await context.openConversation(event, {chatId:'existing'})).ok, true);
  assert.equal(attached, 1);
  assert.equal((await context.openConversation(event, {})).maintenance, true);
  assert.equal((await context.openConversation(event, {chatId:'archive'})).maintenance, true);
  deniedOwner = true;
  assert.equal((await context.openConversation(event, {chatId:'existing'})).ok, false);
  assert.equal(attached, 1);
});
