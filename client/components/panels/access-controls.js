(function (global) {
  'use strict';
  const overlays = new WeakMap();
  function clean(value, key) {
    if (/token|secret|password|authorization|api[_-]?key/i.test(key || '')) return '••••';
    if (Array.isArray(value)) return value.map(item => clean(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v, k)]));
    return value;
  }
  function render(request, escape, options = {}) {
    const esc = escape;
    const text = source => global.SoduWorkI18n?.html ? global.SoduWorkI18n.html(source, source)
      : esc(global.SoduWorkI18n?.t ? global.SoduWorkI18n.t(source) : source);
    const titles = { 'file.read': '允许读取文件？', 'file.write': '允许修改文件？', 'command.execute': '允许运行命令？', 'tool.execute': '允许使用此工具？' };
    const targetLabels = { 'file.read': '文件位置', 'file.write': '文件位置', 'command.execute': '将运行的命令' };
    const payload = clean(request.arguments || {});
    const command = request.action === 'command.execute' || request.action === 'terminal.execute' || request.action === 'native.command' ||
      (request.kind === 'execute' && typeof payload.command === 'string');
    const action = command ? 'command.execute' : request.kind === 'edit' ? 'file.write' : request.kind === 'read' ? 'file.read' : request.action;
    const commandPreview = command && typeof payload.command === 'string' ? payload.command +
      (Array.isArray(payload.args) ? payload.args.map(arg => ' ' + JSON.stringify(String(arg))).join('') : '') : '';
    const files = Array.isArray(payload.changes) ? payload.changes.filter(row => row && typeof row.path === 'string').map(row => row.path) : [];
    const target = commandPreview || (files.length ? [...new Set(files)].join('\n') : request.target) || '';
    const allowSession = request.allowSession !== false;
    const previewScope = allowSession && request.sessionScope?.kind === 'browser-preview';
    const missingInput = payload.inputUnavailable === true || payload.input === null;
    const detail = missingInput ? '' : typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    const scopeNote = previewScope ? '本会话记住页面预览；其他命令仍需确认。'
      : allowSession ? (command ? '记住这条命令；命令或目录改变后仍需确认。' : '记住同一目标的操作。')
        : '仅允许这一次操作。';
    const button = (decision, label, className = '') =>
      '<button type="button" class="nask-btn ' + className +
      '" data-ui-answer="permission" data-ui-value="' + decision + '" data-permission-request="' + esc(request.requestId) +
      '" data-permission-revision="' + Number(request.policyRevision) + '">' + text(label) + '</button>';
    return '<section class="access-request" role="dialog" aria-modal="false" aria-label="权限确认" data-permission-ref="' + esc(options.ref || '') + '">' +
      '<header class="access-head" aria-live="polite"><span class="access-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m12 3 7 3v5c0 4.6-2.7 7.9-7 10-4.3-2.1-7-5.4-7-10V6z"/><path d="m8.8 11.9 2.1 2.2 4.4-4.6"/></svg></span>' +
      '<div><b>' + text(titles[action] || '允许使用此工具？') + '</b><i>' + text('确认后继续当前任务') + '</i></div>' +
      '<span class="access-count" role="status"></span></header><div class="access-body">' +
      (target ? '<div class="access-target-wrap"><span class="access-target-label">' + text(targetLabels[action] || '操作对象') +
      '</span><code class="access-target" data-user-content>' + esc(target) + '</code></div>' : '') +
      (missingInput ? '<p class="access-input-note">' + text('详情不完整，仅允许本次操作。') + '</p>' : '') +
      (!missingInput && payload.inputIncomplete ? '<p class="access-input-note">' + text('详情不完整，请单独确认。') + '</p>' : '') +
      (previewScope ? '<p class="access-input-note">' + text('会话授权范围：页面预览与截图') + '</p>' : '') +
      (detail ? '<details><summary><span>' + text('查看操作详情') + '</span>' +
      (request.tool || request.agent ? '<code data-user-content>' + esc(request.tool || request.agent) + '</code>' : '') +
      '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4"/></svg></summary><pre data-user-content>' + esc(detail.slice(0, 20000)) + '</pre></details>' : '') + '</div>' +
      '<footer><div class="nask-btns">' + button('deny', '拒绝') +
      (allowSession ? button('session', '本会话允许', 'access-remember') : '') + button('once', '允许一次', 'primary') + '</div>' +
      '<small>' + text(scopeNote) + '</small><p class="access-error" role="alert" hidden></p></footer></section>';
  }
  function sync(el, ref, snapshot, escape, onAnswer) {
    if (!el) return;
    const requests = Array.isArray(snapshot?.pendingPermissions) ? snapshot.pendingPermissions
      : snapshot?.pendingUi?.method === 'permission' ? [snapshot.pendingUi] : [];
    const request = ref && requests[0];
    if (!request) { destroy(el); return; }
    let state = overlays.get(el);
    if (!state) {
      const dock = el.querySelector('.nchat-entry-dock'), composer = el.querySelector('.nbox');
      if (!dock || !composer) return;
      const layer = document.createElement('div'); layer.className = 'nchat-access-overlay';
      dock.appendChild(layer);
      const life = new AbortController();
      const position = () => {
        if (!layer.isConnected) return;
        const r = composer.getBoundingClientRect(), d = dock.getBoundingClientRect();
        const top = Math.max(8, el.getBoundingClientRect().top + 8);
        const width = Math.max(0, Math.min(r.width - 16, global.innerWidth - 24));
        const left = Math.max(12, Math.min(r.left + (r.width - width) / 2, global.innerWidth - width - 12));
        layer.style.width = width + 'px';
        layer.style.left = (left - d.left) + 'px';
        layer.style.right = 'auto';
        layer.style.bottom = (d.bottom - r.top + 10) + 'px';
        layer.style.maxHeight = Math.max(40, Math.min(440, r.top - top - 10)) + 'px';
      };
      state = { layer, life, position, key: '', onAnswer };
      layer.addEventListener('click', event => {
        const button = event.target.closest('[data-ui-answer="permission"]');
        if (button && !button.disabled) { event.stopPropagation(); state.onAnswer?.(button); }
      }, { signal: life.signal });
      global.addEventListener('resize', position, { signal: life.signal });
      if (global.ResizeObserver) {
        state.observer = new ResizeObserver(position); state.observer.observe(composer); state.observer.observe(dock);
      }
      overlays.set(el, state);
    }
    state.onAnswer = onAnswer;
    const key = JSON.stringify([ref, request.requestId, request.policyRevision, request.action, request.tool,
      request.agent, request.target, request.arguments, request.allowSession, request.sessionScope]);
    if (state.key !== key) { state.layer.innerHTML = render(request, escape, { ref }); state.key = key; }
    const count = state.layer.querySelector('.access-count');
    const extra = requests.length - 1;
    count.hidden = extra <= 0;
    if (count.dataset.count !== String(extra)) {
      count.textContent = '+' + extra;
      count.title = '还有 ' + extra + ' 项待确认';
      count.setAttribute('aria-label', count.title);
      count.dataset.count = String(extra);
    }
    state.position();
  }
  function destroy(el) {
    const state = el && overlays.get(el);
    if (!state) return;
    state.life.abort(); state.observer?.disconnect(); state.layer.remove(); overlays.delete(el);
  }
  async function answer(button, api, ref) {
    const card = button.closest('.access-request');
    if (!card || card.dataset.answerPending === 'true') return { ok: false };
    if (card.dataset.permissionRef && card.dataset.permissionRef !== ref) return { ok: false, reason: '权限请求已失效' };
    const response = { requestId: button.dataset.permissionRequest,
      policyRevision: Number(button.dataset.permissionRevision), decision: button.dataset.uiValue };
    const buttons = [...card.querySelectorAll('[data-ui-answer]')];
    const error = card.querySelector('.access-error');
    card.dataset.answerPending = 'true'; card.setAttribute('aria-busy', 'true');
    buttons.forEach(item => { item.disabled = true; }); if (error) error.hidden = true;
    let accepted = false;
    try {
      const result = await api.answerUi(ref, response);
      accepted = result?.ok === true;
      if (accepted) card.hidden = true;
      else if (error) { error.hidden = false; error.textContent = result?.reason || '权限确认失败，请重试'; }
      return result || { ok: false, reason: '权限确认失败，请重试' };
    } catch (_) {
      if (error) { error.hidden = false; error.textContent = '权限确认失败，请重试'; }
      return { ok: false, reason: '权限确认失败，请重试' };
    } finally {
      if (!accepted && card.isConnected) {
        card.dataset.answerPending = 'false'; card.setAttribute('aria-busy', 'false');
        buttons.forEach(item => { item.disabled = false; });
      }
    }
  }
  global.AccessControls = { render, sync, destroy, answer };
})(window);
