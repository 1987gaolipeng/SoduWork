(function (global) {
  'use strict';

  const tx = value => (global.SoduWorkI18n && typeof global.SoduWorkI18n.translateText === 'function'
    ? global.SoduWorkI18n.translateText(value) : value) || value;

  const EFFORT_LABELS = Object.freeze({
    minimal: '极简', low: '低', medium: '中', high: '高',
    xhigh: '极高', max: '最高', ultra: '超高',
  });
  const states = new Map();
  let enterpriseModels = [];
  let enterpriseDefaultErrors = {};
  let managedCatalogUnavailable = false;
  let loadPromise = null;
  let loadChanged, signalLoadChange;
  let imageModels = [];
  let nativeModels = [], nativeCatalogAvailable = false;
  let nativeReason = '', nativeRetryable = false;
  let activeRuntime = '';
  let activeScope = '';
  let activeOwner = '';
  let loading = null;
  let enterpriseLoaded = false;
  let nativeLoaded = '';
  let loadSeq = 0;
  let options = {};
  let offModels = null;
  let searchQuery = '';
  let nativeView = 'effort';
  let preparedCatalog = null;
  let cancelReplacement = null;

  function runtime() {
    const id = global.ComposeRuntime ? ComposeRuntime.value() : 'pi';
    const rows = global.ComposeRuntime ? ComposeRuntime.catalog() : [];
    return rows.find((row) => row.id === id) ||
      { id, displayName: id === 'codex' ? 'Codex' : 'Agent', modelMode: 'managed' };
  }
  const cloud = () => global.ComposeRuntime?.location?.() === 'cloud';
  const deviceLocal = model => model?.localOnly === true || String(model?.name || '').startsWith('local:');
  const usable = model => model && model.available !== false && model.unavailable !== true &&
    !/^(?:unavailable:|local:unavailable$)/.test(String(model.name || '')) && (!deviceLocal(model) || !cloud());

  function textChoice(model) {
    return { name: model.name, source: deviceLocal(model) ? 'local' : 'hub', provider: model.providerId || '' };
  }

  function matchesChoice(choice, candidate) {
    return choice.name === candidate.name && choice.source === candidate.source &&
      (!choice.provider || choice.provider === candidate.provider);
  }

  function uniqueTextChoice(choice, models) {
    const matches = models.filter(model => model.name === choice.name);
    return matches.length === 1 && matchesChoice(choice, textChoice(matches[0]));
  }

  function supportsTextModel(target, model) {
    // All local managed Agents obtain Hub models through ai-proxy/config.
    // Device models bypass that proxy. Remote runners supply their own adapters.
    if (!cloud() && !deviceLocal(model) && model.providerKind && model.providerKind !== 'openai-compat') return false;
    if (cloud() && ['codex-harness', 'qwen'].includes(target.id) && model.providerKind === 'anthropic') return false;
    return cloud() || target.id !== 'pi' || model.capabilityProfile?.streaming?.state !== 'unsupported';
  }

  function selectReplacement(target, currentLabel, candidates) {
    if (!document.createElement || !candidates.length) return Promise.resolve(null);
    cancelReplacement?.();
    const dialog = document.createElement('dialog');
    dialog.className = 'app-confirm-dialog cp-switch-model';
    dialog.setAttribute('aria-label', tx('当前模型无法用于目标底座'));
    dialog.innerHTML = '<form method="dialog" class="app-confirm-card"><b class="app-confirm-title">' +
      escape(tx('当前模型无法用于目标底座')) + '</b><p class="app-confirm-message"></p><label>' +
      escape(tx('切换后使用')) + '<select required></select></label><footer class="app-confirm-foot">' +
      '<button type="button" class="app-confirm-cancel">' + escape(tx('取消')) + '</button>' +
      '<button type="submit" class="app-confirm-submit">' + escape(tx('使用此模型并切换')) + '</button></footer></form>';
    dialog.querySelector('p').textContent = currentLabel + ' → ' + (target.displayName || target.id);
    const list = dialog.querySelector('select');
    candidates.forEach((item, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = [...new Set([item.label, item.provider, item.name].filter(Boolean))].join(' · ');
      list.append(option);
    });
    return new Promise(resolve => {
      const finish = value => { cancelReplacement = null; dialog.remove(); resolve(value); };
      cancelReplacement = () => finish(null);
      dialog.querySelector('form').onsubmit = event => { event.preventDefault(); finish(candidates[list.selectedIndex]); };
      dialog.querySelector('.app-confirm-cancel').onclick = cancelReplacement;
      dialog.oncancel = event => { event.preventDefault(); finish(null); };
      document.body.append(dialog); dialog.showModal(); list.focus();
    });
  }

  function loadContext(row = runtime()) {
    // This public scope contains Hub/device/account identifiers, never tokens.
    const owner = String(global.SoduWorkAPI?.taskStorageKey?.('ops') || 'renderer');
    return { owner, key: JSON.stringify([owner, cloud() ? 'cloud' : 'local', row.id, row.modelMode]) };
  }

  function state(id) {
    const key = (cloud() ? 'cloud:' : 'local:') + String(id || 'pi');
    if (!states.has(key)) states.set(key, { modelName: '', reasoningEffort: '', thinkingLevel: '', modelChosen: false });
    return states.get(key);
  }

  function protectedSelection(selected) {
    return selected.directoryPreference || selected.carriedChoice ||
      (selected.modelChosen && Boolean(global.ComposeRuntime?.pendingSelection?.()));
  }

  function escape(value) {
    return options.escape ? options.escape(value) : String(value == null ? '' : value)
      .replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function api() {
    return typeof options.api === 'function' ? options.api() : null;
  }

  function modelById(id) {
    return nativeModels.find((row) => row.id === id) || null;
  }

  function effortChoices(selected) {
    return Object.keys(EFFORT_LABELS).filter(effort => selected?.reasoningLevels?.includes(effort));
  }

  function defaultEffort(model) {
    const levels = effortChoices(model);
    return levels.includes('medium') ? 'medium'
      : levels.includes(model?.defaultReasoning) ? model.defaultReasoning : levels[0] || '';
  }

  function reconcileEffort(selected) {
    const model = modelById(selected.modelName);
    if (!effortChoices(model).includes(selected.reasoningEffort)) {
      selected.reasoningEffort = defaultEffort(model);
    }
  }

  function currentLabel(row, selected) {
    if (selected.catalogUnavailable) return selected.modelName;
    if (selected.unavailable) return tx(deviceLocal({ name: selected.modelName }) ||
      global.SoduWorkModelChoice?.imageChoice(selected.modelName)?.name.startsWith('local:')
      ? '原本地模型已删除或不可用，请重新选择' : '原模型已不可用，请重新选择');
    if (row.id === 'codex') {
      const model = modelById(selected.modelName);
      const modelLabel = model?.label || selected.modelName || tx('Codex 默认');
      const effortLabel = selected.reasoningEffort
        ? EFFORT_LABELS[selected.reasoningEffort] || selected.reasoningEffort : '';
      return modelLabel + (effortLabel ? ' · ' + effortLabel : '');
    }
    const image = imageModels.find(item => global.SoduWorkModelChoice?.imageKey(item) === selected.modelName);
    if (image) return '生成图片 · ' + (image.label || image.name);
    const model = enterpriseModels.find((item) => item.name === selected.modelName);
    return model ? (model.label || model.name) : tx('选择模型');
  }

  function clearStaleManagedSelection(row) {
    if (row.modelMode !== 'managed') return;
    const selected = state(row.id);
    selected.catalogUnavailable = false;
    const chatMatch = enterpriseModels.find((item) => item.name === selected.modelName);
    const imageMatch = !cloud() && row.id === 'pi' && imageModels.some((item) =>
      global.SoduWorkModelChoice && SoduWorkModelChoice.imageKey(item) === selected.modelName);
    if (chatMatch && selected.choice && (!uniqueTextChoice(selected.choice, enterpriseModels) ||
        selected.carriedChoice && !supportsTextModel(row, chatMatch))) {
      selected.unavailable = true; return;
    }
    if (!chatMatch && !imageMatch) {
      const localSelection = deviceLocal({ name: selected.modelName }) ||
        global.SoduWorkModelChoice?.imageChoice(selected.modelName)?.name.startsWith('local:');
      // A local-only fallback directory cannot prove a Hub model was deleted.
      if (managedCatalogUnavailable && selected.modelName && !localSelection) {
        selected.catalogUnavailable = true;
        return;
      }
      // A directory preference is a pair. Keep a missing saved model visible
      // until the user explicitly chooses a replacement instead of sending with a fallback.
      if (protectedSelection(selected)) { selected.unavailable = true; return; }
      const available = enterpriseModels.map(item => item.name);
      if (!cloud() && row.id === 'pi' && global.SoduWorkModelChoice) {
        available.push(...imageModels.map(item => SoduWorkModelChoice.imageKey(item)));
      }
      // New and removed choices use the first available row, with
      // device-owned models first. Valid current choices stay unchanged.
      const next = available[0];
      selected.unavailable = !next;
      if (next) { selected.modelName = next; selected.modelChosen = false; delete selected.choice; }
      selected.thinkingLevel = '';
    } else selected.unavailable = false;
  }

  function check() {
    return '<span class="cp-mtick"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>';
  }

  function heading(subtitle, back = false) {
    return '<div class="cp-model-heading">' + (back ? '<button type="button" class="cp-model-back" data-native-back aria-label="' + escape(tx('返回推理设置')) + '">‹</button>' : '') + '<span><b>' + escape(tx('选择模型')) + '</b><i>' + escape(tx(subtitle)) +
      '</i></span><button type="button" class="cp-model-close" data-model-close aria-label="关闭模型选择">×</button></div>' +
      '<label class="cp-model-search"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/></svg>' +
      '<input type="search" aria-label="搜索模型" placeholder="搜索可用模型" value="' + escape(searchQuery) + '"></label>';
  }

  function filterModels(pop) {
    const query = searchQuery.trim().toLocaleLowerCase();
    let count = 0;
    pop.querySelectorAll?.('.cp-mrow').forEach((row) => {
      row.hidden = !row.textContent.toLocaleLowerCase().includes(query);
      if (!row.hidden) count++;
    });
    const empty = pop.querySelector?.('.cp-model-empty');
    if (empty) empty.hidden = count > 0;
  }

  function emptyList() {
    return '<p class="cp-model-empty" hidden role="status">没有匹配的可用模型</p>';
  }

  function position() {
    const pop = document.getElementById('cpModelPop');
    const button = document.getElementById('cpModelBtn');
    if (!pop?.classList.contains('show') || !pop.getBoundingClientRect || !button?.getBoundingClientRect) return;
    const anchor = button.getBoundingClientRect();
    const available = Math.min(global.innerHeight - 24, anchor.top - 24);
    pop.style.maxHeight = Math.max(160, Math.min(560, available)) + 'px';
    const rect = pop.getBoundingClientRect();
    pop.style.left = Math.max(12, Math.min((anchor.left + anchor.right - rect.width) / 2, global.innerWidth - 12 - rect.width)) + 'px';
    pop.style.top = Math.max(12, Math.min(anchor.top - 9 - rect.height, global.innerHeight - 12 - rect.height)) + 'px';
  }

  function thinkingProfile(item) {
    const value = item || {};
    const config = value.config && typeof value.config === 'object' ? value.config : {};
    const mode = String(value.thinkingMode || config.thinkingMode || '').trim().toLowerCase();
    const key = String(value.wireModelId || value.modelName || value.name || value.id || '').toLowerCase();
    const fixedGlm = /(?:^|\/)glm[-_]?5[._]3(?:[-_]?flash)?$/i.test(key);
    const reasoning = typeof value.reasoning === 'boolean' ? value.reasoning
      : (typeof config.reasoning === 'boolean' ? config.reasoning : null);
    if (mode === 'none' || fixedGlm && reasoning === false) return { supported: false, canDisable: false };
    const format = value.thinkingFormat || config.thinkingFormat || value.reasoningFormat || value.format;
    const hinted = Boolean(format) || /(?:deepseek|glm|zhipu|qwen|qwq|think|thinking|reason|reasoner|\br1\b|\bo[134]\b|gpt-5)/.test(key);
    const supported = ['always', 'controllable'].includes(mode) || (reasoning === null ? hinted : reasoning);
    const map = { ...(fixedGlm ? { minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' } : {}),
      ...(value.thinkingLevelMap || config.thinkingLevelMap || {}) };
    if (fixedGlm || mode === 'always' || value.thinkingAlwaysOn || config.thinkingAlwaysOn) map.off = null;
    const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].filter(level => map[level] !== null &&
      (!['xhigh', 'max'].includes(level) || map[level] !== undefined));
    return { supported, canDisable: supported && levels.includes('off'), levels,
      onLevel: levels.includes('medium') ? 'medium' : levels.find(level => level !== 'off') || 'low',
      unknown: !supported && reasoning === null };
  }

  function fixedThinkingLevel(info, selected) {
    return info.levels?.includes(selected) ? selected : info.onLevel;
  }

  function managedHtml(selected) {
    const selectedModel = enterpriseModels.find(item => item.name === selected.modelName);
    const thinkingInfo = thinkingProfile(selectedModel);
    const canThink = thinkingInfo.supported;
    const canDisable = thinkingInfo.canDisable;
    const thinkingOn = canThink && (!canDisable || (selected.thinkingLevel && selected.thinkingLevel !== 'off'));
    const rows = enterpriseModels.map((item) => ({
        name: item.name,
        provider: item.providerId || '',
        label: item.label || item.name,
        sub: [item.providerName ? tx(item.providerName) : '', item.providerKind === 'anthropic' ? 'Anthropic' :
          item.providerKind === 'openai-compat' ? tx('OpenAI 兼容') : '',
          item.keyFrom === 'mine' ? tx('自己的额度') : ''].filter(Boolean).join(' \u00b7 '),
      }));
    if (!cloud() && runtime().id === 'pi' && global.SoduWorkModelChoice) rows.push(...imageModels.map(item => ({
      name: SoduWorkModelChoice.imageKey(item), label: item.label || item.name,
      sub: [tx('生成图片'), item.providerName ? tx(item.providerName) : '', item.keyFrom === 'mine' ? tx('自己的额度') : ''].filter(Boolean).join(' \u00b7 '),
    })));
    const isSelected = item => item.name === selected.modelName &&
      (!selected.choice?.provider || item.provider === selected.choice.provider);
    const thinkingLabel = !canThink
      ? '\u5f53\u524d\u6a21\u578b\u4e0d\u63d0\u4f9b\u53ef\u63a7\u601d\u8003'
      : (!canDisable ? '\u5df2\u5f00\u542f \u00b7 \u6a21\u578b\u56fa\u5b9a\u601d\u8003'
        : (thinkingOn ? '\u5df2\u5f00\u542f \u00b7 \u4e2d\u7b49\u5f3a\u5ea6' : '\u5df2\u5173\u95ed \u00b7 \u66f4\u5feb\u54cd\u5e94'));
    const thinkingHint = !canThink ? '\u8bf7\u5207\u6362\u5230\u63a8\u7406\u6a21\u578b\u540e\u4f7f\u7528'
      : (!canDisable ? '\u5f53\u524d\u6a21\u578b\u4e0d\u652f\u6301\u5173\u95ed\u601d\u8003' : '\u53ea\u5bf9\u672c\u6b21\u65b0\u5efa\u7684\u4f1a\u8bdd\u751f\u6548');
    const thinking = !canThink ? '<div class="cp-model-summary"><span>思考模式</span><span>' +
      (thinkingInfo.unknown ? '由服务决定 · 未确认' : '不支持') + '</span></div>' : '<div class="cp-thinking' + (thinkingOn ? ' on' : '') + '">' +
      '<span class="cp-thinking-icon" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M10 2.5v3m0 9v3M2.5 10h3m9 0h3M4.7 4.7l2.1 2.1m6.4 6.4 2.1 2.1m0-10.6-2.1 2.1m-6.4 6.4-2.1 2.1"/><circle cx="10" cy="10" r="3.2"/></svg></span>' +
      '<span class="cp-thinking-copy"><b>\u601d\u8003\u6a21\u5f0f</b><i>' + thinkingLabel + '</i><small>' + thinkingHint + '</small></span>' +
      '<button type="button" class="cp-thinking-switch" role="switch" aria-checked="' + (thinkingOn ? 'true' : 'false') + '" data-thinking-toggle' + (canThink && canDisable ? '' : ' disabled') + '><span></span><em class="sr-only">\u5207\u6362\u601d\u8003\u6a21\u5f0f</em></button></div>';
    return heading(runtime().id === 'pi' && imageModels.length ? '对话与图片模型 · 用于本次会话' : '用于本次会话') +
      '<div class="cp-model-scroll">' + rows.map((item) =>
        '<button type="button" class="cp-mrow' + (isSelected(item) ? ' on' : '') +
          '" aria-pressed="' + isSelected(item) + '" data-model="' + escape(item.name) +
          '" data-provider="' + escape(item.provider || '') + '">' + check() +
          '<span class="cp-model-symbol" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="m10 3 2 5 5 2-5 2-2 5-2-5-5-2 5-2Z"/></svg></span><span class="cp-mtxt"><b>' + escape(item.label) + '</b>' +
            (item.sub ? '<i>' + escape(item.sub) + '</i>' : '') + '</span></button>').join('') +
      emptyList() + '</div>' + (!selected.modelName && enterpriseDefaultErrors[runtime().id]
        ? '<div class="cp-native-note is-warning">默认模型暂不可用，请选择其他模型</div>' : '') +
      (enterpriseModels.some(item => item.providerKind === 'anthropic')
        ? '<div class="cp-native-note is-warning" role="note">企业模型对话通道只支持 OpenAI 兼容协议；列表中的 Anthropic 模型需使用支持其协议的 Agent。</div>' : '') + thinking;
  }

  function codexHtml(selected) {
    const selectedModel = modelById(selected.modelName);
    const reason = nativeReason && !nativeModels.length ? catalogNote(nativeReason, nativeRetryable) : '';
    if (nativeView === 'models') return heading('Codex · 使用本机账号', true) +
      '<div class="cp-model-scroll cp-native-models">' + [{ id: '', label: tx('Codex 默认') }, ...nativeModels].map((item) =>
        '<button type="button" class="cp-mrow' + (item.id === selected.modelName ? ' on' : '') +
          '" aria-pressed="' + (item.id === selected.modelName) + '" data-native-model="' + escape(item.id) + '">' + check() +
          '<span class="cp-mtxt"><b>' + escape(item.label) + '</b></span></button>').join('') +
      emptyList() + '</div>' + reason;
    return reason + effortCard(selected, selectedModel);
  }

  function catalogNote(reason, retryable) {
    if (!reason) return '';
    return '<div class="cp-native-note" role="status">' + escape(tx(reason)) +
      (retryable ? ' <button type="button" data-native-refresh>' + escape(tx('刷新')) + '</button>' : '') + '</div>';
  }

  // Both composers use the same native account model and effort surface.
  function effortCard(selected, selectedModel) {
    const efforts = effortChoices(selectedModel);
    return '<div class="cp-effort-card' + (!efforts.length ? ' is-unavailable' : '') + '">' +
        '<div class="cp-effort-heading"><span aria-hidden="true"></span>' +
          '<button type="button" class="cp-native-model-trigger" data-native-list aria-label="' + escape(tx('选择 Codex 模型')) + '" aria-haspopup="dialog"><b data-effort-label>' + escape(tx(EFFORT_LABELS[selected.reasoningEffort] || '选择模型')) + '</b>' +
          '<small>' + escape(selectedModel?.label || selected.modelName || tx('Codex 默认')) + '<span aria-hidden="true"> ›</span></small></button>' +
          '<button type="button" data-effort-reset aria-label="重置推理强度" title="重置推理强度"' + (!efforts.length ? ' disabled' : '') + '><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 7a6.5 6.5 0 1 1-.3 5M4 3v4h4"/></svg></button></div>' +
        '<div class="cp-effort-track"><div class="cp-effort-fill" aria-hidden="true"><div class="cp-effort-sparks">' +
          [8, 22, 39, 55, 72, 88].map((left, index) => '<span style="--spark-x:' + left + '%;--spark-y:' + (index % 2 ? 68 : 30) + '%;--spark-delay:-' + (index * .21) + 's"></span>').join('') +
          '</div></div><div class="cp-effort-stops" aria-hidden="true">' +
          efforts.map(() => '<span></span>').join('') + '</div>' +
          '<span class="cp-effort-thumb" aria-hidden="true"></span>' +
          '<input type="range" min="0" max="' + Math.max(0, efforts.length - 1) + '" step="1" value="' + Math.max(0, efforts.indexOf(selected.reasoningEffort)) +
          '" data-effort-slider aria-label="推理强度" aria-valuetext="' + escape(EFFORT_LABELS[selected.reasoningEffort] || '不可调节') + '"' + (efforts.length < 2 ? ' disabled' : '') + '></div>' +
        (efforts.length > 1 ? '<div class="cp-effort-endpoints" aria-hidden="true"><span>' + escape(EFFORT_LABELS[efforts[0]]) + '</span><span>' + escape(EFFORT_LABELS[efforts.at(-1)]) + '</span></div>' : '') + '</div>';
  }

  function paintEffort() {
    const selected = state(runtime().id);
    paintEffortCard(document.getElementById('cpModelPop'), selected, modelById(selected.modelName));
  }

  function paintEffortCard(pop, selected, model) {
    const levels = effortChoices(model);
    const index = Math.max(0, levels.indexOf(selected.reasoningEffort));
    const card = pop?.querySelector?.('.cp-effort-card');
    if (!card) return;
    const position = String(levels.length > 1 ? index / (levels.length - 1) : 0);
    card.style.setProperty('--effort-fill', position);
    // The thumb follows the committed stop, not the raw pointer: every level
    // has a stable capture region, with a short transition when crossing it.
    card.style.setProperty('--effort-position', position);
    card.classList.toggle('is-intense', index > 0 && index >= levels.length - 2);
    card.querySelectorAll('.cp-effort-stops span').forEach((dot, i) => dot.classList.toggle('is-reached', i < index));
    const slider = card.querySelector('[data-effort-slider]');
    slider.value = index;
    slider.setAttribute('aria-valuetext', EFFORT_LABELS[selected.reasoningEffort] || '不可调节');
    card.querySelector('[data-effort-label]').textContent = tx(EFFORT_LABELS[selected.reasoningEffort] || '选择模型');
  }

  function previewEffort(event) {
    const slider = event.target.closest?.('[data-effort-slider]');
    if (!slider || slider.disabled) return;
    const card = slider.closest('.cp-effort-card');
    const bounds = slider.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left - 14) / Math.max(1, bounds.width - 28)));
    const levels = effortChoices(modelById(state(runtime().id).modelName));
    const index = Math.round(ratio * (levels.length - 1));
    const pressed = card.dataset.pointerId === String(event.pointerId);
    if (pressed && event.type === 'pointermove') {
      card.classList.add('is-dragging');
    }
    const onThumb = Math.abs(ratio * (levels.length - 1) - Number(slider.value)) *
      (bounds.width - 28) / Math.max(1, levels.length - 1) <= 18;
    card.classList.add('is-hovering');
    card.classList.toggle('is-thumb-hover', onThumb);
    card.querySelectorAll('.cp-effort-stops span').forEach((dot, i) => dot.classList.toggle('is-preview', i === index && !onThumb));
  }

  function finishEffortPointer() {
    const card = document.getElementById('cpModelPop')?.querySelector?.('.cp-effort-card');
    if (!card) return;
    const slider = card.querySelector('[data-effort-slider]');
    const pointerId = Number(card.dataset.pointerId);
    delete card.dataset.pointerId;
    card.classList.remove('is-pressed', 'is-dragging');
    if (slider?.hasPointerCapture?.(pointerId)) slider.releasePointerCapture(pointerId);
    paintEffort();
  }

  function leaveEffort(event) {
    const slider = event.target.closest?.('[data-effort-slider]');
    if (!slider) return;
    const card = slider.closest('.cp-effort-card');
    card.classList.remove('is-hovering', 'is-thumb-hover');
    card.querySelectorAll('.cp-effort-stops span').forEach(dot => dot.classList.remove('is-preview'));
  }

  function render() {
    const wrap = document.querySelector('.cp-modelwrap');
    const pop = document.getElementById('cpModelPop');
    const button = document.getElementById('cpModelBtn');
    const name = document.getElementById('cpModelName');
    if (!wrap || !pop || !button || !name) return;

    const row = runtime();
    if (enterpriseLoaded) clearStaleManagedSelection(row);
    const selected = state(row.id);
    const supported = row.modelMode === 'managed'
      ? selected.unavailable || enterpriseModels.length > 0 || (row.id === 'pi' && imageModels.length > 0) : row.id === 'codex';
    wrap.style.display = supported ? '' : 'none';
    if (cloud() && row.modelMode === 'account') {
      wrap.style.display = ''; name.textContent = tx('云端默认模型'); button.disabled = true;
      button.title = tx('使用云端执行机账号配置的模型'); close(); return;
    }
    button.disabled = false;
    if (!supported) {
      close();
      return;
    }

    const label = currentLabel(row, selected);
    name.textContent = label;
    button.dataset.label = '模型';
    button.dataset.runtimeMode = row.id === 'codex' ? 'native' : 'managed';
    button.title = (row.id === 'codex' ? tx('Codex 设置：') : tx('模型：')) + label;
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-haspopup', 'dialog');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', tx(row.id === 'codex' ? 'Codex 模型与推理设置' : '对话与图片模型选择'));
    const active = document.activeElement;
    const focused = pop.contains?.(active) ? {
      search: active.matches('input[type="search"]'),
      start: active.selectionStart, end: active.selectionEnd,
      nativeModel: active.getAttribute('data-native-model'), model: active.getAttribute('data-model'),
      effort: active.matches('[data-effort-slider]'), reset: active.matches('[data-effort-reset]'), thinking: active.matches('[data-thinking-toggle]'),
      nativeList: active.matches('[data-native-list]'), back: active.matches('[data-native-back]'),
      close: active.matches('[data-model-close]'),
    } : null;
    const scroll = pop.querySelector?.('.cp-model-scroll')?.scrollTop || 0;
    pop.dataset.modelView = row.id === 'codex' ? nativeView : 'managed';
    pop.innerHTML = row.id === 'codex' ? codexHtml(selected) : managedHtml(selected);
    try { global.SoduWorkI18n?.translateNode?.(pop); } catch (_) {}
    paintEffort();
    filterModels(pop);
    position();
    if (focused && pop.classList.contains('show')) {
      const target = focused.search ? pop.querySelector('input[type="search"]')
        : focused.effort ? pop.querySelector('[data-effort-slider]')
          : focused.reset ? pop.querySelector('[data-effort-reset]')
          : focused.nativeList ? pop.querySelector('[data-native-list]')
          : focused.back ? pop.querySelector('[data-native-back]')
          : focused.thinking ? pop.querySelector('[data-thinking-toggle]')
            : focused.close ? pop.querySelector('[data-model-close]')
              : Array.from(pop.querySelectorAll('.cp-mrow')).find((item) =>
                focused.nativeModel !== null ? item.getAttribute('data-native-model') === focused.nativeModel
                  : focused.model !== null && item.getAttribute('data-model') === focused.model);
      if (target && !target.hidden) {
        target.focus({ preventScroll: true });
        if (focused.search) target.setSelectionRange(focused.start, focused.end);
      }
    }
    const list = pop.querySelector?.('.cp-model-scroll');
    if (list) list.scrollTop = scroll;
  }

  async function load(force, row, sequence, scope) {
    const current = () => sequence === loadSeq && scope === loadContext().key;
    const prepared = preparedCatalog?.scope === scope ? preparedCatalog.response : null;
    preparedCatalog = null;
    if (cloud() && row.modelMode === 'account') return render();
    if (row.modelMode === 'managed') {
      if (enterpriseLoaded && !force) { render(); notify(); return; }
      try {
        const response = prepared || await global.SoduWorkAPI?.myModels?.({ localDefaults: !cloud() });
        if (!current()) return;
        if (!response || response.ok === false || !Array.isArray(response.usable)) throw Error('模型目录暂时不可用');
        // Device-owned connections can be paired with any local managed
        // runtime. Cloud execution must never receive their private references.
        enterpriseModels = response.usable.filter(usable)
          .sort((a, b) => Number(deviceLocal(b)) - Number(deviceLocal(a)));
        enterpriseDefaultErrors = response?.defaultModelErrors || {};
        managedCatalogUnavailable = response.managedCatalogUnavailable === true;
        imageModels = Array.isArray(response?.mediaUsable?.image)
          ? response.mediaUsable.image.filter(usable) : [];
        clearStaleManagedSelection(row);
        enterpriseLoaded = true;
      } catch (error) {
        if (!current()) return;
        // A temporary lookup failure must not discard the known selection.
      }
      render();
      notify();
      return;
    }
    if (row.id === 'codex') {
      if (nativeLoaded === row.id && !force) return render();
      if (!nativeModels.length) { nativeReason = '正在加载模型…'; nativeRetryable = false; render(); }
      try {
        const bridge = api();
        const response = prepared || await bridge?.runtimeModels?.(row.id);
        if (!current()) return;
        if (!response?.ok || !Array.isArray(response.models)) throw Error('模型目录暂时不可用');
        nativeModels = response.models;
        nativeCatalogAvailable = response.catalogAvailable !== false;
        const selected = state(row.id);
        const protectedChoice = selected.modelChosen || protectedSelection(selected);
        if (nativeCatalogAvailable) {
          if (!protectedChoice && !modelById(selected.modelName)) selected.modelName = '';
          selected.unavailable = Boolean(protectedChoice && selected.modelName && !modelById(selected.modelName));
          reconcileEffort(selected);
        }
        nativeReason = String(response.reason || (nativeCatalogAvailable ? '' : '本机 Codex 模型目录暂时无法读取，可继续使用默认模型'));
        nativeRetryable = response.retryable === true || !nativeCatalogAvailable;
        nativeLoaded = row.id;
      } catch (error) {
        if (!current()) return;
        nativeModels = []; nativeCatalogAvailable = false; nativeRetryable = true;
        nativeReason = '本机 Codex 模型目录暂时无法读取，可继续使用默认模型';
      }
      render();
      notify();
    }
  }

  function chooseModel(id, provider) {
    global.ComposeDirectoryPreferences?.selectionCommitted?.();
    const row = runtime();
    const selected = state(row.id);
    selected.modelChosen = true;
    selected.unavailable = false;
    selected.catalogUnavailable = false;
    selected.carriedChoice = false;
    selected.modelName = String(id || '');
    const chatModel = enterpriseModels.find(item => item.name === id && (!provider || provider === item.providerId));
    selected.choice = row.modelMode === 'account' ? { source: row.id, name: id }
      : chatModel ? textChoice(chatModel) : { source: 'image', name: id };
    if (chatModel && !uniqueTextChoice(selected.choice, enterpriseModels)) selected.unavailable = true;
    if (row.id !== 'codex') {
      const picked = enterpriseModels.find(item => item.name === selected.modelName) ||
        (selected.modelName ? null : enterpriseModels[0]);
      const info = thinkingProfile(picked);
      if (!info.supported) selected.thinkingLevel = '';
      else if (!info.canDisable) selected.thinkingLevel = fixedThinkingLevel(info, selected.thinkingLevel);
    }
    if (row.id === 'codex') { reconcileEffort(selected); nativeView = 'effort'; searchQuery = ''; }
    render();
    notify();
  }

  async function switchCatalog(target, choice) {
    let response, candidates;
    if (target.modelMode === 'managed') {
      response = await global.SoduWorkAPI?.myModels?.({ localDefaults: !cloud() });
      const hubImage = choice.source === 'image' && !global.SoduWorkModelChoice?.imageChoice(choice.name)?.name.startsWith('local:');
      if (!Array.isArray(response?.usable) || response.ok === false ||
          response.managedCatalogUnavailable && (choice.source === 'hub' || hubImage)) {
        return null;
      }
      const models = response.usable.filter(usable);
      const names = new Set(), duplicates = new Set();
      for (const model of models) {
        if (names.has(model.name)) duplicates.add(model.name);
        names.add(model.name);
      }
      candidates = models.filter(model => !duplicates.has(model.name) && supportsTextModel(target, model)).map(model => ({
        ...textChoice(model), label: model.label || model.name,
      }));
      if (!cloud() && target.id === 'pi' && global.SoduWorkModelChoice) {
        for (const model of (response.mediaUsable?.image || []).filter(usable)) candidates.push({
          name: SoduWorkModelChoice.imageKey(model), source: 'image', label: model.label || model.name,
        });
      }
    } else if (target.id === 'codex' && !cloud()) {
      response = await api()?.runtimeModels?.(target.id);
      if (!response?.ok || !Array.isArray(response.models)) return null;
      candidates = [{ source: target.id, name: '', label: tx('Codex 默认') },
        ...response.models.map(model => ({ source: target.id, name: model.id, label: model.label || model.id }))];
    }
    if (!candidates || target.modelMode === 'account' && !candidates.length) {
      candidates = [{ source: 'account', name: '', label: tx('使用底座账号默认模型') }];
    }
    return { response, candidates };
  }

  // The caller commits this prepared model and its Agent in one turn. Until
  // then the input, its capabilities and its current model stay together.
  async function prepareRuntimeSwitch(target, isCurrent, say = () => {}) {
    const source = runtime(), selected = state(source.id);
    if (source.id === target.id || !selected.modelChosen || !selected.choice) return;
    const choice = selected.choice, scope = loadContext().key;
    const current = () => isCurrent() && scope === loadContext().key && state(source.id).choice === choice;
    let catalog = await switchCatalog(target, choice);
    if (!current()) return false;
    if (!catalog) { say(tx('模型目录暂时不可用')); return false; }
    const { candidates } = catalog;
    let next = candidates.find(candidate => matchesChoice(choice, candidate));
    const preservesModel = Boolean(next);
    if (!next) {
      if (!candidates.length) { say(tx('目标底座没有可明确选择的可用模型')); return false; }
      next = await selectReplacement(target, currentLabel(source, selected), candidates);
      if (!next || !current()) return false;
      catalog = await switchCatalog(target, next);
      if (!current()) return false;
      if (!catalog?.candidates.some(candidate => matchesChoice(next, candidate))) {
        say(tx('原模型已不可用，请重新选择')); return false;
      }
    }
    return {
      preservesModel,
      apply() {
        const dest = state(target.id);
        if (dest.modelName !== next.name) { dest.thinkingLevel = ''; dest.reasoningEffort = ''; }
        Object.assign(dest, { modelName: next.name, modelChosen: Boolean(next.name), choice: next,
          carriedChoice: Boolean(next.name), unavailable: false, catalogUnavailable: false });
        preparedCatalog = { scope: loadContext(target).key, response: catalog.response };
      },
    };
  }

  function chooseEffort(value) {
    if (runtime().id !== 'codex') return;
    const selected = state(runtime().id);
    if (!effortChoices(modelById(selected.modelName)).includes(value)) return;
    global.ComposeDirectoryPreferences?.selectionCommitted?.();
    selected.reasoningEffort = value;
    // Keep the native range element alive throughout a pointer drag.
    paintEffort();
    const name = document.getElementById('cpModelName');
    if (name) name.textContent = currentLabel(runtime(), selected);
    const button = document.getElementById('cpModelBtn');
    if (button) {
      button.title = tx('Codex 设置：') + currentLabel(runtime(), selected);
      button.setAttribute('aria-label', button.title);
    }
    position();
    notify();
  }

  function notify() {
    if (typeof options.onChange === 'function') options.onChange(value());
  }

  function close() {
    const pop = document.getElementById('cpModelPop');
    const button = document.getElementById('cpModelBtn');
    if (pop) {
      finishEffortPointer();
      const card = pop.querySelector?.('.cp-effort-card');
      card?.classList.remove('is-hovering', 'is-thumb-hover');
      pop.hidePopover?.();
      pop.classList.remove('show');
    }
    if (button) button.setAttribute('aria-expanded', 'false');
  }

  async function toggle() {
    const pop = document.getElementById('cpModelPop');
    const button = document.getElementById('cpModelBtn');
    if (!pop || !button) return;
    const opening = !pop.classList.contains('show');
    close();
    if (!opening) return;
    searchQuery = '';
    nativeView = 'effort';
    const pending = refresh(true);
    pop.classList.add('show');
    pop.showPopover?.();
    button.setAttribute('aria-expanded', 'true');
    position();
    pop.setAttribute('aria-busy', 'true');
    const empty = pop.querySelector?.('.cp-model-empty');
    if (empty && !empty.hidden) empty.textContent = tx('正在加载模型…');
    await pending;
    pop.setAttribute('aria-busy', 'false');
    if (pop.classList.contains('show')) pop.querySelector?.(runtime().id === 'codex' ? '[data-native-list]' : 'input')?.focus();
  }

  function bind(config) {
    const hadModelBridge = typeof options.api === 'function';
    options = config || {};
    const button = document.getElementById('cpModelBtn');
    const pop = document.getElementById('cpModelPop');
    if (!button || !pop || button.dataset.modelPickerBound === '1') return;
    // Keep theme inheritance while escaping sidebar stacking and overflow clips.
    pop.setAttribute('popover', 'manual');
    button.dataset.modelPickerBound = '1';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      toggle();
    });
    pop.addEventListener('click', (event) => {
      event.stopPropagation();
      if (event.target.closest('[data-model-close]')) { close(); button.focus?.(); return; }
      if (event.target.closest('[data-native-refresh]')) { if (!loading) void refresh(true); return; }
      if (event.target.closest('[data-native-list]')) {
        nativeView = 'models'; searchQuery = ''; render();
        if (nativeRetryable && !loading) void refresh(true);
        pop.querySelector?.('input[type="search"]')?.focus(); return;
      }
      if (event.target.closest('[data-native-back]')) {
        nativeView = 'effort'; searchQuery = ''; render();
        pop.querySelector?.('[data-native-list]')?.focus(); return;
      }
      if (event.target.closest('[data-effort-reset]')) {
        chooseEffort(defaultEffort(modelById(state(runtime().id).modelName))); return;
      }
      const thinkingToggle = event.target.closest('[data-thinking-toggle]');
      if (thinkingToggle) {
        const selected = state(runtime().id);
        const picked = enterpriseModels.find(item => item.name === selected.modelName) || (selected.modelName ? null : enterpriseModels[0]);
        const info = thinkingProfile(picked);
        if (info.supported && info.canDisable) {
          global.ComposeDirectoryPreferences?.selectionCommitted?.();
          selected.thinkingLevel = selected.thinkingLevel && selected.thinkingLevel !== 'off' ? 'off' : info.onLevel;
          render();
          notify();
        }
        return;
      }
      const model = event.target.closest('[data-model]');
      if (model) {
        chooseModel(model.getAttribute('data-model'), model.dataset?.provider);
        close();
        return;
      }
      const nativeModel = event.target.closest('[data-native-model]');
      if (nativeModel) {
        chooseModel(nativeModel.getAttribute('data-native-model'));
        pop.querySelector?.('[data-native-list]')?.focus();
        return;
      }
    });
    pop.addEventListener('input', (event) => {
      if (event.target.matches('[data-effort-slider]')) {
        const levels = effortChoices(modelById(state(runtime().id).modelName));
        chooseEffort(levels[Number(event.target.value)]); return;
      }
      if (!event.target.matches('input[type="search"]')) return;
      searchQuery = event.target.value;
      filterModels(pop);
    });
    pop.addEventListener('pointermove', previewEffort);
    pop.addEventListener('pointerover', previewEffort);
    pop.addEventListener('pointerout', leaveEffort);
    pop.addEventListener('pointerdown', (event) => {
      const slider = event.target.closest?.('[data-effort-slider]');
      if (!slider || slider.disabled || event.button !== 0) return;
      const card = slider.closest('.cp-effort-card');
      card.dataset.pointerId = String(event.pointerId);
      card.classList.add('is-pressed');
      slider.setPointerCapture(event.pointerId);
    });
    pop.addEventListener('pointerup', finishEffortPointer);
    pop.addEventListener('pointercancel', finishEffortPointer);
    pop.addEventListener('lostpointercapture', finishEffortPointer);
    pop.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (runtime().id === 'codex' && nativeView === 'models') {
          event.preventDefault(); event.stopPropagation(); nativeView = 'effort'; searchQuery = ''; render();
          pop.querySelector?.('[data-native-list]')?.focus(); return;
        }
        event.preventDefault(); event.stopPropagation(); close(); button.focus?.(); return;
      }
      if (event.target.matches('input[type="range"]')) return;
      const rows = Array.from(pop.querySelectorAll('.cp-mrow:not([hidden])'));
      const index = rows.indexOf(document.activeElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : rows.length - 1)
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
        rows[next]?.focus();
      } else if (event.key === 'Enter' && event.target.matches('input') && rows.length) {
        event.preventDefault(); rows[0].click();
      }
    });
    // Initial preference paint can already have started discovery before bind.
    // Reuse that request; a newly mounted draft with no pending load still
    // refreshes the directory to pick up settings changed elsewhere.
    // Native discovery needs the bridge first supplied by bind.
    offModels?.();
    offModels = api()?.onModelsChanged?.(() => { void refresh(true); }) || null;
    const needsNativeBridge = runtime().id === 'codex' && !hadModelBridge;
    refresh(needsNativeBridge || loading?.scope !== loadContext().key);
  }

  function refresh(force) {
    const row = runtime();
    const context = loadContext(row);
    if (activeScope !== context.key) {
      cancelReplacement?.();
      if (activeOwner && activeOwner !== context.owner) states.clear();
      activeOwner = context.owner;
      activeScope = context.key;
      enterpriseModels = [];
      enterpriseDefaultErrors = {}; managedCatalogUnavailable = false; imageModels = []; enterpriseLoaded = false;
      nativeModels = []; nativeCatalogAvailable = false; nativeReason = ''; nativeRetryable = false; nativeLoaded = '';
      nativeView = 'effort';
      close();
    }
    if (activeRuntime !== row.id) {
      activeRuntime = row.id;
      close();
      notify();
    }
    render();
    // Layout and permission updates all refresh this control. They must await
    // the first request, not replace it with an ever-later model lookup.
    if (!force && loading?.scope === context.key) return loading.promise;
    const changed = signalLoadChange;
    loadChanged = new Promise(resolve => { signalLoadChange = resolve; });
    const sequence = ++loadSeq;
    const promise = load(Boolean(force), row, sequence, context.key).finally(() => {
      if (loading?.promise === promise) loading = null;
    });
    loading = { scope: context.key, promise };
    loadPromise = promise;
    changed?.();
    return loadPromise;
  }

  async function ready() {
    if (!loadPromise || activeScope !== loadContext().key) refresh();
    let pending;
    do {
      pending = loadPromise;
      await Promise.race([pending, loadChanged]);
      if (activeScope !== loadContext().key) refresh();
    } while (pending !== loadPromise);
    if (runtime().modelMode === 'managed' && !enterpriseLoaded) return false;
    const selected = state(runtime().id);
    return !selected.unavailable && !selected.catalogUnavailable && Boolean(selected.modelName || !enterpriseDefaultErrors[runtime().id]);
  }

  function value() {
    const row = runtime();
    const selected = state(row.id);
    if (cloud()) return { modelName: row.modelMode === 'managed' ? selected.modelName : '', reasoningEffort: '', thinkingLevel: '' };
    if (row.id === 'codex') {
      return { modelName: selected.modelName, reasoningEffort: selected.reasoningEffort };
    }
    if (row.modelMode === 'managed') {
      const picked = enterpriseModels.find(item => item.name === selected.modelName) || (selected.modelName ? null : enterpriseModels[0]);
      const info = thinkingProfile(picked);
      return { modelName: selected.modelName, reasoningEffort: '', thinkingLevel: info.supported && !info.canDisable
        ? fixedThinkingLevel(info, selected.thinkingLevel) : (selected.thinkingLevel || '') };
    }
    return { modelName: '', reasoningEffort: '' };
  }

  function resetSelection(localOnly) {
    cancelReplacement?.();
    preparedCatalog = null;
    if (localOnly) {
      for (const key of states.keys()) if (key.startsWith('local:')) states.delete(key);
    } else states.clear();
    activeScope = ''; activeRuntime = '';
    // Directory changes supersede local lookups without discarding this draft's cloud choice.
    return refresh(true);
  }
  const resetNewDraft = () => resetSelection(false);
  const resetDirectory = () => resetSelection(true);

  async function restoreSelection(saved, isCurrent = () => true) {
    const row = runtime(), context = loadContext().key;
    if (row.id !== saved.adapterId || !isCurrent()) return false;
    await refresh();
    if (!isCurrent() || context !== loadContext().key) return false;
    const selected = state(row.id);
    selected.modelName = String(saved.modelName || '');
    selected.reasoningEffort = String(saved.reasoningEffort || '');
    selected.thinkingLevel = String(saved.thinkingLevel || '');
    selected.directoryPreference = true;
    selected.modelChosen = false;
    delete selected.choice; delete selected.carriedChoice;
    if (row.modelMode === 'managed') {
      if (!enterpriseLoaded) { selected.unavailable = true; render(); notify(); return false; }
      clearStaleManagedSelection(row);
    } else if (row.id === 'codex' && !cloud()) {
      selected.unavailable = Boolean(selected.modelName && nativeCatalogAvailable && !modelById(selected.modelName));
      if (!selected.unavailable && nativeCatalogAvailable) reconcileEffort(selected);
    } else selected.unavailable = Boolean(selected.modelName);
    render(); notify();
    return !selected.unavailable && !selected.catalogUnavailable;
  }

  function releasePreference() {
    for (const selected of states.values()) delete selected.directoryPreference;
  }

  global.ComposeModelPicker = { bind, close, refresh, ready, value, prepareRuntimeSwitch, resetNewDraft, resetDirectory, restoreSelection, releasePreference,
    hasManualChoice: () => state(runtime().id).modelChosen,
    nativeEffort: { catalogNote, html: effortCard, paint: paintEffortCard, levels: effortChoices, defaultLevel: defaultEffort },
    label: () => currentLabel(runtime(), state(runtime().id)) };
  const scopeChanged = () => {
    if (activeScope && activeScope !== loadContext().key) void refresh();
  };
  global.addEventListener?.('soduwork-data-scope-changed', scopeChanged);
  global.addEventListener?.('soduwork-device-auth', scopeChanged);
  // Hubs without model-change push still converge while the composer is visible.
  const refreshVisibleModels = () => {
    const button = document.getElementById('cpModelBtn');
    if (button?.isConnected && button.getClientRects().length && document.visibilityState !== 'hidden' && !loading) void refresh(true);
  };
  global.addEventListener?.('focus', refreshVisibleModels);
  global.setInterval?.(refreshVisibleModels, 60000);
  global.addEventListener?.('resize', position);
  if (typeof module !== 'undefined' && module.exports) module.exports = global.ComposeModelPicker;
})(typeof window !== 'undefined' ? window : globalThis);
