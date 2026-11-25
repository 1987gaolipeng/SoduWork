/* On-demand receipt loading. The transcript owns summaries; the workbench owns files. */
(function (global) {
  'use strict';
  const states = new WeakMap();
  const listeners = new WeakMap();
  const MAX_ENTRIES = 16, MAX_BYTES = 16 * 1024 * 1024;
  const keyOf = tool => JSON.stringify([String(tool.id), String(tool.detailVersion || '')]);
  const scopeOf = ctx => global.ChatTools.recordOwner(ctx);
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
  function openRecord(ctx, id, button) {
    const tool = current(ctx, id), node = nodeOf(ctx, id);
    if (!tool || !node?.contains(button) || button.dataset.commandOwner !== scopeOf(ctx) ||
        !global.ChatTools.render(tool)?.recordAvailable) return false;
    const state = stateFor(ctx), selection = ++state.selection;
    const show = full => {
      // Check the full receipt too: a compact projection can omit bridge arguments.
      const shown = full && global.ChatTools.render(full)?.recordAvailable && global.ChatWorkbench?.openCommandRecord(full);
      sideStatus(node, shown ? '' : '<div class="nd-skip" role="status">详情暂时无法读取</div>');
    };
    if (!tool.detailsDeferred) { show(tool); return true; }
    sideStatus(node, loadingHtml, selection);
    void load(ctx, tool, false).then(entry => {
      if (!live(ctx, state, tool) || selection !== state.selection || !node.isConnected || !node.contains(button) ||
          !global.ChatTools.render(current(ctx, id))?.recordAvailable) {
        if (node.querySelector('[data-tool-detail-status]')?.dataset.detailSelection === String(selection)) sideStatus(node, '');
        return;
      }
      show(entry.tool);
    });
    return true;
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

  const dialogs = new WeakMap();
  async function openSkillFailure(ctx, button) {
    const id = button.dataset.skillFailure;
    const ref = ctx._ref, owner = scopeOf(ctx);
    if (!id || button.dataset.commandOwner !== owner || ctx._snap?.skillFailure?.id !== id) return;
    dialogs.get(ctx)?.remove();
    const dialog = document.createElement('dialog');
    dialogs.set(ctx, dialog);
    dialog.className = 'nchat-skill-failure-dialog';
    const t = value => global.SoduWorkI18n?.translateText?.(value) || value;
    const add = (tag, text) => {
      const element = document.createElement(tag);
      element.textContent = text;
      dialog.appendChild(element);
      return element;
    };
    dialog.setAttribute('aria-label', t('技能失败报告'));
    add('h3', t('技能失败报告'));
    const status = add('p', '');
    status.setAttribute('role', 'status');
    const close = add('button', t('关闭'));
    close.onclick = () => dialog.close();
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (dialogs.get(ctx) === dialog) dialogs.delete(ctx);
    }, { once: true });
    document.body.appendChild(dialog);
    dialog.showModal();
    const current = () => dialog.isConnected && dialogs.get(ctx) === dialog && ctx._ref === ref && scopeOf(ctx) === owner;
    try {
      const result = await ctx._api().skillFailureContext(ref, id);
      if (!current()) return;
      if (!result?.ok) throw Error();
      const r = result.report;
      const fields = [
        ['技能与版本', r.skills.map(s => s.name + ' (' + (s.version || t('未声明版本')) + ')').join(', ')],
        ['本轮提示词', r.prompt], ...(r.files.length ? [['输入附件', r.files.join(', ')]] : []),
        ['失败的工具', r.tool], ['工具入参', r.input], ['失败返回', r.output],
        ['运行系统', r.system], ['Node', r.node || t('未检测到')], ['Python', r.python || t('未检测到')], ['执行目录', r.cwd],
      ];
      const pre = add('pre', fields.map(([key, value]) => t(key) + ': ' + value).join('\n\n'));
      pre.setAttribute('data-user-content', '');
      status.textContent = t(result.unsaved ? '本地保存失败，仍可复制报告' : '报告已保存在本机');
      const copy = add('button', t('复制纯文本报告'));
      copy.dataset.copySkillFailure = '';
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(pre.textContent); status.textContent = t('报告已复制'); }
        catch (_) { status.textContent = t('无法复制报告，请选择文本复制'); }
      };
      dialog.appendChild(close);
      copy.focus();
    } catch (_) { if (current()) status.textContent = t('无法读取这次失败记录'); }
  }

  function reset(ctx) {
    dialogs.get(ctx)?.remove(); dialogs.delete(ctx);
    states.delete(ctx);
    const listener = listeners.get(ctx);
    listener?.root.removeEventListener('click', listener.cancel, true); listeners.delete(ctx);
  }
  global.ChatToolDetails = Object.freeze({ bodyHtml, activate, openRecord, openSkillFailure, reset });
})(typeof window !== 'undefined' ? window : globalThis);
