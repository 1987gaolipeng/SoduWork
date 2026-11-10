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
    const locationLabel = node('span');
    location.append(locationLabel, node('span', '查看环境 ›'));
    const locationHint = node('p'); locationHint.setAttribute('role', 'status');
    execution.append(location, locationHint);
    el.querySelector('.work-composer')?.before(execution);
    location.onclick = async () => {
      if (location.disabled) return;
      location.disabled = true;
      try { await global.SoduWorkMobileBridge.call('resource', {key: 'cloud'}); }
      catch (error) { options.say(error.message); }
      finally { location.disabled = false; }
    };
    let generation = 0;
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
      const missing = options.state().draftOnly && !available();
      const data = directory.peekDirectory?.();
      const local = global.SoduWorkMobileExecutionMode === 'local-test';
      const label = local ? '本地联调环境' : '云端执行';
      if (locationLabel.textContent !== label) locationLabel.textContent = label;
      location.setAttribute('aria-label', label + '，查看执行环境');
      // Eligible targets are not an execution receipt. Do not label a running
      // conversation with the first machine from the current directory.
      const hint = local ? '仅供联调，不代表正式云环境。' : data?.targets?.error
        ? '云环境读取失败，请查看环境后重试。不会切换到本地执行。'
        : missing && data ? '尚无可用云底座，请先在 PC 客户端配置云环境。'
        : '使用账号已配置的云环境；手机不在本地执行。';
      if (locationHint.textContent !== hint) locationHint.textContent = hint;
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
    on(document, 'click', event => { if (!wrap.contains(event.target)) close(); });
    on(document, 'keydown', event => {
      if (event.key === 'Escape' && !fallback.hidden) { close(); modelButton.focus(); }
    });
    on(global, 'resize', position);
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
      destroy() { handoff.destroy(); life.abort(); observer.disconnect(); execution.remove(); fallback.remove(); control.destroy(); }};
  };
})(window);
