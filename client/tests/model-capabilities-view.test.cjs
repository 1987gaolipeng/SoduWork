const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const contract = require('../main/model-capability-contract.cjs');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/model-capabilities.js'), 'utf8');
const reportPhases = {
  output: '检测阶段：检查回复内容', stream: '检测阶段：逐步接收回复',
  tool_call: '检测阶段：请求工具执行', tool_result: '检测阶段：读取工具结果',
};
const reportDetails = {
  tool_finish_reason_mismatch: '模型未按要求发起工具调用',
  tool_call_count_mismatch: '模型未按要求调用一次工具',
  tool_call_invalid: '未收到可用的工具调用',
  tool_arguments_invalid: '工具调用信息不符合检测要求',
  tool_receipt_mismatch: '模型未正确确认工具执行结果',
  tool_result_finish_reason_mismatch: '模型读取工具结果后未正常完成回复',
  invalid_stream_shape: '逐步返回的回复格式无法识别',
  expected_output_mismatch: '回复内容与检测要求不符',
};
const additionalDiagnostics = {
  stream_error: '服务在逐步返回回复时报告错误',
  stream_not_observed: '未收到逐步返回的回复，暂不能确认能力',
  response_truncated: '回复提前结束，未能完成检测',
  content_filtered: '服务拦截了检测回复，暂不能确认能力',
  transport_interrupted: '连接中断，未能完成检测',
};
const badgeMessages = ['最近检测：{0}', '手动配置：{0}', '已有配置：{0}', '未收到与图片中六位数字完全一致的回复', '本次检测未通过', '上次通过',
  '服务拒绝了本次图片请求。对话沿用上次通过的结果，你仍可发图。', '对话沿用上次通过的结果，你仍可发图。'];
const badgeText = (html, index = 0) => [...html.matchAll(/<span class="md-cap-badge [^"]*"[^>]*>([\s\S]*?)<\/span>/g)][index]?.[1].replace(/<[^>]*>/g, '') || '';
function checkedModel(status, { state = 'supported', config = {} } = {}) {
  const result = { checks: { imageInput: { status, checkedAt: '2026-11-17T00:00:00Z' } },
    verifiedChecks: { imageInput: { status: state === 'supported' ? 'passed' : 'unsupported', checkedAt: '2026-11-16T00:00:00Z' } } };
  return { config, capabilityCheck: result, capabilityProfile: contract.profile(config, result) };
}
function load() {
  const context = vm.createContext({});
  // Match production core/store.js: const declarations are not global object properties.
  vm.runInContext('const esc = value => String(value);', context);
  vm.runInContext(source, context);
  assert.equal(context.esc, undefined);
  return context.ModelCapabilitiesUI;
}

function thinkingEditor(values = {}) {
  const fields = Object.fromEntries(Object.entries({ thinkingPreset: 'custom', thinkingFormat: 'qwen',
    supportsReasoningEffort: 'no', thinkingMode: 'controllable', ...values }).map(([key, value]) => [key, {
    value, disabled: false, addEventListener(name, callback) { this[name] = callback; },
  }]));
  const note = { hidden: true };
  return { fields, note, querySelector(selector) {
    if (selector === '[data-paddthinking]') return fields.thinkingMode;
    if (selector === '[data-md-thinking-preset-note]') return note;
    return fields[/data-mdfield="([^"]+)"/.exec(selector)?.[1]] || null;
  } };
}

test('explicit GLM policy round-trips its legal levels and does not infer from a display label', () => {
  const ui = load(), original = { name: 'gateway-model', label: 'GLM 5.3', config: { thinkingMode: 'auto' } };
  const before = JSON.stringify(original);
  assert.match(ui.fields(original), /value="custom" selected/);
  const editor = thinkingEditor({ thinkingPreset: 'glm-5.3', thinkingMode: 'always', maxOutputTokens: '16384' });
  const model = { ...original, ...ui.read(editor, original) };
  assert.deepEqual(JSON.parse(JSON.stringify(model.config.thinkingLevelMap)),
    { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' });
  assert.equal(model.config.thinkingFormat, 'zai');
  assert.equal(model.config.supportsReasoningEffort, true);
  assert.equal(model.config.thinkingMode, 'always');
  assert.match(ui.fields(model), /value="glm-5.3" selected/);
  assert.equal(JSON.stringify(original), before);
});

test('preset controls stay consistent and returning to custom restores the edited controls across redraws', () => {
  const ui = load(), editor = thinkingEditor();
  ui.bindThinking(editor);
  editor.fields.thinkingPreset.value = 'glm-5.3'; editor.fields.thinkingPreset.change();
  for (const [key, value] of [['thinkingMode', 'always'], ['thinkingFormat', 'zai'], ['supportsReasoningEffort', 'yes']]) {
    assert.equal(editor.fields[key].value, value); assert.equal(editor.fields[key].disabled, true);
  }
  assert.equal(editor.note.hidden, false);
  const redrawn = thinkingEditor({ thinkingPreset: 'glm-5.3' });
  ui.bindThinking(redrawn, ui.thinkingDraft(editor));
  redrawn.fields.thinkingPreset.value = 'custom'; redrawn.fields.thinkingPreset.change();
  for (const [key, value] of [['thinkingMode', 'controllable'], ['thinkingFormat', 'qwen'], ['supportsReasoningEffort', 'no']]) {
    assert.equal(redrawn.fields[key].value, value); assert.equal(redrawn.fields[key].disabled, false);
  }
  assert.equal(redrawn.note.hidden, true);
  const original = { config: { thinkingMode: 'controllable', thinkingFormat: 'qwen', thinkingLevelMap: { off: 'none', high: 'high' } } };
  assert.equal(JSON.stringify(ui.read(redrawn, original).config.thinkingLevelMap), JSON.stringify(original.config.thinkingLevelMap));
});
test('model capability view renders inside a host with lexical, rather than window, helpers', () => {
  const ui = load();
  assert.match(ui.badges({ config: { imageRouting: 'native' } }), /图片输入<b>支持/);
  assert.match(ui.fields({ config: { maxOutputTokens: 8192 } }), /value="8192"/);
  assert.match(ui.report({ checkedAt: '2026-10-01T00:00:00Z', checks: { connection: { status: 'passed' } } }), /检测通过/);
});
test('capability errors and form values are escaped independently of the host helper', () => {
  const ui = load();
  const value = '<img src=x onerror="alert(1)">&\'';
  for (const html of [ui.report({ error: value }), ui.fields({ config: { maxOutputTokens: value } })]) {
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('&lt;img'));
    assert.ok(html.includes('&quot;'));
    assert.ok(html.includes('&amp;'));
    assert.ok(html.includes('&#39;'));
  }
});

test('manual capability labels cannot be masked by an unknown profile from an older host', () => {
  const ui = load();
  assert.equal(ui.profile({ config: { capabilities: { imageInput: 'supported' } },
    capabilityProfile: { imageInput: { state: 'unknown', source: 'unknown' } } }).imageInput.source, 'configured');
});

test('badges attribute retained verified states to their prior check and expose each latest uncertain attempt', () => {
  const ui = load(), labels = { inconclusive: '未能确认', failed: '检测失败', cancelled: '已取消', skipped: '未执行' };
  for (const state of ['supported', 'unsupported']) for (const [status, label] of Object.entries(labels)) {
    const model = checkedModel(status, { state }), before = JSON.stringify(model);
    const text = badgeText(ui.badges(model));
    assert.ok(text.includes(state === 'supported' ? '上次验证：支持' : '上次验证：不支持'), state + ': ' + status);
    assert.ok(text.includes('最近检测：' + label), state + ': ' + status);
    assert.equal(JSON.stringify(model), before);
  }
});

test('badges attribute manual and legacy states on divergence while preserving conflicts and concise ordinary states', () => {
  const ui = load();
  for (const [config, source] of [[{ capabilities: { imageInput: 'supported' } }, '手动配置'], [{ imageRouting: 'native' }, '已有配置']]) {
    const text = badgeText(ui.badges(checkedModel('inconclusive', { config })));
    assert.ok(text.includes(source + '：支持'));
    assert.ok(text.includes('最近检测：未能确认'));
  }
  const conflict = checkedModel('passed', { config: { capabilities: { imageInput: 'unsupported' } } });
  const conflictText = badgeText(ui.badges(conflict));
  assert.ok(conflictText.includes('手动配置：不支持'));
  assert.ok(conflictText.includes('最近检测：检测通过'));
  assert.ok(conflictText.includes('配置冲突'));
  for (const model of [checkedModel('passed'), checkedModel('unsupported', { state: 'unsupported' }),
    { config: { capabilities: { imageInput: 'supported' } } }, { config: { imageRouting: 'native' } }, {}]) {
    assert.doesNotMatch(ui.badges(model), /上次验证：|最近检测：|手动配置：|已有配置：/);
  }
});

test('badge attempts stay per-capability and pending observations never replace stored proof', () => {
  const ui = load(), model = checkedModel('passed');
  model.capabilityCheck.checks.toolCalling = { status: 'passed' };
  model.capabilityCheck.verifiedChecks.toolCalling = { status: 'passed' };
  model.capabilityProfile = contract.profile(model.config, model.capabilityCheck);
  const progress = { pending: true, checkedAt: '2026-11-18T00:00:00Z', checks: { imageInput: { status: 'running' } } };
  const before = JSON.stringify({ model, progress });
  let html = ui.badges(model, progress);
  assert.ok(badgeText(html).includes('上次验证：支持'));
  assert.ok(badgeText(html).includes('最近检测：正在检测'));
  assert.equal(badgeText(html, 1), '工具调用支持', 'Unobserved capabilities keep their saved result');
  assert.equal(JSON.stringify({ model, progress }), before);
  progress.checks.imageInput.status = 'passed';
  assert.ok(badgeText(ui.badges(model, progress)).includes('上次验证：支持'), 'Progress is not committed evidence');
  progress.checks.imageInput.status = 'unsupported';
  html = ui.badges(model, progress);
  assert.ok(badgeText(html).includes('上次验证：支持'));
  assert.ok(badgeText(html).includes('最近检测：不支持'));
  assert.equal(badgeText(ui.badges(model, { pending: true })), '图片输入支持');
  assert.equal(badgeText(ui.badges(model, { error: '<img src=x>request failure' })), '图片输入支持');
});

test('unverified attempts expose their finite latest status without borrowing another capability or raw provider text', () => {
  const ui = load();
  const model = { capabilityCheck: { checks: { imageInput: { status: 'inconclusive' }, connection: { status: 'failed' } } } };
  assert.ok(badgeText(ui.badges(model)).includes('图片输入未确认最近检测：未能确认'));
  assert.equal(badgeText(ui.badges(model), 1), '工具调用未确认');
  const projected = { capabilityProfile: { imageInput: { state: 'supported', source: 'verified', checkStatus: 'cancelled' } } };
  assert.ok(badgeText(ui.badges(projected)).includes('最近检测：已取消'));
  for (const status of ['constructor', '__proto__', '<img src=x>', { message: 'private text' }]) {
    assert.doesNotMatch(ui.badges({ capabilityCheck: { checks: { imageInput: { status } } } }), /最近检测：|private text|<img|function Object/);
  }
});

test('image mismatch explains the exact six-digit expectation while other checks retain their general detail', () => {
  const ui = load(), row = { status: 'inconclusive', code: 'expected_output_missing', detailCode: 'expected_output_mismatch' };
  const image = ui.report({ checks: { imageInput: row } });
  assert.match(image, /未收到与图片中六位数字完全一致的回复/);
  assert.doesNotMatch(image, /回复内容与检测要求不符/);
  for (const key of ['connection', 'toolCalling', 'streaming']) {
    const html = ui.report({ checks: { [key]: row } });
    assert.match(html, /回复内容与检测要求不符/);
    assert.doesNotMatch(html, /六位数字/);
  }
});

test('retained native image support explains a rejected image or mismatched reply below the unchanged badge', () => {
  const ui = load();
  for (const [status, detailCode, expected] of [
    ['unsupported', undefined, '服务拒绝了本次图片请求。对话沿用上次通过的结果，你仍可发图。'],
    ['inconclusive', 'expected_output_mismatch', '对话沿用上次通过的结果，你仍可发图。'],
  ]) {
    const model = checkedModel(status), result = model.capabilityCheck;
    Object.assign(result.checks.imageInput, { detailCode, code: status === 'unsupported' ? 'capability_not_supported' : 'expected_output_missing' });
    assert.equal(badgeText(ui.badges(model)), '图片输入支持');
    const report = ui.report(result, model);
    assert.ok(report.includes(expected));
    assert.ok(report.includes(status === 'unsupported' ? '本次检测未通过' : '未能确认'));
    assert.match(report, /上次通过<\/span> <time[^>]*data-md-checked-at="2026-11-16T00:00:00Z"/);
    if (status === 'inconclusive') {
      assert.ok(report.includes('未收到与图片中六位数字完全一致的回复'));
      assert.doesNotMatch(report, /服务拒绝了本次图片请求/);
    }
    for (const overrides of [{ enabled: false }, { modality: 'image' }, { config: { imageRouting: 'vision-fallback' } },
      { config: { imageRouting: 'native' } }, { config: { capabilities: { imageInput: 'supported' } } }]) {
      const excluded = { ...model, ...overrides };
      assert.ok(!ui.report(result, excluded).includes('仍可发图'), JSON.stringify(overrides));
    }
    delete result.verifiedChecks.imageInput;
    assert.doesNotMatch(ui.report(result, model), /仍可发图|上次通过/);
  }
});

test('reports distinguish the latest failed attempt from historical conclusive evidence', () => {
  const html = load().report({ reportVersion: 2, apiFamily: 'chat-completions', checks: { imageInput: {
    status: 'inconclusive', code: 'timeout', checkedAt: '2026-11-16T00:00:00Z' } }, verifiedChecks: {
    imageInput: { status: 'passed', checkedAt: '2026-11-15T00:00:00Z' } } });
  assert.match(html, /未能确认/); assert.match(html, /上次验证：支持/);
  assert.match(html, /上次验证：支持<\/span> <time/, 'The proof label and timestamp must not run together');
});

test('report details take priority over generic diagnostics while preserving status and prior evidence', () => {
  const result = { checks: { toolCalling: { status: 'inconclusive', stage: 'tool_call',
    code: 'expected_output_missing', detailCode: 'tool_arguments_invalid' } },
    verifiedChecks: { toolCalling: { status: 'passed', checkedAt: '2026-11-15T00:00:00Z' } } };
  const before = JSON.stringify(result), html = load().report(result);
  assert.ok(html.includes(reportPhases.tool_call));
  assert.ok(html.includes(reportDetails.tool_arguments_invalid));
  assert.doesNotMatch(html, /未收到预期结果，暂不能确认能力/);
  assert.match(html, /未能确认/); assert.match(html, /上次验证：支持/);
  assert.equal(JSON.stringify(result), before);
});

test('reports describe all known phases and detailed failures using authored text', () => {
  const ui = load();
  for (const [stage, text] of Object.entries(reportPhases)) {
    assert.ok(ui.report({ checks: { toolCalling: { status: 'inconclusive', stage } } }).includes(text), stage);
  }
  for (const [detailCode, text] of Object.entries(reportDetails)) {
    const html = ui.report({ checks: { toolCalling: { status: 'inconclusive', code: 'invalid_response', detailCode } } });
    assert.ok(html.includes(text), detailCode);
    assert.doesNotMatch(html, /服务响应格式无法识别/);
  }
});

test('old reports and unknown detailed failures fall back to known general diagnostics', () => {
  const ui = load();
  for (const detailCode of [undefined, null, 'future_detail', 'constructor', '__proto__', 'timeout', { message: 'private detail' }]) {
    const html = ui.report({ checks: { streaming: { status: 'inconclusive', code: 'invalid_response', detailCode } } });
    assert.match(html, /服务响应格式无法识别/);
    assert.doesNotMatch(html, /private detail|future_detail|function Object|\[object Object\]/);
  }
  for (const [code, text] of Object.entries(additionalDiagnostics)) {
    assert.ok(ui.report({ checks: { streaming: { status: 'inconclusive', code } } }).includes(text), code);
  }
});

test('report phases and diagnostics ignore unknown upstream strings and inherited object keys', () => {
  const ui = load(), unsafe = '<img src=x onerror="privateReceipt()">';
  for (const value of [unsafe, 'constructor', '__proto__', 'toString', { message: unsafe }]) {
    const html = ui.report({ checks: { toolCalling: { status: 'inconclusive',
      stage: value, detailCode: value, code: value, message: unsafe, detail: unsafe, receipt: unsafe } } });
    assert.match(html, /未能确认/);
    assert.doesNotMatch(html, /<small>|检测阶段：|privateReceipt|&lt;img|function Object|\[object Object\]/);
  }
});

test('pending reports expose per-feature progress without presenting it as evidence', () => {
  const html = load().report({ pending: true, checks: { imageInput: { status: 'running' }, connection: { status: 'passed' } } });
  assert.match(html, /图片输入/); assert.match(html, /正在检测/); assert.match(html, /检测通过/);
});

test('unavailable local evidence prompts a recheck without exposing storage diagnostics', () => {
  const ui = load();
  assert.equal(ui.evidenceWarning({}), '');
  const html = ui.evidenceWarning({ capabilityEvidenceError: true });
  assert.match(html, /role="alert"/); assert.match(html, /重新检测/);
  assert.doesNotMatch(html, /secure\.json|decrypt|credentials/);
});

function probeFixture(localOnly) {
  const calls = [], saves = [], scope = 'fixture-account/device';
  const providerId = localOnly ? 'device:shared-provider' : 'shared-provider';
  const provider = { id: providerId, name: 'Saved fixture service', localOnly,
    personal: true, baseUrl: 'https://fixture.invalid/v1', authMode: 'key', myKeySet: true };
  const context = { URL, AbortController, structuredClone, setTimeout, clearTimeout,
    document: { getElementById: () => null }, addEventListener() {},
    esc: value => String(value ?? ''), _humanErr: error => error.message,
    fixtureCatalog: { providers: [provider], myModels: [{ providerId, name: 'saved-model', localOnly }],
      usable: [], revision: 'hub-1', localRevision: 1 },
    SoduWorkAPI: { taskStorageKey: () => scope, checkMyModelCapabilities: async request => {
      calls.push(structuredClone(request));
      return { ok: true, capabilityProfile: { imageInput: { state: 'unknown', source: 'fixture' } } };
    } },
    saveProbe: async closeAfter => { saves.push(closeAfter); return true; },
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ['model-capabilities.js', 'model-catalog-editor.js', 'panels-models.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels', file), 'utf8'), context, { filename: file });
  const evaluate = source => vm.runInContext(source, context);
  evaluate(`_mdData = fixtureCatalog; _mdMyModels = fixtureCatalog.myModels.slice(); _mdLoadState = 'ready';
    _mdNew = {id:'device:pending-service', name:'Unfinished draft', baseUrl:'', personal:true, localOnly:true};
    _mdKeyEdits[_mdNew.id] = 'synthetic-unsaved-draft-key';
    _mdMyModels.push({providerId:_mdNew.id, name:'unsaved-draft-model', localOnly:true});
    _mdDrafts.set(_mdNew.id, {open:true, changed:true, fields:{label:'Pending editor'}});
    _mdLocalDirty = _mdDirty = true; _mdLocalKeyIds = new Set([_mdNew.id]);
    _mdSave = saveProbe;`);
  const draft = () => evaluate(`JSON.stringify({service:_mdNew, key:_mdKeyEdits[_mdNew.id],
    editor:_mdDrafts.get(_mdNew.id), models:_mdMyModels.filter(row=>row.providerId===_mdNew.id)})`);
  return { context, calls, saves, providerId, evaluate, draft,
    check: () => context._mdCheckModel(providerId, 'saved-model') };
}

test('model rows forward per-capability progress and retain the resulting badge after rerender without exposing stale proof', async () => {
  const f = probeFixture(true), saved = checkedModel('passed');
  saved.capabilityCheck.checks.toolCalling = { status: 'passed' };
  saved.capabilityCheck.verifiedChecks.toolCalling = { status: 'passed' };
  saved.capabilityProfile = contract.profile({}, saved.capabilityCheck);
  f.context.savedProof = saved;
  f.evaluate('Object.assign(_mdMyModels[0], savedProof)');
  let notify, finish;
  f.context.soduWorkAPI = { localModels: { onCapabilityProgress: callback => { notify = callback; return () => {}; } } };
  f.context.SoduWorkAPI.checkMyModelCapabilities = async request => {
    f.calls.push(request); return new Promise(resolve => { finish = resolve; });
  };
  const render = stale => f.evaluate('_mdModelListHtml({ ..._mdProvider(' + JSON.stringify(f.providerId) + '), _capStale: ' + Boolean(stale) +
    ' }, [], _mdMyModels.filter(row => row.providerId === ' + JSON.stringify(f.providerId) + '))');
  const pending = f.check();
  assert.equal(badgeText(render()), '图片输入支持', 'Pending alone is not a newer per-capability observation');
  for (const [status, label] of [['running', '正在检测'], ['inconclusive', '未能确认'], ['passed', '检测通过']]) {
    notify({ requestId: f.calls[0].requestId, check: 'imageInput', status });
    assert.ok(badgeText(render()).includes('上次验证：支持'), status);
    assert.ok(badgeText(render()).includes('最近检测：' + label), status);
    assert.equal(badgeText(render(), 1), '工具调用支持');
  }
  assert.doesNotMatch(render(true), /上次验证：|最近检测：/, 'A changed configuration suppresses old and pending evidence');
  const result = { ...saved.capabilityCheck, checks: { ...saved.capabilityCheck.checks,
    imageInput: { status: 'inconclusive', code: 'expected_output_missing', detailCode: 'expected_output_mismatch' } }, runtimeChanged: false };
  result.capabilityProfile = contract.profile({}, result);
  finish(result); await pending;
  assert.equal(badgeText(render()), '图片输入支持');
  assert.ok(render().includes('对话沿用上次通过的结果，你仍可发图。'));
  assert.doesNotMatch(render(true), /上次通过|仍可发图|六位数字/, 'A changed configuration cannot display the previous check');
  f.evaluate('_mdChecks.clear()');
  assert.equal(badgeText(render()), '图片输入支持');
  assert.ok(render().includes('对话沿用上次通过的结果，你仍可发图。'), 'The saved report remains accurate after the transient UI record is cleared');
});

for (const localOnly of [true, false]) {
  const ownership = localOnly ? 'device-local' : 'Hub-managed';
  test(`${ownership} capability probes retain ownership without saving an unrelated incomplete service`, async () => {
    const f = probeFixture(localOnly), draft = f.draft();
    assert.equal(f.evaluate(`_mdNeedsSave(${JSON.stringify(f.providerId)})`), false,
      'only the unrelated incomplete draft is dirty');
    await f.check();
    assert.deepEqual(f.saves, []);
    if (localOnly) assert.match(f.calls[0].requestId, /^cap-/);
    assert.deepEqual(f.calls.map(({ requestId, ...request }) => request), [{ providerId: f.providerId, model: 'saved-model', localOnly,
      checks: ['connection', 'imageInput', 'toolCalling', 'streaming'] }]);
    assert.equal(f.draft(), draft, 'probing another service cannot discard its draft, key or model editor');
    assert.equal(f.evaluate('_mdDirty'), true);
    assert.equal(f.evaluate(`_mdChecks.get(_mdCheckKey(${JSON.stringify(f.providerId)}, 'saved-model')).ok`), true);
  });

  test(`${ownership} capability probes save relevant changes before passing ownership to the API`, async () => {
    const f = probeFixture(localOnly), order = [];
    f.context.saveProbe = async closeAfter => { order.push('save'); f.saves.push(closeAfter); return true; };
    f.context.SoduWorkAPI.checkMyModelCapabilities = async request => {
      order.push('check'); f.calls.push(structuredClone(request)); return { ok: true };
    };
    f.evaluate(`_mdSave = saveProbe; _mdTouchProvider(${JSON.stringify(f.providerId)}, {name:'Changed fixture service'});`);
    assert.equal(f.evaluate(`_mdNeedsSave(${JSON.stringify(f.providerId)})`), true);
    await f.check();
    assert.deepEqual(order, ['save', 'check']);
    assert.deepEqual(f.saves, [false]);
    assert.equal(f.calls[0].localOnly, localOnly);
    assert.equal(f.calls[0].providerId, f.providerId);
  });

  test(`${ownership} capability probes stop when relevant configuration cannot be saved`, async () => {
    const f = probeFixture(localOnly);
    f.context.saveProbe = async closeAfter => { f.saves.push(closeAfter); return false; };
    f.evaluate(`_mdSave = saveProbe; _mdTouchProvider(${JSON.stringify(f.providerId)}, {name:'Changed fixture service'});`);
    await f.check();
    assert.deepEqual(f.saves, [false]);
    assert.deepEqual(f.calls, [], 'a failed save cannot test a different persisted credential');
    assert.match(f.evaluate(`_mdChecks.get(_mdCheckKey(${JSON.stringify(f.providerId)}, 'saved-model')).error`), /请先保存模型配置/);
  });
}

test('local progress is scoped to a request and cancellation uses only its opaque saved reference', async () => {
  const f = probeFixture(true), cancelled = []; let notify, finish, unsubscribed = false;
  const modelRef = 'local:model-' + '1'.repeat(32);
  f.evaluate(`_mdMyModels[0].id = ${JSON.stringify(modelRef)}`);
  f.context.soduWorkAPI = { localModels: { onCapabilityProgress: callback => { notify = callback; return () => { unsubscribed = true; }; },
    cancelCapabilities: async input => { cancelled.push(input); } } };
  f.context.SoduWorkAPI.checkMyModelCapabilities = async request => { f.calls.push(request); return new Promise(resolve => { finish = resolve; }); };
  const pending = f.check();
  notify({ requestId: 'foreign', check: 'imageInput', status: 'passed' });
  assert.equal(f.evaluate(`_mdChecks.get(_mdCheckKey(${JSON.stringify(f.providerId)},'saved-model')).checks`), undefined);
  notify({ requestId: f.calls[0].requestId, check: 'imageInput', status: 'running' });
  assert.match(f.evaluate(`ModelCapabilitiesUI.report(_mdChecks.get(_mdCheckKey(${JSON.stringify(f.providerId)},'saved-model')))`), /图片输入/);
  await f.context._mdCancelModelCheck(f.providerId, 'saved-model');
  assert.equal(cancelled[0].modelRef, modelRef); assert.equal(cancelled[0].requestId, f.calls[0].requestId);
  finish({ checks: { imageInput: { status: 'cancelled', code: 'cancelled' } },
    verifiedChecks: { imageInput: { status: 'passed' } }, runtimeChanged: false }); await pending;
  const report = f.evaluate('_mdChecks.values().next().value');
  assert.equal(report.verifiedChecks?.imageInput.status, 'passed', 'Explicit cancellation retains prior verified evidence');
  assert.equal(unsubscribed, true);
});

test('closing during a pending save cancels the intent before any capability request starts', async () => {
  const f = probeFixture(true); let finishSave;
  f.context.saveProbe = () => new Promise(resolve => { finishSave = resolve; });
  f.evaluate(`_mdSave = saveProbe; _mdTouchProvider(${JSON.stringify(f.providerId)}, {name:'Changed fixture service'});`);
  const pending = f.check();
  f.context.closeModelsPanel(); finishSave(true); await pending;
  assert.deepEqual(f.calls, []);
  assert.equal(f.evaluate(`_mdChecks.get(_mdCheckKey(${JSON.stringify(f.providerId)},'saved-model')).checks.connection.status`), 'cancelled');
});

test('a successful recheck clears the transient local-evidence warning', async () => {
  const f = probeFixture(true);
  f.evaluate('_mdMyModels[0].capabilityEvidenceError = true');
  await f.check();
  assert.equal(f.evaluate('Boolean(_mdMyModels[0].capabilityEvidenceError)'), false);
});


function pendingEditProbe(localOnly) {
  const f = probeFixture(localOnly), cancelled = [];
  const ref = 'local:model-' + '2'.repeat(32);
  f.evaluate('_mdMyModels[0].id = ' + JSON.stringify(ref));
  let release, signal;
  f.context.soduWorkAPI = { localModels: { cancelCapabilities: async input => { cancelled.push(input); } } };
  f.context.SoduWorkAPI.checkMyModelCapabilities = async (_request, options) => {
    signal = options.signal;
    return new Promise(resolve => { release = resolve; });
  };
  const pending = f.check();
  return { ...f, cancelled, ref, signal,
    settle: async () => { release({ checks: { connection: { status: 'cancelled', code: 'cancelled' } }, runtimeChanged: false }); await pending; } };
}

function editTarget(f, selector, attribute) {
  const handlers = {};
  const element = { isConnected: true, value: '', getAttribute: name => name === attribute
    ? selector === '[data-mdel]' ? f.providerId + '|0' : f.providerId : null,
  addEventListener: (name, handler) => { handlers[name] = handler; } };
  f.context._mdBind({ querySelectorAll: name => name === selector ? [element] : [] });
  return { element, handlers };
}

for (const localOnly of [true, false]) {
  const ownership = localOnly ? 'local' : 'Hub';
  for (const edit of ['provider-name', 'credential-input', 'model-rename', 'model-delete-save-fails']) {
    test(ownership + ' pending capability check is cancelled before ' + edit + ' clears its UI record', async () => {
      const f = pendingEditProbe(localOnly);
      try {
        if (edit === 'provider-name') {
          f.context._mdTouchProvider(f.providerId, { name: 'Unsaved service name' });
        } else if (edit === 'credential-input') {
          const input = editTarget(f, '[data-pkey]', 'data-pkey');
          input.element.value = 'synthetic-replacement-key';
          input.handlers.input();
        } else if (edit === 'model-rename') {
          f.evaluate('_mdDrafts.set(' + JSON.stringify(f.providerId) + ', {original:"saved-model"})');
          const values = { '[data-padd]': 'renamed-model', '[data-paddtype]': 'chat', '[data-paddthinking]': 'auto' };
          f.context._mdApplyModel({ isConnected: true, dataset: { mdeditor: f.providerId },
            querySelector: name => ({ value: values[name] || '' }) });
          assert.equal(f.evaluate('_mdMyModels[0].name'), 'renamed-model');
        } else {
          f.evaluate('_mdSave = async () => false');
          const button = editTarget(f, '[data-mdel]', 'data-mdel');
          await button.handlers.click();
        }
        f.context.closeModelsPanel();
        assert.equal(f.signal.aborted, true, 'Editing must cancel the waiting transport even if its row is then removed');
        assert.equal(f.cancelled.length, localOnly ? 1 : 0);
        if (localOnly) assert.equal(f.cancelled[0].modelRef, f.ref);
      } finally { await f.settle(); }
    });
  }
}

function capabilityLocaleHost() {
  const context = vm.createContext({ Date, Intl, Map, Set, Object,
    localStorage: { getItem: () => null, setItem() {} },
    document: { readyState: 'loading', documentElement: { dataset: {} }, querySelectorAll: () => [] },
    addEventListener() {}, dispatchEvent() {}, CustomEvent: class {},
  });
  vm.runInContext('window=globalThis;let cfg={};const saveCfg=()=>{};', context);
  for (const file of JSON.parse(fs.readFileSync(path.join(__dirname, '../core/locales/manifest.json'))))
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../core/locales', file), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../core/i18n.js'), 'utf8'), context);
  return context;
}

for (const locale of ['en-US', 'ja-JP', 'ko-KR']) {
  test('pending capability progress localizes each visible text node in ' + locale, () => {
    const host = capabilityLocaleHost(), api = host.SoduWorkI18n;
    api.setLocale(locale);
    const html = load().report({ pending: true, checks: { connection: { status: 'passed' },
      imageInput: { status: 'running' }, streaming: { status: 'skipped' } } });
    const nodes = [...html.matchAll(/>([^<>]+)</g)].map(match => match[1]);
    for (const text of nodes.filter(value => /[\u3400-\u9fff]/.test(value))) {
      assert.ok(Object.hasOwn(host.SoduWorkLocaleMessages[locale], text), locale + ': ' + text);
      assert.equal(api.translateText(text), host.SoduWorkLocaleMessages[locale][text]);
    }
  });

  test('new capability guidance has native ' + locale + ' copy instead of a fallback', () => {
    const host = capabilityLocaleHost(), api = host.SoduWorkI18n;
    api.setLocale(locale);
    for (const source of [...badgeMessages, ...Object.values(reportPhases), ...Object.values(reportDetails), ...Object.values(additionalDiagnostics), "此协议暂无法自动检测","检测参数不被接受，能力仍未确认","检测已取消，已有证据仍保留","检测记录暂不可用，请重新检测","旧版检测结果需要重新验证","当前模型已确认不支持流式输出，当前执行方式需要流式接口，请选择兼容服务","当前模型已确认不支持工具调用，无法执行所选工具能力，请选择兼容模型","连接检查未通过，此项未执行","模型服务计费额度不可用，请检查供应商账户","检测预算已用尽，能力仍未确认","检测响应超过大小限制","流式响应未正常完成","上次验证：支持","上次验证：不支持","配置与最近检测结果不一致","配置冲突","取消检测","能力检测未能取消，请稍后重试","本地模型不存在或已不可用，请刷新目录后重试","当前客户端尚未提供本机能力检测，请更新客户端","正在检测","未执行"]) {
      assert.ok(Object.hasOwn(host.SoduWorkLocaleMessages[locale], source), locale + ': ' + source);
      const text = api.translateText(source);
      assert.equal(text, host.SoduWorkLocaleMessages[locale][source]);
      if (locale !== 'en-US') assert.notEqual(text, host.SoduWorkLocaleMessages['en-US'][source]);
    }
  });
}

for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']) {
  test('badge provenance, latest attempt and image expectation render authored ' + locale + ' copy', () => {
    const host = capabilityLocaleHost(), api = host.SoduWorkI18n;
    api.setLocale(locale); vm.runInContext(source, host);
    const ui = host.ModelCapabilitiesUI;
    const template = (key, text) => api.translateText(key).replace('{0}', api.translateText(text));
    for (const [config, label] of [[{}, api.translateText('上次验证：支持')],
      [{ capabilities: { imageInput: 'supported' } }, template('手动配置：{0}', '支持')],
      [{ imageRouting: 'native' }, template('已有配置：{0}', '支持')]]) {
      const text = badgeText(ui.badges(checkedModel('inconclusive', { config })));
      assert.ok(text.includes(label), label);
      assert.ok(text.includes(template('最近检测：{0}', '未能确认')));
    }
    const html = ui.report({ checks: { imageInput: { status: 'inconclusive', detailCode: 'expected_output_mismatch' } } });
    assert.ok(html.includes('未收到与图片中六位数字完全一致的回复'));
    assert.equal(api.translateText('未收到与图片中六位数字完全一致的回复'), locale === 'zh-CN'
      ? '未收到与图片中六位数字完全一致的回复' : host.SoduWorkLocaleMessages[locale]['未收到与图片中六位数字完全一致的回复']);
  });

  test('report phases and detailed failures use authored ' + locale + ' copy', () => {
    const host = capabilityLocaleHost(), api = host.SoduWorkI18n;
    api.setLocale(locale); vm.runInContext(source, host);
    for (const stage of Object.keys(reportPhases)) {
      const html = host.ModelCapabilitiesUI.report({ checks: { toolCalling: { status: 'inconclusive',
        stage, code: 'expected_output_missing', detailCode: 'tool_receipt_mismatch' } } });
      const labels = [...html.matchAll(/<small>([^<>]+)<\/small>/g)].map(match => match[1]);
      assert.deepEqual(labels, [reportPhases[stage], reportDetails.tool_receipt_mismatch]);
      assert.deepEqual(labels.map(text => api.translateText(text)), labels.map(text =>
        locale === 'zh-CN' ? text : host.SoduWorkLocaleMessages[locale][text]));
    }
  });

  test('initial current and historical report timestamps follow ' + locale, () => {
    const context = vm.createContext({ Date, SoduWorkI18n: { getLocale: () => locale } });
    vm.runInContext(source, context);
    const current = '2026-11-15T13:24:56Z', previous = '2026-10-14T02:13:45Z';
    const report = { checkedAt: current, checks: { imageInput: { status: 'inconclusive', code: 'timeout' } },
      verifiedChecks: { imageInput: { status: 'passed', checkedAt: previous } } };
    const before = JSON.stringify(report), html = context.ModelCapabilitiesUI.report(report);
    const times = [...html.matchAll(/<time[^>]*>([^<]*)<\/time>/g)].map(match => match[1]);
    assert.deepEqual(times, [current, previous].map(value => new Date(value).toLocaleString(locale)));
    assert.equal(JSON.stringify(report), before, 'Formatting must not mutate stored evidence');
  });
}

test('locale changes reformat every report timestamp without changing its stored value', () => {
  let locale = 'en-US';
  const elements = ['2026-11-15T13:24:56Z', '2026-10-14T02:13:45Z'].map(value => ({ dataset: { mdCheckedAt: value }, textContent: '' }));
  const listeners = new Map(), context = vm.createContext({ Date,
    SoduWorkI18n: { getLocale: () => locale },
    document: { querySelectorAll: () => elements },
    addEventListener: (name, listener) => listeners.set(name, listener),
  });
  vm.runInContext(source, context);
  for (const next of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'en-US']) {
    locale = next; listeners.get('soduwork-locale-change')();
    assert.deepEqual(elements.map(element => element.textContent), elements.map(element => new Date(element.dataset.mdCheckedAt).toLocaleString(next)));
  }
});

test('visible badge provenance and latest status refresh across all four locales without retaining prior-language parameters', () => {
  const host = capabilityLocaleHost(), api = host.SoduWorkI18n, listeners = new Map();
  host.addEventListener = (name, callback) => listeners.set(name, callback);
  vm.runInContext(source, host);
  const html = host.ModelCapabilitiesUI.badges(checkedModel('inconclusive'));
  const labels = [...html.matchAll(/<(?:b|small)[^>]*data-md-cap-label="([^"]+)" data-md-cap-value="([^"]+)"[^>]*>([^<]*)<\/(?:b|small)>/g)]
    .map(match => ({ dataset: { mdCapLabel: match[1], mdCapValue: match[2] }, textContent: match[3] }));
  assert.equal(labels.length, 2);
  host.document.querySelectorAll = selector => selector === '[data-md-cap-label]' ? labels : [];
  for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'en-US']) {
    api.setLocale(locale); listeners.get('soduwork-locale-change')();
    assert.deepEqual(labels.map(label => label.textContent), [api.translateText('上次验证：支持'),
      api.translateText('最近检测：{0}').replace('{0}', api.translateText('未能确认'))]);
    assert.deepEqual(labels.map(label => label.dataset.mdCapValue), ['supported', 'inconclusive']);
  }
});

for (const localOnly of [false, true]) test('capability checks refuse a company provider even with legacy models and localOnly=' + localOnly, async () => {
  const f = probeFixture(localOnly), before = f.draft();
  f.evaluate('fixtureCatalog.providers[0].personal = false; fixtureCatalog.providers[0].addressOverridden = true;');
  const models = f.evaluate('JSON.stringify(_mdMyModels)');
  await f.check();
  assert.deepEqual(f.saves, []);
  assert.deepEqual(f.calls, []);
  assert.equal(f.evaluate('_mdChecks.size'), 0);
  assert.equal(f.evaluate('JSON.stringify(_mdMyModels)'), models);
  assert.equal(f.draft(), before);
});
