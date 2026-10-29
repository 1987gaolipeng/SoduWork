/*
 * Shared renderer confirmation dialog for destructive actions. Native dialog elements
 * provide focus containment, Escape handling, and a backdrop. The main process supplies
 * localized action-specific text; renderer labels are fallbacks only.
 */
(function (global) {
  'use strict';
  let active = null;

  /*
   * Build elements explicitly and assign textContent because messages may contain
   * user-controlled conversation names.
   */
  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  function open(options) {
    const opts = options || {};
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return Promise.resolve(false);
    /* Keep one dialog active; replacing it resolves the previous request as false. */
    if (active) active.finish(false);
    return new Promise((resolve) => {
      const restoreTo = document.activeElement;
      const dialog = document.createElement('dialog');
      let settled = false;
      dialog.className = 'app-confirm-dialog';
      dialog.setAttribute('aria-labelledby', 'appConfirmTitle');
      const danger = opts.danger ? ' app-confirm-danger' : '';
      const cancelLabel = opts.cancel || '取消';
      const card = node('form', 'app-confirm-card');
      card.method = 'dialog';
      const head = node('header', 'app-confirm-head');
      const title = node('b', 'app-confirm-title', opts.title || '确认操作');
      title.id = 'appConfirmTitle';
      const close = node('button', 'app-confirm-close', '×');
      close.type = 'button';
      close.setAttribute('data-app-confirm-cancel', '');
      close.setAttribute('aria-label', cancelLabel);
      head.append(title, close);
      const foot = node('footer', 'app-confirm-foot');
      const cancelButton = node('button', 'app-confirm-cancel', cancelLabel);
      cancelButton.type = 'button';
      cancelButton.setAttribute('data-app-confirm-cancel', '');
      const submit = node('button', 'app-confirm-submit' + danger, opts.confirm || '确认');
      submit.type = 'submit';
      foot.append(cancelButton, submit);
      card.append(head);
      if (opts.message) card.append(node('p', 'app-confirm-message', opts.message));
      if (opts.detail) card.append(node('p', 'app-confirm-detail', opts.detail));
      card.append(foot);
      dialog.append(card);
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (active && active.dialog === dialog) active = null;
        try { if (dialog.open) dialog.close(); } catch (e) { /* Remove directly if showModal was never called. */ }
        dialog.remove();
        /* Restore the previous focus target when closing. */
        try { if (restoreTo && typeof restoreTo.focus === 'function' && document.contains(restoreTo)) restoreTo.focus(); } catch (e) {}
        resolve(Boolean(value));
      };
      active = { finish, dialog };
      dialog.querySelectorAll('[data-app-confirm-cancel]').forEach(button => {
        button.addEventListener('click', () => finish(false));
      });
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
      dialog.addEventListener('click', event => { if (event.target === dialog) finish(false); });
      dialog.querySelector('form').addEventListener('submit', event => { event.preventDefault(); finish(true); });
      document.body.appendChild(dialog);
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      /* Focus Cancel by default for destructive actions to avoid accidental confirmation with Enter. */
      const first = danger ? dialog.querySelector('.app-confirm-cancel') : dialog.querySelector('.app-confirm-submit');
      if (first) first.focus();
    });
  }

  global.SoduWorkConfirmDialog = { open };
})(window);
