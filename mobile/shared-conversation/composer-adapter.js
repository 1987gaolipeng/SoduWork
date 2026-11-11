(function (global) {
  'use strict';
  // Keep the PC composer and its draft callbacks. Only supply the missing
  // mobile state: authorized models can exist before an executor is connected.
  const original = global.ChatComposerControls.create;
  const node = (tag, text, cls) => {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    if (cls) el.className = cls;
    return el;
  };
  global.ChatComposerControls.create = (el, options) => {
    const control = original(el, options), life = new AbortController();
    const handoff = global.SoduWorkMobileHandoff.mount(el, options);
    const wrap = el.querySelector('#nchatModel'), modelButton = wrap.querySelector('button');
    const runtimeButton = el.querySelector('#nchatRuntime');
    const fallback = node('div', '', 'nmodel-pop mobile-model-fallback');
    fallback.hidden = true; fallback.setAttribute('role', 'dialog');
    fallback.setAttribute('aria-label', '选择已授权模型'); wrap.append(fallback);
    const directory = global.SoduWorkMobileSession;
    const execution = node('div', '', 'mobile-execution-location');
    const location = node('button', '', 'mobile-execution-location-button');
    location.type = 'button';
    const locationLabel = node('span', '', 'mobile-location-label');
    const locationIcon = node('span', '', 'mobile-location-icon');
    locationIcon.setAttribute('aria-hidden', 'true');
    function paintLocationIcon(kind) {
      locationIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + (kind === 'cloud'
        ? '<path d="M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19.8 10 4 4 0 0 1 19 18Z"/>'
        : '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>') + '</svg>';
    }
    location.append(locationIcon, locationLabel);
    location.setAttribute('aria-haspopup', 'menu');
    const locationHint = node('p'); locationHint.setAttribute('role', 'status');
    const targets = node('div', '', 'mobile-target-options mobile-execution-menu');
    targets.hidden = true; targets.setAttribute('role', 'menu'); targets.setAttribute('aria-label', '选择执行位置');
    execution.append(location, targets);
    el.querySelector('.wc-tools')?.append(execution);
    locationHint.className = 'mobile-execution-status';
    el.querySelector('.work-composer')?.before(locationHint);
    let targetGeneration = 0;
    function closeTargets() {
      targetGeneration++; targets.hidden = true;
      location.setAttribute('aria-expanded', 'false');
    }
    function positionTargets() {
      if (targets.hidden) return;
      const rect = location.getBoundingClientRect();
      const width = Math.min(240, global.innerWidth - 24);
      // Match the settings menu: anchored to the trigger, not a bottom sheet.
      Object.assign(targets.style, {width: width + 'px',
        left: Math.max(12, Math.min(rect.left || 0, global.innerWidth - width - 12)) + 'px',
        bottom: Math.max(12, global.innerHeight - rect.top + 6) + 'px',
        maxHeight: Math.max(80, rect.top - 18) + 'px'});
    }
    location.onclick = async () => {
      if (location.disabled) return;
      location.disabled = true;
      try {
        const state = options.state(), scope = identity(), agent = state.adapterId;
        const fixed = !state.draftOnly || !!global.SoduWorkMobilePersonalConversation;
        if (!targets.hidden) { closeTargets(); return; }
        close();
        const ticket = ++targetGeneration;
        targets.hidden = false; location.setAttribute('aria-expanded', 'true');
        const list = node('div', '', 'mobile-target-list');
        targets.replaceChildren(list); positionTargets();
        if (fixed) {
          const target = directory.executionTarget?.(state.ref);
          const item = node('div', '', 'mobile-target-choice');
          const copy = node('span', '', 'mobile-target-copy');
          copy.append(node('strong', target?.runnerKind === 'cloud' ? '云端' : '我的电脑'),
            node('small', target?.name || '正在读取原执行位置'));
          item.append(copy); list.append(item);
          list.append(node('p', '此会话沿用原执行位置。新建会话时可选择其他位置。'));
          positionTargets(); return;
        }
        list.append(node('p', '正在读取执行位置…'));
        const data = await directory.directory();
        if (scope !== identity() || agent !== options.state().adapterId || life.signal.aborted || ticket !== targetGeneration) return;
        list.replaceChildren();
        const rows = (data.targets?.targets || []).filter(row => row.agentId === state.adapterId &&
          row.online === true && row.remote === true && row.runnerId && ['cloud', 'work-computer'].includes(row.runnerKind));
        const selected = state.draftOnly ? directory.draftTarget?.() : directory.executionTarget?.(state.ref);
        for (const row of rows) {
          const name = row.runnerName || row.machineLabel || row.runnerId;
          const button = node('button', '', 'mobile-target-choice');
          const label = node('span', '', 'mobile-target-copy');
          label.append(node('strong', row.runnerKind === 'work-computer' ? '我的电脑' : '云端'), node('small', name));
          const check = node('span', '', 'mobile-target-check');
          check.setAttribute('aria-hidden', 'true');
          check.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m4 10 4 4 8-9"/></svg>';
          button.append(check, label);
          button.type = 'button';
          button.setAttribute('role', 'menuitemradio');
          button.setAttribute('aria-checked', String(selected?.runnerId === row.runnerId));
          button.disabled = fixed && selected?.runnerId !== row.runnerId;
          button.onclick = async () => {
            if (fixed) { closeTargets(); return; }
            if (scope !== identity() || agent !== options.state().adapterId || life.signal.aborted || ticket !== targetGeneration) return;
            button.disabled = true;
            try {
              if (state.draftOnly) directory.setDraftTarget({runnerId: row.runnerId, runnerKind: row.runnerKind, name});
              else {
                const result = await directory.selectTarget(state.ref, row.runnerId, row.runnerKind);
                if (!result.ok) throw Error(result.reason);
              }
              closeTargets(); paint();
            } catch (error) { options.say(error.message); }
            finally { button.disabled = false; }
          };
          list.append(button);
        }
        if (fixed) list.append(node('p', '此会话沿用原执行位置。新建会话时可选择其他位置。'));
        if (!rows.some(row => row.runnerKind === 'work-computer')) list.append(node('p', '我的电脑暂不可用。请确认电脑客户端已登录同一账号，且执行服务已连接。'));
        if (!rows.length) list.append(node('p', data.targets?.error || '当前底座没有可用位置，请检查连接或切换底座。'));
        positionTargets();
      }
      catch (error) { options.say(error.message); }
      finally { location.disabled = false; }
    };
    let generation = 0, draftIdentity = '';
    const on = (target, type, fn, capture = false) => target.addEventListener(type, fn, {capture, signal: life.signal});
    const identity = () => options.state().ref || options.state().draftId;
    const available = () => directory.availableRuntimes().some(row => row.id === options.state().adapterId);
    function close() { generation++; fallback.hidden = true; modelButton.setAttribute('aria-expanded', 'false'); }
    function position() {
      if (fallback.hidden) return;
      const rect = modelButton.getBoundingClientRect(), width = Math.min(360, global.innerWidth - 24);
      Object.assign(fallback.style, {position: 'fixed', width: width + 'px',
        left: Math.max(12, Math.min(rect.right - width, global.innerWidth - width - 12)) + 'px',
        bottom: (global.innerHeight - rect.top + 10) + 'px',
        maxHeight: Math.max(120, rect.top - 24) + 'px'});
    }
    function paint() {
      if (global.SoduWorkMobilePersonalConversation) {
        locationLabel.textContent = '由你的电脑执行';
        location.disabled = false;
        paintLocationIcon('work-computer');
        location.setAttribute('aria-label', '我的电脑，查看执行位置');
        location.title = '我的电脑';
        locationHint.textContent = '沿用这条聊天的电脑、模型和已授权能力，请保持电脑在线。';
        locationHint.hidden = true;
        modelButton.hidden = true; runtimeButton.hidden = true;
        el.querySelectorAll('#nchatMore, #nchatContext, [data-chat-execution]').forEach(button => {button.hidden = true;});
        return;
      }
      const missing = options.state().draftOnly && !available();
      const data = directory.peekDirectory?.();
      const current = options.state();
      if (current.draftOnly && current.draftId !== draftIdentity) {
        draftIdentity = current.draftId; directory.setDraftTarget?.(null); closeTargets();
      }
      const target = current.draftOnly ? (directory.ensureDraftTarget?.(current.adapterId) || directory.draftTarget?.()) : directory.executionTarget?.(current.ref);
      const local = global.SoduWorkMobileExecutionMode === 'local-test';
      const label = target ? (target.runnerKind === 'work-computer' ? '我的电脑' : target.runnerKind === 'cloud' ? '云端' : '原执行位置') + ' · ' + target.name
        : current.draftOnly && data ? '我的电脑暂不可用' : '选择执行位置';
      paintLocationIcon(target?.runnerKind);
      if (locationLabel.textContent !== label) locationLabel.textContent = label;
      location.setAttribute('aria-label', label + '，查看执行环境');
      // Eligible targets are not an execution receipt. Do not label a running
      // conversation with the first machine from the current directory.
      const hint = target ? (target.runnerKind === 'work-computer' ? '工作在这台本人电脑执行，请保持电脑在线。' : '工作在所选云环境执行。') + (local ? ' 当前为本地联调服务。' : '')
        : current.draftOnly && data ? '请连接本人电脑，或手动选择云端执行。'
        : local ? '本地联调环境；默认使用本人在线电脑。' : data?.targets?.error
        ? '云环境读取失败，请查看环境后重试。不会切换到本地执行。'
        : missing && data ? '尚无可用云底座，请先在 PC 客户端配置云环境。'
        : '可选择云端或本人在线电脑；开始后沿用所选位置。';
      if (locationHint.textContent !== hint) locationHint.textContent = hint;
      locationHint.hidden = !data?.targets?.error;
      location.title = hint;
      runtimeButton.dataset.mobileUnavailable = String(missing);
      if (missing) {
        const label = runtimeButton.querySelector('b');
        if (label) label.textContent = '选择底座';
        runtimeButton.setAttribute('aria-label', '选择执行底座，当前尚未连接可用环境');
      }
    }
    function hideOtherMenus(keep) {
      for (const pop of el.querySelectorAll('.nmodel-pop,.nchat-access-pop,.wc-chat-more-pop')) {
        if (pop === keep) continue;
        pop.hidden = true;
        if (pop.previousElementSibling?.matches('button,[role=button]')) pop.previousElementSibling.setAttribute('aria-expanded', 'false');
      }
    }
    async function openModels() {
      if (!fallback.hidden) { close(); return; }
      hideOtherMenus(fallback);
      const ticket = ++generation, scope = identity();
      fallback.hidden = false; modelButton.setAttribute('aria-expanded', 'true');
      const header = node('header'), heading = node('b', '选择模型'), dismiss = node('button', '×');
      dismiss.type = 'button'; dismiss.setAttribute('aria-label', '关闭模型选择'); dismiss.onclick = close;
      header.append(heading, dismiss);
      const search = node('input'); search.type = 'search'; search.placeholder = '搜索可用模型'; search.setAttribute('aria-label', '搜索模型');
      const searchWrap = node('label', '', 'nmodel-search'); searchWrap.append(search);
      const list = node('div', '', 'nmodel-options'); list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', '已授权模型');
      list.append(node('p', '正在加载…', 'nmodel-message'));
      const note = node('p', '可先选择模型；发送前还需要可用的执行环境。', 'nchat-access-note');
      fallback.replaceChildren(header, searchWrap, list, note); position();
      try {
        const models = await global.soduWorkAPI.myModels();
        if (life.signal.aborted || ticket !== generation || identity() !== scope || fallback.hidden) return;
        paint();
        if (available()) { close(); modelButton.click(); return; }
        if (models?.error) throw Error(models.error);
        const rows = models?.usable || [];
        function renderRows() {
          const query = search.value.trim().toLowerCase(); list.replaceChildren();
          for (const row of rows.filter(item => (item.label || item.name).toLowerCase().includes(query))) {
            const choice = node('button', row.label || row.name, 'mobile-model-option'); choice.type = 'button';
            choice.setAttribute('role', 'option'); choice.setAttribute('aria-selected', String(options.state().selection?.name === row.name));
            choice.disabled = !options.state().draftOnly;
            choice.onclick = event => {
              event.stopPropagation();
              if (identity() !== scope || !options.state().draftOnly) { close(); return; }
              const result = options.draft.selectModel(row.name, row.label);
              if (!result?.ok) { options.say(result?.reason || '模型选择未完成'); return; }
              close(); options.modelSelected(result.selection);
            };
            list.append(choice);
          }
          if (!list.children.length) list.append(node('p', rows.length ? '没有匹配的模型' : '当前账号没有获授权的模型', 'nmodel-message'));
        }
        search.oninput = renderRows; renderRows();
        if (!options.state().draftOnly) note.textContent = '原执行环境暂不可用，恢复连接后可切换本会话模型。';
        position();
      } catch (error) {
        if (ticket !== generation || identity() !== scope || life.signal.aborted) return;
        list.replaceChildren(node('p', error.message, 'nmodel-message'));
        const retry = node('button', '重新加载'); retry.type = 'button';
        retry.onclick = () => { close(); void openModels(); }; list.append(retry);
      }
    }
    on(el, 'click', event => {
      if (fallback.contains(event.target)) return;
      if (modelButton.contains(event.target)) {
        hideOtherMenus(available() ? wrap.querySelector('.nmodel-pop:not(.mobile-model-fallback)') : fallback);
        if (!available()) { event.preventDefault(); event.stopImmediatePropagation(); void openModels(); }
      } else if (runtimeButton.contains(event.target)) {
        close(); hideOtherMenus(el.querySelector('.nchat-runtime-pop'));
      } else if (event.target.closest('.wc-more')) { close(); }
    }, true);
    on(document, 'click', event => {
      if (!wrap.contains(event.target)) close();
      if (!location.contains(event.target) && !targets.contains(event.target)) closeTargets();
    });
    on(document, 'keydown', event => {
      if (event.key === 'Escape' && !targets.hidden) {closeTargets(); location.focus?.();}
      if (!targets.hidden && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        const rows = [...targets.querySelectorAll('.mobile-target-choice')];
        if (rows.length) {
          event.preventDefault();
          const index = rows.indexOf(document.activeElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
            : (index + (event.key === 'ArrowUp' ? -1 : 1) + rows.length) % rows.length;
          rows[next].focus?.();
        }
      }
      if (event.key === 'Escape' && !fallback.hidden) { close(); modelButton.focus(); }
    });
    on(global, 'resize', () => {position(); positionTargets();});
    const observer = new MutationObserver(() => {
      const pop = el.querySelector('.nchat-runtime-pop');
      if (!pop || pop.hidden || pop.querySelector('button,[data-mobile-empty]') || pop.textContent.includes('正在读取')) return;
      const choices = pop.querySelector('.nchat-access-options');
      if (choices && !choices.children.length) {
        const data = directory.peekDirectory();
        const local = data?.localTest === true;
        const message = node('p', data?.targets?.error || (local ? '本地测试执行器暂未就绪，请刷新重试；手机无需安装底座。' : data?.targets?.summary) || '当前账号尚无可用执行环境。请在云端环境中检查连接和底座状态。', 'nchat-access-note');
        message.dataset.mobileEmpty = 'true'; choices.append(message);
        const retry = node('button', '刷新执行底座'); retry.type = 'button';
        retry.onclick = async () => {
          retry.disabled = true; retry.textContent = '正在读取…';
          try { await directory.directory(); pop.hidden = true; runtimeButton.click(); paint(); }
          catch (error) { message.textContent = error.message; retry.disabled = false; retry.textContent = '刷新执行底座'; }
        };
        choices.append(retry);
        if (local) return;
        const link = node('button', '查看云端环境'); link.type = 'button';
        link.onclick = () => { pop.hidden = true; void global.SoduWorkMobileBridge.call('resource', {key: 'cloud'}).catch(error => options.say(error.message)); };
        choices.append(link);
        const hint = [...pop.children].find(child => child.matches('p.nchat-access-note'));
        if (hint) hint.remove();
      }
    });
    observer.observe(el, {subtree: true, childList: true, attributes: true, attributeFilter: ['hidden']});
    return {...control, render() { control.render(); paint(); handoff.render(); }, reset() { close(); control.reset?.(); handoff.render(); },
      destroy() { handoff.destroy(); life.abort(); observer.disconnect(); execution.remove(); locationHint.remove(); fallback.remove(); control.destroy(); }};
  };
})(window);
