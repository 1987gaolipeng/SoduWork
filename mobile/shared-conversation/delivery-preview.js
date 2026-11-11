(function (global) {
  'use strict';
  // Files come only from the authenticated delivery manifest, never AI text paths.
  const LIMIT = 24 * 1024 * 1024;
  const CSP = "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  const SANDBOX = 'allow-scripts';
  const TYPES = {html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2',
    ttf: 'font/ttf', mp3: 'audio/mpeg', mp4: 'video/mp4'};
  let current = null;

  function cleanPath(value) {
    const path = String(value || '');
    if (!path || path.length > 500 || /[\\\u0000-\u001f\u007f?#:%]/.test(path)
        || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) {
      throw Error('成果包含不安全或无效的文件路径');
    }
    return path;
  }

  function resolvePath(value, from) {
    const raw = String(value || '').trim();
    if (!raw || raw.startsWith('#')) return '';
    if (/^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith('//')) {
      throw Error('预览不加载外部资源：' + raw.slice(0, 80));
    }
    if (/[\\\u0000-\u001f\u007f]/.test(raw) || raw.startsWith('/')) {
      throw Error('成果引用了交付目录之外的资源');
    }
    let pathname;
    try { pathname = decodeURIComponent(raw.split(/[?#]/)[0]); }
    catch (_) { throw Error('成果资源路径编码无效'); }
    if (pathname.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(pathname)) throw Error('成果引用了交付目录之外的资源');
    const parts = cleanPath(from).split('/').slice(0, -1);
    for (const part of pathname.split('/')) {
      if (part === '.' || part === '') continue;
      if (part === '..') {
        if (!parts.length) throw Error('成果引用了交付目录之外的资源');
        parts.pop();
      } else parts.push(part);
    }
    return cleanPath(parts.join('/'));
  }

  function catalog(files) {
    if (!Array.isArray(files) || !files.length || files.length > 200) throw Error('成果文件清单无效');
    const indexed = new Map(); let size = 0;
    for (const file of files) {
      const path = cleanPath(file.path), data = String(file.data || '');
      if (indexed.has(path)) throw Error('成果中出现重复文件：' + path);
      size += data.length * 3 / 4 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
      if (size > LIMIT) throw Error('成果较大，请下载完整文件后打开');
      if (data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
        throw Error('成果文件内容编码无效：' + path);
      }
      const extension = path.split('.').pop().toLowerCase();
      indexed.set(path, {path, data, type: TYPES[extension] || 'application/octet-stream'});
    }
    return indexed;
  }

  function decode(file) {
    const bytes = Uint8Array.from(global.atob(file.data), char => char.charCodeAt(0));
    try { return new TextDecoder('utf-8', {fatal: true}).decode(bytes); }
    catch (_) { throw Error('成果不是有效的 UTF-8 文件：' + file.path); }
  }

  function previewNavigationGuard() {
    document.addEventListener('submit', function (event) { event.preventDefault(); }, true);
    document.addEventListener('click', function (event) {
      const link = event.target.closest?.('a,area');
      if (!link) return;
      // srcdoc resolves #links against the host URL. Keep navigation inside the
      // delivered document without cancelling its own menu/click handlers.
      event.preventDefault();
      const href = (link.getAttribute('href') || '').trim();
      if (!href.startsWith('#')) return;
      let name;
      try { name = decodeURIComponent(href.slice(1)); }
      catch (_) { return; }
      if (!name) { window.scrollTo(0, 0); return; }
      const target = document.getElementById(name) || document.getElementsByName(name)[0];
      target?.scrollIntoView?.({block: 'start'});
    }, true);
  }

  function build(options) {
    const files = catalog(options.files), entryPath = cleanPath(options.entryPath);
    const entry = files.get(entryPath);
    if (!entry || entry.type !== 'text/html') throw Error('找不到网页入口文件');
    // Template parsing is inert, including image requests. Only sanitized content is
    // moved into the DOMParser document; the source HTML never touches the live DOM.
    const template = global.document.createElement('template');
    template.innerHTML = decode(entry);
    const fragment = template.content;
    const requireFile = (url, from) => {
      const path = resolvePath(url, from);
      if (!path) return null;
      const file = files.get(path);
      if (!file) throw Error('成果缺少配套文件：' + path);
      return file;
    };
    const dataUrl = (url, from) => {
      if (String(url).trim().startsWith('#')) return url;
      if (/^data:(?:image\/(?:png|jpeg|gif|webp)|font\/(?:woff2?|ttf));base64,[A-Za-z0-9+/]*={0,2}$/i.test(String(url).trim())) return String(url).trim();
      const file = requireFile(url, from);
      return file ? 'data:' + file.type + ';base64,' + file.data : '';
    };
    function css(text, from) {
      if (/@import\b/i.test(text) || /\\/.test(text) || /<\/style/i.test(text)) {
        throw Error('该网页使用了暂不支持的样式引用，请下载完整成果查看');
      }
      return text.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s][^)]*))\s*\)/gi,
        (_, double, single, plain) => 'url("' + dataUrl(double ?? single ?? plain.trim(), from) + '")');
    }
    for (const el of fragment.querySelectorAll('*')) {
      const tag = el.tagName.toLowerCase();
      if (['iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal'].includes(tag)) {
        throw Error('该网页包含嵌套页面或外部组件，请下载完整成果查看');
      }
      if (tag === 'base' || tag === 'meta') { el.remove(); continue; }
      for (const attr of [...el.attributes]) {
        const key = attr.name.toLowerCase();
        if (['ping', 'action', 'formaction', 'target', 'download', 'srcdoc', 'nonce', 'integrity', 'crossorigin'].includes(key)) {
          el.removeAttribute(attr.name);
        }
        if (key === 'srcset') throw Error('该网页使用了暂不支持的响应式资源，请下载完整成果查看');
        if (key === 'style') el.setAttribute(attr.name, css(attr.value, entryPath));
      }
      if (tag === 'script') {
        if (el.type === 'module' || el.type === 'importmap') {
          throw Error('该网页需要模块运行环境，请下载完整成果查看');
        }
        if (el.hasAttribute('src')) {
          const file = requireFile(el.getAttribute('src'), entryPath);
          if (!file || file.type !== 'text/javascript') throw Error('网页脚本类型无效');
          // A data URL preserves literal </script> sequences without serializing
          // untrusted JS into HTML parser context. CSP blocks its network calls.
          el.setAttribute('src', 'data:text/javascript;base64,' + file.data);
        }
        // Original order matters when static pages split setup and interaction.
        el.removeAttribute('async');
      } else if (tag === 'link') {
        if ((el.getAttribute('rel') || '').toLowerCase() === 'stylesheet') {
          // External fonts are intentionally unavailable in isolated preview.
          // Local dependencies still must exist; never silently omit those.
          if (/^(?:https?:)?\/\//i.test((el.getAttribute('href') || '').trim())) { el.remove(); continue; }
          const file = requireFile(el.getAttribute('href'), entryPath);
          if (!file || file.type !== 'text/css') throw Error('网页样式类型无效');
          const style = global.document.createElement('style');
          style.textContent = css(decode(file), file.path);
          if (el.media) style.setAttribute('media', el.media);
          el.replaceWith(style);
        } else el.remove();
      } else if (tag === 'style') el.textContent = css(el.textContent, entryPath);
      else {
        for (const name of ['src', 'poster', 'background', 'xlink:href']) {
          if (el.hasAttribute(name)) el.setAttribute(name, dataUrl(el.getAttribute(name), entryPath));
        }
        if (el.hasAttribute('href')) {
          const href = el.getAttribute('href');
          if (tag === 'a' || tag === 'area') {
            if (!href.startsWith('#')) { el.removeAttribute('href'); el.title = '预览中不打开外部链接'; }
          } else el.setAttribute('href', dataUrl(href, entryPath));
        }
      }
    }
    const doc = new global.DOMParser().parseFromString('<!doctype html><html><head></head><body></body></html>', 'text/html');
    const charset = doc.createElement('meta'); charset.setAttribute('charset', 'utf-8');
    const policy = doc.createElement('meta'); policy.httpEquiv = 'Content-Security-Policy'; policy.content = CSP;
    const viewport = doc.createElement('meta'); viewport.name = 'viewport'; viewport.content = 'width=device-width,initial-scale=1';
    doc.head.append(charset, policy, viewport);
    const guard = doc.createElement('script');
    guard.textContent = '(' + previewNavigationGuard.toString() + ')();';
    doc.head.append(guard);
    doc.body.append(fragment);
    return '<!doctype html>\n' + doc.documentElement.outerHTML;
  }

  function close() {
    if (!current) return;
    const {root, previous, listener} = current; current = null;
    global.document.removeEventListener('keydown', listener, true);
    root.remove(); previous?.focus?.();
  }

  function open(options) {
    close();
    const document = global.document, previous = document.activeElement;
    const root = document.createElement('section');
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', '成果预览');
    root.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#fff;color:#202124;display:flex;flex-direction:column;font:14px system-ui,sans-serif;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);box-sizing:border-box;';
    const bar = document.createElement('header');
    bar.style.cssText = 'display:flex;align-items:center;gap:10px;min-height:58px;padding:6px 12px;border-bottom:1px solid #e9e9e9;flex-shrink:0;';
    const title = document.createElement('strong'); title.textContent = options.title || '成果预览';
    title.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600';
    const button = (label, text) => {
      const el = document.createElement('button'); el.type = 'button'; el.textContent = text; el.setAttribute('aria-label', label);
      el.style.cssText = 'border:0;background:#f3f3f3;color:inherit;border-radius:22px;min-width:44px;min-height:44px;padding:8px 12px;font:inherit;cursor:pointer;';
      return el;
    };
    const dismiss = button('关闭成果预览', '×'); dismiss.style.fontSize = '24px'; dismiss.onclick = close;
    const download = button('下载完整成果', '下载');
    const note = document.createElement('div');
    note.style.cssText = 'padding:8px 16px;font-size:12px;line-height:1.5;color:#666;background:#fafafa;border-bottom:1px solid #eee;flex-shrink:0;';
    note.textContent = '隔离预览 · 不连接账号与接口；外部字体与样式未加载。外链、表单及服务端功能请下载后运行。';
    const status = document.createElement('div'); status.setAttribute('role', 'status');
    status.style.cssText = 'padding:0 16px;line-height:1.6;font-size:13px;';
    download.disabled = typeof options.onDownload !== 'function';
    download.onclick = async () => {
      download.disabled = true; download.textContent = '下载中'; status.textContent = '';
      try { await options.onDownload(); }
      catch (error) { status.textContent = error.message || '下载失败，请重试'; }
      finally { download.disabled = false; download.textContent = '下载'; }
    };
    bar.append(dismiss, title, download); root.append(bar, note, status);
    let failure = '';
    try {
      const html = build(options), frame = document.createElement('iframe');
      frame.title = '成果网页'; frame.setAttribute('sandbox', SANDBOX);
      frame.setAttribute('referrerpolicy', 'no-referrer'); frame.setAttribute('credentialless', '');
      frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; payment 'none'; usb 'none'");
      frame.style.cssText = 'width:100%;flex:1;min-height:0;border:0;background:white;';
      frame.srcdoc = html; root.append(frame);
    } catch (error) {
      failure = error.message || '成果文件不完整';
      status.textContent = '无法完整预览：' + failure + '。你仍可以下载原始成果。';
      status.style.padding = '32px 20px';
    }
    const listener = event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        const controls = [...root.querySelectorAll('button:not(:disabled),iframe')];
        if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
      }
    };
    current = {root, previous, listener}; document.body.append(root);
    document.addEventListener('keydown', listener, true); dismiss.focus();
    return failure ? {ok: false, reason: failure} : {ok: true};
  }
  const api = {open, close, build};
  global.SoduWorkMobileDeliveryPreview = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = {build, catalog, cleanPath, resolvePath, CSP, SANDBOX};
})(typeof window === 'undefined' ? globalThis : window);
