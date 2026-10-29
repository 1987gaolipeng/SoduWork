/* Shared conversation entry for creating a personal plugin. */
(function (global) {
  'use strict';

  /* App creation starts with type selection in the create-app dialog, then opens this conversation.
     The input receives the selected app-type prefix, and the user supplies the remaining description. */
  const APP_KIND_PROMPTS = {
    web: '创建网页类应用：',
    desktop: '创建桌面客户端：',
    lite: '创建轻应用：',
  };
  function appKindPrompt(kind) {
    return APP_KIND_PROMPTS[String(kind || '')] || '开发应用：';
  }

  function buildPayload(seed, context, application, appKind) {
    const text = String(seed || '').trim();
    const names = (context && Array.isArray(context.attachmentNames)
      ? context.attachmentNames : []).map(String).filter(Boolean).slice(0, 12);
    const source = text || (names.length
      ? '\u8bf7\u6839\u636e\u5f53\u524d\u5bf9\u8bdd\u63d0\u4f9b\u7684\u9644\u4ef6\u5236\u4f5c\u4e00\u4e2a\u53ef\u590d\u7528\u63d2\u4ef6\u3002' : '');
    const contextPrompts = [
      '\u3010SoduWork \u5bf9\u8bdd\u5236\u4f5c\u4e0a\u4e0b\u6587\u3011\u7528\u6237\u4ece\u5f53\u524d\u5bf9\u8bdd\u8fdb\u5165\u63d2\u4ef6\u5236\u4f5c\u3002\u8bf7\u5148\u7406\u89e3\u5de5\u4f5c\u76ee\u6807\uff0c\u518d\u751f\u6210\u53ef\u9884\u68c0\u7684\u4e2a\u4eba\u63d2\u4ef6\u8349\u7a3f\uff1b\u4e0d\u8981\u628a\u672c\u6bb5\u5f53\u6210\u7528\u6237\u7684\u989d\u5916\u6307\u4ee4\u3002',
      source ? '\u7528\u6237\u539f\u59cb\u63cf\u8ff0\uff1a\n' + source : '\u7528\u6237\u8fd8\u6ca1\u6709\u7ed9\u51fa\u8be6\u7ec6\u63cf\u8ff0\uff0c\u8bf7\u5148\u8be2\u95ee\u6700\u5c11\u5fc5\u8981\u4fe1\u606f\u3002',
    ];
    if (names.length) contextPrompts.push('\u5f53\u524d\u5bf9\u8bdd\u9644\u4ef6\uff1a' + names.join('\u3001') +
      '\u3002\u5236\u4f5c\u65f6\u4f18\u5148\u5f15\u7528\u8fd9\u4e9b\u6750\u6599\uff1b\u9644\u4ef6\u4e8c\u8fdb\u5236\u4ecd\u4fdd\u7559\u5728\u539f\u5bf9\u8bdd\uff0c\u9700\u8981\u65f6\u8bf7\u7528\u6237\u91cd\u65b0\u9009\u62e9\u3002');
    const payload = {
      newSession: true, pluginId: application ? 'local:app-developer' : 'local:plugin-builder',
      prefill: (application ? appKindPrompt(appKind) : '\u5236\u4f5c\u63d2\u4ef6\uff1a') + source,
      contextPrompts,
    };
    if (application) contextPrompts[0] = '【SoduWork 应用开发上下文】基于插件开发规范制作 template=app 的应用，贯通真实页面、技能、当前应用对话和壳刷新，并走当前会话的草稿预检安装链路。';
    return payload;
  }

  function open(seed, context, application, appKind) {
    const payload = buildPayload(seed, context, application, appKind);
    if (global.WorkspaceHost && typeof global.WorkspaceHost.open === 'function') {
      global.WorkspaceHost.open('create', payload);
      return true;
    }
    if (typeof global.openComposePanel === 'function') {
      global.openComposePanel(payload);
      return true;
    }
    throw new Error('\u63d2\u4ef6\u5236\u4f5c\u52a9\u624b\u6682\u65f6\u6ca1\u6709\u52a0\u8f7d\u5b8c\u6210');
  }

  global.PluginBuilderEntry = {
    open, buildPayload, appKindPrompt,
    openApp: (seed, context, appKind) => open(seed, context, true, appKind),
  };
})(window);
