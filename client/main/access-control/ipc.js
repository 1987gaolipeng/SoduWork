'use strict';
function answerHandler(session) {
  return async (event, ref, value) => {
    const handle = session.get(ref);
    if (!handle) return { ok: false, reason: '会话不在了' };
    if (typeof handle.answerUi !== 'function') return { ok: false, reason: '当前执行底座没有待处理的交互确认' };
    if (value?.requestId && (!handle.attachedWindow || handle.attachedWindow.webContents?.id !== event.sender.id)) {
      return { ok: false, reason: '请在当前会话窗口确认权限' };
    }
    return (await handle.answerUi(value || {})) || { ok: true };
  };
}
function changeHandler({ session, BrowserWindow, confirmFullAccess = require('./full-access-consent').confirm }) {
  const changing = new Set();
  return async (event, ref, mode, expectedRevision, options = {}) => {
    const handle = session.get(ref);
    const owner = () => handle && event?.sender && handle.attachedWindow?.webContents &&
      session.get(ref) === handle && handle.attachedWindow.webContents.id === event.sender.id;
    if (!owner()) return { ok: false, reason: '请在当前会话窗口修改权限' };
    if (changing.has(ref)) return { ok: false, reason: '正在确认权限，请稍候' };
    changing.add(ref);
    try {
      const snapshot = handle.snapshot();
      if (!snapshot.accessControl?.supported || !snapshot.accessControl?.canChangeDuringSession || typeof handle.setAccessPolicy !== 'function') {
        return { ok: false, reason: '当前执行底座暂不支持在会话中切换权限，请更新客户端或执行机' };
      }
      const rules = require('./policy');
      const current = snapshot.nextAccessPolicy || snapshot.accessPolicy;
      const policy = rules.next(mode, handle.cwd, current, expectedRevision);
      if (!snapshot.accessControl.modes?.includes(mode)) return { ok: false, reason: '当前执行底座不支持此权限模式' };
      if (mode === 'full' && current?.mode !== 'full') {
        const confirmed = await confirmFullAccess(BrowserWindow.fromWebContents(event.sender), { anchor: options?.anchor, source: event.sender });
        if (confirmed !== true) return { ok: false, cancelled: true };
      }
      if (!owner()) return { ok: false, reason: '会话窗口已变化，请重新选择' };
      // Native consent can remain open while the actual session advances.
      rules.next(mode, handle.cwd, handle.snapshot().nextAccessPolicy || handle.snapshot().accessPolicy, expectedRevision);
      const result = await handle.setAccessPolicy(policy, expectedRevision);
      if (!result?.ok) return result && { ...result, reason: require('./errors').message(result.reason) };
      const latest = handle.snapshot();
      return { ...result, effective: result.effective || (latest.nextAccessPolicy ? 'next-turn' : 'current-turn'), accessPolicy: latest.accessPolicy || null,
        nextAccessPolicy: latest.nextAccessPolicy || null, snapshot: latest };
    } catch (error) { return { ok: false, reason: require('./errors').message(error?.message || error) }; }
    finally { changing.delete(ref); }
  };
}
module.exports = { answerHandler, changeHandler };
