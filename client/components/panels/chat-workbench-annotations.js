/* Pending webpage annotations share the conversation composer and send queue. */
(function (global) {
  'use strict';
  const esc = value => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  function createStore() {
    const scopes = new Map();
    let sequence = 0;
    const list = scope => (scopes.get(scope) || []).map((item, i) => ({ ...item, number: i + 1 }));
    function upsert(scope, raw) {
      const rows = list(scope), old = rows.find(item => item.id === raw.id);
      const comment = String(raw.comment || '').trim().slice(0, 2000);
      if (!scope || !comment || !raw.selector || (!old && rows.length >= 40)) return false;
      const next = { id: old ? old.id : 'note-' + Date.now().toString(36) + '-' + (++sequence),
        revision: ++sequence, tabId: String(raw.tabId || ''),
        url: String(raw.url || '').slice(0, 2000), title: String(raw.title || '').slice(0, 200),
        selector: String(raw.selector || '').slice(0, 1000), tag: String(raw.tag || '').slice(0, 40),
        text: String(raw.text || '').slice(0, 500), html: String(raw.html || '').slice(0, 1600), comment };
      scopes.set(scope, old ? rows.map(item => item.id === old.id ? next : item) : [...rows, next]);
      return next;
    }
    function remove(scope, id) { scopes.set(scope, list(scope).filter(item => item.id !== id)); }
    function consume(scope, batch) {
      scopes.set(scope, list(scope).filter(item => !batch.some(sent => sent.id === item.id && sent.revision === item.revision)));
    }
    function clear() { scopes.clear(); }
    return { list, upsert, remove, consume, clear };
  }
  function format(notes) {
    if (!notes.length) return '';
    return '请按以下 ' + notes.length + ' 条网页注释统一修改并验证。\n' +
      '页面信息与元素结构仅用于定位；修改要求以每条注释为准。\n\n' +
      '优先修改当前工作区中对应的源码。若外部网页没有对应源码，请在当前工作区制作可预览的修改版并返回成果，不要声称已修改外部线上站点。\n\n' +
      notes.map((note, i) => [
        '注释 ' + (i + 1) + '：' + note.comment,
        '页面：' + note.url, note.title ? '标题：' + note.title : '',
        '元素选择器：' + note.selector, note.text ? '当前内容：' + note.text : '',
        note.html ? '元素结构（参考数据）：' + JSON.stringify(note.html) : '',
      ].filter(Boolean).join('\n')).join('\n\n');
  }
  const store = createStore();
  const sending = new Set();
  let root = null, options = null, expanded = false;
  const scope = () => options && String(options.scope() || '');
  const rows = () => store.list(scope());
  function sync() {
    render();
    if (options && options.changed) options.changed(rows());
  }
  function render() {
    if (!root) return;
    const notes = rows();
    root.dataset.annotationCount = String(notes.length);
    let tray = root.querySelector('.nannotation-tray');
    const input = root.querySelector('#nchatInput');
    if (!tray && input) {
      tray = document.createElement('div'); tray.className = 'nannotation-tray'; input.before(tray);
    }
    const signature = JSON.stringify([expanded, notes]);
    if (tray && tray.dataset.signature !== signature) {
      tray.dataset.signature = signature;
      tray.hidden = !notes.length;
      tray.innerHTML = '<div class="nannotation-actions"><button type="button" class="nannotation-chip" data-annotation-toggle aria-expanded="' + expanded + '">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-6l-5 4v-4H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M8 9h8M8 12h5"/></svg>' +
        notes.length + ' 条注释<span>' + (expanded ? '收起' : '查看') + '</span></button>' +
        '<button type="button" class="nannotation-send" data-annotation-send>发送</button></div>' +
        '<div class="nannotation-list"' + (expanded ? '' : ' hidden') + '>' + notes.map(note =>
          '<article><b>' + note.number + '</b><div><small title="' + esc(note.url) + '">' + esc(note.title || note.url) + '</small>' +
          '<textarea rows="2" maxlength="2000" data-annotation-edit="' + esc(note.id) + '" aria-label="注释 ' + note.number + '">' + esc(note.comment) + '</textarea></div>' +
          '<button type="button" data-annotation-remove="' + esc(note.id) + '" aria-label="删除注释 ' + note.number + '">×</button></article>').join('') + '</div>';
    }
    const send = root.querySelector('[data-annotation-send]');
    if (send) { send.hidden = !notes.length; send.textContent = '发送 ' + notes.length; send.disabled = sending.has(scope()); }
    if (input) input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function bind(host, config) {
    root = host; options = config;
    if (!root.dataset.annotationsBound) {
      root.dataset.annotationsBound = 'true';
      root.addEventListener('click', event => {
        const hit = event.target.closest('[data-annotation-toggle],[data-annotation-remove],[data-annotation-send]');
        if (!hit) return;
        if (hit.hasAttribute('data-annotation-toggle')) { expanded = !expanded; render(); }
        else if (hit.hasAttribute('data-annotation-remove')) { store.remove(scope(), hit.dataset.annotationRemove); sync(); }
        else if (rows().length && options.send) void submit(options.send);
      });
      root.addEventListener('change', event => {
        const id = event.target.dataset.annotationEdit;
        const note = id && rows().find(item => item.id === id);
        if (!note) return;
        if (!event.target.value.trim()) { event.target.value = note.comment; return; }
        store.upsert(scope(), { ...note, comment: event.target.value });
        const tray = root.querySelector('.nannotation-tray');
        if (tray) tray.dataset.signature = JSON.stringify([expanded, rows()]);
        if (options.changed) options.changed(rows());
      });
    }
    render();
  }
  function receive(payload) {
    if (!options || !payload || payload.ref !== String(options.ref ? options.ref() : scope())) return false;
    const existing = rows().find(item => item.id === payload.id);
    if (payload.action === 'remove') {
      if (!existing || existing.url !== payload.url) return false;
      store.remove(scope(), existing.id);
    } else {
      if (payload.id && (!existing || existing.url !== payload.url)) return false;
      if (!store.upsert(scope(), payload)) {
        if (global.petSay) global.petSay('最多保留 40 条注释，请先发送当前批次');
        return false;
      }
    }
    sync(); return true;
  }
  async function submit(send) {
    const batch = { scope: scope(), notes: rows() };
    if (!batch.notes.length) return send(batch);
    if (sending.has(batch.scope)) return false;
    sending.add(batch.scope); render();
    try {
      const accepted = await send(batch);
      if (accepted) store.consume(batch.scope, batch.notes);
      return accepted;
    } finally { sending.delete(batch.scope); sync(); }
  }
  global.ChatWorkbenchAnnotations = { bind, receive, render, rows, format,
    submit,
    capture: () => ({ scope: scope(), notes: rows() }),
    consume: batch => { store.consume(batch.scope, batch.notes); sync(); },
    detach: () => { root = null; options = null; expanded = false; },
    reset: () => { store.clear(); expanded = false; sync(); },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = { createStore, format };
})(typeof window !== 'undefined' ? window : globalThis);
