'use strict';



const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const CORE = path.join(__dirname, '../core/');
const LOCALES = path.join(CORE, 'locales/');
const LOCALE_FILES = ['en-US.js', 'en-US-workspace.js', 'en-US-chat.js', 'en-US-notification-pages.js',
  'en-US-chat-pages.js', 'en-US-plugin-pages.js', 'ja-JP.js', 'ja-JP-gap-pages.js', 'ko-KR.js', 'ko-KR-gap-pages.js',
  'en-US-runtime-surfaces.js', 'ja-JP-runtime-surfaces.js', 'ko-KR-runtime-surfaces.js'];

// Node locale modules export values instead of populating browser globals.
// Use a VM to simulate script loading into SoduWorkLocaleMessages.
function loadAsBrowserScript(file) {
  vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
}

function loadI18n(locale) {
  // Provide only the storage and DOM interfaces required by i18n.
  global.window = global;
  global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  global.document = {
    documentElement: { dataset: {} }, readyState: 'complete', body: null,
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
  };
  if (typeof global.addEventListener !== 'function') global.addEventListener = () => {};
  if (typeof global.removeEventListener !== 'function') global.removeEventListener = () => {};
  if (typeof global.dispatchEvent !== 'function') global.dispatchEvent = () => true;
  if (typeof global.CustomEvent !== 'function') global.CustomEvent = class CustomEvent { constructor(type) { this.type = type; } };
  loadAsBrowserScript(path.join(LOCALES, 'locale-registry.js'));
  for (const file of LOCALE_FILES) loadAsBrowserScript(path.join(LOCALES, file));
  loadAsBrowserScript(path.join(CORE, 'i18n-dom.js'));
  loadAsBrowserScript(path.join(CORE, 'i18n.js'));
  global.SoduWorkI18n.setLocale(locale, { persist: false, broadcast: false, initial: true });
  return global.SoduWorkI18n;
}

function mergedCatalog(locale) {
  return Object.assign({},
    require(path.join(LOCALES, locale + '.js')),
    require(path.join(LOCALES, locale + '-gap-pages.js')));
}

test('Runner admission positions and long startup diagnostics translate without model-work claims', () => {
  const status = require('../components/panels/panels-chat-status');
  for (const [locale, expected] of [['en-US','Queued · Position 2'],['ja-JP','待機中 · 順番 2'],['ko-KR','대기 중 · 순서 2']]) {
    loadI18n(locale);
    assert.equal(status.work({status:'queued',execution:{queuePosition:2,running:false}}),expected);
    const startup = status.work({status:'streaming',execution:{waitingForStart:true,
      executionStartedAt:0,startupWaitSince:Date.now()-90001,running:false}});
    assert.doesNotMatch(startup,/执行环境|理解|思考/);
    assert.ok(startup.length>10,locale);
  }
});

test('completed summaries explain missing timing in every supported non-Chinese locale', () => {
  const summary = require('../components/panels/chat-turn-summary');
  const expected = {'en-US': 'Not recorded', 'ja-JP': '未記録', 'ko-KR': '미기록'};
  for (const [locale, text] of Object.entries(expected)) {
    loadI18n(locale);
    const html = summary.create({esc: String}).html({key: 'reply:1', elapsedMs: null});
    assert.ok(html.includes(text), locale);
    assert.doesNotMatch(html, /未记录|—|0s/);
    const current = require('../components/panels/panels-chat-status').createThinking(() => ({
      snap: {status: 'idle', messages: [{role: 'user'}, {role: 'assistant', done: true}], execution: {elapsedMs: 0}},
    })).metricsHtml(false);
    assert.ok(current.includes('data-thinking-elapsed>' + text + '</b>'), locale);
  }
});

test('controller reconnect and authentication reasons translate before rendering', () => {
  const status = require('../components/panels/panels-chat-status');
  const reasons = ['正在重新连接执行记录；后续需求继续等待', '停止尚未确认；后续需求继续等待',
    '登录已过期，请重新连接后继续', '当前连接没有执行此操作的权限'];
  for (const locale of ['en-US', 'ja-JP', 'ko-KR']) {
    const i18n = loadI18n(locale);
    for (const reason of reasons) {
      const translated = i18n.translateText(reason);
      assert.notEqual(translated, reason);
      assert.equal(status.work({status:'waiting-user',statusText:reason}), translated);
    }
  }
});

test('system notices localize capability failures and envelopes without rewriting named resources', () => {
  const denied = '当前会话没有授权：浏览网页、Office 文档。请新建会话并开启对应能力后再使用这个插件';
  const readonly = '当前会话是只读模式，插件还需要：文件处理、命令与构建。请改为可读写后重新开始会话';
  const missing = '当前对话尚未接入插件依赖的连接器：销售部飞书；保存$&。请在插件或连接器设置中完成连接并启用后重试';
  const unsupported = '当前对话底座不支持插件声明的能力：custom-capability、保存';
  const i18n = loadI18n('en-US');
  delete require.cache[require.resolve('../components/panels/panels-chat-status.js')];
  const status = require('../components/panels/panels-chat-status.js');
  for (const [locale, expected] of [['en-US','Browse the web'],['ja-JP','ウェブを閲覧'],['ko-KR','웹 탐색']]) {
    i18n.setLocale(locale, {persist:false,broadcast:false});
    const rendered = status.notice('这一轮没发出去（' + denied + '；' + readonly + '）');
    assert.ok(rendered.includes(expected), locale);
    assert.doesNotMatch(rendered, /当前|请新建|浏览网页|文件处理|命令与构建/);
    assert.ok(status.notice(missing).includes('销售部飞书；保存$&'));
    assert.doesNotMatch(status.notice(missing), /当前对话|完成连接/);
    assert.ok(status.notice(unsupported).includes('custom-capability'));
    assert.ok(status.notice(unsupported).includes('保存'));
    assert.doesNotMatch(status.notice(unsupported), /当前对话/);
    assert.equal(status.notice('客户原话；请保留名称'), '客户原话；请保留名称');
  }
  i18n.setLocale('zh-CN', {persist:false,broadcast:false});
  assert.equal(status.notice(denied), denied);
});

test('quota admission notices translate the complete Hub reason and follow locale changes', () => {
  const status = require('../components/panels/panels-chat-status');
  const reasons = [
    '试用已结束，联系管理员分配套餐后即可继续',
    '当前模型的额度已用完，可以选择其他可用模型或联系管理员调整额度',
    '当前套餐未包含此模型，请选择套餐内的模型或联系管理员',
    '当前 AI 额度已用完，联系管理员调整后即可继续',
  ];
  for (const locale of ['en-US', 'zh-CN', 'en-US']) {
    loadI18n(locale);
    for (const reason of reasons) {
      if (locale === 'zh-CN') assert.equal(status.notice(reason), reason);
      else {
        assert.doesNotMatch(status.notice(reason), /[\u4e00-\u9fff]/);
        assert.doesNotMatch(status.notice('这一轮没发出去（' + reason + '）'), /[\u4e00-\u9fff]/);
      }
    }
    assert.equal(status.notice('客户原话：试用已结束，请保留此消息'), '客户原话：试用已结束，请保留此消息');
  }
});

test('model interruption notices translate their system envelope and safe diagnostics without translating provider text', () => {
  const events = require('../main/pi-session/event-stream');
  const status = require('../components/panels/panels-chat-status');
  const denied = events.statusText({ settled: true, lastStopReason: 'error', lastAssistantError: 'HTTP 403' });
  const transient = events.statusText({ settled: true, lastStopReason: 'error', lastAssistantError: 'HTTP 503', modelRetry: { attempt: 2 } });
  const providerText = '客户原话：保存 $&';
  const unknown = events.statusText({ settled: true, lastStopReason: 'error', lastAssistantError: providerText });
  loadI18n('en-US');
  const refusal = status.notice(denied), retry = status.notice(transient);
  assert.match(refusal, /model request was rejected/i);
  const toolDenied = denied.replace('模型请求被拒绝', '工具已完成，请求模型继续生成时被拒绝');
  assert.match(status.notice(toolDenied), /tool completed.*request to continue generating was rejected/i);
  for (const [locale, refusalText, continuationText] of [
    ['ja-JP', 'モデルへのリクエストが拒否されました', 'ツールは完了しましたが、生成を続けるリクエストが拒否されました'],
    ['ko-KR', '모델 요청이 거부되었습니다', '도구 실행은 완료되었지만 생성을 계속하는 요청이 거부되었습니다'],
  ]) {
    loadI18n(locale);
    assert.ok(status.notice(denied).includes(refusalText), locale);
    assert.ok(status.notice(toolDenied).includes(continuationText), locale);
    assert.match(status.notice(toolDenied), /HTTP 403/);
    const translatedRetry = status.notice(transient);
    assert.match(translatedRetry, /HTTP 503/);
    assert.match(translatedRetry, /2/);
    assert.doesNotMatch(translatedRetry, /\{(?:reason|status|count)\}|模型服务在回答过程中|已有内容和工具结果/);
    assert.ok(status.notice(unknown).includes(providerText));
  }
  loadI18n('en-US');
  assert.match(refusal, /HTTP 403/);
  assert.match(retry, /HTTP 503/);
  assert.match(retry, /Automatically retried 2 times/);
  assert.ok(status.notice(unknown).includes(providerText), 'preserves unknown provider text');
  assert.equal(status.notice('客户原话：保存 $&'), providerText);
  for (const raw of ['HTTP 400', 'HTTP 401', 'HTTP 404', 'HTTP 429',
    JSON.stringify({ error: { code: '1113', message: 'billing_required' } }),
    JSON.stringify({ error: { code: 'insufficient_balance' } }),
    'HTTP 400 context_length_exceeded', 'HTTP 400 image input is not supported',
    JSON.stringify({ detail: { code: 'TOKEN_QUOTA_EXCEEDED' } })]) {
    const notice = events.statusText({ settled: true, lastStopReason: 'error', lastAssistantError: raw });
    assert.doesNotMatch(status.notice(notice), /[\u4e00-\u9fff]/, raw);
  }
  const empty = events.statusText({ settled: true, lastStopReason: 'error', lastAssistantError: '' });
  assert.doesNotMatch(status.notice(empty), /[\u4e00-\u9fff]/);
  assert.doesNotMatch(status.notice(denied), /[\u4e00-\u9fff]/);
  loadI18n('zh-CN');
  assert.equal(status.notice(denied), denied);
  assert.equal(status.notice(transient), transient);
});

test('repair failure banners localize only catalog model diagnostics and retain unknown text', () => {
  const status = require('../components/panels/panels-chat-status');
  const reason = require('../main/pi-session/model-errors').describe('HTTP 403').publicText;
  const unknown = 'Provider-specific text $&';
  for (const [locale, expected] of [['en-US', 'The model request was rejected.'],
    ['ja-JP', 'モデルへのリクエストが拒否されました。'], ['ko-KR', '모델 요청이 거부되었습니다.']]) {
    loadI18n(locale);
    for (const value of [reason, '这一轮没跑成（' + reason + '）']) {
      assert.ok(status.notice(value).includes(expected), locale);
      assert.match(status.notice(value), /HTTP 403/);
      assert.doesNotMatch(status.notice(value), /这一轮没跑成|模型请求被拒绝|model\.detail/);
    }
    assert.equal(status.notice(unknown), unknown);
    assert.ok(status.notice('这一轮没跑成（' + unknown + '）').includes(unknown));
  }
  loadI18n('zh-CN');
  assert.equal(status.notice(reason), reason);
  assert.equal(status.notice('这一轮没跑成（' + reason + '）'), '这一轮没跑成（' + reason + '）');
});

const EXPECT = {
  'ja-JP': { pending: 'ご要望を理解しています…', explain: '結果を分かりやすくまとめています…', busy: '処理中' },
  'ko-KR': { pending: '요청을 이해하는 중…', explain: '결과를 명확히 정리하는 중…', busy: '처리 중' },
};

test('completed turn labels translate before dynamic duration composition', () => {
  const summary = require('../components/panels/chat-turn-summary');
  for (const locale of ['en-US', 'ja-JP', 'ko-KR']) {
    const i18n = loadI18n(locale);
    const view = summary.create({ esc: value => String(value).replace(/"/g, '&quot;') });
    const turn = { key: 'reply:2', elapsedMs: 23000, tokens: 311 };
    const historical = view.html(turn, '');
    const current = view.html(turn, '<div><span class="nstatus-metric"><span data-thinking-label>已处理</span> ' +
      '<b data-thinking-elapsed>23s</b></span><span class="nstatus-divider">·</span>' +
      '<span class="nstatus-metric"><span data-thinking-estimate>≈</span><b data-thinking-tokens>40</b><em>tokens</em></span></div>');
    for (const html of [historical, current]) {
      assert.ok(html.includes(i18n.translateText('展开过程')));
      assert.ok(html.includes(i18n.translateText('用时')));
      assert.match(html, /23s/);
      assert.doesNotMatch(html, /311|tokens/);
      assert.doesNotMatch(html, /用时|展开过程|缺失用量|已处理/);
    }
  }
});

test('chat status copy is fully translated for ja-JP and ko-KR', () => {
  for (const [locale, expect] of Object.entries(EXPECT)) {
    const i18n = loadI18n(locale);
    const ChatStatus = require(path.join(__dirname, '../components/panels/panels-chat-status.js'));
    // Translate first-response waiting fragments before joining rotating status text.
    assert.equal(ChatStatus.work({ messages: [] }, false, 'ref-1'), expect.pending);
    assert.equal(ChatStatus.work({ messages: [{ role: 'assistant', blocks: [] }] }, false), expect.explain);
    // Read long-running and delayed-response messages from locale catalogs.
    const values = new Set(Object.values(mergedCatalog(locale)));
    assert.ok(values.has(ChatStatus.rotating('soduwork')), locale + ' rotating copy must come from the catalog');
    assert.ok(values.has(ChatStatus.longWork('ref-2', { elapsedMs: 150000 })), locale + ' long-work copy must come from the catalog');
    // Translate the tool title before applying the stalled-tool duration template.
    global.ChatTools = { render: () => ({ title: '正在运行命令', sub: '' }), currentTurnTools: () => [] };
    const stalled = ChatStatus.work({ tools: [{ state: 'running', name: 'bash' }], execution: { stalled: true, idleMs: 5000 } }, false);
    assert.ok(!stalled.includes('已有'), locale + ' stalled copy should be translated: ' + stalled);
    assert.ok(/秒|초/.test(stalled), 'stalled copy keeps localized seconds: ' + stalled);
    // Verify metric labels, titles, and accessibility labels.
    const thinking = ChatStatus.createThinking({ snap: {}, esc: null });
    const metrics = thinking.metricsHtml(true);
    assert.ok(metrics.includes(expect.busy) && !metrics.includes('>处理中<'), locale + ' busy label translated: ' + metrics);
    assert.ok(!metrics.includes('当前工作统计') && !metrics.includes('包含深度思考与回复'), locale + ' metrics attributes translated');
    assert.ok(thinking.statusHtml(true).includes(expect.pending), locale + ' status line shows translated base copy');
    // Translate shared workspace and status phrases consistently by fragment.
    const info = require(path.join(__dirname, '../components/panels/chat-workspace-info.js'));
    assert.equal(info.status({ messages: [] }, false), expect.pending);
    delete global.ChatTools;
  }
});

test('zh-CN keeps original copy so Chinese surfaces are untouched', () => {
  const i18n = loadI18n('zh-CN');
  const ChatStatus = require(path.join(__dirname, '../components/panels/panels-chat-status.js'));
  assert.equal(ChatStatus.work({ messages: [] }, false), '正在理解你的要求…');
  assert.equal(i18n.translateText('正在理解你的要求…'), '正在理解你的要求…');
});

test('retry countdown and attempt numbers use each locale catalog', () => {
  const original = Date.now;
  Date.now = () => 100000;
  try {
    for (const [locale, expected] of [['en-US', /in 4s \(2\/3\)/], ['ja-JP', /4秒後に再接続（2\/3）/], ['ko-KR', /4초 후 다시 연결\(2\/3\)/]]) {
      loadI18n(locale);
      const ChatStatus = require('../components/panels/panels-chat-status.js');
      const copy = ChatStatus.work({ modelRetry: { active: true, attempt: 2, max: 3, retryAt: 104000 } });
      assert.match(copy, expected);
      assert.doesNotMatch(copy, /模型服务暂时异常/);
    }
  } finally { Date.now = original; }
});

test('historical chat reopen action uses the selected locale', () => {
  for (const [locale, expected] of [
    ['en-US', 'Reopen chat'],
    ['ja-JP', '会話を開き直す'],
    ['ko-KR', '대화 다시 열기'],
  ]) {
    const i18n = loadI18n(locale);
    assert.equal(i18n.translateText('重新打开会话'), expected);
  }
});

test('nav.agents keeps the Agent product name and localizes surrounding ja/ko copy', () => {
  // Preserve Agent proper names and verify rendered translations rather than obsolete source wording.
  for (const [locale, label, eyebrow] of [
    ['ja-JP', 'Agent 管理', 'マイ Agent'],
    ['ko-KR', 'Agent 관리', '내 Agent'],
  ]) {
    const i18n = loadI18n(locale);
    assert.equal(i18n.t('nav.agents'), label);
    assert.equal(i18n.t('eyebrow.my_agents'), eyebrow);
    assert.equal(i18n.translateText('Agent 管理'), label);
  }
});

test('status catalogs still cover every static status phrase (ja/ko)', () => {
  // Cover component status phrases, matching dynamic strings through their template prefixes.
  const phrases = [
    '正在理解你的要求…', '正在把结果讲清楚…', '计划已经形成，正在完成实现与运行验证…',
    '复核发现交付缺口，正在自动补齐并重新验证…', '正在做交付复核，并补齐最后的缺口…',
    '正在执行 {value1}…', '{value1}已有 {value2} 秒没有新进展；现场已保留，达到本类安全上限后会自动停止并换方案…',
    '{value1}仍在运行（{value2} 秒），进度会持续同步…', '正在定向修复：', '正在独立复核，当前质量',
    '正在把服务启动起来…', '正在让程序跑一遍，看看结果…', '正在工作区里找线索…',
    '正在把内容稳稳写进', '正在细修', '正在翻阅', '正在处理 ', '先把事情想明白，再动手…',
    '正在核对刚才的结果…', '收到，正在接上工作区…', '正在运行命令',
  ];
  for (const locale of ['ja-JP', 'ko-KR']) {
    const catalog = JSON.stringify(mergedCatalog(locale));
    for (const phrase of phrases) assert.ok(catalog.includes(phrase), locale + ' catalog missing: ' + phrase);
  }
});


test('incomplete archives and failed working copies show the applicable recovery in English', () => {
  loadI18n('en-US');
  const status = require('../components/panels/panels-chat-status.js');
  const current = { ref: 'chat', snap: { status: 'idle', localReplica: true, execution: { canContinueOnDevice: false } } };
  const view = status.createThinking(() => current);
  const reasons = [
    ['本轮成果未能完整核对，未自动归档。请在会话生成目录中查看原文件。', /verified/],
    ['本轮有 2 个文件超过 32 MiB，未自动归档。请在会话生成目录中查看原文件。', /32 MiB.+2/],
    ['本轮成果归档失败。请在会话生成目录中查看原文件。', /Archiving failed/],
    ['部分会话成果未完成归档，请保留工作目录中的文件。', /Keep the files/],
    ['已归档的原件可从历史成果卡另存。工作副本未能投递，请检查目录权限和可用空间。', /disk space/],
    ['会话成果原件已保存。工作目录已有不同内容的同名副本，可从历史成果卡另存。', /different contents/],
  ];
  for (const [warning, expected] of reasons) {
    current.snap.artifactCaptureWarning = warning;
    assert.match(view.statusHtml(false), expected);
    assert.doesNotMatch(view.statusHtml(false), /[\u4e00-\u9fff]/u);
  }
  view.stopThinkingClock();
});
