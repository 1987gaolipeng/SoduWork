(function (global) {
  'use strict';
  // The desktop renderer remains the source of truth. Only fixed chrome is
  // localized here; messages, model/plugin names, results and paths are data.
  const textSelectors = [
    '#conversationBoot', '#conversationNotice',
    '.wc-placeholder-item', '.wc-placeholder-item b',
    '#nchatMorePop .cp-more-title', '#nchatFilePick b', '#nchatFilePick i',
    '#nchatMoreGoal b', '#nchatMoreGoal i', '#nchatScreenshot b', '#nchatScreenshot i',
    '#nchatMorePop .wc-more-section-head b', '#nchatMoreAll', '#nchatPlugins',
    '#nchatMorePlugins > span', '#nchatMorePlugins .wc-more-retry',
    '[data-mobile-handoff] b',
    '[data-mobile-delivery-copy]',
    '.nmodel-heading span', '.nmodel-heading b', '.nmodel-message',
    '.nmodel-thinking-copy b', '[data-thinking-label]', '[data-thinking-hint]',
    '[data-thinking-toggle] .sr-only', '.nmodel-pop footer span',
    '.nchat-runtime-pop header', '.nchat-runtime-pop .nchat-access-note',
    '.nchat-runtime-pop [role="status"]', '.nchat-runtime-pop .nchat-access-options > button:not([data-session-agent])',
    '#nchatAccessPop header', '#nchatAccessPop .nchat-access-current', '#nchatAccessPop [role="status"]', '#nchatAccessPop [data-access-mode] b',
    '#nchatAccessPop [data-access-mode] small', '#nchatAccessPop .nchat-access-note',
    '.mobile-model-fallback h3', '.mobile-model-fallback header', '.mobile-model-fallback p', '.mobile-model-fallback button',
    '.mtv-path summary', '.mtv-section h3', '.mtv-receipt > summary',
    '.mtv-note', '.mtv-file-button',
    '.nmate-card-send', '.nmate-summary-status', '.nmate-card-tools button',
    '.nmate-results-warning', '.nmate-menu .nplugin-state',
  ];
  const controlSelectors = [
    '#cpChat', '#nchatMorePop', '.cp-skill-tags', '#cpSkillMenu', '#nchatInput', '#nchatMore', '#nchatMic', '#nchatSend', '#nchatRuntime',
    '#nchatMode', '#nchatWd', '#nchatAbility', '.wc-placeholder-rail',
    '.nmodel-button', '.nmodel-pop', '.nmodel-search input', '.mobile-model-fallback input', '.nmodel-options',
    '.nmodel-thinking', '[data-model-close]', '[data-thinking-toggle]',
    '.nchat-runtime-pop', '#nchatAccessPop', '[data-mobile-handoff]',
    '.mtv-close', '.nmate-card-close', '.nmate-card-text', '.ntext-copy',
  ];
  const protectedSelectors = '[data-user-content],[data-message-content],[translate="no"],'
    + '[contenteditable="true"],.nmd,.nuser-text,.nuser-full,.nthink-body,.mtv-code,.mtv-diff,'
    + '.nchat-runtime-name,#nchatRuntimeName,[data-model-name],.mobile-model-option,.wc-more-plugin,.nplugin-option-copy';
  const attributes = ['placeholder', 'title', 'aria-label', 'aria-description', 'data-tooltip'];
  const overrides = Object.freeze({
    '交付成果': 'Deliverables', '成果已收集，可查看或下载。': 'Deliverables collected. Ready to view or download.',
    '执行已结束，但服务端尚未确认成果已收集完成，暂时无法预览或下载。': 'Execution has ended, but the server has not confirmed collection. Preview and download are unavailable.',
    '本轮未完成，过程记录已保留。': 'This turn is incomplete. Execution records are preserved.',
    '成果已移除，暂时无法下载。': 'The deliverable was removed and is unavailable for download.',
    '成果尚未收集完成，请查看错误详情。': 'Deliverable collection is incomplete. See error details.',
    '查看错误详情': 'View error details', '重新收集成果': 'Retry collection',
    '预览网页': 'Preview page', '检查插件草稿': 'Review plugin draft',
    '截图与标注': 'Screenshot and annotate', '框选屏幕，编辑后粘贴到对话': 'Capture an area, edit it and paste into the chat',
    '查看全部': 'View all', '添加内容与插件': 'Add content and plugins',
    '本次使用的 Skill': 'Skills for this turn', '选择 Skill': 'Choose a skill',
    '关闭': 'Close', 'SoduWork 对话': 'SoduWork conversation',
    '正在打开对话…': 'Opening conversation…', '输入工作要求': 'Describe your task',
    '接着说…': 'Continue the conversation…', '使用插件': 'Use a plugin',
    '使用技能': 'Use a skill', '用户发送消息': 'Message a colleague',
    '打开插件、技能或通知用户': 'Open plugins, skills or colleague mentions',
    '告诉 SoduWork 你想完成什么…': 'Tell SoduWork what you want to accomplish…',
    '粘贴文件或图片，补充任务背景': 'Paste files or images to add context',
    '输入“继续”，恢复上一轮工作': 'Type “continue” to resume the previous task',
    '添加内容和能力': 'Add files and capabilities', '添加与设置': 'Add and configure',
    '文件和图片': 'Files and images', '选择文件，或直接粘贴到输入框': 'Choose files or paste them into the message',
    '设定目标': 'Set a goal', '持续目标': 'Ongoing goal',
    '请在新对话发送前设置': 'Set this before sending a new conversation',
    '在对话目标栏中查看与管理': 'View and manage in the conversation goal bar',
    '打开后加载可用插件…': 'Open to load available plugins…',
    '还没有安装插件，可以从「查看全部」中添加。': 'No plugins installed. Add one from “View all”.',
    '插件目录暂时无法加载': 'The plugin catalog is temporarily unavailable',
    '从此对话新建需求': 'Create an issue from this conversation',
    '从此对话新建自动化': 'Create an automation from this conversation',
    '先产生对话记录，再从此对话创建': 'Start a conversation before creating from it',
    '创建结果尚未确认，请到对应列表核对': 'Creation is not confirmed. Check the relevant list.',
    '选择会话模型': 'Choose a conversation model', '应用于后续消息': 'Applies to subsequent messages',
    '不中断当前执行': 'Keeps the current run uninterrupted', '切换模型': 'Switch model',
    '关闭模型选择': 'Close model picker', '搜索可用模型': 'Search available models',
    '搜索模型': 'Search models', '可用模型': 'Available models',
    '没有匹配的模型': 'No models match your search',
    '当前账号没有获授权的模型': 'No models are authorized for this account',
    '原执行环境暂不可用，恢复连接后可切换本会话模型。': 'The original execution environment is unavailable. Reconnect to switch models.',
    '刷新执行底座': 'Refresh Agents', '查看云端环境': 'View cloud environment',
    '本地测试执行器暂未就绪，请刷新重试；手机无需安装底座。': 'The local test runner is not ready. Refresh to try again; no Agent installation is needed on your phone.',
    '当前账号尚无可用执行环境。请在云端环境中检查连接和底座状态。': 'No execution environment is available for this account. Check the connection and Agent status in the cloud environment.',
    '没有匹配的可用模型': 'No available models match your search',
    '云端 Agent 暂未提供模型列表。': 'The cloud Agent has not provided a model list.',
    '该 Agent 暂未提供可切换的模型。': 'This Agent has not provided switchable models.',
    '暂无可用模型，请检查模型服务授权。': 'No models available. Check model service authorization.',
    '模型列表暂不可用，请关闭后重试。': 'The model list is unavailable. Close and try again.',
    '思考模式': 'Thinking mode', '开关思考模式': 'Toggle thinking mode',
    '切换 Agent · 保留当前对话和工作目录': 'Switch Agent · Keep the conversation and workspace',
    '正在读取可用 Agent…': 'Loading available Agents…',
    '保留对话、文件与权限；下一轮使用所选 Agent。': 'Keep this conversation, files and permissions. The next turn uses the selected Agent.',
    '本次会话执行底座': 'Conversation Agent', '本次会话权限': 'Conversation permissions',
    '打开本次会话的工作文件夹': 'Open this conversation’s workspace',
    '能力在会话开始时确定': 'Capabilities are determined when the conversation starts',
    '关闭执行记录': 'Close execution record', '文件路径': 'File path',
    '当次读取记录': 'Read record', '本次写入内容': 'Written content',
    '本次修改片段': 'Changed sections', '修改前': 'Before', '修改后': 'After',
    '执行回执': 'Execution receipt', '返回结果': 'Result', '已同步文件内容': 'Synced file content',
    '操作仍在执行，以下为目前收到的记录。': 'Still running. These are the records received so far.',
    '这是当次执行记录；文件之后可能已有修改。': 'This is the execution record. The file may have changed since.',
    '本次记录没有包含文件内容，以下为执行回执。': 'No file content was included. The execution receipt is shown below.',
    '查看已同步文件': 'View synced file', '重新读取文件': 'Reload file', '重试读取文件': 'Retry loading file',
    '成果预览': 'Deliverable preview', '关闭成果预览': 'Close deliverable preview',
    '下载完整成果': 'Download full deliverable', '成果网页': 'Deliverable page', '下载中': 'Downloading',
    '下载失败，请重试': 'Download failed. Please try again.',
    '隔离预览 · 不连接账号与接口；外部字体与样式未加载。外链、表单及服务端功能请下载后运行。':
      'Isolated preview · Accounts and APIs are disconnected; external fonts and styles are not loaded. Download the file to use links, forms and server features.',
    '工作进展小结': 'Work progress summary',
    '想同步什么？内容发出前都可以改…': 'What would you like to share? You can edit before sending…',
  });
  const document = global.document;
  const sources = new WeakMap();
  let locale = global.SoduWorkI18n?.getLocale?.() || 'zh-CN';
  let stopped = false;
  function translate(value, target) {
    if (target !== 'en-US') return value;
    const key = value.trim();
    let result = overrides[key];
    if (result === undefined) result = global.SoduWorkI18n?.translateText?.(key, target) ?? key;
    return result === key ? value : value.replace(key, () => result);
  }
  function render(owner, key, value, write, translator = translate) {
    let record = sources.get(owner);
    if (!record) { record = {}; sources.set(owner, record); }
    let item = record[key];
    // A PC rerender may update the same node. Never restore stale text over it.
    if (!item || item.output !== value) item = {source: value, output: value};
    item.output = translator(item.source, locale); record[key] = item;
    if (item.output !== value) write(item.output);
  }
  function text(element) {
    if (element.closest(protectedSelectors)) return;
    for (const node of element.childNodes) {
      if (node.nodeType === 3) render(node, 'text', node.nodeValue, value => { node.nodeValue = value; });
    }
  }
  function control(element) {
    if (element.closest(protectedSelectors)) return;
    for (const attribute of attributes) {
      if (!element.hasAttribute(attribute)) continue;
      render(element, attribute, element.getAttribute(attribute), value => element.setAttribute(attribute, value), (value, target) => {
        if (target === 'en-US' && element.matches('.nmodel-button')) {
          const match = /^模型：([\s\S]*) · 用于之后发送的消息$/.exec(value);
          if (match) return 'Model: ' + match[1] + ' · Used for subsequent messages';
        }
        return translate(value, target);
      });
    }
  }
  // The preview has no shared class. Identify the specific mobile chrome from
  // its close control and preserve its file title and isolated iframe document.
  function preview() {
    for (const button of document.querySelectorAll('section[role="dialog"] > header > button')) {
      const source = sources.get(button)?.['aria-label']?.source || button.getAttribute('aria-label');
      if (source !== '关闭成果预览') continue;
      const root = button.parentElement.parentElement;
      control(root);
      for (const sibling of button.parentElement.children) {
        if (sibling.tagName === 'BUTTON') { control(sibling); text(sibling); }
      }
      for (const child of root.children) {
        if (child.tagName === 'DIV') text(child);
        if (child.tagName === 'IFRAME') control(child);
      }
    }
  }
  const observer = typeof global.MutationObserver === 'function' ? new global.MutationObserver(() => apply()) : null;
  function apply(value) {
    if (stopped || !document?.body) return;
    if (typeof value === 'string') locale = /^en(?:-|$)/i.test(value) ? 'en-US' : 'zh-CN';
    observer?.disconnect();
    try {
      document.documentElement.lang = locale;
      document.title = locale === 'en-US' ? 'SoduWork · Conversation' : 'SoduWork · 对话';
      // This adapter is served only in our own same-origin conversation frame.
      try { global.frameElement?.setAttribute('title', locale === 'en-US' ? 'SoduWork conversation' : 'SoduWork 对话'); } catch (_) { /* Cross-origin hosts own their frame label. */ }
      for (const element of document.querySelectorAll(textSelectors.join(','))) text(element);
      for (const element of document.querySelectorAll(controlSelectors.join(','))) control(element);
      preview();
    } finally {
      observer?.observe(document.body, {subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: attributes});
    }
  }
  const changed = event => apply(event.detail?.locale || global.SoduWorkI18n?.getLocale?.());
  function destroy() {
    stopped = true; observer?.disconnect();
    global.removeEventListener('soduwork-locale-change', changed);
    global.removeEventListener('DOMContentLoaded', ready);
    global.removeEventListener('pagehide', hidden);
  }
  const ready = () => apply();
  const hidden = event => { if (!event.persisted) destroy(); };
  global.addEventListener('soduwork-locale-change', changed);
  global.addEventListener('pagehide', hidden);
  global.SoduWorkMobileLocale = Object.freeze({apply, destroy});
  if (document?.readyState === 'loading') global.addEventListener('DOMContentLoaded', ready, {once: true});
  else apply();
})(window);
