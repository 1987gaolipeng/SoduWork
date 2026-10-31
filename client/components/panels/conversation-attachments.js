/* Shared attachment selection, drop, paste, and preview handling for new and existing conversations. */
(function (global) {
  'use strict';

  const MAX_FILES = 20;
  const MAX_BYTES = 256 * 1024 * 1024;
  /*
   * Copy dropped files below this limit into memory immediately; source applications may
   * delete temporary files before sending.
   */
  const CACHE_BYTES = 32 * 1024 * 1024;
  const ANALYSIS_MAX_FILES = 16;
  const ANALYSIS_MAX_BYTES = 24 * 1024 * 1024;
  const ANALYSIS_FILE_BYTES = 12 * 1024 * 1024;
  const ANALYSIS_TEXT_CHARS = 240000;
  const THUMB_CACHE_LIMIT = 48;
  const thumbCache = new Map();
  const thumbPending = new Map();
  const fileKinds = new WeakMap(); // Keep directory identity when a failed send restores the same File.
  // Only files created by this input controller carry prompt identity. An
  // uploaded TXT (or a forged File property) must remain reference material.
  const inputTexts = new WeakMap();
  const fileOrigins = new WeakMap();
  const fileIdentity = file => fileOrigins.get(file) || file;
  const TEXT_EXT = new Set([
    'txt', 'md', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'html', 'htm', 'yaml', 'yml',
    'log', 'sql', 'css', 'scss', 'less', 'js', 'jsx', 'ts', 'tsx', 'py', 'java',
    'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'sh', 'ps1', 'ini', 'conf', 'rtf',
  ]);
  const DOCUMENT_EXT = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp']);
  const esc = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/\"/g, '&quot;');

  function removeLabel(name) {
    return global.SoduWorkI18n?.t('移除 {name}', '移除 {name}', { name }) || '移除 ' + name;
  }
  global.addEventListener?.('soduwork-locale-change', () => {
    global.document?.querySelectorAll('[data-catt-remove][data-catt-name]').forEach(node => {
      node.setAttribute('aria-label', removeLabel(node.getAttribute('data-catt-name')));
    });
  });

  function size(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function extension(name) {
    const hit = String(name || '').toLowerCase().match(/\.([a-z0-9]{1,10})$/);
    return hit ? hit[1] : '';
  }

  /*
   * Detect common formats by file signature when extensions or MIME types are missing.
   * Preserve unknown types without guessing.
   */
  function sniffMime(buffer) {
    const b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || 0);
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
    if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
    if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7)) return 'application/zip';
    if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return 'application/pdf';
    return '';
  }
  const MIME_EXT = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/bmp': 'bmp', 'application/pdf': 'pdf',
  };

  /*
   * Detect transparent-encryption payloads that this process cannot decrypt. Require the
   * fixed header signature plus control-byte evidence so plain text mentioning Esafenet is
   * not rejected.
   */
  const ESF_MAGIC = [0xe0, 0xa8, 0x91, 0xe7, 0xd8, 0xf2, 0x05, 0xac];
  function encryptedHead(head) {
    if (head.length >= 8 && ESF_MAGIC.every((byte, i) => head[i] === byte)) return true;
    const limit = Math.min(head.length, 512) - 8;
    for (let i = 0; i <= limit; i++) {
      if (head[i] === 0x45 && head[i + 1] === 0x73 && head[i + 2] === 0x61 && head[i + 3] === 0x66 &&
          head[i + 4] === 0x65 && head[i + 5] === 0x6e && head[i + 6] === 0x65 && head[i + 7] === 0x74) {
        let control = 0;
        for (let j = 0; j < Math.min(head.length, 512); j++) {
          const b = head[j];
          if ((b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f) control++;
        }
        return control >= 8;
      }
    }
    return false;
  }

  function bytesBase64(data) {
    let binary = '';
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || 0);
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  function pastedName(file, index) {
    if (file && file.name && file.name !== 'image.png') return file.name;
    const type = String((file && file.type) || 'image/png').split('/')[1] || 'png';
    const ext = type === 'jpeg' ? 'jpg' : type.replace(/[^a-z0-9]+/gi, '') || 'png';
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    return '粘贴图片-' + stamp + (index ? '-' + (index + 1) : '') + '.' + ext;
  }

  function paperclipIcon() {
    return '<svg viewBox=\'0 0 24 24\' aria-hidden=\'true\'>' +
      '<path d=\'M7 12.5l6.7-6.7a3.3 3.3 0 0 1 4.7 4.7l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.2-8.2\'/></svg>';
  }

  function imageIcon() {
    return '<svg viewBox=\'0 0 24 24\' aria-hidden=\'true\'><rect x=\'3.5\' y=\'4\' width=\'17\' height=\'16\' rx=\'3\'/>' +
      '<circle cx=\'9\' cy=\'9.5\' r=\'1.5\'/><path d=\'m5.5 17 4.2-4.2 3.1 3 2.2-2.2 3.5 3.4\'/></svg>';
  }

  function isImage(row) {
    return /^image\/(?:png|jpeg|webp|gif)$/i.test(String((row && row.type) || '')) ||
      /\.(?:png|jpe?g|webp|gif)$/i.test(String((row && row.name) || ''));
  }

  function messageAttachment(row) {
    if (isImage(row) && row.previewRef) {
      return '<button type=\'button\' class=\'nuser-att nuser-att-image\' data-catt-message-image=\'' +
        esc(row.previewRef) + '\' data-catt-name=\'' + esc(row.name) + '\' data-catt-size=\'' +
        row.size + '\' aria-label=\'查看图片 ' + esc(row.name) + '\' title=\'点击查看大图\'>' +
        '<span class=\'nuser-att-thumb\'>' + imageIcon() + '<img alt=\'\' hidden></span>' +
        "<span class='nuser-att-copy'><b data-user-content>" + esc(row.name) + '</b><small>图片' +
        (row.size ? ' · ' + esc(size(row.size)) : '') + '</small></span></button>';
    }
    return '<span class=\'nuser-att\' title=\'' + esc(row.name) + '\'>' +
      paperclipIcon() + "<b data-user-content>" + esc(row.name) + '</b></span>';
  }

  function messageHtml(files) {
    const rows = (files || []).map((file) => ({
      name: String((file && (file.name || file.filename)) || file || '').trim(),
      type: String((file && (file.type || file.contentType)) || ''),
      size: Number((file && file.size) || 0),
      previewRef: String((file && file.previewRef) || ''),
    })).filter((row) => row.name);
    return rows.length
      ? '<div class=\'nuser-atts\' aria-label=\'本条消息附件\'>' + rows.map(messageAttachment).join('') + '</div>'
      : '';
  }

  function dataUrl(reply) {
    return reply && reply.ok && reply.data
      ? 'data:' + (reply.mimeType || 'image/png') + ';base64,' + reply.data : '';
  }

  function rememberThumb(key, value) {
    if (thumbCache.has(key)) thumbCache.delete(key);
    thumbCache.set(key, value);
    while (thumbCache.size > THUMB_CACHE_LIMIT) thumbCache.delete(thumbCache.keys().next().value);
  }

  async function thumbnail(api, ref, token) {
    const key = String(ref || '') + '\n' + String(token || '');
    if (thumbCache.has(key)) return thumbCache.get(key);
    if (thumbPending.has(key)) return thumbPending.get(key);
    const request = Promise.resolve(api.attachmentImage(ref, token, 'thumbnail'))
      .then((reply) => {
        const value = dataUrl(reply);
        if (value) rememberThumb(key, value);
        return value;
      }).catch(() => '').finally(() => thumbPending.delete(key));
    thumbPending.set(key, request);
    return request;
  }

  function hydrateMessageImages(root, options) {
    const o = options || {};
    const api = o.api;
    if (!root || !api || typeof api.attachmentImage !== 'function' || !o.ref) return;
    root.querySelectorAll('[data-catt-message-image]').forEach(async (node) => {
      if (node.dataset.cattThumbState) return;
      node.dataset.cattThumbState = 'loading';
      const value = await thumbnail(api, o.ref, node.getAttribute('data-catt-message-image'));
      if (!node.isConnected) return;
      if (!value) { node.dataset.cattThumbState = 'unavailable'; return; }
      const image = node.querySelector('.nuser-att-thumb img');
      if (image) {
        image.src = value; image.hidden = false;
        node.classList.add('has-thumb');
      }
      node.dataset.cattThumbState = 'ready';
    });
  }

  function previewMarkup(options) {
    const o = options || {};
    const copy = o.copy ? '<button type=\'button\' class=\'catt-preview-copy\' data-catt-preview-copy>' +
      '<svg viewBox=\'0 0 24 24\' aria-hidden=\'true\'><rect x=\'8\' y=\'8\' width=\'11\' height=\'11\' rx=\'2\'/>' +
      '<path d=\'M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2\'/></svg>' +
      '<span>复制图片</span></button>' : '';
    return '<div class=\'catt-preview-card\' role=\'dialog\' aria-modal=\'true\' aria-label=\'' +
      esc(o.name || '图片预览') + "'><header><span class='catt-preview-title'><b" + (o.name ? ' data-user-content' : '') + '>' +
      esc(o.name || '图片') + '</b><small>' + esc(o.detail || '') + '</small></span>' + copy +
      '<button type=\'button\' class=\'catt-preview-close\' data-catt-preview-close aria-label=\'关闭\'>×</button>' +
      '</header><div class=\'catt-preview-body\'><div class=\'catt-preview-loading\'>' +
      '<i></i><span>正在读取图片…</span></div></div></div>';
  }

  function previewShell(options) {
    const o = options || {};
    const prior = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'catt-preview';
    overlay.innerHTML = previewMarkup(o);
    const body = overlay.querySelector('.catt-preview-body');
    const close = () => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (prior && typeof prior.focus === 'function') prior.focus();
    };
    const onKey = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !overlay.isConnected) return;
      // Let topmost native confirmations and menus consume Escape before closing image previews.
      if (document.querySelector('dialog:modal,[popover]:popover-open')) return;
      const previews = document.querySelectorAll('.catt-preview');
      if (previews[previews.length - 1] !== overlay) return;
      // Consume during capture so requirement forms and legacy panels cannot also close and discard drafts.
      event.preventDefault(); event.stopImmediatePropagation(); close();
    };
    overlay.addEventListener('click', async (event) => {
      if (event.target === overlay || event.target.closest('[data-catt-preview-close]')) {
        close(); return;
      }
      const copy = event.target.closest('[data-catt-preview-copy]');
      if (!copy || typeof o.copy !== 'function' || copy.disabled) return;
      copy.disabled = true;
      try {
        const result = await o.copy();
        if (result === false || (result && result.ok === false)) {
          throw new Error((result && result.reason) || '复制失败');
        }
        copy.classList.add('done');
        copy.querySelector('span').textContent = '已复制';
      } catch (error) {
        copy.querySelector('span').textContent = '复制失败';
        if (typeof o.say === 'function') o.say(String((error && error.message) || error));
      } finally {
        setTimeout(() => {
          if (!copy.isConnected) return;
          copy.disabled = false; copy.classList.remove('done');
          copy.querySelector('span').textContent = '复制图片';
        }, 1600);
      }
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    overlay.querySelector('[data-catt-preview-close]').focus();
    return {
      image(src, alt) {
        body.innerHTML = '<img src=\'' + esc(src) + '\' alt=\'' + esc(alt || '') + '\'>';
      },
      text(value) { body.innerHTML = '<pre>' + esc(value) + '</pre>'; },
      error(value) {
        body.innerHTML = '<div class=\'catt-preview-error\'><b>图片暂时无法打开</b><span>' +
          esc(value || '文件可能已移动或删除') + '</span></div>';
      },
      close,
    };
  }

  async function copyImageFile(row, nativeCopy) {
    if (!nativeCopy && (!navigator.clipboard || typeof navigator.clipboard.write !== 'function' || !global.ClipboardItem)) {
      throw new Error('当前系统不支持直接复制图片');
    }
    let blob = row.file;
    let mimeType = String(row.type || (blob && blob.type) || '').toLowerCase();
    if (mimeType !== 'image/png') {
      if (typeof global.createImageBitmap !== 'function') throw new Error('当前图片格式暂时不能直接复制');
      const bitmap = await global.createImageBitmap(blob);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('图片复制组件不可用');
        context.drawImage(bitmap, 0, 0);
        blob = await new Promise((resolve, reject) => canvas.toBlob(
          (value) => value ? resolve(value) : reject(new Error('图片转换失败')), 'image/png'));
        mimeType = 'image/png';
      } finally {
        if (typeof bitmap.close === 'function') bitmap.close();
      }
    } else if (blob.type !== mimeType) {
      blob = new Blob([blob], { type: mimeType });
    }
    if (nativeCopy) return nativeCopy(new Uint8Array(await blob.arrayBuffer()));
    await navigator.clipboard.write([new global.ClipboardItem({ [mimeType]: blob })]);
    return true;
  }

  async function openMessageImage(node, options) {
    const o = options || {};
    const api = o.api;
    const token = node && node.getAttribute('data-catt-message-image');
    if (!token || !api || typeof api.attachmentImage !== 'function') return false;
    const name = node.getAttribute('data-catt-name') || '图片';
    const bytes = Number(node.getAttribute('data-catt-size') || 0);
    let fullImage = null;
    const view = previewShell({
      name, detail: bytes ? size(bytes) : '', say: o.say,
      copy: typeof api.copyAttachmentImage === 'function' ? async () => {
        const result = await api.copyAttachmentImage(o.ref, token);
        if (!result || result.code !== 'IMAGE_CONVERSION_REQUIRED') return result;
        // Chromium can decode WebP/GIF even when nativeImage cannot. Convert the
        // already-authorized bytes, not a remote URL or a cross-origin canvas.
        const reply = fullImage || await api.attachmentImage(o.ref, token, 'full');
        if (!dataUrl(reply)) return { ok: false, reason: '图片内容读取失败' };
        const data = Uint8Array.from(atob(reply.data), (char) => char.charCodeAt(0));
        const file = new Blob([data], { type: reply.mimeType });
        return copyImageFile({ file, type: reply.mimeType },
          (png) => api.copyAttachmentImage(o.ref, token, png));
      } : null,
    });
    try {
      const reply = await api.attachmentImage(o.ref, token, 'full');
      const src = dataUrl(reply);
      if (!src) throw new Error((reply && reply.reason) || '图片内容读取失败');
      fullImage = reply;
      view.image(src, name);
    } catch (error) {
      view.error(String((error && error.message) || error));
    }
    return true;
  }

  function taskAttachmentError(error, fallback) {
    // Electron prefixes rejected invokes; retain only the main process's known,
    // user-facing attachment errors, never an arbitrary native stack or file path.
    const message = String(error && (error.reason || error.message) || '')
      .replace(/^Error invoking remote method 'attachment-(?:preview|download)': (?:Error: )?/, '');
    if (/^(?:附件|这份附件|此类附件|图片超过|当前客户端|当前环境|当前窗口|系统没有可打开)/.test(message)) {
      return message.slice(0, 240);
    }
    if (/\b(?:EACCES|EPERM|EBUSY)\b/.test(message)) return '附件无法写入本地目录，请检查目录权限或下载到其他位置';
    if (/\bENOSPC\b/.test(message)) return '本地磁盘空间不足，请清理空间或下载到其他磁盘';
    return typeof global._humanErr === 'function' ? global._humanErr(error, fallback) : fallback;
  }

  // Task input attachments use the same preview and clipboard path as chat images.
  // Main validates the Hub URL and ticket before returning passive image bytes;
  // the renderer never draws a cross-origin URL onto a canvas.
  async function openTaskAttachment(attachment, options) {
    const o = options || {}, api = o.api || global.soduWorkAPI;
    const current = () => typeof o.isCurrent !== 'function' || o.isCurrent();
    if (!current()) return { ok: false, canceled: true };
    if (!api || typeof api.previewAttachment !== 'function') throw new Error('当前客户端版本不支持附件预览');
    const type = String(attachment.contentType || '').split(';', 1)[0].trim().toLowerCase();
    const image = /^image\/(png|jpeg|gif|webp|bmp|avif|x-icon)$/.test(type) ||
      ((!type || type === 'application/octet-stream') && /^(png|jpe?g|gif|webp|bmp|avif|ico)$/.test(extension(attachment.filename)));
    const reply = await api.previewAttachment(Object.assign({}, attachment, { inlineImage: image }));
    // Discard image results after the host closes or the account changes; do not insert stale previews.
    if (!current()) return { ok: false, canceled: true };
    if (!reply || reply.ok === false) throw new Error(reply && reply.reason || '附件没有打开成功');
    if (!reply.data) return reply; // Documents still use the isolated native viewer.
    if (!/^image\/(png|jpeg|gif|webp|bmp|avif|x-icon)$/.test(reply.mimeType || '')) throw new Error('附件不是受支持的图片');
    const data = Uint8Array.from(atob(reply.data), c => c.charCodeAt(0));
    const file = new Blob([data], { type: reply.mimeType });
    const session = api.conversationSession;
    const nativeCopy = session && typeof session.copyImage === 'function'
      ? png => session.copyImage(png) : null;
    const name = attachment.filename || '图片';
    const view = previewShell({
      name, detail: size(data.length), say: o.say,
      copy: () => copyImageFile({ file, type: reply.mimeType }, nativeCopy),
    });
    view.image(dataUrl(reply), name);
    return { ok: true };
  }

  async function copyOutputImage(file, options) {
    const o=options||{}, links=global.ChatOutputLinks;
    // Revalidate the current session/attachment instead of copying a cached URL.
    const reply=await links.readPreview(file,o.api,o.ref,'image-full');
    if(!links.imageUrl(reply))throw Error(reply?.reason||'图片暂时无法读取');
    const bytes=Uint8Array.from(atob(reply.data),c=>c.charCodeAt(0));
    return copyImageFile({file:new Blob([bytes],{type:reply.mimeType}),type:reply.mimeType},
      o.api?.copyImage ? png=>o.api.copyImage(png) : null);
  }

  function create(options) {
    const o = options || {};
    const host = o.host;
    const input = o.input;
    const fileInput = o.fileInput;
    const button = o.button;
    const tray = o.tray;
    /*
     * Capture the host's current conversation for library attribution. Without a session ID,
     * register a manual upload and associate it after session creation.
     */
    const librarySource = () => {
      if (typeof o.librarySource !== 'function') return null;
      try { return o.librarySource() || null; } catch (_) { return null; }
    };
    let rows = [], composing = false, expandedText = false, destroyed = false;

    const notify = (message) => {
      if (typeof o.say === 'function') o.say(message);
    };
    const changed = () => {
      if (typeof o.onChange === 'function') o.onChange(rows.map((row) => row.file));
    };
    const release = (row) => {
      if (row && row.url) { try { global.URL.revokeObjectURL(row.url); } catch (_) { /* ignore */ } }
    };

    function syncHint() {
      if (o.materialHint !== true || !o.hint) return;
      const hasFoldedText = rows.some((row) => inputTexts.has(row.file));
      const hint = understandingHint(rows.length,
        String(input?.value || '').trim() || (hasFoldedText ? 'folded-text' : ''));
      o.hint.textContent = hint;
      o.hint.hidden = !hint;
    }

    function paint() {
      if (!tray) return;
      tray.innerHTML = rows.map((row, index) => {
        const image = /^image\//i.test(row.type);
        const removeButton = '<button type="button" data-catt-remove="' + index + '" data-catt-name="' + esc(row.name) +
          '" data-user-attributes="aria-label" aria-label="' + esc(removeLabel(row.name)) + '">×</button>';
        if (inputTexts.has(row.file)) {
          const firstLine = inputTexts.get(row.file).trimStart().slice(0, 160).split(/\r?\n/, 1)[0];
          const title = Array.from(firstLine).slice(0, 80).join('').trimEnd() || row.name;
          return '<article class="catt-item catt-text"><span class="catt-file">TXT</span><span class="catt-copy">' +
            '<b data-user-content data-user-attributes="title" title="' + esc(title) + '">' + esc(title) + '</b>' +
            '<button type="button" class="catt-restore" data-catt-restore>在文本框中显示 <span aria-hidden="true">›</span></button></span>' + removeButton + '</article>';
        }
        if (image && row.url && tray.closest?.('.work-composer')) {
          return '<article class="catt-item catt-image">' +
            '<button type="button" class="catt-image-preview catt-openable" data-catt-open="' + index +
            '" data-user-attributes="aria-label" aria-label="' + esc('预览 ' + row.name) + '">' +
            '<img src="' + esc(row.url) + '" alt=""></button>' + removeButton +
            '</article>';
        }
        const openable = image || row.kind === 'text';
        const badge = row.kind === 'dir' ? '<svg class="catt-dir" viewBox="0 0 24 24" aria-hidden="true">' +
            '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>'
          : row.kind === 'text' ? '<span class="catt-file">TXT</span>'
          : '<span class="catt-file">' + esc((row.name.split('.').pop() || '文件').slice(0, 5).toUpperCase()) + '</span>';
        return '<article class="catt-item' + (openable ? ' catt-openable' : '') +
          '" data-catt-open="' + index + '"' + (openable ? ' title="点击查看"' : '') + '>' +
          (image && row.url ? '<img src="' + esc(row.url) + '" alt="">' : badge) +
          '<span class="catt-copy"><b data-user-content data-user-attributes="title" title="' + esc(row.name) + '">' + esc(row.name) + '</b><small>' +
            esc(row.kind === 'dir' ? '文件夹' : size(row.size)) + '</small>' +
            '</span>' +
          removeButton +
        '</article>';
      }).join('');
      syncHint();
      tray.classList.toggle('show', rows.length > 0);
    }

    function add(files, source, kinds) {
      const native = Array.from(files || []).filter(file => file?.nativeReference && file.path);
      if (native.length) addReferences(native);
      const incoming = Array.from(files || []).filter(file => file && !file.nativeReference);
      let total = rows.reduce((sum, row) => sum + row.size, 0);
      for (let i = 0; i < incoming.length; i++) {
        const file = incoming[i];
        if (rows.length >= MAX_FILES) { notify('一次最多添加 ' + MAX_FILES + ' 个文件'); break; }
        const kind = inputTexts.has(file) ? 'text' : (kinds && kinds[i]) || fileKinds.get(file) || '';
        if (kind === 'dir') fileKinds.set(file, kind);
        const fileSize = kind === 'dir' ? 0 : Number(file.size || 0);
        if (total + fileSize > MAX_BYTES) { notify('本次附件总大小不能超过 256 MB'); break; }
        const key = [file.name, fileSize, file.lastModified].join(':');
        // Clear the draft before full restoration; preserve separate entries for repeated pastes of the same image.
        if (source !== 'paste' && source !== 'draft' && rows.some((row) => row.key === key)) continue;
        const name = source === 'paste' && /^image\//i.test(file.type || '')
          ? pastedName(file, rows.length) : (file.name || '附件');
        const type = kind === 'dir' ? '' : file.type || '';
        const url = /^image\//i.test(type) ? global.URL.createObjectURL(file) : '';
        const row = { file, name, size: fileSize, type, key, url, kind };
        rows.push(row);
        // Folding a typed prompt is only a display change. Do not upload it to
        // the library or replace its trusted in-memory File during hydration.
        if (inputTexts.has(file)) { total += fileSize; continue; }
        const currentLibrarySource = librarySource();
        const capturedLibrarySource = currentLibrarySource ? { ...currentLibrarySource } : null;
        hydrateRow(row).then(() => {
          /*
           * Register library files after hydration so uploads use validated memory copies. Never
           * upload expired source files or rejected encrypted payloads.
           */
          if (!rows.includes(row)) return;
          // Restoring a requirement card rebuilds only its view; do not upload attachments already registered by the original conversation.
          row.library = source === 'card-restore' ? null : global.LibraryTransfer?.trackFile(row.file, { name: row.name, source, kind: row.kind, librarySource: capturedLibrarySource }, () => {
            if (rows.includes(row)) paint();
          });
          paint();
        });
        total += fileSize;
      }
      paint(); changed();
    }

    // OS requests are already read-checked/staged in the main process. Keep
    // metadata in the composer; a large file never crosses IPC as base64.
    function addReferences(files) {
      let total = rows.reduce((sum, row) => sum + row.size, 0);
      for (const file of files || []) {
        if (!file?.path || !file.name || rows.length >= MAX_FILES) continue;
        const bytes = Number(file.size) || 0;
        if (total + bytes > MAX_BYTES) { notify('本次附件总大小不能超过 256 MB'); break; }
        const key = 'native:' + file.path;
        if (rows.some(row => row.key === key)) continue;
        const reference = { ...file, nativeReference: true };
        fileOrigins.set(reference, fileIdentity(file));
        rows.push({ file: reference, nativePath: file.path,
          name: file.name, size: bytes, type: file.type || '', key, url: '', kind: 'file' });
        total += bytes;
      }
      paint(); changed();
    }

    /*
     * Validate dropped/pasted virtual files immediately, detect their type, and copy small
     * files to memory before temporary caches disappear. Reject unreadable files before they
     * enter the send queue.
     */
    async function hydrateRow(row) {
      // Directory File objects have no readable bytes. Preserve the original
      // object so Electron can resolve its path for the existing runtime reference.
      if (row.kind === 'dir') return;
      try {
        const head = new Uint8Array(await row.file.slice(0, 512).arrayBuffer());
        if (!head.length) throw new Error('empty');
        if (encryptedHead(head)) {
          dropRow(row, '「' + row.name + '」被企业文档透明加密，客户端读不出内容。' +
            '图片请改用截图粘贴（Win+Shift+S），其他文件请另存为普通格式后再拖入');
          return;
        }
        if (!row.type || row.type === 'application/octet-stream') {
          const sniffed = sniffMime(head);
          if (sniffed) row.type = sniffed;
        }
        const ext = MIME_EXT[row.type];
        if (ext && !extension(row.name)) row.name = row.name + '.' + ext;
        if (row.size <= CACHE_BYTES && typeof row.file.arrayBuffer === 'function') {
          const origin = fileIdentity(row.file);
          const buffer = await row.file.arrayBuffer();
          row.file = new File([new Blob([buffer], { type: row.type || 'application/octet-stream' })],
            row.name, { type: row.type || '' });
          fileOrigins.set(row.file, origin);
        }
        if (!row.url && /^image\//i.test(row.type) && !row.kind) {
          row.url = global.URL.createObjectURL(row.file);
        }
        paint();
      } catch (_) {
        dropRow(row, '「' + row.name + '」可能来自企业微信临时缓存，已无法读取，请另存后拖入');
      }
    }

    function dropRow(row, message) {
      const index = rows.indexOf(row);
      if (index < 0) return;
      rows.splice(index, 1); release(row); paint(); changed();
      notify(message);
    }

    function submissionText(typed) {
      return rows.map(row => inputTexts.get(row.file) || '').join('') + String(typed || '');
    }
    function overTextThreshold(text) {
      let count = 0;
      for (const character of text) if (++count > 1500) return true;
      return false;
    }
    function inputChanged() {
      if (typeof global.Event === 'function') input?.dispatchEvent?.(new global.Event('input', { bubbles: true }));
    }
    function foldInput(value = input?.value || '') {
      if (destroyed || !input || composing || expandedText || o.captureLongText === false || !overTextThreshold(value)) return false;
      const previous = rows.filter(row => inputTexts.has(row.file)), text = submissionText(value);
      const file = new File([text], previous[0]?.name || '输入文本-' + Date.now() + '.txt', { type: 'text/plain' });
      const ordinary = rows.filter(row => !inputTexts.has(row.file));
      if (ordinary.length >= MAX_FILES || ordinary.reduce((sum, row) => sum + row.size, file.size) > MAX_BYTES) {
        notify('附件空间不足，原文已保留在输入框中'); return false;
      }
      inputTexts.set(file, text);
      rows = ordinary;
      rows.push({ file, name: file.name, size: file.size, type: file.type, key: 'input-text', url: '', kind: 'text' });
      input.value = '';
      paint(); changed(); inputChanged();
      return true;
    }
    function restoreText() {
      if (!input || !rows.some(row => inputTexts.has(row.file))) return false;
      const text = submissionText(input.value);
      rows = rows.filter(row => !inputTexts.has(row.file));
      expandedText = true; input.value = text;
      paint(); changed(); inputChanged(); input.focus?.();
      input.setSelectionRange?.(input.value.length, input.value.length);
      return true;
    }
    function consumeInputText(submittedFiles, options) {
      if (options?.resetExpanded) expandedText = false;
      const sent = new Set(submittedFiles || []);
      const remaining = rows.filter(row => !inputTexts.has(row.file) || !sent.has(row.file));
      if (remaining.length === rows.length) return false;
      rows = remaining;
      paint(); changed(); inputChanged();
      return true;
    }

    async function openRowPreview(row) {
      if (!row) return;
      const image = isImage(row);
      const api = o.api || (global.soduWorkAPI &&
        (global.soduWorkAPI.conversationSession || global.soduWorkAPI.piSession));
      const nativeCopy = api && typeof api.copyImage === 'function'
        ? (png) => api.copyImage(png) : null;
      const view = previewShell({
        name: row.name, detail: size(row.size), say: notify,
        copy: image ? () => copyImageFile(row, nativeCopy) : null,
      });
      if (image && row.url) { view.image(row.url, row.name); return; }
      let text = '';
      try { text = await row.file.text(); } catch (_) { text = '（内容读不出来）'; }
      view.text(text.slice(0, 200000));
    }

    async function refs(api) {
      const out = [];
      for (const row of rows.slice()) {
        if (row.nativePath) {
          out.push({ name: row.name, size: row.size, type: row.type, path: row.nativePath });
          continue;
        }
        let localPath = '';
        try { localPath = api && typeof api.pathForFile === 'function' ? api.pathForFile(row.file) : ''; }
        catch (_) { localPath = ''; }
        if (localPath) {
          out.push({ name: row.name, size: row.size, type: row.type, path: localPath,
            ...(row.kind === 'dir' ? { kind: 'dir' } : {}) });
          continue;
        }
        if (row.kind === 'dir') {
          notify('文件夹「' + row.name + '」无法取得本地路径，请从文件管理器重新拖入');
          continue;
        }
        if (!row.file || typeof row.file.arrayBuffer !== 'function') continue;
        let data;
        try { data = new Uint8Array(await row.file.arrayBuffer()); }
        catch (_) {
          /*
           * Report the specific attachment that disappeared after initial validation instead of
           * silently omitting it at send time.
           */
          notify('附件「' + row.name + '」读取失败已跳过：可能来自企业微信临时缓存，请另存后拖入');
          continue;
        }
        out.push({ name: row.name, size: data.byteLength, type: row.type, data });
      }
      return out;
    }

    /*
     * Form parsing receives bounded attachment context: text, controlled base64 for
     * images/Office/PDF, or metadata for unknown formats. Preserve originals through the
     * normal upload flow without embedding entire large attachments in a parsing request.
     */
    async function analysis() {
      const out = [];
      let budget = ANALYSIS_MAX_BYTES;
      let imageCount = 0;
      for (const row of rows.slice(0, ANALYSIS_MAX_FILES)) {
        if (inputTexts.has(row.file)) continue; // Already supplied as the exact user request.
        const ext = extension(row.name);
        const item = {
          name: row.name, size: row.size, type: row.type || '',
          kind: row.kind || 'file', extension: ext,
        };
        if (row.kind === 'dir' || !row.file) {
          item.mode = 'metadata'; out.push(item); continue;
        }
        const textLike = /^text\//i.test(row.type || '') || TEXT_EXT.has(ext);
        const image = /^image\//i.test(row.type || '');
        const document = DOCUMENT_EXT.has(ext);
        try {
          if (textLike) {
            const value = await row.file.text();
            item.mode = 'text';
            item.text = String(value || '').slice(0, ANALYSIS_TEXT_CHARS);
            item.truncated = String(value || '').length > ANALYSIS_TEXT_CHARS;
          } else if ((image || document) && row.size <= ANALYSIS_FILE_BYTES &&
              row.size <= budget && (!image || imageCount < 6)) {
            const data = new Uint8Array(await row.file.arrayBuffer());
            item.mode = image ? 'image' : 'document';
            item.encoding = 'base64';
            item.data = bytesBase64(data);
            budget -= data.byteLength;
            if (image) imageCount += 1;
          } else {
            item.mode = 'metadata';
            item.truncated = row.size > ANALYSIS_FILE_BYTES || row.size > budget;
          }
        } catch (_) {
          item.mode = 'metadata'; item.readError = true;
        }
        out.push(item);
      }
      return out;
    }

    /*
     * Use webkitGetAsEntry to identify dropped directories; without entry support, accept the
     * original files collection.
     */
    function addFromDrop(transfer) {
      if (!transfer) return;
      const items = Array.from(transfer.items || []);
      const files = [];
      const kinds = [];
      let usedEntries = false;
      for (const item of items) {
        if (item.kind !== 'file') continue;
        const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
        const file = item.getAsFile();
        if (!file) continue;
        usedEntries = usedEntries || !!entry;
        files.push(file);
        kinds.push(entry && entry.isDirectory ? 'dir' : '');
      }
      if (files.length) add(files, 'drop', kinds);
      else if (!usedEntries) add(transfer.files, 'drop');
    }

    function clear() {
      rows.forEach(release); rows = []; expandedText = false; paint(); changed();
    }
    function remove(index) {
      const row = rows.splice(index, 1)[0]; release(row); paint(); changed();
    }

    if (button && fileInput) button.addEventListener('click', () => fileInput.click());
    if (fileInput) fileInput.addEventListener('change', () => {
      add(fileInput.files, 'picker'); fileInput.value = '';
    });
    if (input) input.addEventListener('paste', (event) => {
      const items = Array.from((event.clipboardData && event.clipboardData.items) || []);
      const files = items.filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter(Boolean);
      if (files.length) { event.preventDefault(); add(files, 'paste'); return; }
      /*
       * Preserve slash commands, skill references, and execution instructions in pasted text.
       * Convert long text to TXT only when material mode is explicitly selected.
       */
      const text = String((event.clipboardData && event.clipboardData.getData('text')) || '');
      const value = String(input.value || ''), start = input.selectionStart ?? value.length, end = input.selectionEnd ?? start;
      if (text && foldInput(value.slice(0, start) + text + value.slice(end))) event.preventDefault();
    });
    input?.addEventListener('compositionstart', () => { composing = true; });
    input?.addEventListener('compositionend', () => { composing = false; foldInput(); });
    input?.addEventListener('input', event => {
      if (!input.value) expandedText = false;
      if (!event.isComposing) foldInput();
    });
    if (host) {
      ['dragenter', 'dragover'].forEach((name) => host.addEventListener(name, (event) => {
        event.preventDefault(); event.stopPropagation(); host.classList.add('drag');
      }));
      ['dragleave', 'dragend'].forEach((name) => host.addEventListener(name, () => host.classList.remove('drag')));
      host.addEventListener('drop', (event) => {
        event.preventDefault(); event.stopPropagation(); host.classList.remove('drag');
        addFromDrop(event.dataTransfer);
      });
    }
    if (tray) tray.addEventListener('click', (event) => {
      if (event.target.closest('[data-catt-restore]')) { event.preventDefault(); event.stopPropagation(); restoreText(); return; }
      const retry = event.target.closest('[data-catt-library-retry]');
      if (retry) { event.stopPropagation(); global.LibraryTransfer?.retry(rows[Number(retry.dataset.cattLibraryRetry)]?.library); return; }
      const hit = event.target.closest('[data-catt-remove]');
      if (hit) { remove(Number(hit.dataset.cattRemove)); return; }
      const open = event.target.closest('.catt-openable[data-catt-open]');
      if (open) openRowPreview(rows[Number(open.dataset.cattOpen)]);
    });

    function destroy() {
      destroyed = true;
      rows.forEach(release);
      rows = [];
      if (tray) { tray.innerHTML = ''; tray.classList.remove('show'); }
    }

    return {
      add, addReferences, clear, destroy, refs, analysis, submissionText, foldInput, restoreText, consumeInputText,
      files: () => rows.map((row) => row.file),
      names: () => rows.map((row) => row.name),
      /* IDs of successfully registered library items for association after conversation creation. */
      libraryItems: () => rows.map((row) => row.library)
        .filter(job => job && job.status === 'saved' && job.result && job.result.item && job.result.item.id)
        .map(job => String(job.result.item.id)),
      has: () => rows.length > 0,
    };
  }

  global.ConversationAttachments = {
    create, size, messageHtml, hydrateMessageImages, openMessageImage, openTaskAttachment, taskAttachmentError, copyOutputImage, MAX_FILES, MAX_BYTES,
    ANALYSIS_MAX_FILES, ANALYSIS_MAX_BYTES, sniffMime, fileIdentity, inputText: file => inputTexts.get(file),
  };
})(window);
