(function (global) {
  'use strict';
  const session = global.soduWorkAPI.conversationSession;
  let latest, disposed = false, checking = false;
  const active = () => global.NativeChat?.sessionInfo?.()?.ref;
  function paint() {
    if (disposed) return;
    const root = document.getElementById('cpChat');
    const composer = root?.querySelector('.work-composer');
    if (!composer) return;
    const blocked = latest?.ref === active() && latest?.snapshot?.mobileAccess?.canSend === false;
    let notice = root.querySelector('[data-mobile-readonly]');
    if (!blocked) {
      notice?.remove();
      for (const button of root.querySelectorAll('[data-mobile-send-blocked]')) {
        button.removeAttribute('data-mobile-send-blocked');
        button.removeAttribute('aria-describedby');
        root.querySelector('#nchatInput')?.dispatchEvent(new Event('input', {bubbles: true}));
      }
      return;
    }
    if (!notice) {
      notice = document.createElement('section');
      notice.dataset.mobileReadonly = ''; notice.className = 'mobile-readonly';
      notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
      const title = document.createElement('strong'); title.textContent = '当前设备仅可查看';
      const reason = document.createElement('p'); reason.id = 'mobileReadonlyReason';
      const check = document.createElement('button'); check.type = 'button';
      check.addEventListener('click', async () => {
        if (checking) return;
        const ref = active(); checking = true; paint();
        try {
          const result = await session.reconnect(ref);
          if (!disposed && active() === ref) global.petSay?.(result?.ok === false
            ? result.reason : latest?.snapshot?.mobileAccess?.canSend === false
              ? '当前设备仍未获准续发，可在原设备继续或新建云会话。' : '会话权限已刷新');
        } catch (error) {
          if (!disposed && active() === ref) global.petSay?.(error.message);
        } finally {checking = false; paint();}
      });
      notice.append(title, reason, check); composer.before(notice);
    }
    const reason = notice.querySelector('p');
    const text = latest.snapshot.mobileAccess.reason || '请在创建会话的设备继续，或新建云会话。已有记录和成果仍可查看，未发送内容可复制保留。';
    if (reason.textContent !== text) reason.textContent = text;
    const check = notice.querySelector('button');
    const label = checking ? '正在检查…' : '重新检查权限';
    if (check.textContent !== label) check.textContent = label;
    if (check.disabled !== checking) check.disabled = checking;
    // Leave the editor intact so an unsent draft remains selectable/copyable.
    // The send API independently rejects keyboard and programmatic retries.
    const send = root.querySelector('#nchatSend');
    if (send && !latest.snapshot.execution?.running) {
      if (!send.hasAttribute('data-mobile-send-blocked')) send.setAttribute('data-mobile-send-blocked', '');
      if (send.getAttribute('aria-describedby') !== 'mobileReadonlyReason') send.setAttribute('aria-describedby', 'mobileReadonlyReason');
      if (!send.disabled) send.disabled = true;
    }
  }
  const unsubscribe = session.onEvent(event => {latest = event; Promise.resolve().then(paint);});
  const observer = new MutationObserver(paint);
  observer.observe(document.getElementById('cpChat'), {childList: true, subtree: true, attributes: true, attributeFilter: ['disabled']});
  global.addEventListener('pagehide', () => {disposed = true; unsubscribe(); observer.disconnect();}, {once: true});
})(window);
