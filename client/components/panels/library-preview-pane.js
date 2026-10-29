/* A single, account-scoped modal preview for files, ZIPs and deliveries. */
(function (global) {
  'use strict';
  const TEXT_LIMIT = 8 * 1024 * 1024, BINARY_LIMIT = 64 * 1024 * 1024;
  const textExtensions = new Set(('txt text csv tsv json jsonl ndjson xml yaml yml log js mjs cjs jsx ts tsx css scss less sass vue svelte py pyi ipynb java kt kts sql sh bash zsh bat cmd ps1 psm1 psd1 c h cpp hpp cc cs swift m mm rb php pl r rs go toml ini cfg conf config env properties gradle dockerfile gitignore gitattributes editorconfig lock diff patch tex rst asc vbs vb dart lua').split(' '));
  const isRemote = file => Boolean(file?.backend && String(file.backend).toLowerCase() !== 'local');
  function kindOf(file) {
    const name = String(file.filename || file.path || '').split(/[\\/]/).pop().trim();
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    const mime = String(file.contentType || file.mimeType || file.type || '').split(';')[0].trim().toLowerCase();
    // Known extensions win over upload MIME guesses. A .txt containing HTML
    // remains literal text, while a .md mislabeled text/html remains Markdown.
    if (/^(docx?|xlsx?|pptx?|odt|ods|odp|rtf)$/.test(ext)) return 'office';
    if (ext === 'zip') return 'archive';
    if (/^(rar|7z|exe|msi|bin|dll|tar|gz)$/.test(ext)) return 'unsupported';
    if (/^(png|jpe?g|gif|webp|avif|bmp|svg|ico)$/.test(ext)) return 'image';
    if (ext === 'pdf') return 'pdf';
    if (/^(mp4|webm|ogv)$/.test(ext)) return 'video';
    if (/^(mp3|wav|ogg|m4a|flac)$/.test(ext)) return 'audio';
    if (/^(html?|xhtml)$/.test(ext)) return 'html';
    if (/^(md|markdown|mdown)$/.test(ext)) return 'markdown';
    if (textExtensions.has(ext)) return 'text';
    if (mime.startsWith('image/')) return 'image';
    if (mime === 'application/pdf') return 'pdf';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    if (/^application\/(zip|x-zip-compressed)$/.test(mime)) return 'archive';
    if (/^(text\/html|application\/xhtml\+xml)$/.test(mime)) return 'html';
    if (mime === 'text/markdown') return 'markdown';
    if (!ext || mime.startsWith('text/') || /json|xml|javascript/.test(mime)) return 'text';
    return 'unsupported';
  }
  const tx = (value, params) => global.SoduWorkI18n?.t('library.preview', value, params) || String(value).replace(/\{(\w+)\}/g, (_, key) => params?.[key] ?? '');
  async function decodeText(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const encodings = bytes[0] === 255 && bytes[1] === 254 ? ['utf-16le'] : bytes[0] === 254 && bytes[1] === 255 ? ['utf-16be'] : ['utf-8', 'gb18030'];
    for (const encoding of encodings) {
      let content;
      try { content = new TextDecoder(encoding, { fatal: true }).decode(bytes); } catch (_) { continue; }
      if (/[\x00-\x08\x0b\x0e-\x1f\x7f-\x9f]/.test(content)) throw new Error(tx('文件包含二进制内容，无法作为文本预览'));
      const truncated = content.length > 2 * 1024 * 1024;
      return { content: content.slice(0, 2 * 1024 * 1024), preview: { encoding, truncated } };
    }
    throw new Error(tx('无法识别文件的文本编码，请使用系统应用打开'));
  }
  const node = (tag, cls, text) => { const element = document.createElement(tag); if (cls) element.className = cls; if (text !== undefined) element.textContent = text; return element; };
  function icon(name) {
    const paths = {
      download: 'M12 3v12 M7 10l5 5 5-5 M5 16v4h14v-4',
      external: 'M14 3h7v7 M21 3l-11 11 M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5',
      folder: 'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M3 9h18',
      close: 'M6 6l12 12 M6 18L18 6',
    };
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.65', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
    svg.classList.add('library-preview-icon');
    const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', paths[name]); svg.append(path); return svg;
  }
  function labelButton(button, label) {
    button.title = label; button.setAttribute('aria-label', label);
  }
  function decorateButton(button, name) {
    labelButton(button, button.textContent); button.replaceChildren(icon(name));
  }
  function bindDialogDrag(dialog, header) {
    const controller = new AbortController(), options = { signal: controller.signal };
    const controls = 'button,a,input,select,textarea,label,summary,[role="button"],[contenteditable],[data-no-drag]';
    let drag = null, positioned = false;
    const eligible = event => !event.target.closest(controls);
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    function position(left, top) {
      const rect = dialog.getBoundingClientRect();
      const gap = Math.min(8, global.innerWidth / 4, global.innerHeight / 4);
      const titlebar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--window-menu-height')) ||
        global.navigator?.windowControlsOverlay?.getTitlebarAreaRect?.()?.height || 0;
      // A nearly full-screen dialog needs to move beyond its original margin.
      // Keep a usable strip of its title bar visible so it can always be returned.
      const visibleWidth = Math.min(200, rect.width, global.innerWidth - gap * 2);
      const visibleHeight = Math.min(header.getBoundingClientRect().height, global.innerHeight - gap * 2);
      dialog.style.inset = 'auto'; dialog.style.margin = '0';
      dialog.style.left = clamp(left, gap + visibleWidth - rect.width, global.innerWidth - gap - visibleWidth) + 'px';
      dialog.style.top = clamp(top, titlebar + gap, global.innerHeight - gap - visibleHeight) + 'px';
      positioned = true;
    }
    function finish() {
      const previous = drag; drag = null; dialog.classList.remove('is-dragging');
      if (previous && header.hasPointerCapture(previous.id)) header.releasePointerCapture(previous.id);
    }
    function move(event) {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      drag.moved = true;
      position(drag.left + dx, drag.top + dy); event.preventDefault();
    }
    header.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0 || drag || !eligible(event)) return;
      // Drag coordinates must use the final surface, even during its entrance.
      dialog.getAnimations().filter(animation => animation.animationName === 'library-preview-enter')
        .forEach(animation => animation.finish());
      const rect = dialog.getBoundingClientRect();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
      // Disable iframe hit testing before the first move: a fast movement can
      // otherwise enter an out-of-process frame before capture takes effect.
      dialog.classList.add('is-dragging');
      header.setPointerCapture(event.pointerId); event.preventDefault();
    }, options);
    header.addEventListener('pointermove', event => {
      if (drag && event.pointerId === drag.id && !(event.buttons & 1)) finish();
      else move(event);
    }, options);
    header.addEventListener('pointerup', event => {
      if (!drag || event.pointerId !== drag.id) return;
      move(event); finish();
    }, options);
    for (const type of ['pointercancel', 'lostpointercapture']) header.addEventListener(type, event => {
      if (drag && event.pointerId === drag.id) finish();
    }, options);
    header.addEventListener('dblclick', event => {
      if (event.button !== 0 || !eligible(event)) return;
      finish(); dialog.style.removeProperty('inset'); dialog.style.removeProperty('margin'); positioned = false;
      event.preventDefault();
    }, options);
    global.addEventListener('blur', finish, options);
    global.addEventListener('resize', () => {
      finish();
      if (positioned) { const rect = dialog.getBoundingClientRect(); position(rect.left, rect.top); }
    }, options);
    return () => { finish(); controller.abort(); };
  }
  function create({ root, onClose }) {
    let pane, body, status, item, selectedFile, files = [], request = 0, scope = '', restoreFocus;
    let fileTitle = '';
    let urls = [], htmlPreview, workspace, navigator, archive = false, archiveDownload, dragCleanup, closingAnimation;
    const api = () => global.SoduWorkAPI;
    const account = () => api()?.taskStorageKey?.('ops') || '';
    const guidance = (local, remote) => tx(isRemote(item) ? remote : local);
    function detail(value) {
      const message = String(value || '');
      if (!isRemote(item)) return message;
      // Older Hubs include native-open advice in their error/notice text. Keep
      // the reason while matching the actions available for this remote file.
      return message.replace(/请使用(?:上方的)?系统(?:应用)?打开(?:或下载(?:文件)?)?[。]?/g, tx('请下载文件后查看。'))
        .replace(/请下载或使用系统应用打开/g, tx('请下载文件后查看'));
    }
    function release() {
      htmlPreview?.dispose(); htmlPreview = null;
      body?.querySelectorAll('video,audio').forEach(media => { media.pause(); media.removeAttribute('src'); media.load(); });
      body?.replaceChildren(); urls.forEach(url => URL.revokeObjectURL(url)); urls = [];
    }
    function markSelection() {
      root.querySelectorAll('[data-library-file-preview]').forEach(button => {
        const selected = button.dataset.libraryFilePreview === item?.id;
        button.setAttribute('aria-pressed', String(selected)); button.closest('.library-card')?.classList.toggle('is-preview-selected', selected);
      });
    }
    function close() {
      closingAnimation?.cancel(); closingAnimation = null;
      request++; release(); navigator = null;
      dragCleanup?.(); dragCleanup = null;
      if (pane?.open) pane.close(); pane?.remove(); pane = null; item = null; files = []; selectedFile = null;
      root.classList.remove('library-preview-open', 'library-preview-overlay', 'library-preview-wide');
      global.removeEventListener('soduwork-data-scope-changed', close);
      markSelection(); if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true }); onClose?.();
    }
    function dismiss() {
      if (!pane || closingAnimation) return;
      if (global.matchMedia?.('(prefers-reduced-motion: reduce)').matches || typeof pane.animate !== 'function') { close(); return; }
      const closingPane = pane;
      request++; // Invalidate pending reads as soon as the user dismisses the view.
      closingPane.classList.add('is-closing'); closingPane.inert = true;
      const animation = closingPane.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.99)' }], { duration: 120, easing: 'ease-in', fill: 'forwards' });
      closingAnimation = animation;
      animation.finished.then(() => { if (pane === closingPane && closingAnimation === animation) close(); }).catch(() => {});
    }
    function button(text, attr, fn) {
      const b = node('button', '', tx(text)); b.type = 'button'; b.setAttribute(attr, '');
      b.addEventListener('click', fn); return b;
    }
    async function action(b, fn) {
      const ticket = request; b.disabled = true;
      try { await fn(); }
      catch (error) { if (pane && ticket === request && account() === scope) status.textContent = error.message || tx('操作失败，请重试'); }
      finally { if (b.isConnected) b.disabled = b.hidden || (b === archiveDownload ? false : !selectedFile); }
    }
    function mount() {
      if (pane) return;
      pane = node('dialog', 'library-preview-pane library-preview-dialog'); pane.setAttribute('aria-label', tx('文件预览'));
      pane.tabIndex = -1;
      pane.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
      const header = node('header', 'library-preview-head library-preview-toolbar');
      header.title = tx('拖动标题栏移动，双击恢复居中');
      const closeButton = button('关闭预览', 'data-preview-close', dismiss);
      closeButton.className = 'library-preview-close'; decorateButton(closeButton, 'close');
      const actionGroup = node('div', 'library-preview-actions'); actionGroup.setAttribute('role', 'group'); actionGroup.setAttribute('aria-label', tx('文件操作'));
      for (const [label, attr, method] of [['下载', 'data-preview-download', 'downloadLibraryItem'], ['系统打开', 'data-preview-system', 'openLibraryExternally'], ['文件位置', 'data-preview-reveal', 'revealLibraryItem']]) {
        const b = button(label, attr, () => action(b, () => {
          if (!item || !selectedFile || (method !== 'downloadLibraryItem' && isRemote(item))) return;
          const member = archive ? selectedFile && { ...selectedFile, archive: true } : item.extra?.soduWorkDelivery ? selectedFile : null;
          return method === 'downloadLibraryItem' ? api()[method](item.id, item.filename, member) : api()[method](item.id, member);
        }));
        decorateButton(b, method === 'downloadLibraryItem' ? 'download' : method === 'openLibraryExternally' ? 'external' : 'folder');
        actionGroup.append(b);
      }
      archiveDownload = button('下载 ZIP', 'data-preview-download-archive', () => action(archiveDownload, () => api().downloadLibraryItem(item.id, item.filename)));
      decorateButton(archiveDownload, 'download');
      archiveDownload.hidden = true; actionGroup.append(archiveDownload);
      header.append(actionGroup, closeButton);
      body = node('section', 'library-preview-body'); body.setAttribute('data-preview-body', '');
      status = node('div', 'library-preview-status'); status.setAttribute('data-preview-status', ''); status.setAttribute('role', 'status');
      const content = node('section', 'library-preview-content'); content.append(body, status);
      workspace = node('div', 'library-preview-workspace'); workspace.append(content);
      pane.append(header, workspace); document.body.append(pane); pane.showModal();
      dragCleanup = bindDialogDrag(pane, header);
      global.addEventListener('soduwork-data-scope-changed', close);
    }
    function messageCard(titleText, detail, retry = false) {
      const card = node('div', 'library-preview-message'); card.append(node('b', '', tx(titleText)), node('p', '', detail));
      if (retry) card.append(button('重试', 'data-preview-retry', typeof retry === 'function' ? retry : () => void preview(selectedFile)));
      return card;
    }
    function message(...args) { body.replaceChildren(messageCard(...args)); }
    function unavailable(file, reason, retry = false) {
      body.replaceChildren(messageCard('暂时无法预览', detail(reason), retry));
    }
    function actions(enabled) {
      for (const attr of ['download', 'system', 'reveal']) {
        const b = pane.querySelector('[data-preview-' + attr + ']');
        b.hidden = attr !== 'download' && isRemote(item);
        b.disabled = !enabled || b.hidden;
      }
    }
    function browseFolder(path, children) {
      request++; release(); selectedFile = null; body.removeAttribute('aria-busy'); actions(false);
      setFileTitle(item.filename || item.title);
      message(path ? path.split('/').pop() : '浏览压缩包', tx(children.length ? '从左侧选择文件进行预览，点击文件夹查看其中的内容。' : '此文件夹为空'));
      status.textContent = path || tx('全部文件');
    }
    function navigation() {
      navigator = global.SoduWorkLibraryArchive.create({ files, name: item.filename || item.title, onFile: file => void preview(file), onFolder: browseFolder });
      workspace.prepend(navigator.element); pane.classList.add('has-archive'); labelButton(archiveDownload, tx('下载 ZIP')); archiveDownload.hidden = false;
    }
    async function loadArchive(current, ticket) {
      archive = true; actions(false); labelButton(archiveDownload, tx('下载 ZIP')); archiveDownload.hidden = false;
      const result = await api().getLibraryArchive(current.id);
      if (!pane || ticket !== request || account() !== scope) return;
      files = result?.archive?.files;
      if (!Array.isArray(files)) throw new Error(tx('压缩包目录返回不完整'));
      navigation();
      const entry = global.SoduWorkLibraryArchive.findEntry(files);
      if (entry) { navigator.select(entry.path); await preview(entry); }
      else navigator.reset();
    }
    function objectUrl(blob, type) {
      const url = URL.createObjectURL(type ? new Blob([blob], { type }) : blob); urls.push(url); return url;
    }
    function setFileTitle(value) {
      fileTitle = value || tx('未命名资料');
      pane.setAttribute('aria-label', tx('文件预览') + ' · ' + fileTitle);
    }
    function renderPreview(render) {
      const rendered = node('div', 'library-preview-render'); rendered.append(render);
      body.replaceChildren(rendered);
    }
    async function preview(file, { fragment = '', autoOpenOffice = true } = {}) {
      if (!item || !file) return;
      selectedFile = file; const ticket = ++request, current = item;
      const valid = () => pane && item === current && request === ticket && account() === scope;
      const kind = kindOf(file), textFile = ['text', 'markdown', 'html'].includes(kind);
      release(); actions(true); status.textContent = tx('正在读取文件…');
      setFileTitle(file.filename || file.path || current.title);
      body.setAttribute('aria-busy', 'true'); message('正在加载预览', tx('正在读取文件…'));
      try {
        const limit = textFile ? TEXT_LIMIT : BINARY_LIMIT;
        if (kind === 'office' && autoOpenOffice && !isRemote(current) && (archive || current.extra?.soduWorkDelivery)) {
          message('使用系统应用查看', tx('正在使用系统应用打开此文件…'));
          await api().openLibraryExternally(current.id, archive ? { ...file, archive: true } : file);
          if (valid()) { message('使用系统应用查看', tx('已交给系统应用打开，可通过上方按钮再次打开或下载。')); status.textContent = tx('保留原始文件'); } return;
        }
        if (Number(file.size) > limit) {
          unavailable(file, guidance('文件较大，请使用系统打开或下载。', '文件较大，请下载文件后查看。'));
          status.textContent = tx('保留原始文件'); return;
        }
        if (['unsupported', 'office', 'archive'].includes(kind)) {
          message(guidance('使用系统应用查看', '下载后查看'), guidance('此格式暂不支持内嵌预览，请使用上方的系统打开或下载。', '此格式暂不支持内嵌预览，请下载文件后查看。'));
          status.textContent = tx('保留原始文件'); return;
        }
        const delivery = Boolean(current.extra?.soduWorkDelivery);
        let blob, content, metadata;
        if (textFile && (archive || !delivery)) {
          const result = archive ? await api().readLibraryArchiveFile(current.id, file.path, { preview: true }) : await api().readLibraryContent(current.id, { preview: true });
          if (!valid()) return;
          if (typeof result?.content !== 'string') throw new Error(tx('文件内容返回不完整'));
          content = result.content; metadata = result.preview;
        } else {
          blob = archive ? await api().readLibraryArchiveFile(current.id, file.path) : delivery ? await api().readDeliveryFile(current.id, file.path) : (await api().readLibraryBinary(current.id))?.blob;
          if (!valid()) return;
          if (!blob) throw new Error(tx('文件内容返回不完整'));
          if (blob.size > limit) throw new Error(guidance('文件较大，请使用系统打开或下载。', '文件较大，请下载文件后查看。'));
          if (textFile) { const result = await decodeText(blob); content = result.content; metadata = result.preview; }
        }
        if (!valid()) return;
        if (textFile) {
          if (kind === 'html' || kind === 'markdown') {
            try {
              if (kind === 'html') {
                if (!global.LibraryDelivery?.buildHtmlDocument) throw new Error(tx('预览组件未加载，请重新打开页面'));
                const html = await global.LibraryDelivery.buildHtmlDocument(content, archive || delivery ? files.filter(f => !f.isDirectory) : [], file, path => {
                  if (!valid()) { const error = new Error(tx('预览已关闭')); error.code = 'STALE_TASK_SCOPE'; throw error; }
                  return archive ? api().readLibraryArchiveFile(current.id, path) : api().readDeliveryFile(current.id, path);
                }, { navigation: archive || delivery });
                if (!valid()) return;
                const frame = node('iframe', 'library-preview-frame'); frame.title = fileTitle;
                frame.setAttribute('sandbox', 'allow-scripts'); frame.setAttribute('referrerpolicy', 'no-referrer');
                htmlPreview = global.SoduWorkLibraryHtmlPreview.attach(frame, html, {
                  onClose: close, fragment,
                  onNavigate: (path, hash) => {
                    if (!valid() || !(archive || delivery)) return;
                    const target = files.find(member => !member.isDirectory && member.path === path);
                    if (!target) return;
                    navigator?.select(target.path);
                    // A document can send messages itself. Package navigation
                    // may render files, but only a host UI action opens an app.
                    void preview(target, { fragment: hash, autoOpenOffice: false });
                  }
                });
                renderPreview(htmlPreview.element);
              } else {
                const html = global.LibraryDelivery?.safeMarkdown(content);
                if (html == null) throw new Error(tx('预览组件未加载，请重新打开页面'));
                const article = node('article', 'library-preview-markdown'); article.setAttribute('data-user-content', ''); article.innerHTML = html;
                article.querySelectorAll('a').forEach(a => { a.removeAttribute('href'); a.removeAttribute('target'); }); renderPreview(article);
              }
            } catch (error) {
              if (!valid()) return;
              message('暂时无法预览', detail(error.message || tx('文件预览失败')) + '\n' + tx('请下载原文件后查看'), true);
            }
          } else {
            const pre = node('pre', 'library-preview-source', content); pre.setAttribute('data-user-content', ''); pre.tabIndex = 0;
            body.replaceChildren(pre);
          }
          status.textContent = [metadata?.encoding ? metadata.encoding.toUpperCase() : tx('只读预览'), metadata?.notice ? detail(tx(metadata.notice)) : metadata?.truncated ? tx('仅显示部分内容，完整内容请下载原文件。') : ''].filter(Boolean).join(' · ');
        } else {
          let view;
          if (kind === 'image') {
            view = node('img', 'library-preview-image'); view.alt = fileTitle;
            view.onerror = () => { if (valid()) message('暂时无法预览', guidance('图片无法解码，请使用系统打开或下载。', '图片无法解码，请下载文件后查看。'), true); };
            view.src = objectUrl(blob);
          } else if (kind === 'pdf') {
            view = node('iframe', 'library-preview-frame'); view.title = fileTitle;
            view.src = objectUrl(blob, 'application/pdf');
          } else {
            view = node(kind, 'library-preview-media'); view.controls = true; view.preload = 'metadata';
            view.onerror = () => { if (valid()) message('暂时无法预览', guidance('此媒体编码不受支持，请使用系统应用打开。', '此媒体编码不受支持，请下载文件后查看。')); };
            view.src = objectUrl(blob);
          }
          body.replaceChildren(view); status.textContent = tx('只读预览');
        }
      } catch (error) {
        if (valid()) {
          const retry = error.retryable !== false && ![413, 415].includes(error.status);
          unavailable(file, error.message || tx('读取文件失败'), retry);
          status.textContent = retry ? guidance('可重试，或使用系统打开和下载', '可重试，或下载原文件') : tx('请下载原文件后查看');
        }
      } finally { if (valid()) body.removeAttribute('aria-busy'); }
    }
    async function open(next) {
      if (!next?.id || next.isDeleted) return;
      // A new explicit selection supersedes a pending animated dismissal.
      if (closingAnimation) { closingAnimation.cancel(); closingAnimation = null; pane.inert = false; pane.classList.remove('is-closing'); }
      if (!pane) restoreFocus = document.activeElement;
      mount(); item = next; scope = account(); markSelection();
      const ticket = ++request; release(); files = []; selectedFile = null;
      navigator?.element.remove(); navigator = null; pane.classList.remove('has-archive'); archiveDownload.hidden = true; actions(true);
      archive = !next.extra?.soduWorkDelivery && kindOf(next) === 'archive';
      setFileTitle(next.title || next.filename); status.textContent = ''; message('正在加载预览', '');
      pane.focus({ preventScroll: true });
      try {
        if (archive) {
          await loadArchive(next, ticket);
        } else if (next.extra?.soduWorkDelivery) {
          actions(false); labelButton(archiveDownload, tx('下载原文件')); archiveDownload.hidden = false;
          const result = await api().getDelivery(next.id);
          if (!pane || ticket !== request || account() !== scope) return;
          files = result?.delivery?.files || [];
          if (!files.length) throw new Error(tx('成果不存在或已移入回收站'));
          if (result.delivery.kind === 'file' && files.length === 1 && kindOf(files[0]) === 'archive') {
            await loadArchive(next, ticket); return;
          }
          const entry = Math.max(0, files.findIndex(f => f.path === result.delivery.entryPath));
          if (result.delivery.kind === 'bundle' || files.length > 1) { navigation(); navigator.select(files[entry].path); }
          else archiveDownload.hidden = true;
          await preview(files[entry]);
        } else { files = [next]; await preview(next); }
      } catch (error) { if (pane && ticket === request && account() === scope) {
        unavailable(next, error.message, () => void open(next));
        status.textContent = tx('可重试，或下载原文件');
      } }
    }
    return { open, close, selectedId: () => item?.id || '', refreshSelection: markSelection };
  }
  global.SoduWorkLibraryPreview = { create, kindOf };
})(window);
