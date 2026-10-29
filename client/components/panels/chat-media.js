/* Explicit conversation media; ordinary URLs and raw HTML remain inert. */
(function (global) {
  'use strict';
  const tr = value => global.SoduWorkI18n?.translateText(value) || value;
  function url(value) {
    if (typeof value !== 'string' || value.length > 16384) return '';
    try {
      const parsed = new URL(value);
      return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : '';
    } catch (_) { return ''; }
  }
  function spec(value) {
    if (!value || !['image', 'gallery', 'video'].includes(value.type) || !Array.isArray(value.items) ||
        !value.items.length || value.items.length > 100 || (value.type !== 'gallery' && value.items.length !== 1)) return null;
    const items = value.items.map(item => ({ url: url(item?.url), title: String(item?.title || '').slice(0, 240) }));
    return items.every(item => item.url) ? { type: value.type, items } : null;
  }
  function declaration(text) {
    const source = String(text || '').trim();
    try { return spec(JSON.parse(source)); } catch (_) { /* One extra quote-escape layer is a model formatting error. */ }
    if (!/^\{\s*\\"/.test(source)) return null;
    try { return spec(JSON.parse(source.replace(/\\"/g, '"'))); } catch (_) { return null; }
  }
  function card(doc, type, title) {
    const figure = doc.createElement('figure'); figure.className = 'nmedia-item nmedia-' + type;
    figure.dataset.mediaState = 'idle';
    const frame = doc.createElement('div'); frame.className = 'nmedia-frame';
    const media = doc.createElement(type === 'video' ? 'video' : 'img');
    media.setAttribute('aria-label', title || (type === 'video' ? 'Video' : 'Image'));
    media.referrerPolicy = 'no-referrer';
    if (type === 'video') {
      media.muted = true; media.defaultMuted = true; media.autoplay = true; media.loop = true;
      media.playsInline = true; media.preload = 'metadata'; media.setAttribute('muted', '');
      media.setAttribute('autoplay', ''); media.setAttribute('loop', ''); media.setAttribute('playsinline', '');
    } else { media.alt = title; media.decoding = 'async'; }
    const status = doc.createElement('span'); status.className = 'nmedia-status'; status.setAttribute('role', 'status');
    const retry = doc.createElement('button'); retry.type = 'button'; retry.className = 'nmedia-retry';
    retry.textContent = tr('重新加载'); retry.hidden = true;
    frame.append(media, status, retry); figure.append(frame);
    return figure;
  }
  function prepare(html, scope) {
    if (!html.includes('soduwork-media')) return html;
    // The Markdown owner has already sanitized this HTML. Parse it in an inert
    // document; construct every new media node with DOM/text APIs below.
    const root = new DOMParser().parseFromString(html, 'text/html').body;
    root.querySelectorAll('code').forEach(code => {
      const fenced = code.parentElement.tagName === 'PRE';
      if (fenced && !code.classList.contains('language-soduwork-media')) return;
      const inline = !fenced && code.textContent.match(/^soduwork-media\s+([\s\S]+)$/);
      if (!fenced && !inline) return;
      // JSON only: never execute markup, scripts or model-provided styles.
      const data = declaration(fenced ? code.textContent : inline[1]);
      if (!data) return;
      const group = document.createElement('div'); group.className = 'nmedia-group';
      if (data.type === 'gallery' && data.items.length > 1) group.classList.add('nmedia-grid');
      group.dataset.chatMedia = JSON.stringify([String(scope || ''), data]);
      data.items.forEach(item => {
        const figure = card(document, data.type === 'video' ? 'video' : 'image', item.title);
        figure.dataset.mediaUrl = item.url;
        group.append(figure);
      });
      if (fenced) code.parentElement.replaceWith(group);
      else if (code.parentElement.tagName === 'P') {
        // Keep block media outside the surrounding paragraph and preserve both
        // prose sides; a div inside p would be rearranged on the next DOM parse.
        const paragraph = code.parentElement, tail = paragraph.cloneNode(false);
        while (code.nextSibling) tail.append(code.nextSibling);
        code.remove(); paragraph.after(group);
        if (tail.hasChildNodes()) group.after(tail);
        if (!paragraph.hasChildNodes()) paragraph.remove();
      } else code.replaceWith(group);
    });
    return root.innerHTML;
  }
  const bindings = new WeakMap();
  const videos = new Set();
  let observer, monitor;
  function play(video) {
    if (!video.isConnected || document.hidden || !bindings.get(video)?.visible) { video.pause(); return; }
    if (!video.src || video.closest('[data-media-state="error"]')) return;
    if (!video.paused) return;
    const pending = video.play();
    pending?.catch(() => {
      if (!video.isConnected) return;
      const figure = video.closest('.nmedia-item');
      figure.dataset.mediaState = 'paused';
      figure.querySelector('.nmedia-retry').hidden = false;
    });
  }
  function track(video) {
    videos.add(video);
    if (!observer && global.IntersectionObserver) observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        const state = bindings.get(entry.target); if (state) state.visible = entry.isIntersecting;
        play(entry.target);
      });
    }, { threshold: 0.01 });
    if (observer) observer.observe(video);
    if (!monitor) {
      const sweep = () => videos.forEach(item => {
        if (!item.isConnected) { item.pause(); observer?.unobserve(item); videos.delete(item); }
        else play(item);
      });
      monitor = new MutationObserver(sweep); monitor.observe(document.body, { childList: true, subtree: true });
      document.addEventListener('visibilitychange', sweep);
    }
  }
  function load(figure, source) {
    const media = figure.querySelector('img,video');
    if (!media || bindings.has(media)) return;
    const state = { visible: !global.IntersectionObserver }; bindings.set(media, state);
    figure.dataset.mediaState = 'loading';
    const status = figure.querySelector('.nmedia-status'), retry = figure.querySelector('.nmedia-retry');
    const failed = () => {
      if (!figure.isConnected) return;
      figure.dataset.mediaState = 'error'; status.textContent = tr('媒体加载失败'); retry.hidden = false;
    };
    const ready = () => {
      if (!figure.isConnected) return;
      figure.dataset.mediaState = 'ready'; status.textContent = ''; retry.hidden = true;
      if (media.tagName === 'VIDEO') play(media);
    };
    media.addEventListener(media.tagName === 'VIDEO' ? 'loadeddata' : 'load', ready);
    if (media.tagName === 'VIDEO') media.addEventListener('play', () => {
      if (document.hidden || !state.visible || !media.isConnected) media.pause();
    });
    media.addEventListener('error', failed);
    retry.onclick = event => {
      event.preventDefault(); event.stopPropagation();
      if (figure.dataset.mediaState === 'paused') { figure.dataset.mediaState = 'ready'; retry.hidden = true; play(media); }
      else { media.removeAttribute('src'); figure.dataset.mediaState = 'loading'; status.textContent = ''; retry.hidden = true; assign(); }
    };
    const assign = () => Promise.resolve().then(source).then(src => {
      if (!figure.isConnected) return;
      if (!src) throw Error('Unavailable media');
      media.src = src;
      if (media.tagName === 'VIDEO') { media.load(); play(media); }
    }).catch(failed);
    if (media.tagName === 'VIDEO') track(media);
    assign();
  }
  function open(figure) {
    const target = url(figure.dataset.mediaUrl);
    if (target) global.ChatWorkbench?.openLink(target, { mediaType: figure.querySelector('video') ? 'video' : 'image' });
  }
  function hydrate(root) {
    root.querySelectorAll('.nmedia-group .nmedia-item').forEach(figure => {
      const src = url(figure.dataset.mediaUrl); if (!src) return;
      load(figure, () => src);
      const media = figure.querySelector('img,video');
      if (media && !media.dataset.mediaBound) {
        media.dataset.mediaBound = 'true'; media.tabIndex = 0; media.setAttribute('role', 'button');
        media.onclick = event => { event.preventDefault(); event.stopPropagation(); open(figure); };
        media.onkeydown = event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); open(figure); } };
      }
    });
  }
  // Keep loaded pixels/playback while Markdown text around the declaration grows.
  function same(current, next) {
    return current?.dataset?.chatMedia && current.dataset.chatMedia === next?.dataset?.chatMedia;
  }
  const api = { url, spec, declaration, card, prepare, hydrate, load, same };
  global.ChatMedia = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
