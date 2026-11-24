'use strict';

// Runs in an isolated JavaScript world with no Node or application bridge.
// The shared DOM carries only visuals; the nonce and handlers stay isolated.
function annotationPage(config) {
  const KEY = '__soduWorkbenchInspectorCleanup';
  if (window[KEY] && window[KEY].update) return window[KEY].update(config);
  try { if (typeof window[KEY] === 'function') window[KEY](); } catch (_) {}
  const host = document.createElement('div');
  host.id = '__soduwork-annotations';
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host{--note-accent:#316ee4;--note-accent-hover:#2863d1;--note-ink:#263449;--note-muted:#66758a;--note-line:#e5eaf1;--note-wash:#f6f8fc;--note-surface:#fff;font:14.5px/1.5 "Alibaba PuHuiTi","Alibaba Sans","Segoe UI Variable","Segoe UI",system-ui,sans-serif;color:var(--note-ink);color-scheme:light}
    *{box-sizing:border-box} [hidden]{display:none!important}
    .outline{position:fixed;border:1.5px solid var(--note-accent);background:#3478f60a;box-shadow:0 0 0 1px #ffffff80 inset;pointer-events:none;border-radius:5px}
    button{appearance:none;border:1px solid transparent;border-radius:9px;background:var(--note-wash);color:var(--note-ink);padding:7px 12px;font:500 14.5px/1.5 "Alibaba PuHuiTi","Alibaba Sans","Segoe UI Variable","Segoe UI",system-ui,sans-serif;cursor:pointer;user-select:none;transition:background-color 140ms,border-color 140ms,box-shadow 140ms,color 140ms}
    button:focus-visible{outline:2px solid var(--note-accent);outline-offset:3px}
    .pin{position:fixed;display:grid;place-items:center;width:26px;height:26px;padding:0;border:2px solid var(--note-surface);border-radius:9px 9px 9px 3px;background:var(--note-accent);color:#fff;box-shadow:0 0 0 1px #2457a61c,0 2px 4px #18386926,0 5px 12px #18386918,inset 0 1px 0 #ffffff30;pointer-events:auto;font-weight:650;line-height:1;font-variant-numeric:tabular-nums}
    .pin:hover{background:var(--note-accent-hover);box-shadow:0 0 0 3px #3478f61c,0 3px 8px #18386926,inset 0 1px 0 #ffffff30}
    .pin:active{background:#225cc8}
    .editor{position:fixed;width:min(356px,calc(100vw - 20px));max-height:calc(100vh - 20px);overflow:auto;padding:16px;background:var(--note-surface);color:var(--note-ink);font:14.5px/1.5 "Alibaba PuHuiTi","Alibaba Sans","Segoe UI Variable","Segoe UI",system-ui,sans-serif;border:1px solid #dfe5ee;border-radius:16px;box-shadow:0 2px 5px #182a4510,0 12px 32px #182a451c,0 28px 64px #182a4512;pointer-events:auto;cursor:default}
    .editor header{display:flex;gap:10px;align-items:center;margin-bottom:13px;min-height:28px}
    .editor header::before{content:"";flex:0 0 28px;width:28px;height:28px;border:1px solid #3478f617;border-radius:9px;background:#3478f60c url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%233478f6' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M7 18 3.5 21V6a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H7Z'/%3E%3Cpath d='M8 8h8M8 12h5'/%3E%3C/svg%3E") center/16px no-repeat}
    .editor header span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;letter-spacing:.1px}
    .editor .close{display:grid;place-items:center;flex:0 0 28px;width:28px;height:28px;padding:0;border-radius:8px;background:transparent;color:var(--note-muted);font:400 22px/1 "Segoe UI",sans-serif}
    .editor .close:hover{background:#eef1f6;color:var(--note-ink)}
    textarea{display:block;width:100%;min-height:96px;max-height:160px;resize:vertical;padding:11px 12px;border:1px solid var(--note-line);border-radius:10px;font:14.5px/1.65 "Alibaba PuHuiTi","Alibaba Sans","Segoe UI Variable","Segoe UI",system-ui,sans-serif;color:var(--note-ink);background:var(--note-wash);outline:none;caret-color:var(--note-accent);cursor:text;transition:border-color 140ms,background-color 140ms,box-shadow 140ms}
    textarea::placeholder{color:var(--note-muted);opacity:1}
    textarea:focus{background:var(--note-surface);border-color:#3478f685;box-shadow:0 0 0 3px #3478f610}
    footer{display:grid;grid-template-columns:1fr auto;align-items:center;gap:10px;margin-top:12px}
    small{grid-column:1/-1;color:var(--note-muted);font-size:14.5px;line-height:1.4}
    .delete{grid-column:1;justify-self:start;background:transparent;color:#7b6370;padding-inline:10px}
    .delete:hover{background:#fff1f2;color:#b43a50;border-color:#f5dce2}
    .save{grid-column:2;background:var(--note-accent);color:#fff;border-color:#2865d6;box-shadow:inset 0 1px 0 #ffffff24,0 1px 2px #1740871a;font-weight:600;padding-inline:14px;white-space:nowrap}
    .save:hover{background:var(--note-accent-hover);border-color:#245bc6;box-shadow:inset 0 1px 0 #ffffff24,0 2px 5px #17408724}
    .save:active{background:#225cc8;box-shadow:inset 0 1px 2px #173c7526}
    @media(prefers-reduced-motion:reduce){button,textarea{transition:none}}
  </style><div class="outline" hidden></div><div class="pins"></div>
  <section class="editor" role="dialog" aria-label="网页注释" hidden><header><span></span><button type="button" class="close" aria-label="取消注释">×</button></header>
  <textarea maxlength="2000" placeholder="希望这里如何修改？" aria-label="注释内容"></textarea><footer><small>Ctrl / ⌘ + Enter 保存</small><button type="button" class="delete">删除</button><button type="button" class="save">保存注释 ✓</button></footer></section>`;
  document.documentElement.appendChild(host);
  const outline = shadow.querySelector('.outline'), pins = shadow.querySelector('.pins');
  const editor = shadow.querySelector('.editor'), area = shadow.querySelector('textarea');
  let state = config, hovered = null, editing = null, frame = 0;
  const send = payload => console.info(state.prefix + JSON.stringify({ ...payload, nonce: state.nonce }));
  // The overlay is a single native focus owner while the editor is open. A
  // previous implementation re-focused the WebContentsView on every
  // pointer/blur event; those asynchronous focus calls competed with the
  // textarea and made its caret and border flicker while typing.
  const currentNotes = () => (state.annotations || []).filter(note => note.url === location.href);
  const lookup = selector => { try { return document.querySelector(selector); } catch (_) { return null; } };
  const visibleRect = element => {
    if (!element || !element.isConnected) return null;
    const r = element.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth ? r : null;
  };
  function selector(element) {
    const parts = [];
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      if (node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) {
        parts.unshift('#' + CSS.escape(node.id)); break;
      }
      let part = node.tagName.toLowerCase();
      if (node.parentElement) {
        const siblings = [...node.parentElement.children].filter(child => child.tagName === node.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
    }
    return parts.join(' > ');
  }
  function info(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll('script,style,#__soduwork-annotations').forEach(node => node.remove());
    for (const node of [clone, ...clone.querySelectorAll('*')]) {
      for (const attr of [...node.attributes]) {
        if (/^on|^data-soduwork-|^(?:value|nonce)$/i.test(attr.name)) node.removeAttribute(attr.name);
      }
    }
    return { url: location.href, title: document.title, selector: selector(element), tag: element.tagName.toLowerCase(),
      text: String(clone.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500), html: clone.outerHTML.slice(0, 1600) };
  }
  function draw() {
    frame = 0;
    const r = state.enabled && !editing && visibleRect(hovered);
    outline.hidden = !r;
    if (r) Object.assign(outline.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    const notes = currentNotes();
    const existing = new Map([...pins.children].map(pin => [pin.dataset.id, pin]));
    for (const note of notes) {
      let pin = existing.get(note.id); existing.delete(note.id);
      if (!pin) { pin = document.createElement('button'); pin.type = 'button'; pin.className = 'pin'; pin.dataset.id = note.id; pins.appendChild(pin); }
      pin.textContent = String(note.number);
      pin.title = '注释 ' + note.number + '：' + note.comment;
      pin.setAttribute('aria-label', pin.title);
      const rect = visibleRect(lookup(note.selector));
      pin.hidden = !rect;
      if (rect) Object.assign(pin.style, { left: Math.max(2, Math.min(innerWidth - 28, rect.left - 8)) + 'px', top: Math.max(2, rect.top - 14) + 'px' });
    }
    existing.forEach(pin => pin.remove());
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(draw); }
  function closeEditor() {
    editing = null; editor.hidden = true; hovered = null;
    // Keep the full-screen inspector transparent while picking page elements,
    // but make it a real hit-test surface while the editor is open. Chromium
    // can otherwise let a click on the shadow textarea pass through to the
    // hosted page, leaving keyboard input on the page behind the editor.
    host.style.pointerEvents = 'none';
    schedule();
  }
  function openEditor(element, note) {
    if (editing && !save()) return;
    if (!note && currentNotes().length >= 40) return;
    const data = note || info(element);
    editing = { ...data };
    area.value = data.comment || '';
    editor.querySelector('header span').textContent = note ? '编辑注释 #' + data.number : '添加注释 · ' + data.tag;
    editor.querySelector('.delete').hidden = !note;
    editor.hidden = false; outline.hidden = true;
    host.style.pointerEvents = 'auto';
    const rect = element && element.getBoundingClientRect();
    const x = rect ? rect.left : 20, y = rect ? rect.bottom + 12 : 20;
    editor.style.left = Math.max(10, Math.min(innerWidth - editor.offsetWidth - 10, x)) + 'px';
    editor.style.top = Math.max(10, Math.min(innerHeight - editor.offsetHeight - 10, y)) + 'px';
    try { area.focus({ preventScroll: true }); } catch (_) { area.focus(); }
  }
  function save() {
    if (!editing) return true;
    const comment = area.value.trim();
    if (!comment) { area.focus(); return false; }
    send({ action: 'upsert', ...editing, comment });
    closeEditor(); return true;
  }
  function target(event) { return event.composedPath().find(node => node instanceof Element && node !== host); }
  function isOverlay(event) {
    // Isolated-world events can be retargeted to the shadow host. Keep the
    // fallback checks so an editor click is never treated as a page click.
    return event.composedPath().includes(host) || event.target === host || host.contains(event.target);
  }
  function over(event) {
    if (!state.enabled || editing || isOverlay(event)) return;
    hovered = target(event); schedule();
  }
  function click(event) {
    if (!state.enabled || isOverlay(event) || !event.isTrusted) return;
    const element = target(event); if (!element) return;
    event.preventDefault(); event.stopImmediatePropagation();
    openEditor(element);
  }
  shadow.addEventListener('click', event => {
    event.stopPropagation();
    if (!event.isTrusted) return;
    const button = event.target.closest('button'); if (!button) return;
    if (button.classList.contains('save')) save();
    else if (button.classList.contains('close')) closeEditor();
    else if (button.classList.contains('delete')) { send({ action: 'remove', id: editing.id }); closeEditor(); }
    else if (button.classList.contains('pin')) {
      const note = currentNotes().find(row => row.id === button.dataset.id);
      if (note) openEditor(lookup(note.selector), note);
    }
  });
  function keydown(event) {
    if (!event.isTrusted || event.isComposing || (!state.enabled && !editing)) return;
    if (editing && (event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault(); event.stopImmediatePropagation(); save();
    } else if (event.key === 'Escape') {
      if (editing) closeEditor();
      else { state.enabled = false; send({ action: 'exit' }); schedule(); }
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }
  document.addEventListener('pointermove', over, true);
  document.addEventListener('click', click, true);
  document.addEventListener('keydown', keydown, true);
  document.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  const cleanup = () => {
    document.removeEventListener('pointermove', over, true); document.removeEventListener('click', click, true);
    document.removeEventListener('keydown', keydown, true); document.removeEventListener('scroll', schedule, true);
    window.removeEventListener('resize', schedule); observer.disconnect(); cancelAnimationFrame(frame);
    host.remove(); delete window[KEY];
  };
  cleanup.update = next => { state = next; if (!state.enabled) closeEditor(); schedule(); return true; };
  window[KEY] = cleanup;
  schedule(); return true;
}

function script(config) { return '(' + annotationPage.toString() + ')(' + JSON.stringify(config) + ')'; }
module.exports = { script };
