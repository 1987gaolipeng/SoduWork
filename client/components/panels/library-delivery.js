/* Personal, server-backed library viewer. Generated documents never get app access.
   Delivery collections and plain library items share the same drawer and the
   same sandboxed rendering pipeline. */
(function (global) {
  'use strict';

  let active = null;
  let activeClose = null;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  const text = value => String(value ?? '').trim();
  const extension = path => text(path).split(/[\\/]/).pop().split('.').pop().toLowerCase();
  const basename = path => text(path).split(/[\\/]/).pop() || text(path);
  const imageTypes = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ico', 'avif']);
  const textTypes = new Set(['md', 'markdown', 'txt', 'csv', 'json', 'yaml', 'yml', 'xml', 'log', 'js', 'jsx', 'ts', 'tsx', 'css', 'scss', 'html', 'htm']);
  const archiveTypes = new Set(['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz']);
  const videoTypes = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv']);
  const audioTypes = new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac']);
  const mimeByExtension = {
    html: 'text/html', htm: 'text/html', md: 'text/markdown', markdown: 'text/markdown',
    pdf: 'application/pdf', json: 'application/json', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
    mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', ico: 'image/x-icon', avif: 'image/avif'
  };

  function safeMarkdown(value) {
    if (!global.marked || !global.DOMPurify) return null;
    return global.DOMPurify.sanitize(global.marked.parse(text(value)), {
      FORBID_TAGS: ['img', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'script', 'style'],
      FORBID_ATTR: ['style', 'onerror', 'onclick', 'onload']
    });
  }
  function contentType(file) {
    return text(file?.contentType || file?.mimeType || file?.type).split(';', 1)[0].toLowerCase();
  }
  function fileKind(file) {
    const ext = extension(file?.path);
    const mime = contentType(file);
    if (archiveTypes.has(ext) || /(?:zip|compressed|tar|rar|7z)/i.test(mime)) return 'archive';
    if (imageTypes.has(ext) || mime.startsWith('image/')) return 'image';
    if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
    if (videoTypes.has(ext) || mime.startsWith('video/')) return 'video';
    if (audioTypes.has(ext) || mime.startsWith('audio/')) return 'audio';
    if (ext === 'html' || ext === 'htm' || mime === 'text/html') return 'html';
    if (textTypes.has(ext) || mime.startsWith('text/') || mime === 'application/json') return 'text';
    return 'download';
  }
  function base64(bytes) {
    let value = ''; const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) value += String.fromCharCode(...bytes.subarray(i, i + chunk));
    return btoa(value);
  }
  async function dataUrl(blob, mime) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return 'data:' + (mime || blob.type || 'application/octet-stream') + ';base64,' + base64(bytes);
  }
  function normalizeAssetPath(value) {
    if (/[\\\x00-\x1f\x7f]/.test(value)) return null;
    const out = [];
    for (const part of String(value || '').split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { if (!out.length) return null; out.pop(); }
      else out.push(part);
    }
    return out.join('/');
  }
  function resolveAssetPath(reference, owner) {
    let value = String(reference || '').trim();
    if (!value || value.startsWith('#') || /^(?:data|blob):/i.test(value)) return { literal: value };
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)) return null;
    const hash = value.indexOf('#'), fragment = hash < 0 ? '' : value.slice(hash);
    value = value.split(/[?#]/, 1)[0];
    try { value = decodeURIComponent(value); } catch (_) { return null; }
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)) return null;
    const directory = value.startsWith('/') ? '' : String(owner || '').split('/').slice(0, -1).join('/');
    const path = normalizeAssetPath((directory ? directory + '/' : '') + value);
    return path === null ? null : { path, fragment };
  }
  function srcsetCandidates(value) {
    const input = String(value || ''), candidates = [];
    const space = /[\t\n\f\r ]/; let position = 0;
    while (position < input.length) {
      while (position < input.length && (space.test(input[position]) || input[position] === ',')) position++;
      const start = position;
      // A URL token ends at whitespace, not every comma: data URLs and archive
      // member names can contain commas. A trailing comma ends a bare URL.
      while (position < input.length && !space.test(input[position])) position++;
      let url = input.slice(start, position), descriptor = '';
      if (url.endsWith(',')) url = url.replace(/,+$/, '');
      else {
        const descriptorStart = position;
        while (position < input.length && input[position] !== ',') position++;
        descriptor = input.slice(descriptorStart, position).trim();
        if (input[position] === ',') position++;
      }
      if (!url) continue;
      if (descriptor) {
        const valid = /^[1-9]\d*w$/.test(descriptor) ||
          /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?x$/.test(descriptor);
        if (!valid || !Number.isFinite(Number(descriptor.slice(0, -1))) || Number(descriptor.slice(0, -1)) <= 0) continue;
      }
      candidates.push({ url, descriptor });
    }
    return candidates;
  }
  async function buildHtmlDocument(source, files, current, readFile, options = {}) {
    const manifest = new Map(), assets = new Map(); let total = 0, reads = 0;
    let expansionRemaining = 16 * 1024 * 1024;
    const perAsset = 2 * 1024 * 1024, aggregate = 8 * 1024 * 1024;
    for (const file of files || []) {
      const path = normalizeAssetPath(file?.path);
      if (path && !file.isDirectory && !manifest.has(path)) manifest.set(path, file);
    }
    function navigationTarget(reference, owner) {
      const resolved = reference.startsWith('?')
        ? { path: normalizeAssetPath(owner), fragment: reference.includes('#') ? reference.slice(reference.indexOf('#')) : '' }
        : resolveAssetPath(reference, owner);
      if (!resolved || 'literal' in resolved || resolved.path === null) return null;
      const directory = resolved.path ? resolved.path + '/' : '';
      for (const path of [resolved.path, directory + 'index.html', directory + 'index.htm']) {
        if (manifest.has(path)) return { path: manifest.get(path).path, fragment: resolved.fragment };
      }
      return null;
    }
    // Resolve only actual references against their owning HTML/CSS directory.
    // A same-named file elsewhere in the archive is never a fallback alias.
    async function asset(reference, owner, ancestors = new Set()) {
      const resolved = resolveAssetPath(reference, owner);
      if (!resolved) return 'data:,';
      if ('literal' in resolved) return resolved.literal;
      const { path, fragment } = resolved;
      if (ancestors.has(path)) return 'data:,';
      if (!assets.has(path)) assets.set(path, (async () => {
        const file = manifest.get(path), declared = Number(file?.size) || 0;
        if (!file || reads >= 128 || declared > perAsset || total + declared > aggregate) return '';
        reads++;
        try {
          const blob = await readFile(file.path);
          if (blob.size > perAsset || total + blob.size > aggregate) return '';
          total += blob.size;
          const mime = mimeByExtension[extension(path)] || contentType(file) || blob.type || 'application/octet-stream';
          if (mime === 'text/css') {
            const chain = new Set(ancestors); chain.add(path);
            const css = await rewriteCss(await blob.text(), path, chain);
            return dataUrl(new Blob([css], { type: mime }), mime);
          }
          return dataUrl(blob, mime);
        } catch (error) {
          if (error?.code === 'STALE_TASK_SCOPE' || error?.code === 'STALE_PREVIEW' || error?.name === 'AbortError') throw error;
          return ''; // One missing support file must not hide the document.
        }
      })());
      const url = await assets.get(path);
      // The source byte budget alone does not bound repeated data URLs or a
      // diamond of CSS imports. Reserve expanded output before concatenation.
      if (!url || url.length + fragment.length > expansionRemaining) return 'data:,';
      expansionRemaining -= url.length + fragment.length;
      return url + fragment;
    }
    async function rewriteCss(value, owner, ancestors) {
      // Skip comments and unrelated quoted strings; retain @import media/layer
      // qualifiers while replacing only its URL and resolve nested CSS in turn.
      const pattern = /\/\*[\s\S]*?\*\/|@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)|"([^"]*)"|'([^']*)')|url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gi;
      const css = String(value || ''); let result = '', offset = 0;
      for (const match of css.matchAll(pattern)) {
        result += css.slice(offset, match.index); offset = match.index + match[0].length;
        if (/^(?:\/\*|["'])/.test(match[0])) { result += match[0]; continue; }
        const reference = match.slice(1).find(value => value !== undefined) || '';
        const url = await asset(reference.trim(), owner, ancestors);
        result += (/^@import/i.test(match[0]) ? '@import ' : '') + 'url("' + url.replace(/"/g, '%22') + '")';
      }
      return result + css.slice(offset);
    }
    // DOMPurify's default document policy intentionally removes <style>, <link>
    // and <script>. That is correct for chat markdown, but makes a generated
    // website look like source text. A separate opaque sandbox keeps the page
    // isolated from SoduWork while allowing its own inline behavior and CSS.
    try {
      const parser = new DOMParser(); const doc = parser.parseFromString(String(source || ''), 'text/html');
      doc.querySelectorAll('iframe,object,embed,base,form,meta[http-equiv]').forEach(node => node.remove());
      doc.querySelectorAll('*').forEach(node => [...node.attributes].forEach(attr => {
        if (/^on/i.test(attr.name) || ['srcdoc', 'data-soduwork-preview-path', 'data-soduwork-preview-fragment'].includes(attr.name)) node.removeAttribute(attr.name);
      }));
      const owner = current?.path || '';
      for (const node of doc.querySelectorAll('[src],[href],[poster],[xlink\\:href]')) {
        for (const attr of ['src', 'poster', 'href', 'xlink:href']) {
          if (!node.hasAttribute(attr)) continue;
          const reference = node.getAttribute(attr).trim();
          if (node.tagName.toLowerCase() === 'a' && attr === 'href') {
            if (!reference.startsWith('#')) {
              node.removeAttribute(attr);
              const target = options.navigation && navigationTarget(reference, owner);
              if (target) {
                node.setAttribute('href', '#');
                node.setAttribute('data-soduwork-preview-path', target.path);
                node.setAttribute('data-soduwork-preview-fragment', target.fragment);
              }
            }
            node.removeAttribute('target'); continue;
          }
          if (node.tagName.toLowerCase() === 'link' && !/\b(?:stylesheet|icon)\b/i.test(node.getAttribute('rel') || '')) {
            node.removeAttribute(attr); continue;
          }
          const resolved = await asset(reference, owner);
          node.setAttribute(attr, resolved);
          if (resolved !== reference) node.removeAttribute('integrity');
        }
      }
      for (const node of doc.querySelectorAll('img[srcset],source[srcset]')) {
        const candidates = [];
        for (const { url, descriptor } of srcsetCandidates(node.getAttribute('srcset'))) {
          const resolved = await asset(url, owner);
          if (!resolved || resolved === 'data:,') continue;
          candidates.push(resolved + (descriptor ? ' ' + descriptor : ''));
        }
        if (candidates.length) node.setAttribute('srcset', candidates.join(', '));
        else node.removeAttribute('srcset');
      }
      for (const style of doc.querySelectorAll('style')) style.textContent = await rewriteCss(style.textContent, owner);
      for (const node of doc.querySelectorAll('[style]')) node.setAttribute('style', await rewriteCss(node.getAttribute('style'), owner));
      const style = doc.createElement('style');
      // Keep this as a restrained baseline only. Generated pages commonly set
      // their own background, typography and link colors; appending defaults
      // that override those rules is what made saved sites look like a bare
      // document in the library viewer.
      style.textContent = ':root{color-scheme:light}html,body{min-height:100%;box-sizing:border-box}body{margin:0;padding:0;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;font-size:16px;line-height:1.7}img,video{max-width:100%;height:auto}pre,code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}';
      (doc.head || doc.documentElement).prepend(style);
      const policy = doc.createElement('meta');
      policy.httpEquiv = 'Content-Security-Policy';
      policy.content = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; connect-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline' data:; script-src 'unsafe-inline' data:";
      (doc.head || doc.documentElement).prepend(policy);
      return '<!doctype html>' + doc.documentElement.outerHTML;
    } catch (error) {
      if (error?.code === 'STALE_TASK_SCOPE' || error?.code === 'STALE_PREVIEW' || error?.name === 'AbortError') throw error;
      throw new Error('HTML 预览处理失败，请下载原文件查看');
    }
  }
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = basename(filename) || 'download';
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /* Generic drawer. `options` labels the drawer and its failure state; `load()`
     resolves a provider describing the files plus how to read and download
     them. Unsupported kinds and oversized files still get the download card. */
  async function showViewer(options, load) {
    const embedded = Boolean(options.mount);
    if (!embedded && active) return;
    const dialog = document.createElement(embedded ? 'section' : 'dialog');
    dialog.className = 'ldelivery-dialog' + (embedded ? ' ldelivery-embedded' : '');
    dialog.setAttribute('aria-label', '资料预览');
    if (!embedded) active = dialog;
    let disposed = false;
    const scope = global.SoduWorkAPI.taskStorageKey('ops');
    let version = 0; let objectUrl = ''; let provider = null; let files = [];
    const valid = () => !disposed && (embedded || active === dialog) && scope === global.SoduWorkAPI.taskStorageKey('ops');
    function close() {
      disposed = true;
      version += 1;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (dialog.open) dialog.close();
      dialog.remove();
      if (active === dialog) active = null;
      if (activeClose === close) activeClose = null;
      global.removeEventListener('soduwork-data-scope-changed', close);
    }
    dialog.innerHTML =
      '<header class="ldelivery-head"><div class="ldelivery-heading">' +
        '<div class="ldelivery-eyebrow">资料库 <span aria-hidden="true">·</span> ' + esc(options.eyebrow || '交付成果') + '</div>' +
        '<h2 data-delivery-title>正在读取…</h2><div class="ldelivery-summary" data-delivery-summary>准备预览</div>' +
      '</div><button class="ldelivery-close" type="button" data-delivery-close aria-label="关闭">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></header>' +
      '<div class="ldelivery-body"><aside class="ldelivery-files-pane" aria-label="交付文件列表"><div class="ldelivery-files-label">文件 <span data-delivery-count></span></div><nav data-delivery-files></nav></aside>' +
        '<section class="ldelivery-preview" data-delivery-preview aria-live="polite"><div class="ldelivery-loading"><span class="library-spinner" aria-hidden="true"></span><span>正在加载预览…</span></div></section></div>' +
      '<footer class="ldelivery-foot"><span data-delivery-error role="status"></span><button class="ldelivery-download" type="button" data-delivery-all disabled>' + (options.openLocal ? '打开当前本地文件' : '下载全部') + '</button></footer>';
    (options.mount || document.body).append(dialog);
    options.onMount?.(close);
    if (!embedded) activeClose = close;
    if (!embedded && typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    global.addEventListener('soduwork-data-scope-changed', close);
    dialog.querySelector('[data-delivery-close]').addEventListener('click', () => { close(); options.onClose?.(); });
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('click', event => { if (!embedded && event.target === dialog) close(); });
    const body = dialog.querySelector('[data-delivery-preview]');
    const note = dialog.querySelector('[data-delivery-error]');
    const filesPane = dialog.querySelector('[data-delivery-files]');

    function downloadSingle(file, button, label) {
      body.querySelector('[data-delivery-single]')?.addEventListener('click', async event => {
        const target = event.currentTarget; target.disabled = true;
        try { if (options.openLocal) await options.openLocal(); else await provider.downloadFile(file); }
        catch (error) { if (valid()) note.textContent = error.message || '下载失败'; }
        finally { if (target.isConnected) target.disabled = false; }
      });
      if (button) { button.textContent = options.openLocal ? '打开当前本地文件' : '下载此文件'; button.setAttribute('aria-label', options.openLocal ? '打开当前本地文件' : label || '下载此文件'); }
    }
    function renderDownload(file, kind) {
      const archive = kind === 'archive';
      if (files.length === 1) dialog.querySelector('[data-delivery-all]').hidden = true;
      const ext = extension(file.path).toUpperCase() || 'FILE';
      const size = file.size ? ' · ' + formatSize(file.size) : '';
      body.innerHTML = '<div class="ldelivery-empty ldelivery-download-card"><div class="ldelivery-empty-icon ldelivery-file-type-icon" aria-hidden="true">' +
        esc(archive ? 'ZIP' : ext) + '</div><h3 data-user-content>' + esc(basename(file.path)) + '</h3><p>' +
        (options.openLocal ? '可在本地文件所在位置使用对应应用打开。' : archive ? '这是一个压缩包，下载后使用系统工具解压。' : '此文件适合下载后使用对应应用打开。') + esc(size) +
        '</p><button class="ldelivery-primary" type="button" data-delivery-single>下载此文件</button></div>';
      downloadSingle(file, body.querySelector('[data-delivery-single]'), '下载 ' + basename(file.path));
    }
    async function preview(file, button) {
      const request = ++version;
      if (!file) return;
      dialog.querySelector('[data-delivery-all]').hidden = false;
      filesPane.querySelectorAll('[data-delivery-file]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
      if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = ''; }
      body.innerHTML = '<div class="ldelivery-loading"><span class="library-spinner" aria-hidden="true"></span><span>正在读取 ' + esc(basename(file.path)) + '…</span></div>';
      try {
        const ext = extension(file.path); const kind = fileKind(file);
        if (kind === 'archive' || kind === 'download' || Number(file.size) > 8 * 1024 * 1024) {
          renderDownload(file, kind); return;
        }
        const blob = await provider.readFile(file.path);
        if (!valid() || request !== version) return;
        if (kind === 'image') {
          objectUrl = URL.createObjectURL(blob);
          const image = document.createElement('img'); image.className = 'ldelivery-image'; image.alt = basename(file.path); image.src = objectUrl;
          body.replaceChildren(image); return;
        }
        if (kind === 'pdf') {
          objectUrl = URL.createObjectURL(blob);
          const frame = document.createElement('iframe'); frame.className = 'ldelivery-document-frame'; frame.title = basename(file.path); frame.src = objectUrl;
          body.replaceChildren(frame); return;
        }
        if (kind === 'video' || kind === 'audio') {
          objectUrl = URL.createObjectURL(blob);
          const media = document.createElement(kind === 'video' ? 'video' : 'audio'); media.className = 'ldelivery-media'; media.controls = true; media.src = objectUrl;
          body.replaceChildren(media); return;
        }
        const source = await blob.text();
        if (!valid() || request !== version) return;
        if (kind === 'html') {
          const documentSource = await buildHtmlDocument(source, files || [], file, path => provider.readFile(path));
          if (!valid() || request !== version) return;
          const frame = document.createElement('iframe'); frame.className = 'ldelivery-html-frame'; frame.setAttribute('sandbox', 'allow-scripts'); frame.setAttribute('referrerpolicy', 'no-referrer'); frame.setAttribute('title', basename(file.path)); frame.srcdoc = documentSource; body.replaceChildren(frame);
          return;
        }
        if (ext === 'md' || ext === 'markdown') {
          const html = safeMarkdown(source);
          if (html) { body.innerHTML = html; body.querySelectorAll('a').forEach(anchor => { const span = document.createElement('span'); span.textContent = anchor.textContent; anchor.replaceWith(span); }); }
          else { const pre = document.createElement('pre'); pre.textContent = source; body.replaceChildren(pre); }
        } else { const pre = document.createElement('pre'); pre.textContent = source; body.replaceChildren(pre); }
      } catch (error) {
        if (valid() && request === version) body.innerHTML = '<div class="ldelivery-empty"><h3>暂时无法预览</h3><p>' + esc(error.message || '读取文件失败，请稍后重试。') + '</p></div>';
      }
    }

    try {
      provider = await load();
      if (!valid()) return;
      if (!provider?.files?.length) throw Error(options.emptyMessage || '内容不存在或已移入回收站');
      files = provider.files;
      const archiveDelivery = files.length === 1 && fileKind(files[0]) === 'archive';
      dialog.classList.toggle('ldelivery-single', files.length === 1);
      dialog.classList.toggle('ldelivery-archive', archiveDelivery);
      dialog.querySelector('[data-delivery-title]').textContent = provider.title || '资料';
      dialog.querySelector('[data-delivery-summary]').textContent = provider.summary || (archiveDelivery ? '压缩包 · 已同步到资料库' : files.length > 1 ? files.length + ' 个文件 · 可逐项预览' : '1 个文件 · 可直接打开');
      dialog.querySelector('[data-delivery-count]').textContent = '(' + files.length + ')';
      filesPane.innerHTML = files.map((file, index) => {
        const role = file.path === provider.entryPath ? '主文件' : file.role === 'supporting' ? '附属文件' : '交付文件';
        const kind = fileKind(file); const kindLabel = kind === 'archive' ? '压缩包' : kind === 'html' ? '网页' : kind === 'pdf' ? 'PDF' : kind === 'image' ? '图片' : kind === 'download' ? '文件' : role;
        return '<button type="button" data-delivery-file="' + index + '" aria-pressed="false"><span class="ldelivery-file-icon" aria-hidden="true">' + esc(kind === 'archive' ? 'ZIP' : extension(file.path).toUpperCase() || 'FILE') + '</span><span class="ldelivery-file-copy"><b data-user-content>' + esc(basename(file.path)) + '</b><small>' + esc(kindLabel) + (file.size ? ' · ' + esc(formatSize(file.size)) : '') + '</small></span></button>';
      }).join('');
      filesPane.addEventListener('click', event => { const button = event.target.closest('[data-delivery-file]'); if (button) void preview(files[Number(button.dataset.deliveryFile)], button); });
      const download = dialog.querySelector('[data-delivery-all]');
      download.disabled = false; download.textContent = options.openLocal ? '打开当前本地文件' : files.length > 1 ? '下载全部 · ZIP' : '下载文件';
      download.addEventListener('click', async () => { download.disabled = true; try { if (options.openLocal) await options.openLocal(); else await provider.downloadAll(); } catch (error) { if (valid()) note.textContent = error.message || '打开失败'; } finally { if (valid()) download.disabled = false; } });
      note.textContent = provider.footerNote || '';
      if (provider.externalDependencies?.length) note.title = provider.externalDependencies.join('\n');
      const entry = Math.max(0, files.findIndex(file => file.path === provider.entryPath));
      await preview(files[entry], filesPane.querySelector('[data-delivery-file="' + entry + '"]'));
    } catch (error) {
      if (valid()) { dialog.querySelector('[data-delivery-title]').textContent = options.errorTitle || '内容暂时不可用'; body.innerHTML = '<div class="ldelivery-empty"><h3>' + esc(options.errorHeading || '无法打开这份内容') + '</h3><p>' + esc(error.message || '请稍后重试。') + '</p></div>'; }
    }
  }

  async function open(id, options = {}) {
    await showViewer({ ...options, eyebrow: '交付成果', emptyMessage: '成果不存在或已移入回收站', errorTitle: '成果暂时不可用', errorHeading: '无法打开这份成果' }, async () => {
      const result = await global.SoduWorkAPI.getDelivery(id);
      const delivery = result?.delivery;
      if (!delivery?.files?.length) throw Error('成果不存在或已移入回收站');
      const listed = delivery.files;
      return {
        title: delivery.title || '交付成果',
        files: listed,
        entryPath: delivery.entryPath,
        externalDependencies: delivery.externalDependencies,
        footerNote: (delivery.externalDependencies?.length ? '运行需要在线服务 · ' : '') + '已同步',
        readFile: path => global.SoduWorkAPI.readDeliveryFile(id, path),
        downloadFile: async file => {
          if (listed.length === 1 && global.SoduWorkAPI.downloadLibraryItem) await global.SoduWorkAPI.downloadLibraryItem(id, delivery?.filename || file.path);
          else downloadBlob(await global.SoduWorkAPI.readDeliveryFile(id, file.path), file.path);
        },
        downloadAll: () => global.SoduWorkAPI.downloadLibraryItem(id, delivery.filename)
      };
    });
  }

  /* Plain library items (manual uploads and other non-delivery rows) share the
     same viewer: one file whose bytes come from the item download endpoint. */
  async function openItem(item) {
    const id = String(item && item.id || '');
    if (!id) return;
    const filename = String(item.filename || item.title || '资料');
    const contentType = String(item.contentType || item.mimeType || item.type || '');
    await showViewer({ eyebrow: '资料预览', emptyMessage: '资料不存在或已移入回收站', errorTitle: '资料暂时不可用', errorHeading: '无法打开这份资料' }, async () => ({
      title: item.title || filename,
      files: [{ path: filename, contentType, role: 'primary', size: Number(item.size) || 0 }],
      entryPath: filename,
      footerNote: '来自资料库',
      readFile: async () => {
        const result = await global.SoduWorkAPI.readLibraryBinary(id);
        const blob = result && (result.blob || result.data);
        if (!blob) throw Error('读取资料内容失败');
        return blob;
      },
      downloadFile: () => global.SoduWorkAPI.downloadLibraryItem(id, filename),
      downloadAll: () => global.SoduWorkAPI.downloadLibraryItem(id, filename)
    }));
  }

  function formatSize(value) {
    const size = Number(value) || 0;
    if (size < 1024) return size + ' B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(size < 10 * 1024 ? 1 : 0) + ' KB';
    return (size / (1024 * 1024)).toFixed(1) + ' MB';
  }
  global.LibraryDelivery = { open, openItem, close: () => activeClose?.(), buildHtmlDocument, fileKind, safeMarkdown,
    textTypes, imageTypes };
})(window);
