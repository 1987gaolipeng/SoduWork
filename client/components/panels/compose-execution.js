/* New conversations default to local; selection is fenced during dispatch. */
(function (global) {
  'use strict';
  let location = 'local', revision = 0, requestId = '', requestOwner = '', busy = false, panelRoot = null, refresh = () => {}, resetPending = false, cloudProbe = 0;
  const ownerScope = () => String(global.SoduWorkAPI?.taskStorageKey?.('ops') || 'renderer');
  function bind(panel, onChange) {
    if (!panel || panelRoot === panel) return;
    panelRoot = panel;
    refresh = onChange;
    const eventRoot = panel;
    if (typeof eventRoot.addEventListener !== 'function') { paint(); return; }
    eventRoot.addEventListener('click', event => {
      if (event.target.closest('[data-execution-configure]')) { if (!busy) global.WorkspaceHost?.open?.('cloud'); return; }
      const button = event.target.closest('[data-execution]');
      if (button && !button.disabled && !busy) {
        const next = button.dataset.execution;
        if (!['local', 'cloud'].includes(next) || next === location) return;
        if (location !== next) revision++;
        location = next;
        global.ComposeRuntime?.setLocation?.(location);
        refresh(); paint();
        // The + menu is a secondary setting. Close it as soon as the choice
        // is made so the composer remains ready for the next action.
        const pop = panel.querySelector('#cpMorePop');
        const more = panel.querySelector('#cpMore');
        if (pop) { pop.hidden = true; pop.classList.remove('show'); }
        if (more) more.setAttribute('aria-expanded', 'false');
        const probe = ++cloudProbe, owner = ownerScope();
        if (location === 'cloud') {
          // Keep the draft and mode controls visible when setup is needed.
          void Promise.resolve(global.ComposeRuntime?.refreshAccess?.()).then(() => {
            if (probe === cloudProbe && owner === ownerScope() && location === 'cloud') {
              refresh(); paint();
            }
          }).catch(() => { if (probe === cloudProbe && owner === ownerScope() && location === 'cloud') global.petSay?.('云端环境检查失败，请重试'); });
        }
      }
    });
    paint();
  }
  function paint() {
    if (!panelRoot) return;
    const cloud = location === 'cloud';
    const mid = panelRoot.querySelector('.cp-mid');
    mid?.classList.toggle('is-cloud-compose', cloud);
    const composer = panelRoot.querySelector('.cp-box');
    if (composer) {
      composer.inert = busy;
      if (typeof composer.setAttribute === 'function') composer.setAttribute('aria-busy', String(busy));
    }
    const notice = panelRoot.querySelector('.wc-execution-notice'), available = global.ComposeRuntime?.availability?.();
    if (notice) {
      notice.hidden = !cloud || available?.ok !== false || available?.checking;
      notice.querySelector('span').textContent = notice.hidden ? '' : (available.reason || '暂无可用云端电脑');
    }
    global.WorkComposer?.syncExecutionMenu?.(panelRoot, location, busy, ownerScope());
    panelRoot.querySelectorAll('[data-execution]').forEach(button => {
      const selected = button.dataset.execution === location;
      button.setAttribute('aria-checked', String(selected)); button.setAttribute('aria-pressed', String(selected)); button.classList.toggle('on', selected); button.disabled = busy;
    });
  }

  function reset() { global.WorkComposer?.closeExecutionMenu?.(); cloudProbe++; if (busy) { resetPending = true; return; } revision++; location = 'local'; requestId = ''; global.ComposeRuntime?.setLocation?.('local'); paint(); }
  async function start({ text, attachments, skills = [], plugins = [], intent, contextPrompts = [], prepare, isCurrent = () => true }) {
    if (busy) return false;
    const agentId = global.ComposeRuntime.value(), selectedLocation = location, owner = ownerScope();
    // A cloud location may auto-select the first installed Harness while its
    // availability probe is finishing. Treat that as the effective cloud
    // choice for this send; local sends keep the strict selection fence so a
    // manual local Harness change cannot dispatch an old draft.
    const current = () => isCurrent() && owner === ownerScope() &&
      (selectedLocation === 'cloud' || global.ComposeRuntime.value() === agentId) &&
      location === selectedLocation;
    busy = true; paint();
    try {
      if (!current()) return false;
      if (prepare) ({ attachments, skills = [], plugins = [], intent, contextPrompts = [] } = await prepare());
      if (!current()) return false;
      if (skills.length || plugins.length || intent === 'goal') throw Error('本机技能、插件和目标模式请在本地使用；云端使用服务器已配置的能力');
      await global.ComposeRuntime?.refreshAccess?.();
      if (!current()) return false;
      if (await global.ComposeRuntime?.ready?.() === false) throw Error(global.ComposeRuntime?.availability?.()?.reason || '当前 Agent 没有可用的云端执行机，请在“云端环境”中配置或更换 Agent');
      if (!current()) return false;
      if (await global.ComposeModelPicker?.ready?.() === false) throw Error('请选择可用模型');
      if (!current()) return false;
      const model = global.ComposeModelPicker?.value?.() || {};
      const api = (global.soduWorkAPI?.conversationSession || global.soduWorkAPI?.piSession)?.cloud;
      if (!api?.start) throw Error('请更新客户端后创建云端会话');
      if (requestOwner !== owner) { requestId = ''; requestOwner = owner; }
      requestId ||= global.crypto.randomUUID();
      const requestAgentId = selectedLocation === 'cloud' ? global.ComposeRuntime.value() : agentId;
      const result = await api.start({ requestId, agentId: requestAgentId, model: model.modelName || '',
        text: [...contextPrompts, text].filter(Boolean).join('\n\n'), attachments, skills: [], plugins: [] });
      if (!result?.ok) throw Error(result?.reason || '云端会话没有创建成功，原消息已保留');
      if (!current()) { requestId = ''; global.petSay?.(owner === ownerScope() ? '云端会话已创建，可从历史会话中打开' : '云端会话已创建，可切回原账号从历史会话中打开'); return false; }
      const opened = await global.NativeChat.enter('', result.sessionId);
      if (!opened) throw Error('云端已接收，请从历史会话重新打开；再次点击也不会重复发送');
      requestId = ''; return true;
    } catch (error) { if (current()) global.petSay?.(error.message || '云端暂不可用，原消息已保留'); return false; }
    finally { busy = false; if (resetPending) { resetPending = false; reset(); } paint(); }
  }
  global.ComposeExecution = { bind, paint, reset, start, value: () => location, revision: () => revision };
})(window);
