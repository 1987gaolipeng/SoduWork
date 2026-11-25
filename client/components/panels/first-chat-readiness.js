/* The first-message composer owns these observations for the selected Agent and location. */
(function (global) {
  'use strict';
  let notice, timer, inFlight = false, lastReport = null, checkGeneration = 0;
  const tx = text => global.SoduWorkI18n?.translateText?.(text) || text;

  function snapshot() {
    const runtime = global.ComposeRuntime?.availability?.() || {};
    const model = global.ComposeModelPicker?.modelReadiness?.() || 'checking';
    const runtimeReady = runtime.checking || runtime.unverified || typeof runtime.ok !== 'boolean'
      ? null : runtime.ok;
    const modelReady = model === 'ready' ? true : ['empty', 'choose'].includes(model) ? false : null;
    return { runtime, model, runtimeReady, modelReady };
  }

  function action(state) {
    if (state.model === 'empty') return ['models', '还没有可用于对话的模型。', '打开模型目录'];
    if (state.model === 'choose') return ['choose', '当前模型不可用，请选择可用模型。', '选择模型'];
    if (state.runtimeReady === false && global.ComposeRuntime?.location?.() !== 'cloud') {
      return ['agents', '当前执行底座不可用。', '设置执行底座'];
    }
    if (state.model === 'unknown' || (state.runtime.unverified && state.runtime.ok === false)) {
      return ['retry', '暂时无法确认对话配置。', '重新检查'];
    }
    return null;
  }

  function same(a, b) {
    return a && b && a.scope === b.scope && a.runtimeReady === b.runtimeReady && a.modelReady === b.modelReady;
  }

  function observation() {
    const api = global.SoduWorkAPI;
    const auth = api?.clientAuthSnapshot?.();
    if (!auth?.user?.id || auth.state !== 'active') return null;
    const { runtimeReady, modelReady } = snapshot();
    return { scope: api.taskStorageKey('ops'), runtimeReady, modelReady };
  }

  async function report() {
    if (inFlight) return;
    const data = observation();
    if (!data) { lastReport = null; return; }
    const generation = checkGeneration;
    if (same(data, lastReport) && (generation === lastReport.generation || Date.now() - lastReport.at < 110000)) return;
    inFlight = true;
    try {
      if (await global.SoduWorkAPI.reportFirstChatReadiness(data.scope, data.runtimeReady, data.modelReady)) {
        lastReport = { ...data, at: Date.now(), generation };
      }
    } catch (_) { /* A disconnected or older Hub can still run a local chat. */ }
    finally {
      inFlight = false;
      if (!same(data, observation())) queueReport();
    }
  }

  function queueReport() {
    if (timer || inFlight) return;
    timer = global.setTimeout(() => { timer = null; void report(); }, 200);
  }

  function paint() {
    if (!notice) return;
    const next = action(snapshot());
    notice.hidden = !next;
    if (next) {
      const [id, message, label] = next;
      const button = notice.querySelector('button'), text = notice.querySelector('span');
      button.dataset.action = id;
      if (text.textContent !== tx(message)) text.textContent = tx(message);
      if (button.textContent !== tx(label)) button.textContent = tx(label);
    }
    queueReport();
  }

  function bind(panel) {
    const element = panel?.querySelector?.('.cp-first-chat-notice');
    if (!element || notice === element) return;
    notice = element;
    notice.querySelector('button').addEventListener('click', event => {
      const id = event.currentTarget.dataset.action;
      if (id === 'retry') {
        void global.ComposeRuntime?.refreshAccess?.();
        void global.ComposeModelPicker?.refresh?.(true);
      } else if (id === 'choose') document.getElementById('cpModelBtn')?.click();
      else global.WorkspaceHost?.open?.(id);
    });
    paint();
  }

  function canStart() {
    const state = snapshot();
    return state.runtimeReady !== false && state.modelReady !== false;
  }

  global.addEventListener?.('soduwork-locale-change', paint);
  global.FirstChatReadiness = { bind, paint, canStart, checked() { checkGeneration++; paint(); } };
})(window);
