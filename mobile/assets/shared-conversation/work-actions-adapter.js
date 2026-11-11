(function (global) {
  'use strict';
  const bridge = global.SoduWorkMobileBridge;
  const desktopActions = global.ChatWorkActions;
  const actionRows = [
    {id: 'work.requirement.create', command: '需求', aliases: ['新建需求', '创建需求', 'task'], name: '新建需求', description: '记录目标与完成标准，保存到需求池或交办给同事', icon: '需', badge: '内置表单', priority: 10},
    {id: 'work.automation.create', command: '自动化', aliases: ['自动化任务', '定时任务', '定时', '巡检', 'automation'], name: '创建自动化', description: '按时间或周期交给 Agent 执行，在对话中查看过程、结果与异常', icon: '自', badge: '内置表单', priority: 30},
    {id: 'work.plugin.create', command: '制作插件', aliases: ['创建插件', 'plugin'], name: '制作插件', description: '对话生成插件草稿，确认后提交审核', icon: '✦', badge: '对话制作', priority: 50},
  ];
  const unregistered = [];
  if (global.PluginUIHost?.registerAction) {
    actionRows.forEach(row => {
      try { unregistered.push(global.PluginUIHost.registerAction({...row, open: () => true})); } catch (_) {}
    });
  }
  function say(message) { if (typeof global.petSay === 'function') global.petSay(String(message || '')); }
  function currentSession() {
    try { return global.NativeChat?.sessionInfo?.() || {}; } catch (_) { return {}; }
  }
  async function conversationContext(ref, includeFiles) {
    if (!ref || !global.soduWorkAPI?.conversationSession?.snapshot || !global.ChatWorkIntent?.create) return null;
    const value = await global.soduWorkAPI.conversationSession.snapshot(ref);
    if (value?.ok !== true || !value.snapshot) return null;
    const context = await global.ChatWorkIntent.create({_snap: value.snapshot})
      ._workConversationContext('', {includeFiles: Boolean(includeFiles)});
    return context?.text?.trim() ? context : null;
  }
  async function openAction(command, context) {
    if (global.SoduWorkMobileWorkCards?.supported(command.id)) {
      return global.SoduWorkMobileWorkCards.open(command, context || {});
    }
    const ref = String(currentSession().ref || '').trim();
    const taskId = ref && global.SoduWorkMobileSession?.taskId?.(ref);
    const kind = command.id === 'work.requirement.create' ? 'requirement' :
      command.id === 'work.automation.create' ? 'automation' : '';
    if (taskId && kind) {
      const material = await conversationContext(ref, kind === 'requirement');
      if (!material) throw Error('此对话还没有可带入的正文');
      return global.SoduWorkMobileBridge.call('handoff', {
        kind, taskId, contextText: material.text, turnCount: material.turnCount,
        instruction: String(command.text || ''),
      });
    }
    return bridge.call('workAction', {
      actionId: command.id,
      text: String(command.text || '').trim(),
      ref,
      contextText: String(context?.text || '').slice(0, 40000),
    });
  }
  function restore(input, value) {
    if (!input || input.isConnected === false) return;
    input.value = value;
    input.dispatchEvent(new Event('input', {bubbles: true}));
    input.focus();
  }
  async function route(options, context) {
    const o = options || {};
    const selectedAction = o.mention?.action?.();
    const formSelected = global.SoduWorkMobileWorkCards?.supported(selectedAction?.id || selectedAction?.actionId);
    // A retained form is not an explicit composer selection. Ordinary chat
    // must keep its text and attachments even while a local draft is open.
    if (desktopActions?.route && formSelected) {
      return desktopActions.route(o, {...context, open: async (command, seed) => {
        await global.SoduWorkMobileWorkCards.open(command, {...seed,
          model: context?.model, files: o.attachments?.files?.() || []});
        return true;
      }});
    }
    const selected = o.mention?.action?.();
    if (!selected) return {handled: false, accepted: false};
    const text = String(o.text || '').trim();
    const command = global.PluginUIHost?.commandFromSelection?.(selected, text);
    if (!command) { say('选中的能力当前不可用，内容已保留，请重新选择'); return {handled: true, accepted: false}; }
    const original = String(o.input?.value || '');
    if (o.input) { o.input.value = ''; o.input.style.height = 'auto'; o.input.dispatchEvent(new Event('input', {bubbles: true})); }
    try {
      const result = await openAction(command, o.conversationContext);
      if (result?.cancelled === true) { restore(o.input, original); return {handled: true, accepted: false}; }
      if (result?.ok === false) throw Error(result.message || '工作表单没有保存');
      o.mention.clearAction?.();
      const message = command.id === 'work.requirement.create' ? '需求已创建' :
        command.id === 'work.automation.create' ? '自动化已创建' :
        result?.message || '操作已完成';
      say(message);
      return {handled: true, accepted: true};
    } catch (error) {
      restore(o.input, original);
      say(error?.message || '工作表单没有打开，请重试');
      return {handled: true, accepted: false};
    }
  }
  global.ChatWorkActions = {route, open: openAction};
  if (global.NativeChat?.openWorkAction) {
    const nativeOpen = global.NativeChat.openWorkAction;
    global.NativeChat.openWorkAction = (command, options) =>
      global.SoduWorkMobileWorkCards?.supported(command?.id)
        ? global.SoduWorkMobileWorkCards.open(command, options || {}) : nativeOpen(command, options);
  }
  let activeMention = null;
  global.SoduWorkMobileComposerActions = {
    selected: () => activeMention?.action?.()?.actionId || '',
    clear(actionId) {
      const selected = activeMention?.action?.();
      if (!selected || (selected.actionId || selected.id) !== actionId) return false;
      activeMention.clearAction?.();
      return true;
    },
    async select(actionId) {
      if (!actionRows.some(row => row.id === actionId)) throw Error('此工作动作不可用');
      const current = activeMention;
      if (!current?.select) throw Error('输入区域尚未准备好，请重新打开');
      return current.select(actionId, () => activeMention === current, {keepText: true});
    },
  };
  const mention = global.ChatPluginMention;
  if (mention?.create && !mention.create.__soduWorkMobileWrapped) {
    const originalCreate = mention.create;
    const wrapped = function (options) {
      const o = options || {};
      const control = originalCreate({...o,
        onChange() {
          o.onChange?.();
          global.dispatchEvent(new Event('soduwork:composer-selection'));
        },
        createPlugin: (seed, context) => {
          const info = global.NativeChat?.sessionInfo?.() || {};
          return bridge.call('workAction', {actionId: 'work.plugin.create', text: String(seed || '').trim(), ref: String(info.ref || ''), contextText: String(context?.text || '').slice(0, 40000)}).then(result => {
          if (result?.ok !== false) say('插件制作入口已打开');
          return result;
          });
        },
        debugPlugin: undefined,
      });
      activeMention = control;
      if (!control) return control;
      const destroy = control.destroy;
      control.destroy = () => {
        if (activeMention === control) activeMention = null;
        destroy?.();
      };
      return control;
    };
    wrapped.__soduWorkMobileWrapped = true;
    mention.create = wrapped;
  }
  global.addEventListener('pagehide', () => unregistered.splice(0).forEach(dispose => { try { dispose(); } catch (_) {} }), {once: true});
})(window);
