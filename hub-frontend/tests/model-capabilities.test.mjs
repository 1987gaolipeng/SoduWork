import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createComponentHarness } from './helpers/react-harness.mjs'
import { setLocale, translateText } from '../src/i18n.js'
import messages from '../src/locales/model-capabilities.js'

const reportPhases = {
  output: '检测阶段：检查回复内容', stream: '检测阶段：逐步接收回复',
  tool_call: '检测阶段：请求工具执行', tool_result: '检测阶段：读取工具结果',
}
const reportDetails = {
  tool_finish_reason_mismatch: '模型未按要求发起工具调用',
  tool_call_count_mismatch: '模型未按要求调用一次工具',
  tool_call_invalid: '未收到可用的工具调用',
  tool_arguments_invalid: '工具调用信息不符合检测要求',
  tool_receipt_mismatch: '模型未正确确认工具执行结果',
  tool_result_finish_reason_mismatch: '模型读取工具结果后未正常完成回复',
  invalid_stream_shape: '逐步返回的回复格式无法识别',
  expected_output_mismatch: '回复内容与检测要求不符',
}
const additionalDiagnostics = {
  stream_error: '服务在逐步返回回复时报告错误',
  stream_not_observed: '未收到逐步返回的回复，暂不能确认能力',
  response_truncated: '回复提前结束，未能完成检测',
  content_filtered: '服务拦截了检测回复，暂不能确认能力',
  transport_interrupted: '连接中断，未能完成检测',
}
const badgeGuidance = ['本次检测未通过', '上次通过', '服务拒绝了本次图片请求。对话沿用上次通过的结果，你仍可发图。', '对话沿用上次通过的结果，你仍可发图。', '最近检测：{0}', '手动配置：{0}', '已有配置：{0}', '未收到与图片中六位数字完全一致的回复',
  '支持', '不支持', '未确认', '检测通过', '检测失败', '未能确认',
  '图片输入', '工具调用', '流式输出', '实际检测', '手动配置', '已有配置', '检测结果', '服务连接',
  '检测结果仅适用于当前服务和模型配置；超时或网络异常不代表模型不支持。']
const surfaceCopy = {
  'zh-CN': { capabilities: ['图片输入', '工具调用', '流式输出'], verified: '实际检测', configured: '手动配置', legacy: '已有配置',
    result: '检测结果', connection: '服务连接', footer: '检测结果仅适用于当前服务和模型配置；超时或网络异常不代表模型不支持。' },
  'en-US': { capabilities: ['Image input', 'Tool calling', 'Streaming'], verified: 'Verified by test', configured: 'Manual configuration', legacy: 'Existing configuration',
    result: 'Test results', connection: 'Connection', footer: 'Results apply to the current provider and model settings. Timeouts and network errors do not mean a capability is unsupported.' },
  'ja-JP': { capabilities: ['画像入力', 'ツール呼び出し', 'ストリーミング出力'], verified: '実際のテスト', configured: '手動で設定', legacy: '既存の設定',
    result: 'テスト結果', connection: 'サービス接続', footer: 'テスト結果は現在のサービスとモデル設定にのみ適用されます。タイムアウトやネットワーク異常はモデルの非対応を意味しません。' },
  'ko-KR': { capabilities: ['이미지 입력', '도구 호출', '스트리밍 출력'], verified: '실제 점검', configured: '수동 구성', legacy: '기존 구성',
    result: '점검 결과', connection: '서비스 연결', footer: '점검 결과는 현재 서비스와 모델 구성에만 적용됩니다. 타임아웃이나 네트워크 이상은 모델 미지원을 뜻하지 않습니다.' },
}
const badgeCopy = {
  'zh-CN': { supported: '支持', unsupported: '不支持', unknown: '未确认', previous: '上次验证：不支持',
    configured: '手动配置：不支持', legacy: '已有配置：支持', image: '未收到与图片中六位数字完全一致的回复',
    attempts: { inconclusive: '最近检测：未能确认', cancelled: '最近检测：已取消', failed: '最近检测：检测失败', skipped: '最近检测：未执行' } },
  'en-US': { supported: 'Supported', unsupported: 'Unsupported', unknown: 'Unknown', previous: 'Previously verified: unsupported',
    configured: 'Manual configuration: Unsupported', legacy: 'Existing configuration: Supported', image: 'The reply did not exactly match the six digits in the image.',
    attempts: { inconclusive: 'Last test: Inconclusive', cancelled: 'Last test: Cancelled', failed: 'Last test: Failed', skipped: 'Last test: Skipped' } },
  'ja-JP': { supported: '対応', unsupported: '非対応', unknown: '未確認', previous: '前回の検証：非対応',
    configured: '手動設定：非対応', legacy: '既存の設定：対応', image: '画像内の6桁の数字と完全に一致する返信を受信できませんでした。',
    attempts: { inconclusive: '直近の検査：確認できませんでした', cancelled: '直近の検査：キャンセル済み', failed: '直近の検査：テスト失敗', skipped: '直近の検査：未実行' } },
  'ko-KR': { supported: '지원', unsupported: '미지원', unknown: '미확인', previous: '이전 검증: 지원 안 함',
    configured: '수동 설정: 미지원', legacy: '기존 설정: 지원', image: '이미지의 여섯 자리 숫자와 정확히 일치하는 응답을 받지 못했습니다.',
    attempts: { inconclusive: '최근 검사: 확인하지 못했습니다', cancelled: '최근 검사: 취소됨', failed: '최근 검사: 점검 실패', skipped: '최근 검사: 실행 안 함' } },
}

test('capability checks prevent duplicate calls and retry network failures without declaring unsupported', async t => {
  let resolve, calls = 0, fail = false
  const responses = []
  const page = await createComponentHarness(new URL('../src/screens/ModelCapabilities.jsx', import.meta.url), {
    exportName: 'ModelCapabilityStatus', props: { model: { providerId: 'org', name: 'vision' }, onChecked: data => responses.push(data) },
    dependencies: { '../api.js': { api: { checkModelCapabilities: body => {
      calls++; assert.deepEqual(body, { providerId: 'org', model: 'vision', checks: ['connection', 'imageInput', 'toolCalling', 'streaming'] })
      return fail ? Promise.reject(new Error('Network timeout')) : new Promise(done => { resolve = done })
    } } } },
  })
  t.after(() => page.unmount())
  const button = () => page.nodes(n => n.type === 'button')[0]
  const pending = button().props.onClick(); await button().props.onClick()
  assert.equal(calls, 1); assert.equal(button().props.disabled, true)
  const result = { checks: { imageInput: { status: 'passed', code: 'verified' } } }
  resolve(result); await pending; await page.flush()
  assert.equal(responses.length, 1); assert.equal(Boolean(button().props.disabled), false)
  fail = true; await button().props.onClick(); await page.flush()
  assert.equal(page.nodes(n => n.props.role === 'alert')[0].props.children, 'Network timeout')
  assert.equal(responses.length, 1)
  fail = false; const retry = button().props.onClick(); resolve(result); await retry; await page.flush()
  assert.equal(page.nodes(n => n.props.role === 'alert').length, 0)
})

test('a queued first check skips rows that changed, have evidence, or already ran manually', async t => {
  const model = { providerId: 'org', name: 'new-chat' }
  for (const change of ['disabled', 'reported', 'removed', 'manual']) {
    let run, calls = 0
    const props = { model, scheduleFirstCheck: job => { run = job } }
    const page = await createComponentHarness(new URL('../src/screens/ModelCapabilities.jsx', import.meta.url), {
      exportName: 'ModelCapabilityStatus', props, dependencies: { '../api.js': { api: {
        checkModelCapabilities: async () => { calls++; return { checks: {} } },
      } } },
    })
    page.render()
    assert.equal(typeof run, 'function', 'a successful create schedules its check')
    if (change === 'removed') page.unmount()
    if (change === 'disabled') page.render({ ...props, disabled: true })
    if (change === 'reported') page.render({ ...props, model: { ...model, capabilityCheck: { checks: {} } } })
    if (change === 'manual') await page.nodes(n => n.type === 'button')[0].props.onClick()
    await run()
    assert.equal(calls, change === 'manual' ? 1 : 0)
    if (change !== 'removed') page.unmount()
  }
})

test('old check responses cannot update a removed or changed model row', async () => {
  let done, applied = 0
  const page = await createComponentHarness(new URL('../src/screens/ModelCapabilities.jsx', import.meta.url), {
    exportName: 'ModelCapabilityStatus', props: { model: { providerId: 'org', name: 'vision' }, onChecked: () => applied++ },
    dependencies: { '../api.js': { api: { checkModelCapabilities: () => new Promise(resolve => { done = resolve }) } } },
  })
  const pending = page.nodes(n => n.type === 'button')[0].props.onClick()
  page.unmount(); done({ checks: {} }); await pending
  assert.equal(applied, 0)
})

test('legacy native capability is configured, not falsely marked verified', async t => {
  const page = await createComponentHarness(new URL('../src/screens/ModelCapabilities.jsx', import.meta.url), {
    exportName: 'CapabilityBadges', props: { model: { config: { imageRouting: 'native' } } }, dependencies: { '../api.js': { api: {} } },
  })
  t.after(() => { page.unmount(); setLocale('zh-CN') })
  setLocale('en-US'); page.render({ model: { config: { imageRouting: 'native' } } })
  const badges = page.nodes(n => n.type === 'span')
  assert.equal(badges[0].props.title, 'Existing configuration')
  assert.equal(badges[1].props.title, 'Unknown')
})

test('all authored capability copy has an English translation', () => {
  for (const [source, english] of Object.entries(messages)) assert.equal(translateText(source, [], 'en-US'), english)
})

test('manual declarations remain visible when an older host returns an unknown profile', async t => {
  setLocale('zh-CN')
  const page = await createComponentHarness(new URL('../src/screens/ModelCapabilities.jsx', import.meta.url), {
    exportName: 'CapabilityBadges', props: { model: { config: { capabilities: { imageInput: 'supported' } },
      capabilityProfile: { imageInput: { state: 'unknown', source: 'unknown' } } } }, dependencies: { '../api.js': { api: {} } },
  })
  t.after(() => page.unmount())
  assert.equal(page.nodes(n => n.type === 'b')[0].props.children, '支持')
})

test('retained image support explains a rejection only when automatic chat still accepts images', async t => {
  setLocale('zh-CN')
  const report = { checks: { imageInput: { status: 'unsupported', code: 'capability_not_supported' } },
    verifiedChecks: { imageInput: { status: 'passed', checkedAt: '2026-11-15T00:00:00Z' } } }
  const model = { enabled: true, modality: 'chat', capabilityProfile: { imageInput: { state: 'supported', source: 'verified' } },
    capabilityCheck: report }
  const badge = await createComponentHarness(new URL('../src/screens/ModelCapabilities.jsx', import.meta.url), {
    exportName: 'CapabilityBadges', props: { model }, dependencies: { '../api.js': { api: {} } },
  })
  const page = await createComponentHarness(new URL('../src/screens/ModelCapabilities.jsx', import.meta.url), {
    exportName: 'ModelCapabilityStatus', props: { model }, dependencies: { '../api.js': { api: {} } },
  })
  t.after(() => { page.unmount(); badge.unmount(); setLocale('zh-CN') })
  assert.equal(badge.nodes(node => node.type === 'b')[0].props.children, '支持')
  assert.equal(badge.nodes(node => node.type === 'small').length, 0)
  for (const locale of Object.keys(surfaceCopy)) {
    setLocale(locale)
    const html = renderToStaticMarkup(page.render({ model }))
    for (const label of ['本次检测未通过', '服务拒绝了本次图片请求。对话沿用上次通过的结果，你仍可发图。', '上次通过']) {
      assert.ok(html.includes(translateText(label, [], locale)), locale + ': ' + label)
    }
    assert.ok(html.includes(report.verifiedChecks.imageInput.checkedAt))
  }
  setLocale('zh-CN')
  for (const props of [{ model, disabled: true }, { model: { ...model, enabled: false } },
    { model: { ...model, config: { imageRouting: 'vision-fallback' } } },
    { model: { ...model, config: { capabilities: { imageInput: 'supported' } } } },
    { model: { ...model, capabilityCheck: { checks: report.checks } } }]) {
    assert.doesNotMatch(renderToStaticMarkup(page.render(props)), /你仍可发图/)
  }
})

test('image mismatch keeps the supported badge and explains retained proof in the report', async t => {
  setLocale('zh-CN')
  const model = { config: { imageRouting: 'auto' }, capabilityProfile: {
    imageInput: { state: 'supported', source: 'verified', lastVerifiedAt: '2026-11-15T00:00:00Z' },
  }, capabilityCheck: { checkedAt: '2026-11-17T00:00:00Z', checks: {
    imageInput: { status: 'inconclusive', detailCode: 'expected_output_mismatch', checkedAt: '2026-11-16T00:00:00Z' },
    toolCalling: { status: 'passed', checkedAt: '2026-11-17T00:00:00Z' },
  }, verifiedChecks: { imageInput: { status: 'passed', checkedAt: '2026-11-15T00:00:00Z' } } } }
  const before = JSON.stringify(model)
  const page = await createComponentHarness(new URL('../src/screens/ModelCapabilities.jsx', import.meta.url), {
    exportName: 'CapabilityBadges', props: { model }, dependencies: { '../api.js': { api: {} } },
  })
  t.after(() => page.unmount())
  assert.equal(page.nodes(node => node.type === 'b')[0].props.children, '支持')
  assert.equal(page.nodes(node => node.type === 'small').length, 0)
  const detail = await createComponentHarness(new URL('../src/screens/ModelCapabilities.jsx', import.meta.url), {
    exportName: 'ModelCapabilityStatus', props: { model }, dependencies: { '../api.js': { api: {} } },
  })
  t.after(() => detail.unmount())
  const html = renderToStaticMarkup(detail.render())
  assert.match(html, /未收到与图片中六位数字完全一致的回复/)
  assert.match(html, /对话沿用上次通过的结果，你仍可发图。/)
  assert.match(html, /未能确认/)
  assert.doesNotMatch(html, /服务拒绝了本次图片请求/)
  assert.equal(page.nodes(node => node.props.className?.startsWith('model-cap-badge '))[0].props.title, '实际检测')
  assert.doesNotMatch(renderToStaticMarkup(page.render()), /本次检测|2026-11-17/)
  assert.equal(JSON.stringify(model), before)
})

test('retained supported and unsupported proof remains distinct from every unfinished attempt status', async t => {
  setLocale('zh-CN')
  const page = await createComponentHarness(new URL('../src/screens/ModelCapabilities.jsx', import.meta.url), {
    exportName: 'CapabilityBadges', props: { model: {} }, dependencies: { '../api.js': { api: {} } },
  })
  t.after(() => page.unmount())
  for (const state of ['supported', 'unsupported']) {
    for (const [status, expected] of Object.entries({ inconclusive: '未能确认', cancelled: '已取消', failed: '检测失败', skipped: '未执行' })) {
      // A profile-only older host still describes the last attempt for this capability.
      page.render({ model: { capabilityProfile: { imageInput: { state, source: 'verified', checkStatus: status } } } })
      assert.equal(page.nodes(node => node.type === 'b')[0].props.children, state === 'supported' ? '上次验证：支持' : '上次验证：不支持')
      assert.equal(page.nodes(node => node.type === 'small')[0].props.children, '最近检测：' + expected)
    }
  }
})

test('divergent manual and legacy states name their real source and retain conflict information', async t => {
  setLocale('zh-CN')
  const page = await createComponentHarness(new URL('../src/screens/ModelCapabilities.jsx', import.meta.url), {
    exportName: 'CapabilityBadges', props: { model: {} }, dependencies: { '../api.js': { api: {} } },
  })
  t.after(() => page.unmount())
  for (const [config, state, status, label, source] of [
    [{ capabilities: { imageInput: 'supported' } }, 'supported', 'unsupported', '手动配置：支持', '手动配置'],
    [{ capabilities: { imageInput: 'unsupported' } }, 'unsupported', 'passed', '手动配置：不支持', '手动配置'],
    [{ imageRouting: 'native' }, 'supported', 'inconclusive', '已有配置：支持', '已有配置'],
  ]) {
    const model = { config, capabilityProfile: { imageInput: { state, source: 'verified', conflict: true, checkStatus: 'failed' } },
      capabilityCheck: { checks: { imageInput: { status } } } }
    const before = JSON.stringify(model)
    page.render({ model })
    assert.equal(page.nodes(node => node.type === 'b')[0].props.children, label)
    assert.equal(page.nodes(node => node.props.className?.startsWith('model-cap-badge '))[0].props.title, source)
    const copy = renderToStaticMarkup(page.render())
    assert.ok(copy.includes('最近检测：' + ({ passed: '检测通过', unsupported: '不支持', inconclusive: '未能确认' })[status]))
    assert.match(copy, /配置冲突/)
    assert.doesNotMatch(copy, /上次验证：/)
    assert.equal(JSON.stringify(model), before)
  }
})

test('ordinary conclusive and never-tested badges keep their concise effective labels', async t => {
  setLocale('zh-CN')
  const page = await createComponentHarness(new URL('../src/screens/ModelCapabilities.jsx', import.meta.url), {
    exportName: 'CapabilityBadges', props: { model: {} }, dependencies: { '../api.js': { api: {} } },
  })
  t.after(() => page.unmount())
  for (const [model, expected] of [
    [{ capabilityProfile: { imageInput: { state: 'supported', source: 'verified' } }, capabilityCheck: { checks: { imageInput: { status: 'passed' } } } }, '支持'],
    [{ capabilityProfile: { imageInput: { state: 'unsupported', source: 'verified' } }, capabilityCheck: { checks: { imageInput: { status: 'unsupported' } } } }, '不支持'],
    [{ config: { capabilities: { imageInput: 'supported' } } }, '支持'],
    [{ config: { imageRouting: 'native' } }, '支持'],
    [{}, '未确认'],
  ]) {
    page.render({ model })
    assert.equal(page.nodes(node => node.type === 'b')[0].props.children, expected)
    assert.equal(page.nodes(node => node.type === 'small').length, 0)
  }
})

test('unknown last-attempt strings cannot turn upstream values into badge copy', async t => {
  setLocale('zh-CN')
  const page = await createComponentHarness(new URL('../src/screens/ModelCapabilities.jsx', import.meta.url), {
    exportName: 'CapabilityBadges', props: { model: {} }, dependencies: { '../api.js': { api: {} } },
  })
  t.after(() => page.unmount())
  for (const status of ['constructor', '__proto__', '<img src=x onerror="privateReceipt()">']) {
    page.render({ model: { capabilityProfile: { imageInput: { state: 'supported', source: 'verified' } },
      capabilityCheck: { checks: { imageInput: { status } } } } })
    assert.equal(page.nodes(node => node.type === 'b')[0].props.children, '支持')
    assert.doesNotMatch(renderToStaticMarkup(page.render()), /最近检测：|privateReceipt|function Object/)
  }
})

test('an unconfirmed capability with no prior proof still shows its unfinished last attempt', async t => {
  setLocale('zh-CN')
  const page = await createComponentHarness(new URL('../src/screens/ModelCapabilities.jsx', import.meta.url), {
    exportName: 'CapabilityBadges', props: { model: {} }, dependencies: { '../api.js': { api: {} } },
  })
  t.after(() => page.unmount())
  for (const [status, label] of Object.entries({ inconclusive: '未能确认', cancelled: '已取消', failed: '检测失败', skipped: '未执行' })) {
    page.render({ model: { capabilityCheck: { checks: { imageInput: { status } } } } })
    assert.equal(page.nodes(node => node.type === 'b')[0].props.children, '未确认')
    assert.equal(page.nodes(node => node.type === 'small')[0]?.props.children, '最近检测：' + label)
    assert.doesNotMatch(renderToStaticMarkup(page.render()), /上次验证：|手动配置：|已有配置：/)
  }
})

test('a transient report renders retained conclusive evidence separately', async t => {
  setLocale('zh-CN')
  const page = await createComponentHarness(new URL('../src/screens/ModelCapabilities.jsx', import.meta.url), {
    exportName: 'CapabilityReport', props: { result: { checks: { imageInput: { status: 'inconclusive', code: 'timeout' } },
      verifiedChecks: { imageInput: { status: 'passed', checkedAt: '2026-11-15T00:00:00Z' } } } }, dependencies: { '../api.js': { api: {} } },
  })
  t.after(() => page.unmount())
  assert.ok(page.nodes(n => n.type === 'span').some(n => n.props.children === '上次验证：支持'))
})

test('image output mismatch explains the six-digit requirement and separates prior proof from its date', async t => {
  setLocale('zh-CN')
  const result = { checks: { imageInput: { status: 'inconclusive', detailCode: 'expected_output_mismatch' },
    streaming: { status: 'inconclusive', detailCode: 'expected_output_mismatch' } },
    verifiedChecks: { imageInput: { status: 'passed', checkedAt: '2026-11-15T00:00:00Z' } } }
  const page = await createComponentHarness(new URL('../src/screens/ModelCapabilities.jsx', import.meta.url), {
    exportName: 'CapabilityReport', props: { result }, dependencies: { '../api.js': { api: {} } },
  })
  t.after(() => page.unmount())
  const html = renderToStaticMarkup(page.render())
  assert.match(html, /未收到与图片中六位数字完全一致的回复/)
  assert.match(html, /回复内容与检测要求不符/)
  assert.match(html, /上次验证：支持<\/span>\s+<time/)
})

test('report details take priority while status and retained evidence remain visible', async t => {
  setLocale('zh-CN')
  const result = { checks: { toolCalling: { status: 'inconclusive', stage: 'tool_call',
    code: 'expected_output_missing', detailCode: 'tool_arguments_invalid' } },
    verifiedChecks: { toolCalling: { status: 'passed', checkedAt: '2026-11-15T00:00:00Z' } } }
  const before = JSON.stringify(result)
  const page = await createComponentHarness(new URL('../src/screens/ModelCapabilities.jsx', import.meta.url), {
    exportName: 'CapabilityReport', props: { result }, dependencies: { '../api.js': { api: {} } },
  })
  t.after(() => page.unmount())
  const html = renderToStaticMarkup(page.render())
  assert.ok(html.includes(reportPhases.tool_call))
  assert.ok(html.includes(reportDetails.tool_arguments_invalid))
  assert.doesNotMatch(html, /未收到预期结果，暂不能确认能力/)
  assert.match(html, /未能确认/); assert.match(html, /上次验证：支持/)
  assert.equal(JSON.stringify(result), before)
})

test('all known detailed failures and old report codes receive authored explanations', async t => {
  setLocale('zh-CN')
  const page = await createComponentHarness(new URL('../src/screens/ModelCapabilities.jsx', import.meta.url), {
    exportName: 'CapabilityReport', props: { result: null }, dependencies: { '../api.js': { api: {} } },
  })
  t.after(() => page.unmount())
  for (const [detailCode, text] of Object.entries(reportDetails)) {
    const html = renderToStaticMarkup(page.render({ result: { checks: { toolCalling: {
      status: 'inconclusive', code: 'invalid_response', detailCode,
    } } } }))
    assert.ok(html.includes(text), detailCode)
    assert.doesNotMatch(html, /服务响应格式无法识别/)
  }
  for (const detailCode of [undefined, null, 'future_detail', 'constructor', '__proto__', 'timeout', { message: 'private detail' }]) {
    const html = renderToStaticMarkup(page.render({ result: { checks: { streaming: {
      status: 'inconclusive', code: 'invalid_response', detailCode,
    } } } }))
    assert.match(html, /服务响应格式无法识别/)
    assert.doesNotMatch(html, /private detail|future_detail|function Object|\[object Object\]/)
  }
  for (const [code, text] of Object.entries(additionalDiagnostics)) {
    const html = renderToStaticMarkup(page.render({ result: { checks: { streaming: { status: 'inconclusive', code } } } }))
    assert.ok(html.includes(text), code)
  }
})

test('report phases and diagnostics ignore unknown upstream strings and inherited object keys', async t => {
  setLocale('zh-CN')
  const page = await createComponentHarness(new URL('../src/screens/ModelCapabilities.jsx', import.meta.url), {
    exportName: 'CapabilityReport', props: { result: null }, dependencies: { '../api.js': { api: {} } },
  })
  t.after(() => page.unmount())
  const unsafe = '<img src=x onerror="privateReceipt()">'
  for (const value of [unsafe, 'constructor', '__proto__', 'toString', { message: unsafe }]) {
    const html = renderToStaticMarkup(page.render({ result: { checks: { toolCalling: { status: 'inconclusive',
      stage: value, detailCode: value, code: value, message: unsafe, detail: unsafe, receipt: unsafe } } } }))
    assert.match(html, /未能确认/)
    assert.doesNotMatch(html, /<small>|检测阶段：|privateReceipt|&lt;img|function Object|\[object Object\]/)
  }
})

for (const locale of ['en-US', 'ja-JP', 'ko-KR']) {
  test('new capability diagnostics have native ' + locale + ' translations', async () => {
    const { messagesByLocale } = await import('../src/locales/extra-languages.js');
    const owned = locale === 'en-US' ? messages : messagesByLocale[locale];
    for (const source of [...badgeGuidance, ...Object.values(reportPhases), ...Object.values(reportDetails), ...Object.values(additionalDiagnostics), "此协议暂无法自动检测","检测参数不被接受，能力仍未确认","检测已取消，已有证据仍保留","旧版检测结果需要重新验证","连接检查未通过，此项未执行","模型服务计费额度不可用，请检查供应商账户","检测预算已用尽，能力仍未确认","检测响应超过大小限制","流式响应未正常完成","上次验证：支持","上次验证：不支持","配置与最近检测结果不一致","配置冲突","已取消","未执行"]) {
      assert.ok(Object.hasOwn(owned, source), locale + ': ' + source);
      assert.equal(translateText(source, [], locale), owned[source]);
      if (locale !== 'en-US') assert.notEqual(owned[source], messages[source]);
    }
  });
}

for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']) {
  test('divergent badge provenance and the last attempt localize in ' + locale, async t => {
    setLocale(locale)
    const expected = badgeCopy[locale]
    const model = { capabilityProfile: { imageInput: { state: 'unsupported', source: 'verified' } },
      capabilityCheck: { checks: { imageInput: { status: 'cancelled' } } } }
    const page = await createComponentHarness(new URL('../src/screens/ModelCapabilities.jsx', import.meta.url), {
      exportName: 'CapabilityBadges', props: { model }, dependencies: { '../api.js': { api: {} } },
    })
    t.after(() => { page.unmount(); setLocale('zh-CN') })
    const badges = () => page.nodes(node => node.type === 'span' && node.props.className?.startsWith('model-cap-badge '))
    assert.deepEqual(badges().map(node => node.props.children[0]), surfaceCopy[locale].capabilities)
    assert.equal(badges()[0].props.title, surfaceCopy[locale].verified)
    for (const [status, text] of Object.entries(expected.attempts)) {
      page.render({ model: { ...model, capabilityCheck: { checks: { imageInput: { status } } } } })
      assert.equal(page.nodes(node => node.type === 'b')[0].props.children, expected.previous)
      assert.equal(page.nodes(node => node.type === 'small')[0].props.children, text)
    }
    for (const [config, text] of [
      [{ capabilities: { imageInput: 'unsupported' } }, expected.configured],
      [{ imageRouting: 'native' }, expected.legacy],
    ]) {
      page.render({ model: { ...model, config } })
      assert.equal(page.nodes(node => node.type === 'b')[0].props.children, text)
      assert.equal(page.nodes(node => node.type === 'small')[0].props.children, expected.attempts.cancelled)
      assert.equal(badges()[0].props.title, surfaceCopy[locale][config.imageRouting ? 'legacy' : 'configured'])
    }
    for (const [state, status] of [['supported', 'passed'], ['unsupported', 'unsupported']]) {
      page.render({ model: { capabilityProfile: { imageInput: { state, source: 'verified' } },
        capabilityCheck: { checks: { imageInput: { status } } } } })
      assert.equal(page.nodes(node => node.type === 'b')[0].props.children, expected[state])
      assert.equal(page.nodes(node => node.type === 'small').length, 0)
    }
    page.render({ model: {} })
    assert.equal(page.nodes(node => node.type === 'b')[0].props.children, expected.unknown)
  })

  test('badges distinguish an untested protocol from a model refusal in ' + locale, async t => {
    setLocale(locale)
    const model = {
      capabilityProfile: { streaming: { state: 'unsupported', source: 'verified' } },
      capabilityCheck: { checks: {
        imageInput: { status: 'inconclusive', code: 'expected_output_missing' },
        toolCalling: { status: 'inconclusive', code: 'protocol_not_tested' },
        streaming: { status: 'unsupported', code: 'capability_not_supported' },
      } },
    }
    const page = await createComponentHarness(new URL('../src/screens/ModelCapabilities.jsx', import.meta.url), {
      exportName: 'CapabilityBadges', props: { model }, dependencies: { '../api.js': { api: {} } },
    })
    t.after(() => { page.unmount(); setLocale('zh-CN') })
    assert.deepEqual(page.nodes(node => node.type === 'small').map(node => node.props.children), [
      badgeCopy[locale].attempts.inconclusive, translateText('此协议暂无法自动检测', [], locale),
    ])
    assert.deepEqual(page.nodes(node => node.type === 'b').map(node => node.props.children), [
      badgeCopy[locale].unknown, badgeCopy[locale].unknown, badgeCopy[locale].unsupported,
    ])
  })

  test('admin report phases and detailed failures render localized ' + locale + ' copy', async t => {
    setLocale(locale)
    const page = await createComponentHarness(new URL('../src/screens/ModelCapabilities.jsx', import.meta.url), {
      exportName: 'CapabilityReport', props: { result: null }, dependencies: { '../api.js': { api: {} } },
    })
    t.after(() => { page.unmount(); setLocale('zh-CN') })
    for (const stage of Object.keys(reportPhases)) {
      page.render({ result: { checks: { connection: { status: 'passed' }, toolCalling: { status: 'inconclusive', stage,
        code: 'expected_output_missing', detailCode: 'tool_receipt_mismatch' } } } })
      assert.deepEqual(page.nodes(node => node.type === 'small').map(node => node.props.children),
        [reportPhases[stage], reportDetails.tool_receipt_mismatch].map(text => translateText(text, [], locale)))
    }
    assert.equal(page.nodes(node => node.type === 'summary')[0].props.children[0], surfaceCopy[locale].result)
    assert.deepEqual(page.nodes(node => node.type === 'dt').map(node => node.props.children),
      [surfaceCopy[locale].connection, surfaceCopy[locale].capabilities[1]])
    assert.equal(page.nodes(node => node.type === 'p')[0].props.children, surfaceCopy[locale].footer)
  })

  test('admin capability report retains evidence and formats both timestamps in ' + locale, async t => {
    setLocale(locale);
    const current = '2026-11-15T13:24:56Z', previous = '2026-10-14T02:13:45Z';
    const result = { checkedAt: current, checks: { imageInput: { status: 'inconclusive', code: 'parameter_not_supported' } },
      verifiedChecks: { imageInput: { status: 'passed', checkedAt: previous } } };
    const before = JSON.stringify(result);
    const page = await createComponentHarness(new URL('../src/screens/ModelCapabilities.jsx', import.meta.url), {
      exportName: 'CapabilityReport', props: { result }, dependencies: { '../api.js': { api: {} } },
    });
    t.after(() => { page.unmount(); setLocale('zh-CN'); });
    const times = page.nodes(node => node.type === 'time');
    assert.deepEqual(times.map(node => node.props.children), [current, previous].map(value => new Date(value).toLocaleString(locale)));
    assert.ok(page.nodes(node => node.type === 'span').some(node => node.props.children === translateText('上次验证：支持', [], locale)));
    assert.equal(JSON.stringify(result), before);
    page.render({ result: { ...result, checks: { imageInput: { status: 'inconclusive', code: 'expected_output_missing', detailCode: 'expected_output_mismatch' } } } });
    assert.ok(page.nodes(node => node.type === 'small').some(node => node.props.children === badgeCopy[locale].image));
    assert.match(renderToStaticMarkup(page.render()), /<\/span>\s+<time/);
  });
}
