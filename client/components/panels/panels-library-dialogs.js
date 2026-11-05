(function (global) {
  'use strict';
  function create({ state, esc, icon, notify, errorText, load, getEpoch }) {
    let documentDialog, folderDialog, confirmDialog, shareDialog;
    const tx = source => global.SoduWorkI18n?.translateText(source) || source;
    async function showError(error, fallback) {
      const message = errorText(error, fallback);
      if (error?.code === 'LOCAL_LIBRARY_FILE_MISSING') {
        await openConfirmDialog({ title: '本地文件不存在', description: '找不到这份资料的本地文件，可能已被删除或移动。请恢复文件后重试，或从原会话重新保存、重新上传到资料库。', confirm: '知道了', alert: true });
      } else if (error?.code === 'LIBRARY_NAME_CONFLICT' || /同名/.test(message)) {
        await openConfirmDialog({ title: '名称重复', description: message, confirm: '知道了', alert: true });
      } else notify(message);
    }
  function openDocumentEditor(kind = 'document', targetFolderId = state.folderId, targetStorage = state.storage) {
    if (documentDialog) return Promise.resolve(false);
    return new Promise(resolve => {
      const dialog = document.createElement('dialog');
      documentDialog = dialog;
      const epoch = getEpoch();
      let settled = false;
      const copy = kind === 'note'
        ? { title: '新建笔记', untitled: '未命名笔记', placeholder: '在这里输入笔记内容…', saved: '笔记已保存', failed: '笔记保存失败' }
        : { title: '新建文档', untitled: '未命名文档', placeholder: '在这里输入文档内容…', saved: '文档已保存', failed: '文档保存失败' };
      const formatMarkup = kind === 'document'
        ? '<label>格式<select data-library-editor-format><option value="txt">TXT（纯文本）</option><option value="md">Markdown（纯文本）</option></select></label>'
        : '';
      const legacyCancel = ' data-library-' + kind + '-cancel';
      dialog.className = 'library-note-dialog library-document-dialog';
      dialog.dataset.libraryEditorKind = kind;
      dialog.setAttribute('aria-labelledby', 'library' + (kind === 'note' ? 'Note' : 'Document') + 'EditorTitle');
      dialog.innerHTML = '<form class="library-note-editor" method="dialog">' +
        '<header class="library-note-editor-head"><div><b id="library' + (kind === 'note' ? 'Note' : 'Document') + 'EditorTitle">' + esc(copy.title) + '</b><span>在空白页面输入内容，保存后写入资料库。</span></div><button type="button" class="library-note-editor-close" data-library-editor-cancel' + legacyCancel + ' aria-label="关闭">×</button></header>' +
        '<div class="library-note-editor-body"><label>标题<input type="text" data-library-editor-title data-library-' + kind + '-title maxlength="240" value="' + esc(tx(copy.untitled)) + '" required></label>' + formatMarkup + '<label>正文<textarea data-library-editor-content data-library-' + kind + '-content rows="18" placeholder="' + esc(copy.placeholder) + '"></textarea></label></div>' +
        '<footer class="library-note-editor-foot"><button type="button" data-library-editor-cancel' + legacyCancel + '>取消</button><button type="submit" class="library-note-editor-save">保存到资料库</button></footer></form>';
      const form = dialog.querySelector('form');
      const titleInput = dialog.querySelector('[data-library-editor-title]');
      const contentInput = dialog.querySelector('[data-library-editor-content]');
      const finish = value => {
        if (settled) return;
        settled = true;
        if (dialog.open) dialog.close();
        dialog.remove();
        if (documentDialog === dialog) documentDialog = null;
        resolve(Boolean(value));
      };
      dialog._libraryFinish = finish;
      dialog.querySelectorAll('[data-library-editor-cancel]').forEach(close => close.addEventListener('click', () => finish(false)));
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
      dialog.addEventListener('click', event => { if (event.target === dialog) finish(false); });
      form.addEventListener('submit', async event => {
        event.preventDefault();
        const title = titleInput.value.trim();
        if (!title) { titleInput.focus(); return; }
        const formatInput = dialog.querySelector('[data-library-editor-format]');
        const textFormat = formatInput ? (formatInput.value || 'txt') : '';
        const filenameBase = title.replace(/\.(?:txt|md)$/i, '') || title;
        const save = dialog.querySelector('.library-note-editor-save');
        if (save.disabled) return;
        save.disabled = true;
        try {
          const payload = { kind, title, content: contentInput.value, folderId: targetFolderId || '', storage: targetStorage || '' };
          if (formatInput) { payload.format = textFormat; payload.filename = filenameBase + '.' + textFormat; }
          await global.SoduWorkAPI.createLibraryItem(payload);
          if (epoch !== getEpoch()) return;
          notify(copy.saved);
          finish(true);
          if (state.scope !== 'all') state.scope = 'all';
          state.folderId = targetFolderId || '';
          await load();
        } catch (error) {
          save.disabled = false;
          if (epoch === getEpoch()) await showError(error, copy.failed);
        }
      });
      document.body.appendChild(dialog);
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      titleInput.focus(); titleInput.select();
    });
  }
  function openMoveFolderDialog(folders) {
    if (folderDialog) return Promise.resolve(null);
    return new Promise(resolve => {
      const dialog = document.createElement('dialog');
      dialog.className = 'library-folder-dialog library-move-dialog';
      dialog.setAttribute('aria-labelledby', 'libraryMoveFolderDialogTitle');
      folderDialog = dialog;
      const options = folders.map(folder => '<button type="button" class="library-move-folder-option" data-library-move-folder="' + esc(folder.id) + '">' + icon('folder') + '<span data-user-content>' + esc(folder.displayName || folder.name) + '</span></button>').join('');
      dialog.innerHTML = '<form class="library-folder-editor library-move-folder-editor" method="dialog">' +
        '<header class="library-folder-editor-head"><div><b id="libraryMoveFolderDialogTitle">添加到文件夹</b><span>选择已有文件夹，或新建一个文件夹后移动资料。</span></div><button type="button" class="library-folder-editor-close" data-library-move-cancel aria-label="关闭">×</button></header>' +
        '<div class="library-move-folder-list">' +
        '<button type="button" class="library-move-folder-option library-move-root-option" data-library-move-folder="">' + icon('back') + '<span>根目录</span></button>' +
        (options || '<p class="library-move-folder-empty">暂无可用文件夹</p>') +
        '</div>' +
        '<footer class="library-folder-editor-foot"><button type="button" data-library-move-create>' + icon('folder') + '新建文件夹</button><button type="button" data-library-move-cancel>取消</button></footer></form>';
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        if (dialog.open) dialog.close();
        dialog.remove();
        if (folderDialog === dialog) folderDialog = null;
        resolve(value == null ? null : value);
      };
      dialog._libraryFinish = () => finish(null);
      dialog.querySelectorAll('[data-library-move-cancel]').forEach(node => node.addEventListener('click', () => finish(null)));
      dialog.querySelectorAll('[data-library-move-folder]').forEach(node => node.addEventListener('click', () => finish({ kind: 'folder', folderId: node.dataset.libraryMoveFolder || '' })));
      dialog.querySelector('[data-library-move-create]').addEventListener('click', () => finish({ kind: 'create' }));
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
      dialog.addEventListener('click', event => { if (event.target === dialog) finish(null); });
      document.body.appendChild(dialog);
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      const first = dialog.querySelector('[data-library-move-folder]') || dialog.querySelector('[data-library-move-create]');
      if (first) first.focus();
    });
  }
  function openConfirmDialog(options = {}) {
    if (confirmDialog) return Promise.resolve(false);
    return new Promise(resolve => {
      const dialog = document.createElement('dialog');
      confirmDialog = dialog;
      let settled = false;
      dialog.className = 'library-confirm-dialog';
      dialog.setAttribute('aria-labelledby', 'libraryConfirmDialogTitle');
      const title = options.title || '确认操作';
      const description = options.description || '';
      // Interpolate business names only after translating the fixed sentence.
      // Keyed markup retains the source and exact names across locale changes.
      const descriptionMarkup = options.descriptionParams
        ? (global.SoduWorkI18n?.html('library.confirm.description', description, options.descriptionParams)
          || esc(description.replace(/\{(\w+)\}/g, (all, key) => options.descriptionParams[key] ?? all)))
        : esc(description);
      const confirm = options.confirm || '确认';
      const danger = options.danger ? ' library-confirm-danger' : '';
      const descriptionClass = options.descriptionClass ? ' ' + String(options.descriptionClass).replace(/[^\w-]/g, '') : '';
      dialog.innerHTML = '<form class="library-confirm-card" method="dialog">' +
        '<header class="library-confirm-head"><b id="libraryConfirmDialogTitle">' + esc(title) + '</b><button type="button" class="library-confirm-close" data-library-confirm-cancel aria-label="关闭">×</button></header>' +
        '<p class="library-confirm-description' + descriptionClass + '">' + descriptionMarkup + '</p>' +
        '<footer class="library-confirm-foot">' + (options.alert ? '' : '<button type="button" class="library-confirm-cancel" data-library-confirm-cancel>取消</button>') + '<button type="submit" class="library-confirm-submit' + danger + '">' + esc(confirm) + '</button></footer></form>';
      const finish = value => {
        if (settled) return;
        settled = true;
        if (dialog.open) dialog.close();
        dialog.remove();
        if (confirmDialog === dialog) confirmDialog = null;
        resolve(Boolean(value));
      };
      dialog._libraryFinish = () => finish(false);
      dialog.querySelectorAll('[data-library-confirm-cancel]').forEach(button => button.addEventListener('click', () => finish(false)));
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
      dialog.addEventListener('click', event => { if (event.target === dialog) finish(false); });
      dialog.querySelector('form').addEventListener('submit', event => { event.preventDefault(); finish(true); });
      document.body.appendChild(dialog);
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      dialog.querySelector('.library-confirm-submit').focus();
    });
  }
  function openNameDialog(options = {}) {
    if (folderDialog) return Promise.resolve('');
    return new Promise(resolve => {
      const dialog = document.createElement('dialog');
      folderDialog = dialog;
      let settled = false;
      dialog.className = 'library-folder-dialog' + (options.create ? ' library-folder-create-dialog' : '');
      dialog.setAttribute('aria-labelledby', 'libraryFolderDialogTitle');
      const title = options.title || '新建文件夹';
      const description = options.description || '创建文件夹来整理资料库中的项目。';
      const label = options.label || '文件夹名称';
      const value = String(options.value || '');
      const placeholder = options.placeholder || '输入文件夹名称';
      const confirm = options.confirm || '创建';
      const maxLength = Number(options.maxLength) || 120;
      dialog.innerHTML = '<form class="library-folder-editor" method="dialog">' +
        '<header class="library-folder-editor-head"><div><b id="libraryFolderDialogTitle">' + esc(title) + '</b><span>' + esc(description) + '</span></div><button type="button" class="library-folder-editor-close" data-library-folder-cancel aria-label="关闭">×</button></header>' +
        '<div class="library-folder-editor-body"><label>' + esc(label) + '<input type="text" data-library-folder-name maxlength="' + maxLength + '" placeholder="' + esc(placeholder) + '" value="' + esc(value) + '" required></label></div>' +
        '<footer class="library-folder-editor-foot"><button type="button" data-library-folder-cancel>取消</button><button type="submit" class="library-folder-editor-save">' + esc(confirm) + '</button></footer></form>';
      const form = dialog.querySelector('form');
      const input = dialog.querySelector('[data-library-folder-name]');
      const finish = value => {
        if (settled) return;
        settled = true;
        if (dialog.open) dialog.close();
        dialog.remove();
        if (folderDialog === dialog) folderDialog = null;
        resolve(value || '');
      };
      dialog._libraryFinish = () => finish('');
      dialog.querySelectorAll('[data-library-folder-cancel]').forEach(close => close.addEventListener('click', () => finish('')));
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(''); });
      dialog.addEventListener('click', event => { if (event.target === dialog) finish(''); });
      form.addEventListener('submit', event => {
        event.preventDefault();
        const name = input.value.trim();
        if (!name) { input.focus(); return; }
        finish(name);
      });
      document.body.appendChild(dialog);
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      input.focus(); input.select();
    });
  }
  function openFolderDialog() {
    return openNameDialog({ title: '新建文件夹', description: '创建文件夹来整理资料库中的项目。', label: '文件夹名称', placeholder: '输入文件夹名称', confirm: '创建', maxLength: 120, create: true });
  }
  function openShareDialog({ item, items, folders, bundled: bundledOption, members, filename, size, localCopy, onSubmit }) {
    if (shareDialog) return Promise.resolve(false);
    return new Promise(resolve => {
      const dialog = document.createElement('dialog'); shareDialog = dialog;
      const epoch = getEpoch(); let settled = false, sending = false;
      const selectedItems = (Array.isArray(items) && items.length ? items : item ? [item] : []).filter(Boolean);
      const selectedFolders = (Array.isArray(folders) ? folders : []).filter(Boolean);
      const bundled = bundledOption === true || selectedItems.length + selectedFolders.length > 1 || selectedFolders.length > 0;
      const unique = [...new Map(members.filter(member => member.id).map(member => [String(member.id), member])).values()];
      const options = unique.map(member => '<label class="library-share-member"><input type="checkbox" value="' + esc(member.id) + '"><span class="library-share-avatar" aria-hidden="true">' + esc(String(member.name || member.username || '?').trim().slice(0, 1).toUpperCase()) + '</span><span class="library-share-member-copy"><b data-user-content>' + esc(member.name || member.username) + '</b><small data-user-content>' + esc(member.username || '') + '</small></span></label>').join('');
      const fileRows = selectedItems.map(row => '<li><span class="library-share-file-icon">' + icon('document') + '</span><span><b data-user-content>' + esc(row.displayName || (selectedItems.length === 1 && filename) || row.filename || row.title) + '</b><small>' + esc(row.displaySize || (selectedItems.length === 1 && size) || '') + '</small></span></li>').join('') + selectedFolders.map(row => '<li><span class="library-share-file-icon">' + icon('folder') + '</span><span><b data-user-content>' + esc(row.displayName || row.name || '文件夹') + '</b><small>' + esc(row.displaySize || tx('文件夹内容')) + '</small></span></li>').join('');
      const shareHint = bundled
        ? (localCopy
          ? '选中的文件和文件夹会打包为一个压缩包，仅发送一条通知；本机原件保留。压缩包只能下载或保存到资料库。'
          : '选中的文件和文件夹会打包为一个压缩包，仅发送一条通知。压缩包只能下载或保存到资料库。')
        : (localCopy
          ? '直接发送文件通知，本机原件保留。分享双方可在通知中打开、下载或保存到资料库。'
          : '可选择所有成员，他们会在通知中心收到文件。');
      dialog.className = 'library-share-dialog'; dialog.setAttribute('aria-labelledby', 'libraryShareTitle');
      dialog.innerHTML = '<form class="library-share-card" method="dialog"><header class="library-share-head"><div><b id="libraryShareTitle">' + esc(tx(bundled ? '打包分享资料' : '分享资料')) + '</b><span>' + esc(tx(shareHint)) + '</span></div><button type="button" class="library-share-close" data-library-share-cancel aria-label="' + esc(tx('关闭')) + '">×</button></header>' +
        '<ul class="library-share-files">' + fileRows + '</ul>' +
        (bundled ? '<p class="library-share-bundle-hint" role="status">' + esc(tx('将自动打包为一个压缩包，仅发送一条通知')) + '</p>' : '') +
        '<label class="library-share-search"><span>' + esc(tx('分享给')) + '</span><input type="search" data-library-share-search placeholder="' + esc(tx('搜索姓名或账号')) + '" aria-label="' + esc(tx('搜索成员')) + '"></label>' +
        '<div class="library-share-members">' + options + '<p data-library-share-empty hidden>' + esc(tx('没有匹配的成员')) + '</p></div>' +
        '<label class="library-share-note"><span>' + esc(tx('附言（可选）')) + '</span><textarea maxlength="500" data-library-share-note placeholder="' + esc(tx('告诉对方为什么分享这份文件')) + '"></textarea></label>' +
        '<p data-library-share-error role="alert" hidden></p><footer class="library-share-foot"><span data-library-share-status role="status" aria-live="polite"></span><button type="button" data-library-share-cancel>' + esc(tx('取消')) + '</button><button type="submit" class="library-share-submit" disabled>' + esc(tx(bundled ? '打包并分享' : '分享文件')) + '</button></footer></form>';
      const form = dialog.querySelector('form'), submit = dialog.querySelector('.library-share-submit');
      const status = dialog.querySelector('[data-library-share-status]'), error = dialog.querySelector('[data-library-share-error]');
      const inputs = [...dialog.querySelectorAll('input[type=checkbox]')], search = dialog.querySelector('[data-library-share-search]');
      const selected = () => inputs.filter(input => input.checked).map(input => input.value);
      const refresh = () => {
        const count = selected().length;
        submit.disabled = sending || !count; submit.textContent = tx(sending ? (bundled ? '正在打包并分享…' : '正在分享…') : (bundled ? '打包并分享' : '分享文件'));
        status.textContent = sending ? tx(bundled ? '正在打包并分享…' : '正在分享…') : count ? tx('已选择 {count} 位成员').replace('{count}', count) : tx('请选择成员');
        inputs.forEach(input => { input.disabled = sending || (count >= 50 && !input.checked); });
        dialog.querySelectorAll('[data-library-share-cancel],textarea,[data-library-share-search]').forEach(control => { control.disabled = sending; });
        form.setAttribute('aria-busy', String(sending));
      };
      const finish = value => {
        if (settled) return; settled = true;
        if (dialog.open) dialog.close(); dialog.remove(); if (shareDialog === dialog) shareDialog = null; resolve(Boolean(value));
      };
      dialog._libraryFinish = () => finish(false);
      const cancel = () => { if (!sending) finish(false); };
      inputs.forEach(input => input.addEventListener('change', () => { error.hidden = true; refresh(); }));
      search.addEventListener('input', () => {
        const query = search.value.trim().toLocaleLowerCase(); let visible = 0;
        inputs.forEach(input => { const row = input.closest('label'); row.hidden = !row.textContent.toLocaleLowerCase().includes(query); if (!row.hidden) visible++; });
        dialog.querySelector('[data-library-share-empty]').hidden = Boolean(visible);
      });
      dialog.querySelectorAll('[data-library-share-cancel]').forEach(control => control.addEventListener('click', cancel));
      dialog.addEventListener('cancel', event => { event.preventDefault(); cancel(); });
      dialog.addEventListener('click', event => { if (event.target === dialog) cancel(); });
      form.addEventListener('submit', async event => {
        event.preventDefault(); const ids = selected();
        if (sending || !ids.length || settled || epoch !== getEpoch()) return;
        sending = true; error.hidden = true; refresh();
        try {
          await onSubmit(ids, dialog.querySelector('[data-library-share-note]').value.trim());
          if (!settled && epoch === getEpoch()) finish(true);
        } catch (failure) {
          if (!settled && epoch === getEpoch()) {
            if (failure?.code === 'LOCAL_LIBRARY_FILE_MISSING') {
              sending = false; refresh();
              await showError(failure, '分享失败，请重试');
            } else {
              error.textContent = errorText(failure, tx('分享失败，请重试')); error.hidden = false;
              if (failure?.code === 'LIBRARY_NAME_CONFLICT' || /同名/.test(error.textContent)) await showError(failure, '分享失败，请重试');
            }
          }
        } finally { if (!settled) { sending = false; refresh(); } }
      });
      refresh(); document.body.appendChild(dialog);
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
      search.focus();
    });
  }
    function close() { [documentDialog, folderDialog, confirmDialog, shareDialog].forEach(dialog => dialog?._libraryFinish?.()); }
    return { openDocumentEditor, openMoveFolderDialog, openConfirmDialog, openNameDialog, openFolderDialog, openShareDialog, showError, close };
  }
  global.SoduWorkLibraryDialogs = { create };
})(window);
