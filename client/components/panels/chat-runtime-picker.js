(function (global) {
  'use strict';
  function node(tag, text, className) {
    const el = document.createElement(tag); if (text) el.textContent = text;
    if (className) el.className = className; return el;
  }
  function create(el, options) {
    const button = el.querySelector('#nchatRuntime');
    if (!button) return { render() {}, reset() {}, destroy() {} };
    const life = new AbortController(), on = (node, type, fn) => node.addEventListener(type, fn, { signal: life.signal });
    const pop = document.createElement('div'); pop.className = 'nchat-access-pop nchat-runtime-pop'; pop.hidden = true;
    pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', '切换 Agent'); button.after(pop);
    let ref = '', lastIdentity = '', generation = 0, saving = false, request = null;
    const api = () => global.soduWorkAPI.conversationSession;
    const close = () => { generation++; pop.hidden = true; button.setAttribute('aria-expanded', 'false'); };
    function position() {
      const r = button.getBoundingClientRect(), width = Math.min(280, global.innerWidth - 24);
      pop.style.width = width + 'px'; pop.style.left = Math.max(12, Math.min(r.right - width, global.innerWidth - width - 12)) + 'px';
      pop.style.bottom = (global.innerHeight - r.top + 8) + 'px'; pop.style.top = 'auto';
      pop.style.maxHeight = Math.max(160, r.top - 24) + 'px';
    }
    function render() {
      const s = options.state();
      const identity = s.ref || (s.draftOnly ? 'draft:' + s.draftId : '');
      if (lastIdentity !== identity) { lastIdentity = identity; ref = s.ref || ''; saving = false; request = null; close(); }
      button.disabled = (!s.ref && !s.draftOnly) || saving || s.runtimeSwitching || (s.cloudHandoff && s.cloudHandoff.phase !== 'committed');
      button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-busy', String(saving || !!s.runtimeSwitching));
      button.setAttribute('role', 'button'); button.title = '切换 Agent · 保留当前对话和工作目录';
      if (!pop.hidden) position();
    }
    on(button, 'click', async event => {
      event.stopPropagation(); if (!pop.hidden) { close(); return; }
      const state = options.state();
      if (state.busy) {
        options.say(state.recoveryRequired
          ? (state.recoveryReason || '执行状态尚未确认') + '；请先点击“核实执行状态”后再切换 Agent'
          : '请等待本轮和排队消息完成后切换 Agent'); return;
      }
      const token = ++generation, activeRef = ref;
      pop.replaceChildren(node('header', '切换 Agent'), node('p', '正在读取可用 Agent…', 'nchat-access-note'));
      pop.hidden = false; button.setAttribute('aria-expanded', 'true'); position();
      try {
        const result = options.state().draftOnly ? await options.draft.runtimes() : await api().conversationRuntimes(activeRef);
        if (token !== generation || activeRef !== options.state().ref) return;
        if (!result?.ok) throw Error(result?.reason || '无法读取 Agent 列表');
        const choices = node('div', '', 'nchat-access-options');
        for (const row of result.runtimes || []) {
          const choice = node('button'); choice.type = 'button'; choice.dataset.sessionAgent = row.id;
          choice.setAttribute('aria-pressed', String(row.id === options.state().adapterId));
          const name = node('span', '', 'nchat-runtime-name'), branding = global.AgentBrand;
          if (branding?.MONOGRAMS) {
            const id = branding.canonical(row.id);
            const brand = node('span', '', branding.className(id, 'runtime-brand'));
            brand.append(node('span', branding.MONOGRAMS[id] || 'AI', 'agent-monogram'));
            name.append(brand);
          }
          name.append(document.createTextNode(row.displayName || row.id)); choice.append(name);
          if (row.id === options.state().adapterId) { const check = node('span', '✓'); check.setAttribute('aria-hidden', 'true'); choice.append(check); }
          choices.append(choice);
        }
        const status = node('p'); status.setAttribute('role', 'status'); status.hidden = true;
        pop.replaceChildren(node('header', '切换 Agent'), choices,
          node('p', '保留对话、文件与权限；下一轮使用所选 Agent。', 'nchat-access-note'), status);
        position();
      } catch (error) { if (token === generation) { pop.replaceChildren(node('p', error.message, 'nchat-access-note')); position(); } }
    });
    on(pop, 'click', event => {
      const row = event.target.closest('[data-session-agent]');
      if (!row || saving) return;
      if (row.dataset.sessionAgent === options.state().adapterId) { close(); return; }
      const token = generation, activeRef = ref;
      saving = true; render();
      pop.querySelectorAll('button').forEach(b => { b.disabled = true; });
      const status = pop.querySelector('[role=status]'); status.hidden = false; status.textContent = '正在切换…';
      request = (async () => {
        try {
          const result = options.state().draftOnly ? options.draft.selectRuntime(row.dataset.sessionAgent)
            : await api().selectAgent(activeRef, row.dataset.sessionAgent);
          if (token !== generation || activeRef !== options.state().ref) return false;
          if (!result?.ok) throw Error(result?.reason || '切换未完成，原会话已保留');
          options.runtimeSelected?.(result); close(); return true;
        } catch (error) {
          if (token === generation) { status.textContent = error.message; pop.querySelectorAll('button').forEach(b => { b.disabled = false; }); }
          return false;
        } finally { if (activeRef === options.state().ref) { saving = false; request = null; render(); } }
      })();
    });
    on(document, 'click', event => { if (!saving && !pop.contains(event.target) && !button.contains(event.target)) close(); });
    on(document, 'keydown', event => { if (event.key === 'Escape' && !saving && !pop.hidden) { event.preventDefault(); close(); button.focus(); } });
    on(global, 'resize', position);
    return { render, wait: () => request || Promise.resolve(true), reset: close,
      destroy() { close(); life.abort(); pop.remove(); } };
  }
  global.ChatRuntimePicker = { create };
})(window);
