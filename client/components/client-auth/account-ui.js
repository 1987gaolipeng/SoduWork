(function (global) {
  'use strict';
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g,
    ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const email = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim()) && String(value).length <= 254;
  const code = value => /^\d{6}$/.test(String(value || ''));
  function error(value) {
    return String(value && (value.error || value.message || value.reason) || '操作未完成，请重试');
  }
  function check(result) {
    if (!result || result.ok === false) throw Object.assign(Error(error(result)), result || {});
    return result;
  }
  function modal(parent, title, body, className) {
    const previous = document.activeElement;
    const owner = global.SoduWorkAPI?.clientAuthSnapshot?.()?.user?.id;
    const hub = global.SoduWorkAPI?.hubBase?.();
    const mask = document.createElement('div');
    mask.className = 'ac-mask ' + (className || '');
    mask.innerHTML = '<section class="ac-dialog" role="dialog" aria-modal="true" aria-label="' + esc(title) + '">' +
      '<header class="ac-dialog-head"><h2>' + esc(title) + '</h2><button type="button" class="ac-icon" data-ac-close aria-label="关闭对话框">×</button></header>' +
      '<div class="ac-dialog-body">' + body + '</div></section>';
    parent.appendChild(mask);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      mask.dispatchEvent(new Event('ac-close'));
      mask.remove(); document.removeEventListener('keydown', keydown, true);
      global.removeEventListener('soduwork-data-scope-changed', scopeChanged);
      global.removeEventListener('soduwork-client-auth-required', scopeChanged);
      if (previous?.isConnected) previous.focus();
    };
    const scopeChanged = () => {
      if (owner && (owner !== global.SoduWorkAPI?.clientAuthSnapshot?.()?.user?.id || hub !== global.SoduWorkAPI?.hubBase?.())) close();
    };
    const keydown = event => {
      if (document.querySelectorAll('.ac-mask').length && [...document.querySelectorAll('.ac-mask')].at(-1) !== mask) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
      if (event.key !== 'Tab') return;
      const fields = [...mask.querySelectorAll('button,input,textarea,select,a[href]')].filter(el => !el.disabled && el.getClientRects().length);
      if (!fields.length) return;
      const first = fields[0], last = fields.at(-1);
      if (event.shiftKey && (document.activeElement === first || !mask.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown, true);
    global.addEventListener('soduwork-data-scope-changed', scopeChanged);
    global.addEventListener('soduwork-client-auth-required', scopeChanged);
    mask.querySelector('[data-ac-close]').addEventListener('click', close);
    mask.querySelector('input,button')?.focus();
    return { mask, close, active: () => !closed && mask.isConnected };
  }
  function legal(parent, documents, kind) {
    const rows = Array.isArray(documents) ? documents : [];
    const doc = rows.find(item => item.kind === kind || item.type === kind || item.id === kind || item.key === kind);
    const title = kind === 'terms' ? '用户协议' : '隐私政策';
    const dialog = modal(parent, title, '<div class="ac-legal-copy"></div>', 'ac-legal');
    const content = dialog.mask.querySelector('.ac-legal-copy');
    content.textContent = doc?.content || doc?.body || '协议内容暂未加载，请稍后重试。';
    if (doc?.version) {
      const version = document.createElement('p'); version.className = 'ac-muted';
      version.textContent = '版本：' + doc.version; content.prepend(version);
    }
    return dialog;
  }
  function bindPassword(parent) {
    const tx = value => (global.SoduWorkI18n && typeof global.SoduWorkI18n.translateText === 'function')
      ? global.SoduWorkI18n.translateText(value) : value;
    const refresh = () => parent.querySelectorAll('[data-password-toggle]').forEach(button => {
      const input = parent.querySelector('#' + button.dataset.passwordToggle);
      const visible = input && input.type === 'text';
      button.textContent = tx(visible ? '隐藏' : '显示');
      button.setAttribute('aria-label', tx(visible ? '隐藏密码' : '显示密码'));
      button.setAttribute('aria-pressed', String(visible));
    });
    parent.querySelectorAll('[data-password-toggle]').forEach(button => button.addEventListener('click', () => {
      const input = parent.querySelector('#' + button.dataset.passwordToggle);
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password'; refresh();
    }));
    refresh();
    const onLocaleChange = () => refresh();
    global.addEventListener?.('soduwork-locale-change', onLocaleChange);
    parent._accountUiPasswordLocaleDispose = () => global.removeEventListener?.('soduwork-locale-change', onLocaleChange);
  }
  global.AccountUI = { esc, email, code, error, check, modal, legal, bindPassword };
})(window);
