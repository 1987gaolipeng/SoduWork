'use strict';
const crypto = require('node:crypto');
const { createStore, declaration } = require('./custom-runtime-store.cjs');

function create({ app, session, runner, store = createStore(app), changed = () => {} }) {
  let operation = Promise.resolve();
  function list() {
    return { ok: true, agents: store.read().map(entry => ({ id: entry.declaration.id,
      displayName: entry.declaration.displayName, summary: entry.declaration.summary,
      modelMode: entry.declaration.modelMode, active: entry.active })) };
  }
  function restore() {
    for (const entry of store.read()) if (entry.active) session.addRuntime(entry.declaration);
  }
  async function activate() {
    const entries = store.read();
    if (!entries.length) return list();
    try {
      const result = await runner.rpc('runtime.catalog.apply', { agents: entries.map(entry => entry.declaration) }, 10000);
      if (!result?.ok) throw Error(result?.error || '执行机未确认底座配置，请更新 Runner 后重试');
      if (!Array.isArray(result.data?.agents) || entries.some(entry => !result.data.agents.some(row =>
        row.id === entry.declaration.id && row.modelMode === entry.declaration.modelMode))) {
        throw Error('执行机返回的底座确认不完整，请更新 Runner 后重试');
      }
      entries.forEach(entry => session.addRuntime(entry.declaration));
      store.write(entries.map(entry => ({ ...entry, active: true })));
      changed();
      return { ...list(), state: 'active' };
    } catch (error) {
      return { ...list(), state: 'pending', reason: '配置已保存，尚未确认生效：' + String(error.message || error) };
    }
  }
  function serialized(fn) {
    const job = operation.then(fn); operation = job.catch(() => {}); return job;
  }
  return { list, restore, activate: () => serialized(activate),
    add: input => serialized(async () => {
      const row = declaration({ ...input, id: input?.id || 'custom-' + crypto.randomUUID().slice(0, 8) });
      const entries = store.read(), existing = entries.find(entry => entry.declaration.id === row.id);
      if (existing && JSON.stringify(existing.declaration) !== JSON.stringify(row)) throw Error('此底座标识已存在，请使用新的标识');
      if (!existing) store.write([...entries, { declaration: row, active: false }]);
      return { ...await activate(), id: row.id };
    }),
  };
}
function install({ app, ipcMain, session, runner, BrowserWindow, dialog, changed }) {
  const trusted = require('../access-control/preferences').isTrusted;
  const controller = create({ app, session, runner, changed: changed || (() => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('agent-runtimes-changed');
    }
  }) });
  try { controller.restore(); } catch (error) { console.warn('[custom-agents] configuration unavailable:', error.message); }
  const wrap = action => async (event, input) => {
    if (!trusted(event)) return { ok: false, reason: '请在 SoduWork 的 Agent 管理中接入底座' };
    try { return await action(input); } catch (error) { return { ok: false, reason: String(error.message || error) }; }
  };
  ipcMain.handle('custom-agents-list', wrap(() => controller.list()));
  ipcMain.handle('custom-agents-add', wrap(input => controller.add(input)));
  ipcMain.handle('custom-agents-activate', wrap(() => controller.activate()));
  ipcMain.handle('custom-agents-pick', async event => {
    if (!trusted(event)) return { ok: false, reason: '请在 SoduWork 的 Agent 管理中选择程序' };
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender),
      require('../native-locale.cjs').dialogOptions({ title: '选择已安装的 Agent 程序', properties: ['openFile'] }));
    return result.canceled ? { ok: false, canceled: true } : { ok: true, path: result.filePaths[0] };
  });
  return controller;
}
module.exports = { create, install };
