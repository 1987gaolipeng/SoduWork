/* Markdown rendering state and incremental DOM patching for one conversation. */
(function (global) {
  'use strict';
  function create(ctx, repaint) {
  const richCache = new Map();
  let cacheBytes = 0, cacheRef = null, cacheRefMode = '';
  let liveMarkdownKey = '', liveMarkdownSource = null, liveMarkdownHtml = '', liveMarkdownAt = 0, liveMarkdownMode = '';
  let flushTimer = 0;
  function reset() {
    richCache.clear(); cacheBytes = 0; cacheRef = null; cacheRefMode = '';
    liveMarkdownKey = ''; liveMarkdownSource = null; liveMarkdownHtml = ''; liveMarkdownAt = 0; liveMarkdownMode = '';
    if (flushTimer) { global.clearTimeout(flushTimer); flushTimer = 0; }
  }
  function markdownMode() { return global.marked && typeof global.marked.parse === 'function' && global.DOMPurify && typeof global.DOMPurify.sanitize === 'function' ? 'marked' : 'plain'; }
  function rich(s) {
    const src = String(s == null ? '' : s);
    const mode = markdownMode();
    if (cacheRef !== ctx._ref || cacheRefMode !== mode) {
      richCache.clear(); cacheBytes = 0; cacheRef = ctx._ref; cacheRefMode = mode;
    }
    if (richCache.has(src)) return richCache.get(src);
    const html = renderRich(src);
    const bytes = src.length + html.length;
    if (bytes <= 500000 && (mode !== 'marked' || html.includes('<div class="nmd">'))) {
      richCache.set(src, html); cacheBytes += bytes;
      while (richCache.size > 160 || cacheBytes > 2000000) {
        const [key, value] = richCache.entries().next().value;
        cacheBytes -= key.length + value.length; richCache.delete(key);
      }
    }
    return html;
  }
  function renderRich(src) {
    try {
      if (markdownMode() === 'marked') {
        const parsed = global.marked.parse(src, { gfm: true, breaks: false });
        const clean = global.ChatOutputLinks
          ? global.ChatOutputLinks.sanitize(parsed, global.DOMPurify)
          // Keep the same app-DOM boundary if the output helper is unavailable.
          : global.DOMPurify.sanitize(parsed, {
            FORBID_TAGS: ['style', 'link', 'meta', 'base', 'video', 'audio', 'source', 'picture'], FORBID_ATTR: ['style'],
          });
        return '<div class="nmd">' + (global.ChatMedia ? global.ChatMedia.prepare(clean, ctx._ref) : clean) + '</div>';
      }
    } catch (e) { /* Fall back to safe plain text if rendering dependencies fail. */ }
    return _richPlain(src);
  }
  function _richPlain(s) {
    return String(s == null ? '' : s).split('\n').map((line) => {
      const raw = line.trim();
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(raw)) return '<span class="nrule"></span>';
      let cls = '';
      let body = line;
      const h = raw.match(/^(#{1,6})\s+(.*)$/);
      if (h) { cls = ' class="nh"'; body = h[2]; }
      const li = body.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
      if (li) { cls = ' class="nli"'; body = li[3]; }
      let html = ctx.esc(body)
        .replace(/\x60([^\x60]+)\x60/g, (_m, c) => '<code>' + c + '</code>')
        .replace(/\*\*([^*]+)\*\*/g, (_m, c) => '<b>' + c + '</b>');
      if (li) html = '<span class="nbul">' + (/\d/.test(li[2]) ? ctx.esc(li[2]) : '·') + '</span>' + html;
      /* Each line is already a block; avoid extra newlines that double spacing around headings and lists. */
      const c = cls ? cls.replace('class="', 'class="nline ') : ' class="nline"';
      return '<span' + c + '>' + html + '</span>';
    }).join('');
  }
  function _streamText(s) {
    const text = String(s == null ? '' : s);
    // Keep the prefix: slicing a sliding tail can remove a fence/table header,
    // reinterpret the whole response, and collapse thousands of pixels.
    const visible = text;
    const mode = markdownMode();
    const key = String(ctx._ref || '') + ':' + String(ctx._liveTextKey || '');
    const now = Date.now();
    if (mode === 'marked') {
      if (liveMarkdownKey !== key || liveMarkdownMode !== mode) {
        liveMarkdownKey = key; liveMarkdownMode = mode; liveMarkdownSource = null;
        liveMarkdownHtml = ''; liveMarkdownAt = 0;
      }
      if (liveMarkdownSource === visible) return liveMarkdownHtml;
      // Short replies paint smoothly; long responses get a bounded parse rate.
      // A deferred flush also paints the last delta when the provider pauses.
      const interval = Math.min(320, 50 + Math.floor(visible.length / 24000) * 30);
      const remaining = interval - (now - liveMarkdownAt);
      if (liveMarkdownHtml && remaining > 0) {
        if (!flushTimer && repaint && typeof global.setTimeout === 'function') {
          flushTimer = global.setTimeout(() => { flushTimer = 0; repaint(); }, remaining + 1);
        }
        return liveMarkdownHtml;
      }
      if (flushTimer) { global.clearTimeout(flushTimer); flushTimer = 0; }
      liveMarkdownSource = visible;
      liveMarkdownAt = now;
      liveMarkdownHtml = renderRich(visible);
      return liveMarkdownHtml;
    }
    liveMarkdownKey = key; liveMarkdownMode = mode; liveMarkdownSource = visible;
    liveMarkdownHtml = ''; liveMarkdownAt = now;
    return ctx.esc(visible).replace(/\n/g, '<br>');
  }

  /* Update a streaming text block in place. Replacing all descendants on every
     provider event briefly removes the node under the mouse, so Chromium has
     to resolve the cursor against the parent and then the new child again.
     Keeping same-kind nodes (especially text nodes and the current paragraph)
     makes the hit target and the selection anchor stable while the answer grows. */
  function _patchStreamNode(current, next) {
    if (global.ChatMedia?.same(current, next)) return;
    if (current?.dataset?.chatMedia || next?.dataset?.chatMedia) { current.replaceWith(next); return; }
    if (!current || !next || current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) return;
    if (current.nodeType !== 1) {
      if (current.nodeValue !== next.nodeValue) {
        if (current.nodeType === 3 && next.nodeValue.startsWith(current.nodeValue)) {
          current.appendData(next.nodeValue.slice(current.nodeValue.length));
        } else current.nodeValue = next.nodeValue;
      }
      return;
    }
    for (const attr of Array.from(current.attributes)) {
      if (!next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
    }
    for (const attr of Array.from(next.attributes)) {
      if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
    }
    const old = Array.from(current.childNodes), desired = Array.from(next.childNodes);
    desired.forEach((wanted, index) => {
      const node = old[index];
      if (!node) current.appendChild(wanted);
      else if (node.nodeType !== wanted.nodeType || node.nodeName !== wanted.nodeName) node.replaceWith(wanted);
      else _patchStreamNode(node, wanted);
    });
    old.slice(desired.length).forEach(node => node.remove());
  }
  function _ensureHlCss() {
    _inject('hljsCss', global.__HLJS_CSS);      // Syntax highlighting.
    _inject('d2hCss', global.__D2H_CSS);        // GitHub-style diff2html theme.
  }

  function _inject(id, css) {
    if (document.getElementById(id) || !css) return;
    const st = document.createElement('style');
    st.id = id;
    st.textContent = css;
    document.head.appendChild(st);
  }

    return { rich, _richPlain, _streamText, _patchStreamNode, _ensureHlCss, _inject, reset };
  }
  global.ChatMarkdown = { create };
})(window);
