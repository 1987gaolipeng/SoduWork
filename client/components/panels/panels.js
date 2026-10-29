




/* ---------- Utilities ---------- */
const _PRIO_LABEL = window.TaskPriority.labels;
const _RECUR_LABEL = { daily: '每天', weekly: '每周', monthly: '每月' };
function _fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts), p = n => (n < 10 ? '0' : '') + n;
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function _fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return (d.getMonth() + 1) + '/' + d.getDate();
}
/* Date inputs require yyyy-MM-dd values. */
function _fmtInputDate(ts) {
  if (!ts) return '';
  const d = new Date(ts), p = x => (x < 10 ? '0' : '') + x;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* Global event bindings. */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _bindPanelEvents);
} else {
  _bindPanelEvents();
}
function _bindPanelEvents() {
  /*
   * Settings owns its close handler; binding it here would invoke it twice.
   */
  const ac = document.getElementById('addCancel');     if (ac) ac.addEventListener('click', () => window.closeAdd());
  const ao = document.getElementById('addOk');         if (ao) ao.addEventListener('click', _submitAdd);
  const it = document.getElementById('inTitle');
  if (it) it.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); _submitAdd(); } });
  /*
   * app/app.js binds the settings segments and their apply callbacks; avoid duplicate
   * handlers.
   */
  const skc = document.getElementById('skinClose');
  if (skc) skc.addEventListener('click', () => { if (typeof closeSkinManager === 'function') closeSkinManager(); });
  const mask = document.getElementById('addMask');
  if (mask) mask.addEventListener('click', e => { if (e.target === mask) window.closeAdd(); });

  /* Offer Copy for selected text; leave other context menus to their owners. */
  document.addEventListener('contextmenu', e => {
    const s = window.getSelection ? String(window.getSelection() || '').trim() : '';
    if (!s) return;
    e.preventDefault();
    _showCopyMenu(e.clientX, e.clientY, s);
  });
  document.addEventListener('click', e => {
  if (!e.target.closest('.ctx-menu')) hideCtx();
  /*
   * Task views stay open until minimized through navigation. Standalone task-list popups
   * still close on outside clicks.
   */
  });
  document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (e.defaultPrevented || document.querySelector('dialog:modal,[popover]:popover-open,.catt-preview,.pui-layer.is-visible')) return;
    const _iv = document.getElementById('imgViewer');
    if (_iv && _iv.classList.contains('show') && _iv._close) { _iv._close(); return; }
    hideCtx();
    const pm = document.getElementById('soduWorkPwdModal');
    if (pm && pm.classList.contains('is-open')) return;   /* Let the topmost password dialog handle dismissal without closing settings. */
    // Keep workspace and standalone main pages open; Escape dismisses overlays only.
    const page = document.documentElement.dataset.deskPanel;
    const isOverlay = (node, ...pages) => node && node.classList.contains('show') &&
      !node.classList.contains('workspace-hosted') && !pages.includes(page);
    const sp = document.getElementById('settingsPanel');
    const am = document.getElementById('addMask');
    const sm = document.getElementById('skinManager');
    if (isOverlay(sp, 'settings') && typeof closeSettings === 'function') { closeSettings(); return; }
    if (isOverlay(am, 'add')) { window.closeAdd(); return; }
    if (isOverlay(sm, 'skin') && typeof closeSkinManager === 'function') { closeSkinManager(); return; }
    const hb = document.getElementById('historyBoard');
    if (isOverlay(hb, 'history', 'workitems')) { closeHistoryBoard(); return; }
    const np = document.getElementById('noticePanel');
    if (isOverlay(np, 'notices')) { closeNoticePanel(); return; }
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'n' || e.key === 'N')) {
    /* Route creation through Entry to the main workspace so an overlay form cannot displace the always-on-top pet. */




    if (document.documentElement.dataset.deskPanel) return;
    e.preventDefault();
    if (typeof openAddEntry === 'function') openAddEntry();
    else window.WorkEntrySheet?.openTask({ source: '需求池', requirement: true, saveOnly: true, triageStage: 'intake' });
  }
  });
}
