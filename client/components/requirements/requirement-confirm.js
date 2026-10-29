/* One themed, cancellable decision for requirement maintenance and materials. */
(function (global) {
  'use strict';
  let active = null;
  function cancel() { active?.finish(false); }
  function open(options = {}) {
    if (active) return Promise.resolve(false);
    const valid = () => {
      try { return !options.valid || options.valid(); } catch (_) { return false; }
    };
    if (!valid()) return Promise.resolve(false);
    const previous = document.activeElement;
    return new Promise(resolve => {
      const dialog = document.createElement('dialog');
      dialog.className = 'rq-action-confirm';
      dialog.setAttribute('role', 'alertdialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'rqActionTitle');
      dialog.setAttribute('aria-describedby', 'rqActionName rqActionDescription');
      // Names and descriptions are text, including user-authored markup.
      const make = (tag, className, text) => {
        const node = document.createElement(tag); node.className = className;
        if (text != null) node.textContent = text;
        return node;
      };
      const header = make('header', 'rq-action-head'), title = make('h3', '', options.title || '确认删除？');
      title.id = 'rqActionTitle';
      const closeButton = make('button', 'rq-action-close', '×');
      closeButton.type = 'button'; closeButton.dataset.rqActionClose = '';
      closeButton.setAttribute('aria-label', '关闭确认弹窗');
      header.append(title, closeButton);
      const body = make('div', 'rq-action-body'), name = make('p', 'rq-action-name', options.name);
      name.id = 'rqActionName'; name.hidden = !options.name; name.dataset.userContent = '';
      const description = make('p', 'rq-action-description', options.description);
      description.id = 'rqActionDescription';
      body.append(name, description);
      const footer = make('footer', 'rq-action-foot'), cancelButton = make('button', '', '取消');
      cancelButton.type = 'button'; cancelButton.dataset.rqActionCancel = '';
      const confirmButton = make('button', 'rq-action-danger', options.confirmLabel || '删除');
      confirmButton.type = 'button'; confirmButton.dataset.rqActionConfirm = '';
      footer.append(cancelButton, confirmButton); dialog.append(header, body, footer);
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        const accepted = Boolean(value && valid());
        if (dialog.open) dialog.close();
        dialog.remove(); active = null;
        const target = options.returnFocus?.() || previous;
        if (target?.isConnected && target.getClientRects().length) target.focus({preventScroll: true});
        resolve(accepted);
      };
      active = {finish};
      closeButton.addEventListener('click', () => finish(false));
      cancelButton.addEventListener('click', () => finish(false));
      confirmButton.addEventListener('click', () => finish(true));
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
      dialog.addEventListener('close', () => finish(false));
      dialog.addEventListener('click', event => {
        if (event.target !== dialog) return;
        const r = dialog.getBoundingClientRect();
        if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) finish(false);
      });
      dialog.addEventListener('keydown', event => {
        // The decision owns keyboard input; Escape must not close the drawer.
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); finish(false); }
        if (event.key === 'Tab') {
          if (event.shiftKey && document.activeElement === closeButton) {
            event.preventDefault(); confirmButton.focus();
          } else if (!event.shiftKey && document.activeElement === confirmButton) {
            event.preventDefault(); closeButton.focus();
          }
        }
      });
      document.body.appendChild(dialog);
      try { dialog.showModal(); cancelButton.focus({preventScroll: true}); }
      catch (_) { finish(false); }
    });
  }
  global.addEventListener('soduwork-data-scope-changed', cancel);
  global.addEventListener('pagehide', cancel);
  global.RequirementConfirm = {open, cancel, isOpen: () => !!active};
})(window);
