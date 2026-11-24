/* Composer controls only; messages and the send pipeline remain owned by NativeChat. */
(function (global) {
  'use strict';
  const esc = value => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  function create(el, options) {
    const lifecycle = new AbortController();
    const on = (target, type, handler, capture = false) => target.addEventListener(type, handler, { capture, signal: lifecycle.signal });
    const queue = el.querySelector('#nchatQueue'), wrap = el.querySelector('#nchatModel');
    const button = wrap.querySelector('button'), pop = wrap.querySelector('.nmodel-pop');
    pop.setAttribute('popover', 'manual');
    const thinkingDot = wrap.querySelector('.nmodel-thinking-dot');
    let drag = null, generation = 0, rows = [], selecting = false, thinkingBusy = false, lastAdapter = '', lastIdentity = '';
    let nativeModels = [], nativeView = 'effort', effortEpoch = 0, pendingEffort = null, effortPreview = null, effortRequest = null, modelRequest = null;
    const effortView = () => global.ComposeModelPicker?.nativeEffort;
    const nativeMode = state => state.adapterId === 'codex' && !state.cloudHandoff && Boolean(effortView());
    let catalogScope = '', lastScope = '', catalogLoads = 0, catalogFlight = null, catalogVersion = 0;
    const MODEL_WAIT_MS = 12000;
    const modelErrors = new WeakSet();
    const automaticSelections = new WeakMap();
    const modelError = (code, message) => {
      const error = Object.assign(new Error(message), { code });
      modelErrors.add(error); return error;
    };
    const catalogError = () => modelError('MODEL_CATALOG_UNAVAILABLE', '模型列表暂时无法读取，请检查连接或模型配置后重试；输入已保留。');
    const selectionTimeout = () => modelError('MODEL_SELECTION_UNCONFIRMED', '模型切换尚未确认，请稍候重试；当前请求仍在确认中，输入已保留。');
    function bounded(promise, deadline, timeoutError, expired) {
      let timer;
      return Promise.race([Promise.resolve(promise), new Promise((_, reject) => {
        timer = global.setTimeout(() => { expired?.(); reject(timeoutError()); }, Math.max(0, deadline - Date.now()));
      })]).finally(() => global.clearTimeout(timer));
    }
    function supersedeCatalog() {
      if (catalogFlight && !catalogFlight.done) {
        catalogFlight.invalidated = true;
        catalogFlight.wake();
      }
    }
    const modelScope = () => {
      const state = options.state();
      return JSON.stringify([global.SoduWorkAPI?.taskStorageKey?.('ops') || '',
        state.ref || 'draft:' + state.draftId, state.adapterId || 'pi', state.cloudHandoff?.phase || '']);
    };
    const meta = el.querySelector('#nchatMeta');
    let contextPinned = false;
    const sessionControls = global.ChatSessionControls?.create(el, options);
    const runtimePicker = global.ChatRuntimePicker?.create(el, options);
    function positionContext() {
      if (!meta || !meta.classList.contains('show-detail')) return;
      const hint = meta.querySelector('.nctx-pop');
      if (!hint) return;
      const anchor = meta.getBoundingClientRect(), width = hint.offsetWidth;
      const center = anchor.left + anchor.width / 2;
      const left = Math.max(12, Math.min(global.innerWidth - width - 12, center - width / 2));
      meta.style.setProperty('--ctx-shift', (left + width / 2 - center) + 'px');
    }
    function showContext() {
      if (!meta) return;
      meta.classList.add('show-detail'); meta.setAttribute('aria-expanded', 'true'); positionContext();
    }
    function closeContext() {
      contextPinned = false;
      if (meta) { meta.classList.remove('show-detail'); meta.setAttribute('aria-expanded', 'false'); }
    }
    if (meta) {
      // A custom tooltip replaces the browser title, including keyboard/touch access.
      meta.removeAttribute('title'); meta.setAttribute('aria-describedby', 'nchatContextHint');
      meta.setAttribute('aria-expanded', 'false');
      on(meta, 'mouseenter', showContext);
      on(meta, 'mouseleave', () => { if (!contextPinned) closeContext(); });
      on(meta, 'focus', showContext);
      on(meta, 'blur', () => { if (!contextPinned) closeContext(); });
      on(meta, 'click', event => {
        event.stopPropagation();
        if (contextPinned) closeContext();
        else { contextPinned = true; showContext(); }
      });
      on(global, 'resize', positionContext);
    }
    function close(focus) {
      generation++; pop.hidePopover?.(); pop.hidden = true; pop.classList.remove('show'); button.setAttribute('aria-expanded', 'false');
      if (focus) button.focus();
    }
    function positionModels() {
      if (pop.hidden) return;
      const anchor = button.getBoundingClientRect();
      const above = anchor.top - 24;
      // Use the viewport when a tall composer leaves too little room above its toolbar.
      pop.style.maxHeight = Math.max(160, Math.min(560, above >= 260 ? above : global.innerHeight - 24)) + 'px';
      const width = pop.offsetWidth, height = pop.offsetHeight;
      pop.style.left = Math.max(12, Math.min((anchor.left + anchor.right - width) / 2, global.innerWidth - 12 - width)) + 'px';
      pop.style.top = Math.max(12, Math.min(anchor.top - 9 - height, global.innerHeight - 12 - height)) + 'px';
    }
    on(global, 'resize', positionModels);
    function renderThinking(state) {
      const panel = pop.querySelector('.nmodel-thinking');
      if (!panel) return;
      const thinking = state && state.thinking || {};
      const supported = Boolean(thinking.supported);
      const canDisable = supported && thinking.canDisable !== false;
      const enabled = Boolean(supported && thinking.enabled);
      const toggle = panel.querySelector('[data-thinking-toggle]');
      const label = panel.querySelector('[data-thinking-label]');
      const hint = panel.querySelector('[data-thinking-hint]');
      if (toggle) {
        const hadFocus = document.activeElement === toggle;
        toggle.disabled = !supported || !canDisable || thinkingBusy;
        // Keep keyboard focus in the picker when Chromium blurs a newly disabled control.
        if (hadFocus && toggle.disabled && !pop.hidden) pop.querySelector('[data-model-search], [data-model-close]')?.focus();
        toggle.setAttribute('aria-checked', enabled ? 'true' : 'false');
        toggle.classList.toggle('is-on', enabled);
      }
      if (label) label.textContent = !supported
        ? '当前模型不提供可控思考'
        : (!canDisable ? '已开启 · 模型固定思考'
          : (enabled ? '已开启 · 中等强度' : '已关闭 · 更快响应'));
      if (hint) hint.textContent = !supported
        ? '切换到支持推理的模型后可使用'
        : (!canDisable ? '当前模型始终开启思考，不支持关闭'
          : '只对后续发送的消息生效，不会中断当前轮次');
    }
    function render() {
      if (options.state().readOnlyHistory) { close(false); return; }
      sessionControls?.render(); runtimePicker?.render();
      const state = options.state(), selection = state.selection || {};
      global.SoduWorkQuotaNotice?.modelChanged?.(selection.model || state.model, state.adapterId || 'pi', el);
      const identity = state.ref || (state.draftOnly ? 'draft:' + state.draftId : '');
      const scope = modelScope();
      if (lastScope !== scope || lastIdentity !== identity || lastAdapter !== state.adapterId || state.runtimeSwitching) {
        close(false); rows = []; nativeModels = []; nativeView = 'effort'; effortEpoch++; pendingEffort = null; effortPreview = null; effortRequest = null; modelRequest = null; selecting = false;
        pop.removeAttribute('aria-busy');
      }
      lastScope = scope;
      lastIdentity = identity;
      lastAdapter = state.adapterId;
      const selectedName = selection.name || selection.model?.id || state.model?.id || '';
      const updated = catalogScope === modelScope() && rows.find(row => row.name === selectedName);
      const selectedModel = selection.model || (!selection.name || selection.name === state.model?.id ? state.model : null);
      const label = nativeMode(state) && !selectedName && !state.restoringHistory ? 'Codex 默认' :
        (selectedModel?.unavailable ? selectedModel.label : updated?.label) || selectedModel?.label ||
        selectedName || (state.restoringHistory ? '正在加载…' : '选择模型');
      button.querySelector('span').textContent = label;
      button.title = '模型：' + label + ' · 用于之后发送的消息';
      button.setAttribute('aria-label', button.title);
      // New drafts can choose a model immediately. History needs its own live handle first.
      button.disabled = Boolean(!state.ref && !state.draftOnly || state.runtimeSwitching || state.cloudHandoff && state.cloudHandoff.phase !== 'committed');
      if (state.cloudHandoff && state.cloudHandoff.phase !== 'committed') { button.title = '请先完成云端交接'; if (!pop.hidden) close(false); }
      if (thinkingDot) {
        thinkingDot.hidden = !Boolean(state.thinking && state.thinking.enabled);
        thinkingDot.title = thinkingDot.hidden ? '' : '思考模式已开启';
      }
      if (meta) meta.hidden = selection.model?.modality === 'image';
      if (!pop.hidden) {
        if (nativeMode(state) && nativeView === 'effort' && pop.querySelector('.cp-effort-card')) paintNativeEffort(state);
        else renderThinking(state);
      }
      if ((!selectedName || selectedModel?.unavailable) && !['codex'].includes(state.adapterId) &&
          !catalogLoads && catalogScope !== scope) void loadModels();
    }
    function nativeSelection(state) {
      return { modelName: state.selection?.name || state.selection?.model?.id || state.model?.id || '',
        reasoningEffort: effortPreview?.epoch === effortEpoch ? effortPreview.level : state.thinking?.level || '' };
    }
    function paintNativeEffort(state = options.state()) {
      const selected = nativeSelection(state);
      effortView()?.paint(pop, selected, nativeModels.find(model => model.id === selected.modelName));
    }
    function renderNativeEffort() {
      const state = options.state();
      pop.classList.add('cp-modelpop', 'show'); pop.dataset.modelView = nativeView;
      if (nativeView === 'models') {
        pop.innerHTML = '<header class="nmodel-header"><button type="button" data-native-back aria-label="返回推理设置">‹</button><div class="nmodel-heading"><b>选择模型</b><span>Codex · 使用本机账号</span></div><button type="button" data-model-close aria-label="关闭模型选择">×</button></header>' +
          '<label class="nmodel-search"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/></svg><input type="search" aria-label="搜索模型" placeholder="搜索可用模型"></label>' +
          '<div class="nmodel-options" role="listbox" aria-label="可用模型"></div>';
        list();
      } else {
        const selected = nativeSelection(state), model = nativeModels.find(row => row.id === selected.modelName);
        pop.innerHTML = effortView().html(selected, model);
        paintNativeEffort(state);
      }
      positionModels();
    }
    function chooseNativeEffort(level) {
      const state = options.state(), model = nativeModels.find(row => row.id === nativeSelection(state).modelName);
      if (!nativeMode(state) || state.runtimeSwitching || selecting || !effortView().levels(model).includes(level)) return;
      const epoch = effortEpoch, ref = state.ref, adapter = state.adapterId;
      pendingEffort = { level, ref, epoch }; effortPreview = { level, epoch }; paintNativeEffort(state);
      if (effortRequest) return;
      const request = (async () => {
        let accepted = true;
        while (pendingEffort && epoch === effortEpoch) {
          const next = pendingEffort; pendingEffort = null;
          try {
            const result = state.draftOnly ? options.draft.selectThinking(next.level)
              : await global.soduWorkAPI.conversationSession.setThinking(next.ref, next.level);
            if (epoch !== effortEpoch || ref !== options.state().ref || adapter !== options.state().adapterId) return false;
            if (!result?.ok) { accepted = false; pendingEffort = null; options.say(result?.reason || '推理强度更新未完成，请重试'); break; }
            options.thinkingChanged?.(result.thinking);
          } catch (_) {
            if (epoch !== effortEpoch || ref !== options.state().ref || adapter !== options.state().adapterId) return false;
            accepted = false; pendingEffort = null; options.say('推理强度更新未完成，请重试'); break;
          }
        }
        return accepted;
      })().finally(() => {
        if (effortRequest === request) effortRequest = null;
        if (epoch === effortEpoch) { effortPreview = null; if (nativeMode(options.state()) && !pop.hidden && nativeView === 'effort') paintNativeEffort(); }
      });
      effortRequest = request;
    }
    function list(filter = '') {
      const state = options.state(), selection = state.selection || {};
      const selected = selection.name || selection.model?.id || state.model?.id || '';
      const visible = rows.filter(row => (row.label + ' ' + row.name + ' ' + (row.subtitle || '')).toLowerCase().includes(filter.trim().toLowerCase()));
      pop.querySelector('.nmodel-options').innerHTML = visible.length ? visible.map(row =>
        '<button type="button" role="option" aria-selected="' + (row.name === selected) +
        '" data-model-name="' + esc(row.name) + '"><span class="nmodel-symbol" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="m10 3 2 5 5 2-5 2-2 5-2-5-5-2 5-2Z"/></svg></span>' +
        '<span class="nmodel-row-copy"><b data-user-content>' + esc(row.label) + '</b>' +
        (row.subtitle ? '<small class="nmodel-row-subtitle" data-user-content>' + esc(row.subtitle) + '</small>' : '') + '</span>' +
        '<i class="nmodel-tick" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></i></button>').join('') :
        '<p class="nmodel-message">没有匹配的可用模型</p>';
    }
    function thinkingMarkup() {
      return '<section class="nmodel-thinking" aria-label="思考模式">' +
        '<span class="nmodel-thinking-icon" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M10 2.5v3m0 9v3M2.5 10h3m9 0h3M4.7 4.7l2.1 2.1m6.4 6.4 2.1 2.1m0-10.6-2.1 2.1m-6.4 6.4-2.1 2.1"/><circle cx="10" cy="10" r="3.2"/></svg></span>' +
        '<span class="nmodel-thinking-copy"><b>思考模式</b><small data-thinking-label>正在加载</small></span>' +
        '<button type="button" class="nmodel-switch" role="switch" aria-checked="false" data-thinking-toggle><i aria-hidden="true"></i><span class="sr-only">开关思考模式</span></button>' +
        '<small class="nmodel-thinking-hint" data-thinking-hint></small></section>';
    }
    on(button, 'click', async () => {
      if (!pop.hidden) { close(); return; }
      const current = options.state();
      nativeView = 'effort'; pop.classList.remove('cp-modelpop', 'show'); delete pop.dataset.modelView;
      pop.hidden = false; button.setAttribute('aria-expanded', 'true');
      pop.innerHTML = '<header class="nmodel-header"><div class="nmodel-heading"><b>选择模型</b><span title="只对后续发送的消息生效，不会中断当前轮次">用于本次会话</span></div><button type="button" data-model-close aria-label="关闭模型选择">×</button></header>' +
        '<label class="nmodel-search"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/></svg><input type="search" aria-label="搜索模型" placeholder="搜索可用模型"></label>' +
        '<div class="nmodel-options" role="listbox" aria-label="可用模型"><p class="nmodel-message">正在加载…</p></div>' +
        thinkingMarkup();
      pop.showPopover?.();
      renderThinking(current); positionModels();
      pop.querySelector('input').focus({ preventScroll: true });
      await loadModels();
    });
    function loadModels(force = false) {
      const state = options.state();
      if (lifecycle.signal.aborted || state.readOnlyHistory || (!state.ref && !state.draftOnly)) return Promise.resolve(false);
      const scope = modelScope();
      if (!force && catalogFlight?.scope === scope && !catalogFlight.done && !catalogFlight.invalidated)
        return catalogFlight.promise;
      supersedeCatalog();
      const flight = { scope, version: ++catalogVersion, deadline: Date.now() + MODEL_WAIT_MS,
        stage: 'read', invalidated: false, done: false, stale: false, error: null };
      flight.superseded = new Promise(resolve => { flight.wake = resolve; });
      catalogFlight = flight;
      flight.promise = readModels(flight).finally(() => { flight.done = true; });
      return flight.promise;
    }
    async function readModels(flight) {
      catalogLoads++;
      const current = options.state(), scope = flight.scope;
      const selectedAtStart = current.selection?.name || current.selection?.model?.id || current.model?.id || '';
      const valid = () => !lifecycle.signal.aborted && !flight.invalidated && flight.version === catalogVersion && scope === modelScope();
      const stale = () => { flight.stale = true; return false; };
      const read = promise => bounded(Promise.race([promise, flight.superseded]), flight.deadline,
        () => modelError('MODEL_CATALOG_TIMEOUT', '读取模型列表超时，请检查连接后重试；输入已保留。'),
        () => { flight.invalidated = true; });
      let managedChoiceBlocked = false;
      try {
        const adapter = current.adapterId || 'pi';
        const catalog = await read(global.soduWorkAPI.conversationSession.runtimes());
        if (!valid()) return stale();
        const runtime = catalog?.ok && catalog.runtimes?.find(item => item.id === adapter);
        if (!runtime) throw new Error('Agent catalog unavailable');
        const native = runtime.modelMode === 'account';
        const response = native ? (current.cloudHandoff ? { models: [] } : await read(global.soduWorkAPI.conversationSession.runtimeModels(adapter, current.devicePreview ? undefined : current.ref))) :
          await read(global.SoduWorkAPI.myModels({ localDefaults: !current.cloudHandoff }));
        if (!valid()) return stale();
        if (native) {
          nativeModels = response.models || [];
          rows = nativeModels.map(row => ({ name: row.id, label: row.label || row.id }));
          if (adapter === 'codex' && !current.cloudHandoff) rows.unshift({ name: '', label: 'Codex 默认' });
        }
        else {
          if (response?.ok === false || !Array.isArray(response?.usable)) throw new Error('Model catalog unavailable');
          const subtitle = row => [row.providerName, row.keyFrom === 'mine' ? '自己的额度' : ''].filter(Boolean).join(' · ');
          const deviceLocal = row => row.localOnly === true || String(row.name || '').startsWith('local:');
          const allowed = row => row && row.available !== false && row.unavailable !== true &&
            !/^(?:unavailable:|local:unavailable$)/.test(String(row.name || '')) &&
            (!current.cloudHandoff || !deviceLocal(row));
          rows = (response.usable || []).filter(allowed)
            .sort((a, b) => Number(deviceLocal(b)) - Number(deviceLocal(a)))
            .map(row => ({ name: row.name, label: row.label || row.name, subtitle: subtitle(row) }));
          if (adapter === 'pi' && global.SoduWorkModelChoice) rows.push(...(response.mediaUsable?.image || []).filter(allowed).map(row => ({
            name: SoduWorkModelChoice.imageKey(row), label: '生成图片 · ' + (row.label || row.name), subtitle: subtitle(row),
          })));
          const latest = options.state(), selection = latest.selection || {}, selected = selection.name || selection.model?.id || latest.model?.id || '';
          const localReference = selected.startsWith('local:') ? selected : global.SoduWorkModelChoice?.imageChoice(selected)?.name;
          const availableRow = rows.find(row => row.name === selected || !selected.startsWith('local:') &&
            localReference?.startsWith('local:') && global.SoduWorkModelChoice?.imageChoice(row.name)?.name === localReference);
          if (selected !== selectedAtStart || selecting) { render(); return stale(); }
          if (!availableRow && response.managedCatalogUnavailable === true && selected && !localReference?.startsWith('local:')) {
            // A partial local directory cannot establish that a Hub choice was deleted.
            managedChoiceBlocked = true; flight.error = catalogError();
          } else if (!availableRow || (selection.model || latest.model)?.unavailable) {
            if (!rows.length) {
              options.modelAvailabilityChanged?.({ ...selection, name: selected, model: {
                ...(selection.model || latest.model || {}), unavailable: true,
                label: '暂无可用模型，请检查模型配置',
              } });
              flight.error = modelError('MODEL_UNAVAILABLE', '暂无可用模型，请检查模型配置后重试；输入已保留。');
              catalogScope = scope; render(); return false;
            }
            // A successful directory read proves the old choice is absent.
            // Switch through the normal IPC so runtime state and persistence
            // match the displayed replacement; never infer deletion on errors.
            const target = availableRow || (latest.devicePreview && rows.find(row => row.name === response.defaultModels?.[adapter])) || rows[0];
            const request = (async () => {
              const result = latest.draftOnly
                ? await options.draft.selectModel(target.name, target.label)
                : await global.soduWorkAPI.conversationSession.selectModel(latest.ref, target.name);
              if (lifecycle.signal.aborted || scope !== modelScope() || !result?.ok) return false;
              const live = options.state(), liveName = live.selection?.name || live.selection?.model?.id || live.model?.id || '';
              if (liveName !== selected && liveName !== target.name) return false;
              options.modelSelected(result.selection);
              if (result.thinking) options.thinkingChanged?.(result.thinking);
              return true;
            })();
            // A dispatched selection may commit after the caller stops waiting.
            // Retain its acknowledgement and never roll back or launch another mutation on timeout.
            modelRequest = request; selecting = true; flight.stage = 'selection'; flight.selection = request;
            automaticSelections.set(request, flight);
            try { if (!await request) {
              flight.error = modelError('MODEL_SELECTION_FAILED', '模型切换未能确认，请重新选择模型后重试；输入已保留。');
              return false;
            } }
            finally { if (modelRequest === request) { modelRequest = null; selecting = false; } }
            if (!valid()) { render(); return stale(); }
          }
        }
        catalogScope = scope;
        render();
        if (pop.hidden) return !managedChoiceBlocked;
        if (nativeMode(options.state()) && nativeView === 'effort') {
          if (pop.querySelector('.cp-effort-card')) paintNativeEffort();
          else { renderNativeEffort(); pop.querySelector('[data-native-list]')?.focus({ preventScroll: true }); }
          return true;
        }
        if (!rows.length) {
          pop.querySelector('.nmodel-options').innerHTML = '<p class="nmodel-message">' +
            (native ? (current.cloudHandoff ? '云端 Agent 暂未提供模型列表。' : '该 Agent 暂未提供可切换的模型。') : '暂无可用模型，请检查模型服务授权。') + '</p>'; return native;
        }
        const listNode = pop.querySelector('.nmodel-options'), scroll = listNode?.scrollTop || 0;
        const focusedName = pop.contains(document.activeElement) ? document.activeElement?.dataset?.modelName : '';
        list(pop.querySelector('input')?.value || '');
        if (focusedName) Array.from(pop.querySelectorAll('[data-model-name]')).find(row => row.dataset.modelName === focusedName)?.focus({ preventScroll: true });
        if (listNode) listNode.scrollTop = scroll;
        renderThinking(options.state()); positionModels();
        return !managedChoiceBlocked;
      } catch (error) {
        flight.error = modelErrors.has(error) ? error : flight.stage === 'selection'
          ? modelError('MODEL_SELECTION_FAILED', '模型切换未能确认，请重新选择模型后重试；输入已保留。') : catalogError();
        if (scope === modelScope() && flight.version === catalogVersion && !pop.hidden && pop.querySelector('.nmodel-options'))
          pop.querySelector('.nmodel-options').innerHTML = '<p class="nmodel-message">' + esc(flight.error.message) + '</p>';
        return false;
      } finally { catalogLoads--; }
    }
    const offModels = global.soduWorkAPI?.conversationSession?.onModelsChanged?.(() => { void loadModels(true); });
    const refreshVisibleModels = () => {
      if (!catalogLoads && el.isConnected && el.getClientRects().length && document.visibilityState !== 'hidden') void loadModels();
    };
    on(global, 'focus', refreshVisibleModels);
    const modelTimer = global.setInterval?.(refreshVisibleModels, 60000);

    on(pop, 'input', event => {
      if (event.target.matches('[data-effort-slider]')) {
        const model = nativeModels.find(row => row.id === nativeSelection(options.state()).modelName);
        chooseNativeEffort(effortView().levels(model)[Number(event.target.value)]); return;
      }
      if (event.target.matches('input[type=search]')) list(event.target.value);
    });
    on(pop, 'click', async event => {
      event.stopPropagation();
      if (event.target.closest('[data-model-close]')) { close(true); return; }
      if (event.target.closest('[data-native-list]')) { nativeView = 'models'; renderNativeEffort(); pop.querySelector('input')?.focus(); return; }
      if (event.target.closest('[data-native-back]')) { nativeView = 'effort'; renderNativeEffort(); pop.querySelector('[data-native-list]')?.focus(); return; }
      if (event.target.closest('[data-effort-reset]')) {
        chooseNativeEffort(effortView().defaultLevel(nativeModels.find(row => row.id === nativeSelection(options.state()).modelName))); return;
      }
      const thinkingToggle = event.target.closest('[data-thinking-toggle]');
      if (thinkingToggle) {
        const state = options.state(), thinking = state.thinking || {};
        if (!state.ref || thinkingBusy || !thinking.supported || thinking.canDisable === false) return;
        thinkingBusy = true; pop.setAttribute('aria-busy', 'true'); renderThinking(state);
        try {
          const result = await global.soduWorkAPI.conversationSession.setThinking(state.ref, !thinking.enabled);
          if (state.ref !== options.state().ref) return;
          if (!result || !result.ok) { options.say(result && result.reason || '\u601d\u8003\u6a21\u5f0f\u5207\u6362\u5931\u8d25'); return; }
          if (typeof options.thinkingChanged === 'function') options.thinkingChanged(result.thinking);
          renderThinking(options.state());
        } catch (_) { options.say('\u601d\u8003\u6a21\u5f0f\u66f4\u65b0\u672a\u5b8c\u6210\uff0c\u8bf7\u91cd\u8bd5'); }
        finally { thinkingBusy = false; pop.removeAttribute('aria-busy'); renderThinking(options.state()); }
        return;
      }
      const choice = event.target.closest('[data-model-name]');
      if (!choice || selecting) return;
      const ref = options.state().ref, adapterId = options.state().adapterId, name = choice.dataset.modelName, epoch = effortEpoch;
      const current = () => epoch === effortEpoch && ref === options.state().ref && adapterId === options.state().adapterId;
      selecting = true; pop.setAttribute('aria-busy', 'true');
      const request = (async () => { try {
        if ((effortRequest && !await effortRequest) || !current()) return false;
        const result = options.state().draftOnly
          ? await options.draft.selectModel(name, rows.find(row => row.name === name)?.label)
          : await global.soduWorkAPI.conversationSession.selectModel(ref, name);
        if (!current()) return false;
        if (!result || !result.ok) { options.say(result && result.reason || '\u6a21\u578b\u5207\u6362\u5931\u8d25\uff0c\u5f53\u524d\u8bbe\u7f6e\u672a\u6539\u53d8'); return false; }
        options.modelSelected(result.selection);
        if (result.thinking) options.thinkingChanged?.(result.thinking);
        else if (options.state().draftOnly && nativeMode(options.state())) {
          const model = nativeModels.find(row => row.id === name), levels = effortView().levels(model);
          options.thinkingChanged?.({ supported: Boolean(levels.length), enabled: Boolean(levels.length),
            level: effortView().defaultLevel(model), levels, defaultLevel: effortView().defaultLevel(model) });
        }
        if (nativeMode(options.state())) {
          nativeView = 'effort'; renderNativeEffort(); pop.querySelector('[data-native-list]')?.focus();
        } else close(true);
        render();
        return true;
      } catch (_) { if (current()) options.say('\u6a21\u578b\u5207\u6362\u672a\u5b8c\u6210\uff0c\u8bf7\u91cd\u8bd5\uff1b\u4f1a\u8bdd\u5185\u5bb9\u5df2\u4fdd\u7559'); return false; }
      })().finally(() => {
        if (modelRequest === request) { modelRequest = null; selecting = false; pop.removeAttribute('aria-busy'); }
      });
      modelRequest = request;
      await request;
    });

    on(el, 'keydown', event => {
      if (event.key === 'Escape' && meta && meta.classList.contains('show-detail')) { event.stopPropagation(); closeContext(); }
      if (event.key === 'Escape' && !pop.hidden && nativeMode(options.state()) && nativeView === 'models') {
        event.preventDefault(); event.stopPropagation(); nativeView = 'effort'; renderNativeEffort(); pop.querySelector('[data-native-list]')?.focus(); return;
      }
      if (event.key === 'Escape' && !pop.hidden) { event.stopPropagation(); close(wrap.contains(event.target)); }
      if (event.target.matches('[data-effort-slider]')) return;
      if (pop.contains(event.target) && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
        const items = [...pop.querySelectorAll('[role="option"]')], index = items.indexOf(document.activeElement);
        if (items.length) { event.preventDefault(); items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
      }
      const grip = event.target.closest('[data-queue-grip]');
      if (grip && event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault(); void options.updateQueue(grip.dataset.queueGrip, event.key === 'ArrowUp' ? 'up' : 'down', '');
      }
    });
    on(document, 'click', event => {
      if (!wrap.contains(event.target)) close();
      if (meta && !meta.contains(event.target)) closeContext();
    });
    on(queue, 'toggle', event => {
      const menu = event.target;
      if (!menu.matches('.nqueue-more') || !menu.open) return;
      queue.querySelectorAll('.nqueue-more[open]').forEach(other => { if (other !== menu) other.open = false; });
      const rect = menu.querySelector('summary').getBoundingClientRect(), panel = menu.querySelector('div');
      panel.style.right = Math.max(8, innerWidth - rect.right) + 'px';
      panel.style.top = Math.max(8, rect.top - 84) + 'px';
    }, true);
    on(document, 'click', event => {
      if (!event.target.closest('.nqueue-more')) queue.querySelectorAll('.nqueue-more[open]').forEach(menu => { menu.open = false; });
    });
    const clearDrag = () => {
      queue.querySelectorAll('.is-dragging,.drop-before,.drop-after').forEach(row =>
        row.classList.remove('is-dragging', 'drop-before', 'drop-after'));
      drag = null; options.renderQueue();
    };
    // Pointer capture also works in Electron on Windows, where native HTML drag
    // from a nested button may never start. Only the grip consumes pointer input.
    on(queue, 'pointerdown', event => {
      const grip = event.target.closest('[data-queue-grip]');
      if (!grip || event.button !== 0) return;
      event.preventDefault();
      drag = { id: grip.dataset.queueGrip, ref: options.state().ref, pointer: event.pointerId,
        startY: event.clientY, moved: false, before: null };
      grip.setPointerCapture(event.pointerId); grip.focus();
    });
    on(queue, 'pointermove', event => {
      if (!drag || drag.pointer !== event.pointerId) return;
      if (!drag.moved && Math.abs(event.clientY - drag.startY) < 4) return;
      drag.moved = true;
      const items = [...queue.querySelectorAll('[data-queue-draggable]')];
      const source = items.find(row => row.dataset.queueRow === drag.id);
      if (source) source.classList.add('is-dragging');
      queue.querySelectorAll('.drop-before,.drop-after').forEach(row => row.classList.remove('drop-before', 'drop-after'));
      const others = items.filter(row => row !== source);
      const target = others.find(row => { const r = row.getBoundingClientRect(); return event.clientY < r.y + r.height / 2; });
      drag.before = target ? target.dataset.queueRow : '';
      if (target) target.classList.add('drop-before');
      else if (others.length) others.at(-1).classList.add('drop-after');
    });
    on(queue, 'pointerup', event => {
      if (!drag || drag.pointer !== event.pointerId) return;
      const pending = drag; clearDrag();
      if (pending.moved && pending.before !== null && pending.ref === options.state().ref)
        void options.updateQueue(pending.id, 'before', pending.before);
    });
    on(queue, 'pointercancel', () => { if (drag && drag.pointer !== undefined) clearDrag(); });
    on(queue, 'dragstart', event => {
      if (drag && drag.pointer !== undefined) { event.preventDefault(); return; }
      const row = event.target.closest('[data-queue-draggable]');
      if (!row) { event.preventDefault(); return; }
      drag = { id: row.dataset.queueRow, ref: options.state().ref };
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', drag.id);
      row.classList.add('is-dragging');
    });
    on(queue, 'dragover', event => {
      if (!drag) return;
      const row = event.target.closest('[data-queue-draggable]');
      if (!row) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'move';
      queue.querySelectorAll('.drop-before,.drop-after').forEach(x => x.classList.remove('drop-before', 'drop-after'));
      const after = event.clientY > row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
      row.classList.add(after ? 'drop-after' : 'drop-before');
    });
    on(queue, 'drop', event => {
      const row = event.target.closest('[data-queue-draggable]');
      if (!drag || !row) return;
      event.preventDefault();
      const { id, ref } = drag;
      const ordered = [...queue.querySelectorAll('[data-queue-draggable]')];
      const after = row.classList.contains('drop-after');
      const target = after ? ordered[ordered.indexOf(row) + 1] : row;
      const before = target ? target.dataset.queueRow : '';
      clearDrag();
      if (ref === options.state().ref && id !== before && id !== row.dataset.queueRow) void options.updateQueue(id, 'before', before);
    });
    on(queue, 'dragend', clearDrag);
    async function waitForAccess() {
      // Capture pending choices before other awaits can clear a failed result.
      const model = modelRequest, effort = effortRequest, deadline = Date.now() + MODEL_WAIT_MS;
      const identity = () => {
        const state = options.state();
        return JSON.stringify([global.SoduWorkAPI?.taskStorageKey?.('ops') || '',
          state.ref || 'draft:' + state.draftId, state.cloudHandoff?.phase || '']);
      };
      const requested = identity();
      const waitChoice = promise => bounded(promise || true, deadline, selectionTimeout);
      const waitedModels = [];
      const waitModel = promise => {
        if (promise) waitedModels.push(promise);
        return waitChoice(promise);
      };
      const waitAccess = promise => bounded(promise || true, deadline, () => modelError('EXECUTION_OPTIONS_UNCONFIRMED',
        '执行选项尚未确认，请稍候重试；输入已保留。'));
      const ready = (await waitAccess(runtimePicker?.wait())) && (await waitAccess(sessionControls?.wait())) &&
        (await waitModel(model)) && (await waitModel(modelRequest)) && (await waitChoice(effort)) &&
        (await waitChoice(effortRequest)) && (await waitAccess(options.draft?.ready()));
      if (requested !== identity() || lifecycle.signal.aborted) return false;
      if (!options.state().ref && !options.state().draftOnly) return false;
      if (!ready) {
        const failed = waitedModels.map(request => automaticSelections.get(request)?.error).find(Boolean);
        if (failed) throw failed;
        return false;
      }
      if (['codex'].includes(options.state().adapterId)) return true;
      // A confirmed Agent switch may change the adapter while preserving the conversation.
      const scope = modelScope();
      // Recheck at send time and share an in-flight read. A model-change push
      // supersedes that read; follow the latest directory without releasing send admission.
      let promise = loadModels(), flight = catalogFlight;
      while (!lifecycle.signal.aborted && scope === modelScope()) {
        const result = await bounded(Promise.race([promise, flight.superseded]), deadline, () => {
          if (modelRequest || flight.stage === 'selection') return selectionTimeout();
          return modelError('MODEL_CATALOG_TIMEOUT', '读取模型列表超时，请检查连接后重试；输入已保留。');
        }, () => { if (flight.stage === 'read') flight.invalidated = true; });
        if (scope !== modelScope() || lifecycle.signal.aborted) return false;
        if (flight !== catalogFlight) {
          flight = catalogFlight; promise = flight.promise; continue;
        }
        if (flight.error) throw flight.error;
        if (result && !flight.invalidated) return true;
        if (!flight.stale && !flight.invalidated) throw catalogError();
        if (!await waitChoice(modelRequest)) throw modelError('MODEL_SELECTION_FAILED', '模型切换未能确认，请重新选择模型后重试；输入已保留。');
        promise = loadModels(true); flight = catalogFlight;
      }
      return false;
    }
    return { render, positionContext, waitForAccess, destroy() { offModels?.(); global.clearInterval?.(modelTimer); effortEpoch++; pendingEffort = null; options.draft?.destroy(); runtimePicker?.destroy(); sessionControls?.destroy(); close(); closeContext(); lifecycle.abort(); supersedeCatalog(); drag = null; }, isDragging: () => Boolean(drag), reset() { runtimePicker?.reset(); sessionControls?.reset(); close(); closeContext(); drag = null; render(); } };
  }
  global.ChatComposerControls = { create };
})(window);
