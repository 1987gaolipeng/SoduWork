(function (global) {
  'use strict';
  const bridge = global.SoduWorkMobileBridge;
  let noticeTimer, disposed = false;
  function appearance(value) {
    global.SoduWorkI18n?.setLocale(value.locale === 'en-US' ? 'en-US' : 'zh-CN', {persist: false, broadcast: false});
    document.documentElement.dataset.theme = value.dark ? 'dark' : 'light';
    document.documentElement.dataset.accent = ['brand', 'blue', 'green'].includes(value.accent) ? value.accent : 'neutral';
  }
  global.petSay = message => {
    const node = document.getElementById('conversationNotice');
    node.textContent = message; node.hidden = false;
    clearTimeout(noticeTimer); noticeTimer = setTimeout(() => {node.hidden = true;}, 7000);
  };
  async function withinStartupBudget(promise, fallback, milliseconds = 1200) {
    let timer;
    try {
      return await Promise.race([Promise.resolve(promise),
        new Promise(resolve => {timer = setTimeout(() => resolve(fallback), milliseconds);})]);
    } finally {clearTimeout(timer);}
  }
  async function start() {
    try {
      const session = global.soduWorkAPI?.conversationSession;
      if (['open', 'snapshot', 'send', 'conversationRuntimes', 'selectAgent', 'selectModel'].some(key => typeof session?.[key] !== 'function')) {
        throw Error('对话资源版本不一致，请载入更新后重新打开');
      }
      const info = await bridge.call('ready');
      if (disposed) return;
      global.SoduWorkMobileSession.initialize(info.scope);
      global.SoduWorkMobileExecutionMode = info.executionMode === 'local-test' ? 'local-test' : 'cloud';
      global.SoduWorkMobilePluginAuthoring = info.pluginAuthoring === true;
      // A fresh mobile page starts empty. In-page navigation restores only the
      // host's current draft below; never resurrect the PC localStorage mirror.
      if (!info.taskId) global.NativeChat.clearDraft('new');
      appearance(info);
      if (info.taskId) {
        // Labels belong to the authorized catalog. Failure must not block
        // access to a saved conversation when its executor is offline.
        void global.SoduWorkMobileSession.directory().catch(() => {});
        await global.NativeChat.enter('', info.taskId, {chatTitle: info.title});
      }
      else {
        const directory = global.soduWorkAPI.conversationSession.runtimes();
        const data = await withinStartupBudget(directory.catch(() => null), null);
        if (disposed) return;
        const prepare = value => {
          const adapterId = value?.runtimes?.[0]?.id || 'pi';
          const model = global.SoduWorkMobileSelection.defaultModel(global.SoduWorkMobileSession.peekDirectory(), adapterId);
          global.NativeChat.prepare({adapterId, modelName: model?.name || '', modelLabel: model?.label || ''});
          document.getElementById('nchatInput')?.dispatchEvent(new Event('input', {bubbles: true}));
        };
        prepare(data);
        if (!data) {
          global.SoduWorkMobileDefaultRuntimePending = true;
          void directory.then(value => {
            if (disposed) return;
            // No task can be sent with the temporary desktop Pi default.
            // prepare preserves the editor and only updates an unbound view.
            prepare(value);
          }).catch(error => {
            if (!disposed) global.petSay('执行底座暂时无法读取：' + error.message);
          }).finally(() => {global.SoduWorkMobileDefaultRuntimePending = false;});
        }
      }
      if (disposed) return;
      document.getElementById('conversationBoot').remove();
      const input = document.getElementById('nchatInput');
      if (!info.taskId && info.initialDraft) {
        input.value = String(info.initialDraft);
      }
      // PC mounts can assign a restored value after binding the hint rail.
      // Reconcile both restored and empty editors before revealing the page.
      input.dispatchEvent(new Event('input', {bubbles: true}));
      input.setAttribute('aria-label', '输入工作要求');
      input.setAttribute('enterkeyhint', 'enter');
      const reportDraft = () => {void bridge.call('draft', {text: input.value,
        actionId: global.SoduWorkMobileComposerActions?.selected?.() || ''}).catch(() => {});};
      input.addEventListener('input', reportDraft);
      input.addEventListener('change', reportDraft);
      global.addEventListener('soduwork:composer-selection', reportDraft);
      global.addEventListener('pagehide', () => global.removeEventListener('soduwork:composer-selection', reportDraft), {once: true});
      if (!info.taskId && info.initialAction) {
        // Only an explicit module entry selects a mode. Typed slash text still
        // goes through the original PC menu and is never inferred as a command.
        void global.SoduWorkMobileComposerActions.select(info.initialAction)
          .then(() => {if (!disposed) reportDraft();})
          .catch(error => {if (!disposed) global.petSay(error.message);});
      }
      reportDraft();
      // Preserve the existing editor when opening controls. No focus-driven
      // replacement of the input or its containing DOM is performed.
      let restoreEditor = false;
      const modelPop = document.querySelector('#nchatModel .nmodel-pop');
      const modelObserver = new MutationObserver(() => {
        if (modelPop.hidden && restoreEditor) {restoreEditor = false; input.focus({preventScroll: true});}
      });
      modelObserver.observe(modelPop, {attributes: true, attributeFilter: ['hidden']});
      global.addEventListener('pagehide', () => modelObserver.disconnect(), {once: true});
      document.addEventListener('pointerdown', event => {
        if (!event.target.closest('#nchatModel')) restoreEditor = false;
        else if (document.activeElement === input) restoreEditor = true;
        if (event.target.closest('.wc-toolbar,.nmodel-pop,.nchat-access-pop,.wc-more-pop') &&
            !event.target.closest('input,textarea,[contenteditable]') && event.pointerType === 'mouse') event.preventDefault();
      });
      const theme = bridge.listen(message => {
        if (message.event === 'suspend-input') document.activeElement?.blur();
        if (message.event === 'appearance') appearance(message);
      });
      global.addEventListener('pagehide', theme, {once: true});
      document.documentElement.dataset.conversationReady = 'true';
    } catch (error) {
      if (disposed) return;
      const node = document.getElementById('conversationBoot');
      if (!node) {global.petSay(error.message); return;}
      node.textContent = '对话暂时无法打开：' + error.message;
      const retry = document.createElement('button'); retry.textContent = '重新打开'; retry.onclick = () => location.reload(); node.appendChild(retry);
    }
  }
  global.addEventListener('pagehide', () => {disposed = true; global.SoduWorkMobileSession.dispose(); clearTimeout(noticeTimer);}, {once: true});
  void start();
})(window);
