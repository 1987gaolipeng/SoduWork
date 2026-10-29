/* Shared context menus, copying and notification icons. */
/* Aggregated external tasks are read-only: offer details and source links, not status changes or deletion. */
function _externalCtxItems(task) {
  const items = [{ ico: 'M5 12h14M12 5l7 7-7 7', label: '打开详情', act: () => openDetailEntry(task.id) }];
  if (task.externalUrl) items.push({ ico: 'M14 3h7v7M21 3l-9 9M5 7v12a2 2 0 0 0 2 2h12', label: '打开原任务 ↗', act: () => openExternalTask(task) });
  return items;
}

/* Context menu supporting showCtxMenu(e,t) and showCtxMenu(x,y,t). */
function showCtxMenu(x, y, t) {
  let px, py, task;
  if (typeof x === 'object' && x !== null) { task = y; px = x.clientX; py = x.clientY; }
  else { task = t; px = x; py = y; }
  if (!task) return;
  const menu = document.getElementById('ctxMenu');
  if (!menu) return;


  const _cur = task.status;
  const _stIco = {
    todo: 'M5 12h4l2 5 4-12 2 7h2',
    doing: 'M12 3a9 9 0 1 0 9 9M12 7v5l3 2',
    done: 'M20 6L9 17l-5-5',
    cancel: 'M8 5h8a2 2 0 0 1 2 2v14l-6-4-6 4V7a2 2 0 0 1 2-2z',
  };
  const _stItem = (s) => ({
    ico: _stIco[s], label: STATUS[s], ctx: s, checked: _cur === s,
    act: () => _ctxSet(task, s),
  });
  let items;
  if (typeof isExternalTask === 'function' && isExternalTask(task)) {
    items = _externalCtxItems(task);
  } else {
    items = [
      { ico: 'M15 3h6v6M10 14L21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6', label: '打开详情', act: () => openDetailEntry(task.id) },
      { sep: true },
      _stItem('todo'), _stItem('doing'), _stItem('done'), _stItem('cancel'),
    ];
    /*
     * Current owners may update platform-assigned task status, but personal deletion is
     * limited to locally created tasks.
     */
    if (!task.origin || task.origin === 'local') {
      items.push({ sep: true });
      items.push({ ico: 'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6', label: '删除', danger: true, act: () => _ctxDel(task) });
    }
  }
  let html = "<div class=\"ctx-title\"" + (task.title ? ' data-user-content' : '') + '>' + esc(task.title || '未命名') + '</div>';
  items.forEach(it => {
  if (it.sep) { html += '<div class="ctx-sep"></div>'; return; }
  html += '<button class="ctx-item' + (it.danger ? ' danger' : '') + (it.checked ? ' checked' : '') + '"' +
    (it.ctx ? ' data-ctx="' + it.ctx + '"' : '') + '>' +
    '<svg class="ico" viewBox="0 0 24 24"><path d="' + it.ico + '"/></svg>' +
    '<span>' + it.label + '</span>' +
    (it.checked ? '<svg class="ctx-check" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>' : '') +
    '</button>';
  });
  menu.innerHTML = html;
  const btns = menu.querySelectorAll('.ctx-item');
  let bi = 0;
  items.forEach(it => {
  if (it.sep) return;
  const b = btns[bi++];
  b.addEventListener('click', () => { hideCtx(); it.act(); });
  });
  const mw = 160, mh = items.length * 36;
  if (px + mw > window.innerWidth - 8) px = window.innerWidth - mw - 8;
  if (py + mh > window.innerHeight - 8) py = window.innerHeight - mh - 8;
  menu.style.left = px + 'px'; menu.style.top = py + 'px';
  menu.classList.add('show');
  if (typeof expandForOverlay === 'function') expandForOverlay();
}
function hideCtx() {
  const menu = document.getElementById('ctxMenu');
  if (menu) menu.classList.remove('show');
  if (typeof shrinkFromOverlay === 'function') shrinkFromOverlay();
}



function _showCopyMenu(px, py, text) {
  const menu = document.getElementById('ctxMenu');
  if (!menu) return;
  const n = text.length;
  menu.innerHTML = '<div class="ctx-title">已选中 ' + n + ' 个字</div>' +
    '<button class="ctx-item" id="ctxCopy">' +
    '<svg class="ico" viewBox="0 0 24 24"><path d="M9 9h10v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z"/>' +
    '<path d="M15 5.5V4a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h1.5"/></svg>' +
    '<span>复制</span></button>';
  const b = document.getElementById('ctxCopy');
  if (b) {
    /* Preserve text selection while pressing the copy-menu item. */
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', async () => { hideCtx(); await _copyText(text); });
  }
  const mw = 160, mh = 72;
  if (px + mw > window.innerWidth - 8) px = window.innerWidth - mw - 8;
  if (py + mh > window.innerHeight - 8) py = window.innerHeight - mh - 8;
  menu.style.left = px + 'px'; menu.style.top = py + 'px';
  menu.classList.add('show');
  if (typeof expandForOverlay === 'function') expandForOverlay();
}

/*
 * Try navigator.clipboard.writeText, then copy through a temporary selected textarea. Do
 * not rely on the original selection, which menu interaction may clear.
 */
async function _copyText(text) {
  try { await navigator.clipboard.writeText(text); return _copyToast(true); } catch (e) { /* Use the clipboard fallback. */ }
  let ok = false;
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select(); ta.setSelectionRange(0, text.length);
    ok = document.execCommand('copy');
    document.body.removeChild(ta);
  } catch (e) { ok = false; }
  return _copyToast(ok);
}
function _copyToast(ok) {
  if (typeof petSay === 'function') petSay(ok ? '复制好了~' : '没复制成，试试 Ctrl+C');
  return ok;
}
function _ctxSet(t, st) {
  if (!markStatus(t, st)) return;
  save(); render();
  if (typeof petSay === 'function') petSay('「' + t.title + '」→ ' + STATUS[st]);
}
/* Retain the removed task and original index for one-time undo. */
function _delTaskWithUndo(id) {
  const removed = typeof Store !== 'undefined' ? Store.removeTask(id, 6000) : null;
  if (!removed) return;
  const task = removed.task, idx = removed.index;
  render();
  const restore = () => { Store.restoreTask(task, idx); render(); if (typeof petSay === 'function') petSay('已恢复「' + task.title + '」~'); };
  if (typeof petSayUndo === 'function') petSayUndo('删掉了「' + task.title + '」· 点我撤销', restore, 6000);
  else if (typeof petSay === 'function') petSay('删掉了「' + task.title + '」');
}
function _ctxDel(t) { _delTaskWithUndo(t.id); }





/* Notification icons use theme-aware monochrome outlines, with color indicating notification type. */
const _NK_PATH = {
  notice: '<path d="M3 11v2a1 1 0 0 0 1 1h2l4 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M16 8a5 5 0 0 1 0 8"/>',
  task: '<path d="M4 7h16v13H4z"/><path d="M4 7l2-3h12l2 3"/><path d="M10 12h4"/>',
  remind: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M5 3L2.5 5.5M19 3l2.5 2.5"/>',
  recur: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
  system: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>',
};
function _nkIcon(kind) {
  const p = _NK_PATH[kind] || _NK_PATH.notice;
  return '<svg class="np-svg" viewBox="0 0 24 24">' + p + '</svg>';
}
