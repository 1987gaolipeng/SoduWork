(function (global) {
  'use strict';
  const tx = value => (global.SoduWorkI18n && typeof global.SoduWorkI18n.translateText === 'function'
    ? global.SoduWorkI18n.translateText(value) : value) || value;
  function node(tag, text, className) {
    const el = document.createElement(tag); if (text) el.textContent = text;
    if (className) el.className = className; return el;
  }
  function create(el, options) {
    const button = el.querySelector('#nchatRuntime');
    if (!button) return { render() {}, reset() {}, destroy() {} };
    const life = new AbortController(), on = (node, type, fn) => node.addEventListener(type, fn, { signal: life.signal });
    const pop = document.createElement('div'); pop.className = 'nchat-access-pop nchat-runtime-pop cp-runtime-pop'; pop.hidden = true;
    pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', tx('切换 Agent')); button.after(pop);
    const missingWrap = el.querySelector('#nchatRuntimeAvailability'), missing = el.querySelector('#nchatRuntimeMissing'), more = el.querySelector('#nchatRuntimeMore');
    let ref = '', lastIdentity = '', generation = 0, saving = false, request = null;
    let availability = null, availabilityIdentity = '', availabilityFlight = null, checkingId = '';
    const api = () => global.soduWorkAPI.conversationSession;
    const close = () => { generation++; pop.hidden = true; button.setAttribute('aria-expanded', 'false'); };
    function openAgents() {
      if (typeof global.openAgentsEntry === 'function') return global.openAgentsEntry();
      if (typeof global.openAgentsPanel === 'function') return global.openAgentsPanel({ tab: 'runners' });
      if (global.WorkspaceHost && typeof global.WorkspaceHost.open === 'function') return global.WorkspaceHost.open('agents', { tab: 'runners' });
      return false;
    }
    function paintMissing(result) {
      if (!missingWrap || !missing || !more) return;
      const rows = (Array.isArray(result && result.missing) ? result.missing : []).filter(row => row && row.id !== 'pi');
      missing.replaceChildren(...rows.slice(0, 6).map(row => {
        const icon = node('span', '', 'wc-runtime-missing-icon');
        icon.dataset.runtimeMissing = row.id || ''; icon.title = tx(row.displayName || row.id || '');
        icon.setAttribute('aria-hidden', 'true');
        const src = global.AgentBrand?.ICONS?.[row.id];
        if (src) {
          const image = node('img'); image.src = src; image.alt = ''; image.draggable = false;
          image.className = 'agent-brand'; icon.append(image);
        } else icon.textContent = '•';
        return icon;
      }));
      missingWrap.hidden = rows.length === 0; missing.hidden = rows.length === 0; more.hidden = rows.length === 0;
      const names = rows.map(row => tx(row.displayName || row.id)).filter(Boolean).join('、');
      missing.setAttribute('aria-label', tx('缺失的执行底座') + (names ? '：' + names : ''));
      more.textContent = tx('更多'); more.title = tx('打开 Agent 管理，安装或修复执行底座');
      more.setAttribute('aria-label', tx('打开 Agent 管理'));
    }
    function attachFooter() {
      if (!missingWrap) return;
      missingWrap.classList.add('cp-runtime-availability-footer');
      if (missingWrap.parentNode !== pop) pop.appendChild(missingWrap);
    }
    // Keep the management entry in the picker from the moment the component
    // is created. Availability probes can finish while the picker is closed.
    attachFooter();
    function rowsFrom(result) {
      const declared = Array.isArray(result && result.runtimes) ? result.runtimes : [];
      const rows = Array.isArray(result && result.availableRuntimes)
        ? result.availableRuntimes : declared.filter(row => row && row.id === 'pi');
      if (!Array.isArray(rows)) return [];
      const pi = declared.find(row => row && row.id === 'pi');
      const available = pi && !rows.some(row => row && row.id === 'pi') ? [pi, ...rows] : rows;
      return available.slice().sort((a, b) => Number(a.order || 999) - Number(b.order || 999));
    }
    function renderLoading() {
      const heading = node('div', '', 'cp-runtime-heading');
      const title = node('span'); title.append(node('b', tx('选择执行底座')));
      heading.append(title, node('em', '…'));
      pop.replaceChildren(heading, node('p', tx('正在读取可用执行底座…'), 'nchat-access-note'));
      attachFooter();
    }
    function renderPicker(result) {
      const rows = rowsFrom(result);
      const heading = node('div', '', 'cp-runtime-heading');
      const title = node('span'); title.append(node('b', tx('选择执行底座')));
      heading.append(title, node('em', rows.length + ' ' + tx('个底座')));
      const host = node('div', '', 'cp-runtime-rows');
      const groups = [[tx('推荐'), rows.filter(row => row.group !== 'more')], [tx('更多底座'), rows.filter(row => row.group === 'more')]];
      for (const [label, group] of groups) {
        if (!group.length) continue;
        host.append(node('div', label, 'cp-runtime-group' + (label === tx('推荐') ? ' is-first' : '')));
        for (const runtime of group) {
          const selected = runtime.id === options.state().adapterId;
          const choice = node('button', '', 'wc-pop-row cp-runtime-row');
          choice.type = 'button'; choice.dataset.runtime = runtime.id; choice.dataset.sessionAgent = runtime.id;
          choice.setAttribute('aria-selected', String(selected)); choice.setAttribute('aria-pressed', String(selected));
          choice.classList.toggle('on', selected);
          const src = global.AgentBrand?.ICONS?.[runtime.id];
          if (src) {
            const brand = node('span', '', global.AgentBrand.className(runtime.id, 'runtime-brand'));
            const image = node('img'); image.src = src; image.alt = ''; image.draggable = false;
            brand.append(image); choice.append(brand);
          } else choice.append(node('span', '•', 'runtime-brand'));
          const copy = node('span', '', 'cp-runtime-copy');
          const head = node('span', '', 'cp-runtime-head');
          head.append(node('b', runtime.displayName || runtime.id));
          head.append(node('small', tx(runtime.modelMode === 'account' ? '个人账号' : '企业模型'), 'cp-runtime-mode'));
          copy.append(head);
          const meta = node('span', '', 'cp-runtime-meta');
          const state = node('em', checkingId === runtime.id ? tx('检测中') : (selected ? '' : tx('待检测')), 'cp-runtime-state');
          state.dataset.state = checkingId === runtime.id ? 'checking' : 'unknown'; state.hidden = selected && checkingId !== runtime.id;
          const check = node('b', '✓', 'wc-check'); check.setAttribute('aria-label', tx('当前底座')); check.hidden = !selected || checkingId === runtime.id;
          meta.append(state, check); choice.append(copy, meta); host.append(choice);
        }
      }
      if (!host.children.length) host.append(node('div', tx('暂时没有可用执行底座'), 'cp-runtime-empty'));
      const status = node('p', '', 'nchat-access-status'); status.setAttribute('role', 'status'); status.hidden = true;
      pop.replaceChildren(heading, host, status);
      attachFooter();
    }
    function loadAvailability(force = false) {
      const state = options.state(), identity = state.ref || (state.draftOnly ? 'draft:' + state.draftId : '');
      if (!identity) return Promise.resolve(null);
      if (!force && availability && availabilityIdentity === identity) return Promise.resolve(availability);
      if (!force && availabilityFlight && availabilityIdentity === identity) return availabilityFlight;
      availabilityIdentity = identity;
      const token = ++generation;
      const job = Promise.resolve().then(() => state.draftOnly ? options.draft?.runtimes?.() : api()?.conversationRuntimes?.(state.ref))
        .then(result => {
          const current = options.state(), currentIdentity = current.ref || (current.draftOnly ? 'draft:' + current.draftId : '');
          if (token !== generation || identity !== currentIdentity) return result;
          if (!result || result.ok === false) {
            availability = result || null;
            paintMissing(result || null); options.runtimeAvailability?.(result || null);
            throw Error(result && result.reason || tx('无法读取 Agent 列表'));
          }
          availability = result; paintMissing(result); options.runtimeAvailability?.(result); return result;
        }).catch(error => { if (token === generation) paintMissing(availability && availability.missing ? availability : null); throw error; })
        .finally(() => { if (availabilityFlight === job) availabilityFlight = null; });
      availabilityFlight = job; return job;
    }
    function position() {
      const r = button.getBoundingClientRect(), width = Math.min(340, global.innerWidth - 24);
      pop.style.width = width + 'px'; pop.style.left = Math.max(12, Math.min(r.right - width, global.innerWidth - width - 12)) + 'px';
      pop.style.bottom = (global.innerHeight - r.top + 8) + 'px'; pop.style.top = 'auto';
      pop.style.maxHeight = Math.max(160, r.top - 24) + 'px';
    }
    function render() {
      const s = options.state();
      const identity = s.ref || (s.draftOnly ? 'draft:' + s.draftId : '');
      if (lastIdentity !== identity) { lastIdentity = identity; ref = s.ref || ''; saving = false; request = null; checkingId = ''; availability = null; availabilityFlight = null; availabilityIdentity = identity; close(); }
      button.disabled = (!s.ref && !s.draftOnly) || saving || s.runtimeSwitching || (s.cloudHandoff && s.cloudHandoff.phase !== 'committed');
      button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-busy', String(saving || !!s.runtimeSwitching));
      button.setAttribute('role', 'button'); button.title = tx('切换 Agent · 保留当前对话和工作目录');
      if (identity && !availability && !availabilityFlight) void loadAvailability().catch(() => {});
      if (!pop.hidden) position();
    }
    if (more) on(more, 'click', event => { event.stopPropagation(); close(); openAgents(); });
    on(global, 'soduwork-locale-change', () => {
      pop.setAttribute('aria-label', tx('切换 Agent')); button.title = tx('切换 Agent · 保留当前对话和工作目录');
      if (availability) { paintMissing(availability); if (!pop.hidden) renderPicker(availability); }
    });
    on(button, 'click', async event => {
      event.stopPropagation(); if (!pop.hidden) { close(); return; }
      // The model picker uses the browser popover top layer. Close it before
      // opening the runtime picker so the two menus cannot overlap and steal
      // clicks from the selected runtime row.
      const modelPop = el.querySelector('.nmodel-pop');
      if (modelPop && !modelPop.hidden) {
        modelPop.hidePopover?.(); modelPop.hidden = true; modelPop.classList?.remove('show');
        modelPop.previousElementSibling?.setAttribute('aria-expanded', 'false');
      }
      const state = options.state();
      if (state.busy) {
        options.say(state.recoveryRequired
          ? (state.recoveryReason || tx('执行状态尚未确认')) + '；' + tx('请先点击“核实执行状态”后再切换 Agent')
          : tx('请等待本轮和排队消息完成后切换 Agent')); return;
      }
      const activeRef = ref;
      renderLoading();
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
      } catch (error) { if (!pop.hidden) { pop.replaceChildren(node('p', error.message, 'nchat-access-note')); attachFooter(); position(); } }
    });
    on(pop, 'click', event => {
      const row = event.target.closest('[data-runtime]');
      if (!row || saving) return;
      const selectedId = row.dataset.runtime || '';
      if (selectedId === options.state().adapterId) { close(); return; }
      const token = generation, activeRef = ref;
      saving = true; render();
      checkingId = selectedId;
      if (availability) renderPicker(availability);
      pop.querySelectorAll('button').forEach(b => { b.disabled = true; });
      const status = pop.querySelector('[role=status]'); if (status) { status.hidden = false; status.textContent = tx('正在切换…'); }
      request = (async () => {
        try {
          const result = options.state().draftOnly ? options.draft.selectRuntime(selectedId)
            : await api().selectAgent(activeRef, selectedId);
          if (token !== generation || activeRef !== options.state().ref) return false;
          if (!result?.ok) throw Error(result?.reason || tx('切换未完成，原会话已保留'));
          checkingId = ''; options.runtimeSelected?.(result); close(); return true;
        } catch (error) {
          if (token === generation) {
            checkingId = ''; if (status) status.textContent = error.message;
            pop.querySelectorAll('button').forEach(b => { b.disabled = false; });
          }
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
