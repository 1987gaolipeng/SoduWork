/* The diagnostic card is bound to one failed call. Changing chat or starting
   another turn invalidates pending catalog reads and removes their results. */
(function (global) {
  'use strict';
  const phases = { initial: '首次模型请求', 'tool-result': '工具结果后的模型请求', model: '模型请求' };
  const notices = {
    changed: '此配置已变更或删除，请在「我的模型」重新确认。',
    account: '请使用发起该请求的账号检查模型。',
    managed: '请联系管理员检测此企业模型。',
    failed: '请在「我的模型」检查服务配置后重试。',
    unavailable: '当前模型目录暂不可用，请稍后重试。',
    unversioned: '此次请求缺少配置版本，请在「我的模型」确认后检测。'
  };
  function create(ctx, repaint) {
    const t = text => ctx.esc(global.SoduWorkI18n?.translateText?.(text) || text);
    let current;
    const scopeEvents = ['soduwork-data-scope-changed', 'soduwork-device-auth', 'soduwork-client-auth-required'];
    const scope = () => global.SoduWorkAPI.failedModelScope();
    function scopeChanged() {
      if (current && current.scope !== scope()) {
        reset();
        repaint();
      }
    }
    function reset() {
      if (!current) return;
      for (const type of scopeEvents) global.removeEventListener?.(type, scopeChanged);
      const previous = current;
      current = null;
      previous.controller.abort();
    }
    async function load(entry, check) {
      entry.pending = true;
      try {
        entry.view = await global.SoduWorkAPI.inspectFailedModel(entry.target, { check, signal: entry.controller.signal });
      } catch (error) {
        let state = check ? 'failed' : 'unavailable';
        if (error?.code === 'STALE_TASK_SCOPE' || error?.status === 401) state = 'account';
        if (error?.code === 'MODEL_PROVIDER_READ_ONLY') state = 'managed';
        if (error?.code === 'MODEL_PROVIDER_UNAVAILABLE' || error?.status === 404 ||
            error?.message === '模型配置在检测期间已变更，请重新检测') state = 'changed';
        entry.view = { state };
      } finally {
        entry.pending = false;
        if (current === entry) repaint();
      }
    }
    function html(target) {
      if (!target) { reset(); return ''; }
      const owner = scope();
      const key = JSON.stringify([ctx._ref, target]);
      if (current?.key !== key || current.scope !== owner) {
        reset();
        current = { key, target, scope: owner, controller: new AbortController(), view: {} };
        for (const type of scopeEvents) global.addEventListener?.(type, scopeChanged);
        void load(current, false);
      }
      const { view, pending } = current;
      const parts = [t(phases[target.phase] || phases.model)];
      if (Number.isInteger(target.status) && target.status >= 400 && target.status < 600) parts.push('HTTP ' + target.status);
      if ((view.service || view.model) && /^[a-f0-9]{32}$/.test(target.trace)) parts.push('soduwork-trace: ' + ctx.esc(target.trace));
      const safeLabel = value => typeof value === 'string' && /^[\p{L}\p{N}][\p{L}\p{N} ._:/()（）-]{0,159}$/u.test(value) &&
        !/\/\/|\b(?:\d{1,3}\.){3}\d{1,3}\b|\bbearer\s|^(?:sk-|gh[pousr]_|AKIA)[a-z\d_-]{10,}/i.test(value) ? value : '';
      const ids = [safeLabel(view.service), safeLabel(view.model)].filter(Boolean);
      const action = view.state === 'ready' || view.state === 'failed' || view.state === 'unavailable';
      // Render only contract check rows. A provider's free-form response body
      // must never become a diagnostic or an error message in the transcript.
      const checks = {};
      for (const key of ['connection', 'streaming', 'toolCalling']) {
        const row = view.report?.checks?.[key];
        if (row) checks[key] = { status: ['passed', 'failed', 'unsupported', 'cancelled', 'skipped'].includes(row.status) ? row.status : 'inconclusive',
          code: row.code, stage: row.stage, detailCode: row.detailCode };
      }
      const report = Object.keys(checks).length ? global.ModelCapabilitiesUI?.report({ checks }) || '' : '';
      return '<section class="nmodel-failure" data-chat-node="model-failure"><strong>' + t('失败的模型请求') + '</strong>' +
        '<div data-user-content>' + ids.map(ctx.esc).join(' / ') + '</div><div>' + parts.join(' · ') + '</div>' +
        (notices[view.state] ? '<div role="status">' + t(notices[view.state]) + '</div>' : '') +
        (action ? '<button type="button" data-check-failed-model' + (pending ? ' disabled' : '') + '>' +
          t(pending ? '正在检测能力…' : '检测此模型的能力') + '</button>' : '') + report + '</section>';
    }
    function bind(list) {
      const button = list.querySelector('[data-check-failed-model]');
      if (button) button.onclick = () => {
        if (!current || current.pending) return;
        if (current.scope !== scope()) { scopeChanged(); return; }
        const entry = current;
        void load(entry, true);
        repaint();
      };
    }
    return { reset, html, bind };
  }
  global.ChatModelFailure = { create };
})(globalThis);
