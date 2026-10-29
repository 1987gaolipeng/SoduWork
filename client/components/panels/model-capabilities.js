(function (global) {
  'use strict';
  const names = { imageInput: '图片输入', toolCalling: '工具调用', streaming: '流式输出' };
  const states = { unknown: '未确认', supported: '支持', unsupported: '不支持' };
  const statusNames = { passed: '检测通过', failed: '检测失败', unsupported: '不支持', inconclusive: '未能确认' };
  const sources = { configured: '手动配置', 'legacy-native': '已有配置', verified: '实际检测', unknown: '未确认' };
  const diagnostics = {
    timeout: '服务响应超时，可稍后重试', temporarily_unavailable: '服务暂时不可用，可稍后重试',
    credentials_or_access: '请检查凭据及模型访问权限', model_or_endpoint_missing: '请检查模型 ID 和接口地址',
    capability_not_supported: '服务明确返回不支持此能力', request_not_accepted: '服务未接受检测请求，请检查协议配置',
    expected_output_missing: '未收到预期结果，暂不能确认能力', invalid_response: '服务响应格式无法识别',
    protocol_not_tested: '当前协议尚不支持自动检测，请手动配置'
  };
  // The workspace's esc is a lexical binding, not a window property. Keep this
  // shared component independent of how its host exposes formatting helpers.
  const e = value => String(value ?? '').replace(/[&<>"']/g,
    char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  function select(key, label, options, value) {
    return '<label class="md-cap-field"><span>' + label + '</span><select class="md-in" data-mdfield="' + key + '">' +
      Object.entries(options).map(([id, text]) => '<option value="' + id + '"' + (id === value ? ' selected' : '') + '>' + text + '</option>').join('') + '</select></label>';
  }
  function profile(model) {
    const config = model.config || {}, profile = model.capabilityProfile || {};
    return Object.fromEntries(Object.keys(names).map(key => {
      const explicit = config.capabilities?.[key];
      const legacy = key === 'imageInput' && config.imageRouting === 'native';
      return [key, profile[key] || { state: explicit && explicit !== 'unknown' ? explicit : legacy ? 'supported' : 'unknown',
        source: explicit && explicit !== 'unknown' ? 'configured' : legacy ? 'legacy-native' : 'unknown' }];
    }));
  }
  function badges(model) {
    if (model.modality && model.modality !== 'chat') return '';
    return '<div class="md-cap-badges">' + Object.entries(profile(model)).map(([key, value]) =>
      '<span class="md-cap-badge is-' + (value.state === 'supported' ? 'supported' : 'neutral') + '" title="' + e(sources[value.source] || '未确认') + '">' +
      names[key] + '<b>' + (states[value.state] || states.unknown) + '</b></span>').join('') + '</div>';
  }
  function fields(model) {
    const config = model.config || {};
    return '<div class="md-cap-fields" data-mdchat><div class="md-cap-intro"><b>模型能力</b><span>按服务实际支持的能力设置，未知项可检测确认。</span></div>' +
      '<div class="md-cap-grid">' + Object.entries(names).map(([key, name]) => select(key, name, states, config.capabilities?.[key] || 'unknown')).join('') + '</div>' +
      '<details class="md-cap-advanced"><summary>高级设置</summary><div class="md-cap-grid">' +
      select('imageRouting', '图片处理方式', { auto: '自动选择', native: '模型原生识图', 'vision-fallback': '独立视觉服务' }, config.imageRouting || 'auto') +
      '<label class="md-cap-field"><span>上下文窗口</span><input class="md-in" data-mdfield="ctxWindow" type="number" min="1024" max="10000000" step="1" placeholder="自动" value="' +
        e(model.contextWindowKnown === false ? '' : model.ctxWindow || model.contextWindow || '') + '"></label>' +
      '<label class="md-cap-field"><span>最大输出 Token</span><input class="md-in" data-mdfield="maxOutputTokens" type="number" min="1024" max="262144" step="1" placeholder="16384" value="' + e(config.maxOutputTokens || '') + '"></label>' +
      select('thinkingFormat', '思考协议格式', { '': '自动识别（按模型名）', openai: 'OpenAI reasoning_effort',
        deepseek: 'DeepSeek thinking', qwen: 'Qwen enable_thinking', 'qwen-chat-template': 'Qwen chat_template_kwargs',
        'chat-template': '自定义 chat_template_kwargs', zai: 'Z.ai thinking', openrouter: 'OpenRouter reasoning',
        together: 'Together reasoning', baseten: 'Baseten reasoning', 'ant-ling': 'Ant Ling thinking', 'string-thinking': '字符串 thinking' }, config.thinkingFormat || '') +
      select('supportsReasoningEffort', '思考强度参数', { auto: '自动识别', yes: '支持', no: '不支持' },
        typeof config.supportsReasoningEffort === 'boolean' ? config.supportsReasoningEffort ? 'yes' : 'no' : 'auto') +
      '</div><p>自动选择优先使用已确认的原生视觉能力；兼容识图需要配置独立视觉服务。</p></details></div>';
  }
  function read(container, model) {
    const config = { ...(model?.config || {}) }, capabilities = { ...config.capabilities };
    const value = key => container.querySelector('[data-mdfield="' + key + '"]')?.value || '';
    for (const key of Object.keys(names)) capabilities[key] = value(key) || 'unknown';
    config.capabilities = capabilities;
    const format = value('thinkingFormat'), effort = value('supportsReasoningEffort');
    if (format) config.thinkingFormat = format; else delete config.thinkingFormat;
    if (effort === 'yes' || effort === 'no') config.supportsReasoningEffort = effort === 'yes'; else delete config.supportsReasoningEffort;
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
  function report(result) {
    if (!result) return '<span class="md-cap-unchecked">能力尚未检测</span>';
    if (result.pending) return '<span role="status" class="md-cap-unchecked">正在检测能力…</span>';
    if (result.error) return '<span role="alert" class="md-cap-error">' + e(result.error) + '</span>';
    const rows = Object.entries(result.checks || {}).filter(([key]) => key === 'connection' || names[key]);
    const date = result.checkedAt ? new Date(result.checkedAt) : null;
    const time = date && !Number.isNaN(date.getTime()) ? date.toLocaleString(global.SoduWorkI18n?.getLocale?.() || undefined) : '';
    return '<details class="md-cap-report"><summary>检测结果' + (time ? '<time data-user-content data-md-checked-at="' + e(result.checkedAt) + '">' + e(time) + '</time>' : '') + '</summary><dl>' +
      rows.map(([key, check]) => '<div><dt>' + (names[key] || '服务连接') + '</dt><dd class="is-' + e(check.status) + '">' +
        (statusNames[check.status] || statusNames.inconclusive) + '</dd>' +
        (diagnostics[check.code] ? '<small>' + diagnostics[check.code] + '</small>' : '') + '</div>').join('') +
      '</dl><p>检测结果仅适用于当前服务和模型配置；超时或网络异常不代表模型不支持。</p></details>';
  }
  global.ModelCapabilitiesUI = { names, states, profile, badges, fields, read, report };
  global.addEventListener?.('soduwork-locale-change', () => {
    global.document?.querySelectorAll('[data-md-checked-at]').forEach(element => {
      const date = new Date(element.dataset.mdCheckedAt);
      if (!Number.isNaN(date.getTime())) element.textContent = date.toLocaleString(global.SoduWorkI18n?.getLocale?.() || undefined);
    });
  });
})(globalThis);
