'use strict';
(async () => {
  const bridge = window.fullAccessConsent;
  const cancel = document.getElementById('consentCancel');
  const close = document.getElementById('consentClose');
  const allow = document.getElementById('consentAllow');
  const checkbox = document.getElementById('consentAcknowledged');
  const appearanceKeys = ['--bg-0','--bg-1','--bg-2','--bg-3','--ink','--ink-2','--ink-3','--ink-4',
    '--line','--line-2','--line-3','--accent','--accent-hover','--accent-soft','--accent-soft-2','--font-ui','--font-display'];
  let data, finished = false, newestTheme;
  function applyAppearance(appearance) {
    if (!appearance) return;
    const root = document.documentElement;
    for (const name of ['theme','skin','character','colorScheme']) root.dataset[name] = appearance[name] || '';
    for (const key of appearanceKeys) {
      root.style.removeProperty(key);
      if (appearance.tokens?.[key]) root.style.setProperty(key, appearance.tokens[key]);
    }
  }
  const unsubscribe = bridge.onTheme?.(value => {
    newestTheme = value;
    if (data && value.requestId === data.requestId) applyAppearance(value.appearance);
  }) || (() => {});
  window.addEventListener('unload', unsubscribe, { once: true });
  async function answer(decision) {
    if (finished || !data || (decision === 'allow' && !checkbox.checked)) return;
    finished = true;
    allow.disabled = cancel.disabled = close.disabled = checkbox.disabled = true;
    try { await bridge.answer({ requestId: data.requestId, decision, acknowledged: checkbox.checked }); }
    catch (_) { /* The main process closes failed or expired requests. */ }
  }
  cancel.addEventListener('click', () => answer('cancel'));
  close.addEventListener('click', () => answer('cancel'));
  allow.addEventListener('click', () => answer('allow'));
  checkbox.addEventListener('change', () => { allow.disabled = !checkbox.checked; });
  // Report the natural content height so the window hugs its content.
  function reportSize() {
    if (!bridge.size) return;
    const el = document.querySelector('.consent');
    if (!el) return;
    const prev = el.style.height;
    el.style.height = 'auto';
    const natural = Math.ceil(el.getBoundingClientRect().height);
    el.style.height = prev;
    if (natural > 0) bridge.size(natural + 4); // + body padding (2px top/bottom)
  }
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); answer('cancel'); }
    if (event.key !== 'Tab') return;
    const controls = [...document.querySelectorAll('button,summary,input')].filter(item => !item.disabled);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  try {
    data = await bridge.content();
    if (!data?.requestId) return;
    // During a development update an already-running main process may still
    // return the previous content contract. Keep every new field readable;
    // never fabricate a request ID or approval from missing main-process data.
    const fallback = data.lang === 'zh-CN' ? {
      category: '权限调整', scope: '访问范围', scopeValue: '仅此会话', full: '完全访问',
      impact: '可修改文件，也可运行命令并向外发送数据。',
      detailShow: '查看权限明细', detailHide: '收起权限明细',
      adjustment: '随时可从对话框调整权限。',
    } : {
      category: 'Access change', scope: 'Access scope', scopeValue: 'This chat only', full: 'Full access',
      impact: 'Can change files, run commands, and send data outside your device.',
      detailShow: 'View permission details', detailHide: 'Hide permission details',
      adjustment: 'You can change access from the chat composer at any time.',
    };
    data = { ...fallback, ...data };
    applyAppearance(newestTheme?.requestId === data.requestId ? newestTheme.appearance : data.appearance);
    document.documentElement.lang = data.lang;
    document.title = data.title;
    for (const element of document.querySelectorAll('[data-text]')) element.textContent = data[element.dataset.text] || '';
    for (const element of document.querySelectorAll('[data-label]')) element.setAttribute('aria-label', data[element.dataset.label] || '');
    cancel.focus();
    document.body.dataset.ready = 'true';
    reportSize();
    document.fonts?.ready?.then(reportSize);
    document.getElementById('permissionDetails').addEventListener('toggle', reportSize);
  } catch (_) { /* No data means the confirmation remains disabled. */ }
})();
