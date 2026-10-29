'use strict';

function install({ app, ipcMain, session, identityOf, notify, assertOwner = () => {} }) {
  const controller = require('./cloud-handoff').create({ app, identityOf, notify,
    validateHandle(handle, identity) {
      const current = session.get(handle.ref);
      if ((current?.[Symbol.for('soduwork.agent-runtime.native-handle')] || current) !== handle) throw Error('会话已关闭，请重新打开');
      assertOwner(identity, handle);
      require('./requirement-context').identityMatches(handle, identity);
    } });
  session.setExternalHistory?.(controller);
  for (const action of ['start', 'targets']) {
    ipcMain.handle('conversation-cloud-' + action, async (event, input) => {
      try {
        if (!require('../access-control/preferences').isTrusted(event)) throw Error('请在 SoduWork 工作区中创建云端会话');
        return await controller[action](input);
      } catch (error) { return { ok: false, reason: String(error.message || error) }; }
    });
  }
  for (const action of ['preview', 'confirm', 'recover', 'abort', 'materialize']) {
    ipcMain.handle('conversation-cloud-' + action, async (event, ref, input) => {
      try {
        if (!require('../access-control/preferences').isTrusted(event)) throw Error('请在 SoduWork 工作区中操作云端交接');
        const handle = session.get(ref);
        if (!handle) throw Error('会话已关闭，请重新打开后再试');
        if (action === 'materialize' && handle.attachedWindow?.webContents &&
            handle.attachedWindow.webContents !== event.sender) throw Error('请在所属会话窗口中打开成果');
        const result = await controller[action](handle, input || {});
        // A reopened transfer uses a passive projection, not a dormant SDK.
        // Once Hub proves cancellation, dispose it before the renderer resumes
        // the original archive so the registry cannot hand back a locked view.
        if (result?.handoff?.phase === 'aborted' && handle.passiveCloudView) {
          await handle.close();
          return { ...result, reopenLocal: true, sessionId: handle.sessionId };
        }
        return result;
      } catch (error) { return { ok: false, reason: String(error.message || error) }; }
    });
  }
  return controller;
}

module.exports = { install };
