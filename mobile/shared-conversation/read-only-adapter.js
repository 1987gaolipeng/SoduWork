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
    const rejected = latest?.ref === active() && latest?.snapshot?.mobileAccess?.personal && ['rejected', 'closed'].includes(latest.snapshot.mobileAccess.relay?.phase);
    if (!blocked) {
      for (const button of root.querySelectorAll('[data-mobile-send-blocked]')) {
        button.removeAttribute('data-mobile-send-blocked');
        button.removeAttribute('aria-describedby');
        root.querySelector('#nchatInput')?.dispatchEvent(new Event('input', {bubbles: true}));
      }
      if (!rejected) {notice?.remove(); return;}
    }
    if (!notice) {
      notice = document.createElement('section');
      notice.dataset.mobileReadonly = ''; notice.className = 'mobile-readonly';
      notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
      const title = document.createElement('strong');
      const reason = document.createElement('p'); reason.id = 'mobileReadonlyReason';
      const check = document.createElement('button'); check.type = 'button';
      check.addEventListener('click', async () => {
        if (checking) return;
        const ref = active(); checking = true; paint();
        try {
          const result = await session.reconnect(ref);
          if (!disposed && active() === ref) global.petSay?.(result?.ok === false
            ? result.reason : latest?.snapshot?.mobileAccess?.canSend === false
              ? latest.snapshot.mobileAccess.reason || '暂时无法发送，请稍后重试。' : '可以继续发送了');
        } catch (error) {
          if (!disposed && active() === ref) global.petSay?.(error.message);
        } finally {checking = false; paint();}
      });
      const recover = document.createElement('button'); recover.type = 'button'; recover.dataset.personalRecover = '';
      recover.addEventListener('click', async () => {
        if (checking) return;
        const ref = active(), resolve = latest?.snapshot?.mobileAccess?.relay?.resolve === true;
        if (resolve && !global.confirm('请先在电脑核对这条消息是否已发送。确认核对后关闭待确认回执？这不会重新发送。')) return;
        checking = true; paint();
        try {await session.personalRecover(ref, resolve);}
        catch (error) {if (!disposed && active() === ref) global.petSay?.(error.message);}
        finally {checking = false; paint();}
      });
      notice.append(title, check, reason, recover); composer.before(notice);
    }
    const personal = latest.snapshot.mobileAccess.personal;
    const title = notice.querySelector('strong');
    const acceptance = latest.snapshot.mobileAcceptance;
    const copy = global.SoduWorkMobileAccess.notice(latest.snapshot.mobileAccess, acceptance);
    const titleText = copy.title;
    if (title.textContent !== titleText) title.textContent = titleText;
    const reason = notice.querySelector('p');
    const text = copy.text;
    if (reason.textContent !== text) reason.textContent = text;
    const recover = notice.querySelector('[data-personal-recover]');
    const relay = latest.snapshot.mobileAccess.relay || {};
    recover.hidden = !personal || (!relay.retry && !relay.resolve);
    if (recover.disabled !== checking) recover.disabled = checking;
    const recoverText = relay.resolve ? '已在电脑核对，关闭待确认回执' : '重试原发送';
    if (recover.textContent !== recoverText) recover.textContent = recoverText;
    const check = notice.querySelector('button');
    check.hidden = !!acceptance?.binding;
    const label = checking ? '正在检查…' : (personal ? '刷新状态' : '重新检查权限');
    if (check.textContent !== label) check.textContent = label;
    if (check.disabled !== checking) check.disabled = checking;
    // Leave the editor intact so an unsent draft remains selectable/copyable.
    // The send API independently rejects keyboard and programmatic retries.
    const send = root.querySelector('#nchatSend');
    if (send && blocked && !latest.snapshot.execution?.running) {
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
