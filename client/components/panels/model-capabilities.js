(function (global) {
  'use strict';
  const names = { imageInput: '图片输入', toolCalling: '工具调用', streaming: '流式输出' };
  const states = { unknown: '未确认', supported: '支持', unsupported: '不支持' };
  const statusNames = { passed: '检测通过', failed: '检测失败', unsupported: '不支持', inconclusive: '未能确认', running: '正在检测', cancelled: '已取消', skipped: '未执行' };
  const sources = { configured: '手动配置', 'legacy-native': '已有配置', verified: '实际检测', unknown: '未确认' };
  const diagnostics = {
    request_rejected: '服务拒绝了检测请求，原因尚未确认',
    timeout: '服务响应超时，可稍后重试', temporarily_unavailable: '服务暂时不可用，可稍后重试',
    credentials_or_access: '请检查凭据及模型访问权限', model_or_endpoint_missing: '请检查模型 ID 和接口地址',
    capability_not_supported: '服务明确返回不支持此能力', request_not_accepted: '服务未接受检测请求，请检查协议配置',
    expected_output_missing: '未收到预期结果，暂不能确认能力', invalid_response: '服务响应格式无法识别',
    protocol_not_tested: '此协议暂无法自动检测', parameter_not_supported: '检测参数不被接受，能力仍未确认',
    cancelled: '检测已取消，已有证据仍保留', connection_blocked: '连接检查未通过，此项未执行',
    legacy_recheck_required: '旧版检测结果需要重新验证',
    billing_unavailable: '模型服务计费额度不可用，请检查供应商账户',
    budget_exhausted: '检测预算已用尽，能力仍未确认', response_too_large: '检测响应超过大小限制',
    response_limit: '检测响应超过大小限制', stream_interrupted: '流式响应未正常完成', stream_incomplete: '流式响应未正常完成',
    stream_error: '服务在逐步返回回复时报告错误', stream_not_observed: '未收到逐步返回的回复，暂不能确认能力',
    response_truncated: '回复提前结束，未能完成检测', content_filtered: '服务拦截了检测回复，暂不能确认能力',
    transport_interrupted: '连接中断，未能完成检测'
  };
  const stages = {
    output: '检测阶段：检查回复内容', stream: '检测阶段：逐步接收回复',
    tool_call: '检测阶段：请求工具执行', tool_result: '检测阶段：读取工具结果'
  };
  const detailDiagnostics = {
    tool_finish_reason_mismatch: '模型未按要求发起工具调用', tool_call_count_mismatch: '模型未按要求调用一次工具',
    tool_call_invalid: '未收到可用的工具调用', tool_arguments_invalid: '工具调用信息不符合检测要求',
    tool_receipt_mismatch: '模型未正确确认工具执行结果', tool_result_finish_reason_mismatch: '模型读取工具结果后未正常完成回复',
    invalid_stream_shape: '逐步返回的回复格式无法识别', expected_output_mismatch: '回复内容与检测要求不符'
  };
  // The workspace's esc is a lexical binding, not a window property. Keep this
  // shared component independent of how its host exposes formatting helpers.
  const e = value => String(value ?? '').replace(/[&<>"']/g,
    char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  // Older reports lack detail codes; unknown provider values must never become UI copy.
  const knownMessage = (messages, key) => typeof key === 'string' && Object.hasOwn(messages, key) ? messages[key] : '';
  function checkDiagnostic(key, check, retained) {
    const stage = knownMessage(stages, check.stage);
    const detail = key === 'imageInput' && check.detailCode === 'expected_output_mismatch'
      ? '未收到与图片中六位数字完全一致的回复'
      : knownMessage(detailDiagnostics, check.detailCode) || knownMessage(diagnostics, check.code);
    const message = retained && check.status === 'unsupported' ? '服务拒绝了本次图片请求。对话沿用上次通过的结果，你仍可发图。' : detail;
    return (stage ? '<small>' + e(stage) + '</small>' : '') + (message ? '<small>' + e(message) + '</small>' : '') +
      (retained && check.status === 'inconclusive' ? '<small>对话沿用上次通过的结果，你仍可发图。</small>' : '');
  }
  function select(key, label, options, value) {
    return '<label class="md-cap-field"><span>' + label + '</span><select class="md-in" data-mdfield="' + key + '">' +
      Object.entries(options).map(([id, text]) => '<option value="' + id + '"' + (id === value ? ' selected' : '') + '>' + text + '</option>').join('') + '</select></label>';
  }
  const glmThinkingLevels = { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' };
  const thinkingDrafts = new WeakMap();
  function thinkingPreset(config) {
    return config.thinkingMode === 'always' && config.thinkingFormat === 'zai' && config.supportsReasoningEffort === true &&
      Object.keys(glmThinkingLevels).every(key => config.thinkingLevelMap?.[key] === glmThinkingLevels[key]) ? 'glm-5.3' : 'custom';
  }
  function bindThinking(container, restored) {
    const preset = container.querySelector('[data-mdfield="thinkingPreset"]');
    if (!preset) return;
    const controls = [container.querySelector('[data-paddthinking]'), container.querySelector('[data-mdfield="thinkingFormat"]'),
      container.querySelector('[data-mdfield="supportsReasoningEffort"]')];
    const current = () => controls.map(field => field?.value || '');
    thinkingDrafts.set(container, Array.isArray(restored) ? restored.slice() : current());
    function sync() {
      const fixed = preset.value === 'glm-5.3';
      controls.forEach((field, index) => {
        if (!field) return;
        field.disabled = fixed;
        if (fixed) field.value = ['always', 'zai', 'yes'][index];
      });
      const note = container.querySelector('[data-md-thinking-preset-note]');
      if (note) note.hidden = !fixed;
    }
    preset.addEventListener('change', () => {
      if (preset.value === 'glm-5.3') thinkingDrafts.set(container, current());
      else controls.forEach((field, index) => { if (field) field.value = thinkingDrafts.get(container)[index]; });
      sync();
    });
    sync();
  }
  function profile(model) {
    const config = model.config || {}, profile = model.capabilityProfile || {};
    return Object.fromEntries(Object.keys(names).map(key => {
      const explicit = config.capabilities?.[key];
      const legacy = key === 'imageInput' && config.imageRouting === 'native';
      return [key, explicit && explicit !== 'unknown' ? { ...profile[key], state: explicit, source: 'configured' }
        : legacy ? { ...profile[key], state: 'supported', source: 'legacy-native' }
        : profile[key] || { state: 'unknown', source: 'unknown' }];
    }));
  }
  function badgeLabel(kind, value) {
    const translate = text => global.SoduWorkI18n?.translateText?.(text) || text;
    if (kind === 'recheck') return translate(diagnostics.legacy_recheck_required);
    if (kind === 'verified') return ['supported', 'unsupported'].includes(value)
      ? translate(value === 'supported' ? '上次验证：支持' : '上次验证：不支持') : '';
    const templates = { configured: '手动配置：{0}', 'legacy-native': '已有配置：{0}', latest: '最近检测：{0}' };
    const template = knownMessage(templates, kind), label = knownMessage(kind === 'latest' ? statusNames : states, value);
    return template && label ? translate(template).replace('{0}', translate(label)) : '';
  }
  function badgeLabelHtml(tag, kind, value) {
    return '<' + tag + ' data-user-content data-md-cap-label="' + kind + '" data-md-cap-value="' + value + '">' +
      e(badgeLabel(kind, value)) + '</' + tag + '>';
  }
  function retainedImageSupport(model, result, imageProfile) {
    const latest = result?.checks?.imageInput;
    return model && model.enabled !== false && (!model.modality || model.modality === 'chat') &&
      model.config?.imageRouting !== 'vision-fallback' && imageProfile?.source === 'verified' && imageProfile.state === 'supported' &&
      !result?.pending && result?.verifiedChecks?.imageInput?.status === 'passed' &&
      (latest?.status === 'unsupported' || (latest?.status === 'inconclusive' && latest.detailCode === 'expected_output_mismatch'));
  }
  function badges(model, result = model.capabilityCheck) {
    if (model.modality && model.modality !== 'chat') return '';
    return '<div class="md-cap-badges">' + Object.entries(profile(model)).map(([key, value]) => {
      const latest = result?.checks?.[key] ?? model.capabilityCheck?.checks?.[key];
      const status = latest?.status ?? value.checkStatus, lastLabel = knownMessage(statusNames, status);
      const knownState = ['supported', 'unsupported'].includes(value.state);
      const attemptState = status === 'passed' ? 'supported' : status === 'unsupported' ? 'unsupported' : 'unknown';
      // Progress reports an observation, never a replacement for saved proof.
      const pending = Boolean(result?.pending && result.checks?.[key]);
      const retained = key === 'imageInput' && retainedImageSupport(model, result, value);
      const divergent = !retained && knownState && lastLabel && (pending || attemptState !== value.state);
      const attributed = divergent && ['verified', 'configured', 'legacy-native'].includes(value.source);
      const label = attributed ? badgeLabelHtml('b', value.source, value.state)
        : '<b>' + e(knownMessage(states, value.state) || states.unknown) + '</b>';
      const recent = latest?.code === 'legacy_recheck_required' ? badgeLabelHtml('small', 'recheck', latest.code)
        : lastLabel && (divergent || !knownState) ? badgeLabelHtml('small', 'latest', status) : '';
      return '<span class="md-cap-badge is-' + (value.state === 'supported' ? 'supported' : 'neutral') + '" title="' +
        e(knownMessage(sources, value.source) || sources.unknown) + '">' + names[key] + label + recent +
        (value.conflict ? '<small title="配置与最近检测结果不一致">配置冲突</small>' : '') + '</span>';
    }).join('') + '</div>';
  }
  function fields(model) {
    const config = model.config || {};
    return '<div class="md-cap-fields" data-mdchat><div class="md-cap-intro"><b>模型能力</b><span>按服务实际支持的能力设置，未知项可检测确认。</span></div>' +
      '<div class="md-cap-grid">' + Object.entries(names).map(([key, name]) => select(key, name, states, config.capabilities?.[key] || 'unknown')).join('') + '</div>' +
      '<details class="md-cap-advanced"><summary>高级设置</summary><div class="md-cap-grid">' +
      select('imageRouting', '图片处理方式', { auto: '自动选择', native: '模型原生识图', 'vision-fallback': '独立视觉服务' }, config.imageRouting || 'auto') +
      '<label class="md-cap-field"><span>上下文窗口</span><input class="md-in" data-mdfield="ctxWindow" type="number" min="1024" max="10000000" step="1" placeholder="自动" value="' +
        e(model.contextWindowKnown === false ? '' : model.ctxWindow || model.contextWindow || '') + '"></label>' +
      '<label class="md-cap-field"><span>最大输出 Token</span><input class="md-in" data-mdfield="maxOutputTokens" type="number" min="1024" max="262144" step="1" placeholder="16384" value="' + e(config.maxOutputTokens || '') + '"><small>留空时使用 16384 Token。请按服务实际限制填写；能力检测不验证最大输出上限。</small></label>' +
      select('thinkingPreset', '思考策略', { custom: '自定义（保留当前设置）', 'glm-5.3': 'GLM 5.3（始终思考）' }, thinkingPreset(config)) +
      select('thinkingFormat', '思考协议格式', { '': '自动识别（按模型名）', openai: 'OpenAI reasoning_effort',
        deepseek: 'DeepSeek thinking', qwen: 'Qwen enable_thinking', 'qwen-chat-template': 'Qwen chat_template_kwargs',
        'chat-template': '自定义 chat_template_kwargs', zai: 'Z.ai thinking', openrouter: 'OpenRouter reasoning',
        together: 'Together reasoning', baseten: 'Baseten reasoning', 'ant-ling': 'Ant Ling thinking', 'string-thinking': '字符串 thinking' }, config.thinkingFormat || '') +
      select('supportsReasoningEffort', '思考强度参数', { auto: '自动识别', yes: '支持', no: '不支持' },
        typeof config.supportsReasoningEffort === 'boolean' ? config.supportsReasoningEffort ? 'yes' : 'no' : 'auto') +
      '</div><p data-md-thinking-preset-note' + (thinkingPreset(config) === 'glm-5.3' ? '' : ' hidden') + '>仅当服务实际提供 GLM 5.3 时选择。始终思考，默认低强度；不更改模型 ID、显示名称或输出上限。</p>' +
      '<p>自动选择优先使用已确认的原生视觉能力；兼容识图需要配置独立视觉服务。</p></details></div>';
  }
  function read(container, model) {
    const config = { ...(model?.config || {}) }, capabilities = { ...config.capabilities };
    const value = key => container.querySelector('[data-mdfield="' + key + '"]')?.value || '';
    for (const key of Object.keys(names)) capabilities[key] = value(key) || 'unknown';
    config.capabilities = capabilities;
    const format = value('thinkingFormat'), effort = value('supportsReasoningEffort');
    if (format) config.thinkingFormat = format; else delete config.thinkingFormat;
    if (effort === 'yes' || effort === 'no') config.supportsReasoningEffort = effort === 'yes'; else delete config.supportsReasoningEffort;
    config.thinkingMode = container.querySelector('[data-paddthinking]')?.value || 'auto';
    // Clear obsolete declarations before applying a complete, explicitly chosen policy.
    if (config.thinkingMode !== model?.config?.thinkingMode) {
      delete config.reasoning; delete config.thinkingAlwaysOn; delete config.thinkingLevelMap;
    }
    if (value('thinkingPreset') === 'glm-5.3') {
      delete config.reasoning; delete config.thinkingAlwaysOn;
      Object.assign(config, { thinkingMode: 'always', thinkingFormat: 'zai', supportsReasoningEffort: true,
        thinkingLevelMap: { ...glmThinkingLevels } });
    }
    config.imageRouting = value('imageRouting') || 'auto';
    if (config.imageRouting === 'native' && capabilities.imageInput === 'unsupported') throw Error('原生识图与不支持图片输入的配置冲突');
    const number = (key, max) => {
      const raw = value(key);
      if (!raw) return 0;
      const num = Number(raw);
      if (!Number.isInteger(num) || num < 1024 || num > max) throw Error('Token 上限必须填写允许范围内的整数');
      return num;
    };
    const output = number('maxOutputTokens', 262144), context = number('ctxWindow', 10000000);
    if (context && output > context) throw Error('最大输出不能超过上下文窗口');
    if (output) config.maxOutputTokens = output; else delete config.maxOutputTokens;
    return { config, ctxWindow: context };
  }
  function report(result, model) {
    if (!result) return '<span class="md-cap-unchecked">能力尚未检测</span>';
    if (result.pending) return '<div role="status" class="md-cap-unchecked"><span>正在检测能力…</span>' +
      Object.entries(result.checks || {}).map(([key, check]) => '<div><span>' + (names[key] || '服务连接') + '</span> · <span>' +
        (statusNames[check.status] || statusNames.inconclusive) + '</span></div>').join('') + '</div>';
    if (result.error) return '<span role="alert" class="md-cap-error">' + e(result.error) + '</span>';
    const rows = Object.entries(result.checks || {}).filter(([key]) => key === 'connection' || names[key]);
    const date = result.checkedAt ? new Date(result.checkedAt) : null;
    const time = date && !Number.isNaN(date.getTime()) ? date.toLocaleString(global.SoduWorkI18n?.getLocale?.() || undefined) : '';
    const retainedImage = retainedImageSupport(model, result, model && profile(model).imageInput);
    const history = (key, check, retained) => {
      const previous = result.verifiedChecks?.[key];
      if (!previous || previous.status === check.status && previous.checkedAt === check.checkedAt) return '';
      const label = retained ? '上次通过' : (previous.status === 'passed' ? '上次验证：支持' : '上次验证：不支持');
      return '<small><span>' + label + '</span>' +
        (previous.checkedAt ? ' <time data-user-content data-md-checked-at="' + e(previous.checkedAt) + '">' + e(new Date(previous.checkedAt).toLocaleString(global.SoduWorkI18n?.getLocale?.() || undefined)) + '</time>' : '') + '</small>';
    };
    return '<details class="md-cap-report"><summary>检测结果' + (time ? '<time data-user-content data-md-checked-at="' + e(result.checkedAt) + '">' + e(time) + '</time>' : '') + '</summary><dl>' +
      rows.map(([key, check]) => {
        const retained = key === 'imageInput' && retainedImage;
        const status = retained && check.status === 'unsupported' ? '本次检测未通过' : statusNames[check.status] || statusNames.inconclusive;
        return '<div><dt>' + (names[key] || '服务连接') + '</dt><dd class="is-' + e(check.status) + '">' + status + '</dd>' +
          checkDiagnostic(key, check, retained) + history(key, check, retained) + '</div>';
      }).join('') +
      '</dl><p>检测结果仅适用于当前服务和模型配置；超时或网络异常不代表模型不支持。</p></details>';
  }
  function evidenceWarning(model) {
    return model.capabilityEvidenceError ? '<p role="alert" class="md-cap-error">检测记录暂不可用，请重新检测</p>' : '';
  }
  global.ModelCapabilitiesUI = { names, states, profile, badges, fields, read, report, evidenceWarning,
    bindThinking, thinkingDraft: container => thinkingDrafts.get(container)?.slice() };
  global.addEventListener?.('soduwork-locale-change', () => {
    global.document?.querySelectorAll('[data-md-cap-label]').forEach(element => {
      const label = badgeLabel(element.dataset.mdCapLabel, element.dataset.mdCapValue);
      if (label) element.textContent = label;
    });
    global.document?.querySelectorAll('[data-md-checked-at]').forEach(element => {
      const date = new Date(element.dataset.mdCheckedAt);
      if (!Number.isNaN(date.getTime())) element.textContent = date.toLocaleString(global.SoduWorkI18n?.getLocale?.() || undefined);
    });
  });
})(globalThis);
