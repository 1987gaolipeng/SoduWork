/* Conversation view helper; state is scoped to its renderer instance. */
(function (global) {
  'use strict';
  function create(ctx) {
  function _ctxText() {
    const usage = _contextUsage();
    if (!usage.present || !usage.value) return '';
    const used = usage.value;
    const win = _contextWindow();
    const known = _contextWindowKnown();
    const n = _tokenText(used);
    if (!win || !known) return '已用 ' + n;
    const pct = (used / win) * 100;
    return pct < 1 ? '已用 ' + n + '（不到 1%）' : '上下文 ' + Math.round(pct) + '%';
  }

  /* Last request input (or native context watermark), including cache once.
     Output and cumulative consumption are not a context watermark. */
  function _usageFrom(value) {
    if (!value || typeof value !== 'object') return null;
    const pick = (row, keys) => {
      for (const key of keys) {
        const n = row?.[key];
        if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return Math.round(n);
      }
      return null;
    };
    const input = pick(value, [
      'input', 'inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens',
      'contextTokens', 'context_tokens', 'context',
    ]);
    const read = pick(value, ['cacheRead', 'cache_read_tokens', 'cache_read_input_tokens',
      'cached_input_tokens']) ?? pick(value.cache, ['read']);
    const write = pick(value, ['cacheWrite', 'cache_write_tokens', 'cacheCreation',
      'cache_creation_input_tokens', 'cache_write_input_tokens']) ?? pick(value.cache, ['write']);
    if (input === null && read === null && write === null) return null;
    const has = key => Object.prototype.hasOwnProperty.call(value, key);
    const separate = ['cache_read_input_tokens', 'cache_creation_input_tokens'].some(has);
    const includes = value.inputIncludesCache ?? value.input_includes_cache ??
      (has('cached_input_tokens') || (!separate &&
        ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens'].some(has)));
    return (input || 0) + (includes ? 0 : (read || 0) + (write || 0));
  }

  function _contextUsage() {
    const snap = ctx._snap || {};
    // An explicit null invalidates pre-compaction/previous-runtime usage.
    for (const key of ['contextUsage', 'tokens', 'context']) {
      if (!Object.prototype.hasOwnProperty.call(snap, key)) continue;
      const value = _usageFrom(snap[key]);
      return { value: value ?? 0, present: value !== null };
    }
    const messages = Array.isArray(snap.messages) ? snap.messages : [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role !== 'assistant' || messages[i].done !== true) continue;
      const value = _usageFrom(messages[i].usage);
      if (value !== null) return { value, present: true };
    }
    return { value: 0, present: false };
  }

  function _contextWindowInfo() {
    const snap = ctx._snap || {};
    const snapshotWindow = Number(snap.contextWindow || snap.ctxWindow || 0);
    if (snapshotWindow > 0) return {
      value: snapshotWindow,
      estimated: snap.contextWindowEstimated === true || snap.contextWindowKnown === false,
    };
    const model = snap.modelSelection?.activeModel || ctx._model || {};
    const modelWindow = Number(model.contextWindow || model.context_window ||
      model.maxContextTokens || 0);
    if (modelWindow > 0) return {
      value: modelWindow,
      estimated: model.contextWindowEstimated === true || model.contextWindowKnown === false,
    };
    const name = String(model.id || model.name || model.label || '').toLowerCase();
    const suffix = name.match(/(?:^|[-_./])(\d+(?:\.\d+)?)\s*(k|m|b)(?:$|[-_./])/i);
    if (suffix) {
      const multiplier = suffix[2].toLowerCase() === 'b' ? 1000000000
        : suffix[2].toLowerCase() === 'm' ? 1000000 : 1000;
      const value = Math.round(Number(suffix[1]) * multiplier);
      if (value >= 1024 && value <= 8000000) return { value, estimated: true };
    }
    if (/gpt-4\.1|(?:^|[-_:/.])o[134](?:-mini)?(?:$|[-_:/.])/.test(name)) {
      return { value: 1048576, estimated: true };
    }
    if (/claude|sonnet|opus|haiku/.test(name)) return { value: 200000, estimated: true };
    if (/gemini/.test(name)) return { value: 1048576, estimated: true };
    if (/deepseek/.test(name)) return { value: 64000, estimated: true };
    if (/qwen|通义千问/.test(name)) {
      return { value: 131072, estimated: true };
    }
    if (/glm|chatglm|moonshot|kimi|doubao|seed|llama|mistral/.test(name)) {
      return { value: 128000, estimated: true };
    }
    return { value: 128000, estimated: true };
  }

  function _contextWindow() {
    return _contextWindowInfo().value;
  }

  function _contextWindowKnown() {
    return _contextWindow() > 0;
  }

  function _contextWindowEstimated() {
    return Boolean(_contextWindowInfo().estimated);
  }

  function _tokenText(value) {
    const n = Math.max(0, Math.round(Number(value || 0)));
    return n.toLocaleString((globalThis.SoduWorkI18n?.getLocale() || 'zh-CN'));
  }

  function _ctxHtml() {
    const usage = _contextUsage();
    const used = usage.value;
    const win = _contextWindow();
    const known = _contextWindowKnown();
    const pct = known ? Math.max(0, Math.min(100, used / win * 100)) : 0;
    const visual = used && known ? Math.max(2, pct) : 0;
    const level = pct >= 85 ? ' hot' : (pct >= 60 ? ' warm' : '');
    const summary = !usage.present ? '暂无用量数据' :
      (!used ? '0%' : pct < 1 ? '不到 1%' : Math.round(pct) + '%');
    return '<span class="nctx-ring' + level + '" aria-hidden="true">' +
      '<svg viewBox="0 0 18 18" fill="none" focusable="false"><circle class="nctx-track" cx="9" cy="9" r="7"/>' +
      (visual > 0 ? '<circle class="nctx-value" cx="9" cy="9" r="7" pathLength="100" stroke-dasharray="' +
        visual.toFixed(1) + ' 100" transform="rotate(-90 9 9)"/>' : '') + '</svg></span>' +
      '<span class="nctx-pop" id="nchatContextHint" role="tooltip"><span class="nctx-label">上下文窗口</span>' +
      '<span class="nctx-percent">' + summary + (known && usage.present ? ' 已用' : '') + '</span>' +
      '<span class="nctx-total">' + (usage.present
        ? '已用 ' + _tokenText(used) + ' 标记，共 ' + _tokenText(win) +
          (_contextWindowEstimated() ? '（估算上限）' : '')
        : '上限 ' + _tokenText(win) + (_contextWindowEstimated() ? '（估算上限）' : '') +
          '，本轮尚未返回用量数据') + '</span><span class="nctx-total">' +
      '最近一次上报的上下文用量，含缓存；不含待发送内容' + '</span></span>';
  }

    return { _ctxText, _tokenText, _ctxHtml };
  }
  global.ChatContextMeter = { create };
})(window);
