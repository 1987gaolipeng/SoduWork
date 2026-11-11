(function (global) {
  'use strict';
  let key = '', draft;
  const create = global.ChatDraftRecovery.create;
  global.ChatDraftRecovery.create = function (ctx) {
    // Reuse the existing draft implementation, but never share its desktop
    // storage key across mobile accounts or service endpoints.
    draft = create.call(this, new Proxy(ctx, {get(target, name, receiver) {
      if (name === '_draftStorageKey') {
        if (!key) throw Error('Draft identity is not ready');
        return key;
      }
      return Reflect.get(target, name, receiver);
    }}));
    return draft;
  };
  global.SoduWorkMobileDrafts = {
    initialize(info) {
      const identity = String(info.identity || info.scope || '');
      if (!identity) throw Error('账号尚未就绪，请重新打开对话');
      const next = 'soduwork.mobile.conversation-drafts.v1:' + identity;
      if (key && key !== next) throw Error('账号已切换，请重新打开对话');
      key = next;
    },
    flush() { if (key) draft?._flushConversationDrafts(); },
  };
  global.addEventListener('pagehide', () => global.SoduWorkMobileDrafts.flush());
})(window);
