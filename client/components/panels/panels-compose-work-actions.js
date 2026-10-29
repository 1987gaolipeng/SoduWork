/* Route explicitly selected work actions from the blank compose entry into the shared
   conversation/plugin surface. Parsing and forms remain owned by PluginUIHost. */
(function (global) {
  'use strict';
  const inputStates = new WeakMap();
  function trackInput(input) {
    if (!input) return null;
    let state = inputStates.get(input);
    if (!state) {
      state = { ticket: 0, edits: 0 }; inputStates.set(input, state);
      input.addEventListener?.('input', () => { state.edits++; });
    }
    return state;
  }

  function restoreInput(input, value) {
    if (!input) return;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  }

  function reportRouteError(error) {
    if (global.console && typeof console.error === 'function') {
      console.error('[ComposeWorkActions] route failed', error);
    }
    if (typeof global.petSay === 'function') {
      petSay('这次没有打开工作表单，内容已经保留，请重试');
    }
  }

  async function route(options) {
    const o = options || {};
    const mention = o.pluginMention;
    const attachments = o.attachments;
    const submittedFiles = attachments?.files?.().slice() || [];
    const identity = file => global.ConversationAttachments?.fileIdentity?.(file) ?? file;
    const submittedIdentities = submittedFiles.map(identity);
    const sameFiles = () => !attachments?.files || (() => {
      const current = attachments.files();
      return current.length === submittedIdentities.length && current.every((file, index) => identity(file) === submittedIdentities[index]);
    })();
    const submittedAction = mention?.action?.();
    const command = global.PluginUIHost?.commandFromSelection?.(submittedAction, o.text) || null;
    if (submittedAction && !command) {
      global.petSay?.('选中的能力当前不可用，内容已保留，请重新选择');
      return { handled: true, accepted: false };
    }
    const bindingContext = global.PluginUIHost?.captureBindingContext?.(o.bindingContext, mention?.selected?.()) || {};
    const input = o.input, panel = o.panel;
    const original = input ? String(input.value || '') : o.text;
    const previousStage = panel && panel.dataset.stage;
    const state = command?.text ? trackInput(input) : null;
    const ticket = state ? ++state.ticket : 0;
    let clearedEdits = state?.edits, nativeState = null, nativeEdits = 0;
    const current = () => input?.isConnected !== false && (!o.isCurrent || o.isCurrent()) && (!state || ticket === state.ticket);
    const unedited = () => sameFiles() && (!state || state.edits === clearedEdits) && (!nativeState || nativeState.edits === nativeEdits);
    let chatInput = null;
    const restore = () => {
      if (!current() || !unedited() || input?.value || chatInput && chatInput !== input && chatInput.value) return;
      if (panel) panel.dataset.stage = previousStage || 'compose';
      restoreInput(input, original);
    };
    let sessionOptions, submittedModel;
    if (command?.text) {
      try {
        sessionOptions = typeof o.prepareSession === 'function' ? await o.prepareSession() : undefined;
        if (sessionOptions === false || !current() || !unedited() || (input && input.value !== original)) {
          return { handled: true, accepted: false };
        }
        submittedModel = sessionOptions ? sessionOptions.modelName || ''
          : (typeof o.model === 'function' ? o.model() : o.model || '');
        if (sessionOptions) sessionOptions = { ...sessionOptions };
      } catch (error) {
        if (current()) reportRouteError(error);
        return { handled: true, accepted: false };
      }
    }
    if (command?.text) {
      if (!current()) return { handled: true, accepted: false };
      if (input) {
        input.value = ''; input.style.height = '';
        input.dispatchEvent?.(new Event('input', { bubbles: true }));
      }
      // Commit before mounting NativeChat or waiting for analysis. Its new
      // composer must not restore the just-submitted prompt from draft storage.
      global.NativeChat?.clearDraft?.('new');
      clearedEdits = state?.edits;
    }
    let attachmentContext = [];
    try {
      attachmentContext = o.hasAttachments && attachments && typeof attachments.analysis === 'function'
        ? await attachments.analysis() : [];
    } catch (error) {
      if (command?.text) restore();
      reportRouteError(error);
      return { handled: true, accepted: false, attachmentContext };
    }
    if (!command) return { handled: false, attachmentContext };
    if (!command.text) {
      if (typeof global.petSay === 'function') {
        petSay('在 /' + command.command + ' 后写清楚要记录的内容，再发送');
      }
      return { handled: true, attachmentContext };
    }

    if (!current()) return { handled: true, accepted: false, attachmentContext };
    let accepted = false;
    try {
      if (panel) panel.dataset.stage = 'chat';
      if (global.NativeChat && typeof NativeChat.prepare === 'function') NativeChat.prepare(sessionOptions);
      chatInput = global.document?.getElementById('nchatInput');
      nativeState = chatInput && chatInput !== input ? trackInput(chatInput) : null;
      nativeEdits = nativeState?.edits;
      accepted = global.NativeChat && typeof NativeChat.openWorkAction === 'function'
        ? await NativeChat.openWorkAction(command, {
          source: '新建入口', model: () => submittedModel, bridge: o.bridge, attachmentContext, bindingContext,
        }) : false;
    } catch (error) {
      reportRouteError(error);
    }
    if (!accepted) restore();
    if (accepted && current() && unedited() && !input?.value && (!mention?.action || mention.action() === submittedAction) &&
        mention && typeof mention.clearAction === 'function') {
      mention.clearAction();
    }
    if (accepted && current()) attachments?.consumeInputText?.(submittedFiles, { resetExpanded: unedited() && !input?.value });
    return { handled: true, accepted, attachmentContext };
  }

  global.ComposeWorkActions = { route };
})(window);
