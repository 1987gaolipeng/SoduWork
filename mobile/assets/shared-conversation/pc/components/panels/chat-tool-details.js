/* On-demand receipt loading. The transcript owns summaries; the workbench owns files. */
(function (global) {
  'use strict';
  const states = new WeakMap();
  const listeners = new WeakMap();
  const MAX_ENTRIES = 16, MAX_BYTES = 16 * 1024 * 1024;
  const keyOf = tool => JSON.stringify([String(tool.id), String(tool.detailVersion || '')]);
  const scopeOf = ctx => JSON.stringify([ctx._ref, ctx._viewEpoch, ctx._draftScopeEpoch, ctx._draftOwnerScope?.()]);
  const current = (ctx, id) => ctx._snap?.tools?.find(tool => String(tool.id) === String(id));
  const nodeOf = (ctx, id) => global.ChatDomPatch?.findDataNode(ctx._mount?.(), 'data-tool-node', id);
  const loadingHtml = '<div class="nd-skip" role="status">正在读取详情…</div>';
  const errorHtml = id => '<div class="nd-skip" role="status">详情暂时无法读取 · <button type="button" data-tool-detail-retry="' +
    global.ChatTools.esc(id) + '">重试</button></div>';
  function stateFor(ctx) {
    const scope = scopeOf(ctx);
    let state = states.get(ctx);
    if (!state || state.scope !== scope) {
      state = { scope, entries: new Map(), pending: new Map(), bytes: 0, selection: 0 };
      states.set(ctx, state);
    }
    const root = ctx._mount?.(), prior = listeners.get(ctx);
    if (root?.addEventListener && prior?.root !== root) {
      prior?.root.removeEventListener('click', prior.cancel, true);
      const cancel = event => {
        if (!event.target.closest('[data-wb-close],[data-wb-tab],[data-wb-tab-close],[data-wb-new],[data-wb-file],[data-wb-service],[data-wb-files],[data-open-app]')) return;
        const active = states.get(ctx); if (active) active.selection++;
        root.querySelectorAll('[data-tool-detail-status]').forEach(status => sideStatus(status.parentElement, ''));
      };
      root.addEventListener('click', cancel, true); listeners.set(ctx, { root, cancel });
    }
    return state;
  }
  function live(ctx, state, tool) {
    return states.get(ctx) === state && scopeOf(ctx) === state.scope && keyOf(current(ctx, tool.id) || {}) === keyOf(tool);
  }
  function remove(state, key) {
    const prior = state.entries.get(key);
    if (prior) state.bytes -= prior.bytes;
    state.entries.delete(key);
  }
  function cached(state, key) {
    const entry = state.entries.get(key);
    if (entry) { state.entries.delete(key); state.entries.set(key, entry); }
    return entry;
  }
  function remember(state, key, entry) {
    remove(state, key);
    // Oversized receipts remain usable for this click, without pinning them in memory.
    if (entry.bytes > MAX_BYTES) return;
    state.entries.set(key, entry); state.bytes += entry.bytes;
    while (state.entries.size > MAX_ENTRIES || state.bytes > MAX_BYTES) remove(state, state.entries.keys().next().value);
  }
  function receiptBytes(tool) {
    try { return JSON.stringify(tool).length * 2; } catch (_) { return MAX_BYTES + 1; }
  }
  function setBody(ctx, tool, html) {
    const node = nodeOf(ctx, tool.id), body = node?.querySelector('.ntool-body');
    if (body && ctx._openTool.has(tool.id) && body.innerHTML !== html) global.ChatDomPatch.patchHtml(body, html);
  }
  function load(ctx, tool, bodyWanted) {
    const state = stateFor(ctx), key = keyOf(tool), prior = cached(state, key);
    if (prior?.tool || (bodyWanted && prior?.html != null)) return Promise.resolve(prior);
    if (state.pending.has(key)) return state.pending.get(key);
    const api = ctx._api?.(), ref = ctx._ref;
    const request = Promise.resolve().then(async () => {
      if (!api?.toolDetail) throw Error('detail unavailable');
      const response = await api.toolDetail(ref, String(tool.id));
      if (!response?.ok || !response.tool || String(response.tool.id) !== String(tool.id)) throw Error('detail unavailable');
      const full = response.tool;
      const html = bodyWanted ? (global.ChatTools.render(full)?.body || '') : null;
      const size = receiptBytes(full), entry = { tool: size <= MAX_BYTES ? full : null, html, bytes: 0 };
      entry.bytes = (entry.tool ? size : 0) + (html?.length || 0) * 2;
      if (entry.bytes > MAX_BYTES) { entry.tool = null; entry.bytes = (html?.length || 0) * 2; }
      if (live(ctx, state, tool)) {
        remember(state, key, entry);
        if (bodyWanted) setBody(ctx, tool, html);
      }
      // The caller may open an oversized receipt; only the bounded cache omits it.
      return { ...entry, tool: full };
    }).catch(() => {
      const entry = { error: true, bytes: 0 };
      if (live(ctx, state, tool)) {
        remember(state, key, entry);
        if (bodyWanted) setBody(ctx, tool, errorHtml(tool.id));
      }
      return entry;
    }).finally(() => state.pending.delete(key));
    state.pending.set(key, request);
    return request;
  }
  function bodyHtml(ctx, tool, view) {
    // Command summaries have no details; restored expansion state must not trigger receipt reads.
    if (view?.commandOnly) return view.body || '';
    if (!tool.detailsDeferred) return view.body || '';
    const state = stateFor(ctx), entry = cached(state, keyOf(tool));
    if (entry?.error) return errorHtml(tool.id);
    if (entry?.html != null) return entry.html;
    if (entry?.tool) {
      const html = global.ChatTools.render(entry.tool)?.body || '';
      remember(state, keyOf(tool), { ...entry, html, bytes: entry.bytes + html.length * 2 });
      return html;
    }
    void load(ctx, tool, true);
    return loadingHtml;
  }
  function sideStatus(node, html, selection) {
    if (!node) return;
    let status = node.querySelector('[data-tool-detail-status]');
    if (!html) { status?.remove(); node.removeAttribute('aria-busy'); return; }
    if (!status) { status = document.createElement('div'); status.dataset.toolDetailStatus = ''; node.appendChild(status); }
    if (selection != null) status.dataset.detailSelection = String(selection);
    global.ChatDomPatch.patchHtml(status, html);
    node.setAttribute('aria-busy', String(html === loadingHtml));
  }
  function activate(ctx, id, retry = false) {
    const tool = current(ctx, id);
    if (!tool || !global.ChatTools) return false;
    const state = stateFor(ctx), view = global.ChatTools.render(tool), node = nodeOf(ctx, id);
    if (view?.summaryOnly) return true;
    if (retry) remove(state, keyOf(tool));
    if (view?.side) {
      const selection = ++state.selection;
      if (!tool.detailsDeferred) { sideStatus(node, ''); return global.ChatTools.openSide(tool); }
      sideStatus(node, loadingHtml, selection);
      void load(ctx, tool, false).then(entry => {
        if (states.get(ctx) !== state || scopeOf(ctx) !== state.scope) return;
        const activeNode = nodeOf(ctx, id);
        if (selection !== state.selection) {
          if (activeNode?.querySelector('[data-tool-detail-status]')?.dataset.detailSelection === String(selection)) sideStatus(activeNode, '');
          return;
        }
        if (!activeNode?.isConnected) return;
        if (!live(ctx, state, tool)) { if (current(ctx, id)) activate(ctx, id); return; }
        if (entry.error || !entry.tool || !global.ChatTools.openSide(entry.tool)) sideStatus(activeNode, errorHtml(id));
        else sideStatus(activeNode, '');
      });
      return true;
    }
    const open = retry || !ctx._openTool.has(tool.id);
    if (open) ctx._openTool.add(tool.id); else ctx._openTool.delete(tool.id);
    node?.classList.toggle('open', open);
    node?.querySelector('[data-tool]')?.setAttribute('aria-expanded', String(open));
    if (open) setBody(ctx, tool, bodyHtml(ctx, tool, view));
    return true;
  }
  function reset(ctx) {
    states.delete(ctx);
    const listener = listeners.get(ctx);
    listener?.root.removeEventListener('click', listener.cancel, true); listeners.delete(ctx);
  }
  global.ChatToolDetails = Object.freeze({ bodyHtml, activate, reset });
})(typeof window !== 'undefined' ? window : globalThis);
