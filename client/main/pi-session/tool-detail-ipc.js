'use strict';
// Receipts are addressed only by a known session and recorded call ID. This
// endpoint never accepts a filesystem path or dispatches an executor command.
function createHandler({ session, BrowserWindow }) {
  return async (event, ref, id) => {
    const handle = typeof ref === 'string' && session.get(ref);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!handle || !win || win.isDestroyed() || handle.detached || handle.attachedWindow !== win ||
        (event.senderFrame && event.senderFrame !== event.sender.mainFrame)) {
      return { ok: false, reason: '当前窗口无法读取此会话的工具详情' };
    }
    if (typeof id !== 'string' || !id || id.length > 4096) return { ok: false, reason: '工具记录无效' };
    try {
      const tool = handle.toolDetail ? await handle.toolDetail(id) :
        require('./tool-detail').find(handle.snapshot()?.tools, id);
      if (session.get(ref) !== handle || handle.detached || handle.attachedWindow !== win)
        return { ok: false, reason: '会话已切换，请重新打开文件' };
      return tool ? { ok: true, tool } : { ok: false, reason: '工具记录已不可用，请重新打开会话后重试' };
    } catch (error) { return { ok: false, reason: String(error.message || error) }; }
  };
}
function install(options) { options.ipcMain.handle('pi-session-tool-detail', createHandler(options)); }
module.exports = { createHandler, install };
