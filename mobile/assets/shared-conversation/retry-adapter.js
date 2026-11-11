(function (global) {
  'use strict';
  const session = global.soduWorkAPI.conversationSession;
  let latest, busy = false, disposed = false;
  const active = () => global.NativeChat?.sessionInfo?.()?.ref;
  function paint() {
    if (disposed) return;
    const root = document.getElementById('cpChat');
    if (!root) return;
    const existing = root.querySelector('[data-mobile-reconnect]');
    const eligible = latest?.ref === active() && latest?.snapshot?.status === 'unreachable';
    if (!eligible) {existing?.remove(); return;}
    const host = root.querySelector('[data-chat-node="runtime-error"]');
    if (!host || host.querySelector('[data-session-retry]')) return;
    const button = existing || document.createElement('button');
    if (!existing) {
      button.type = 'button'; button.dataset.mobileReconnect = '';
      button.addEventListener('click', async () => {
        if (busy || latest?.ref !== active()) return;
        const ref = active(); busy = true; paint();
        try {
          const result = await session.reconnect(ref);
          if (!disposed && active() === ref && result?.ok === false) {
            global.petSay?.(result.reason || '连接尚未恢复，请稍后重试');
          }
        } catch (error) {
          if (!disposed && active() === ref) global.petSay?.(error.message || '连接尚未恢复');
        } finally {busy = false; paint();}
      });
      host.append(button);
    }
    const label = busy ? '正在连接…' : '重新连接';
    if (button.textContent !== label) button.textContent = label;
    if (button.disabled !== busy) button.disabled = busy;
  }
  const unsubscribe = session.onEvent(event => {
    latest = event;
    // The PC subscriber paints the same event first; decorate that result.
    Promise.resolve().then(paint);
  });
  const observer = new MutationObserver(paint);
  observer.observe(document.getElementById('cpChat'), {childList: true, subtree: true});
  global.addEventListener('pagehide', () => {disposed = true; unsubscribe(); observer.disconnect();}, {once: true});
})(window);
