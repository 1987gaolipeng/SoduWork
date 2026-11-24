'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');
const store = require('./local-model-store.cjs');
const capabilities = require('./local-model-capabilities.cjs');

function install({ app, ipcMain, safeStorage, changed = () => {} }) {
  store.configure({ app, safeStorage });
  function assertDesk(event) {
    const frame = event.senderFrame, url = frame?.url || event.sender.getURL();
    if ((frame && frame !== event.sender.mainFrame) || !url.startsWith('file:') ||
        path.resolve(fileURLToPath(new URL(url))) !== path.resolve(__dirname, '../desk.html')) {
      throw Error('本地模型设置只允许主工作台管理');
    }
  }
  ipcMain.handle('local-models-get', (event, historyChoice) => { assertDesk(event); return store.get(historyChoice); });
  ipcMain.handle('local-models-save', (event, input) => {
    assertDesk(event);
    const result = store.save(input || {});
    changed();
    return result;
  });
  ipcMain.handle('local-models-test', async (event, providerId, modelName) => {
    assertDesk(event);
    const result = await store.test(providerId || '', modelName || '');
    if (result.ok) changed();
    return result;
  });
  ipcMain.handle('local-models-capabilities-check', async (event, input) => {
    assertDesk(event);
    const result = await capabilities.check(input, { progress: value => {
      try { event.sender.send('local-models-capabilities-progress', { requestId: input.requestId, ...value }); } catch { /* View closed. */ }
    } });
    if (result.runtimeChanged) changed();
    return result;
  });
  ipcMain.handle('local-models-capabilities-cancel', (event, input) => { assertDesk(event); return capabilities.cancel(input); });
  app.on?.('before-quit', () => capabilities.shutdown());
}

module.exports = { install };
