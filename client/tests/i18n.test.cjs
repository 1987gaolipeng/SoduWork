const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const script = fs.readFileSync(path.join(__dirname, '../core/i18n.js'), 'utf8');
test('localized slash actions resolve to the same work contract and preserve request text', () => {
  const window = { TaskPriority: { labels: {} }, addEventListener() {} };
  const context = vm.createContext({ window, document: { addEventListener() {} }, Intl, setTimeout, clearTimeout });
  const read = name => fs.readFileSync(path.join(__dirname, '../components/panels', name), 'utf8');
  vm.runInContext(read('plugin-ui-host.js'), context);
  context.PluginUIHost = window.PluginUIHost;
  for (const file of ['work-entry-sheet.js', 'work-automation-sheet.js']) vm.runInContext(read(file), context);
  for (const [en, zh, actionId] of [
    ['issue', '需求', 'work.requirement.create'], ['request', '创建需求', 'work.requirement.create'], ['task', '任务', 'work.requirement.create'],
    ['automation', '自动化', 'work.automation.create'],
  ]) for (const command of [en, zh]) {
    const result = window.PluginUIHost.commandFromText('/' + command + ' 保存 this request');
    assert.equal(result?.actionId, actionId, command);
    assert.equal(result.text, '保存 this request');
  }
});
function client(saved = {}, blocked = false, options = {}) {
  const storage = new Map(Object.entries(saved)), listeners = new Map(), sent = [];
  const context = vm.createContext({
    Intl, Map, Set, Object,
    localStorage: { getItem: key => { if (blocked) throw Error('blocked'); return storage.get(key) || null; }, setItem: (key, value) => { if (blocked) throw Error('blocked'); storage.set(key, value); } },
    document: { readyState: 'loading', documentElement: { dataset: {} }, querySelectorAll: () => [] },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    addEventListener: (name, cb) => { listeners.set(name, cb); },
    dispatchEvent: event => { listeners.get(event.type)?.(event); },
    soduWorkAPI: { setLocale: locale => sent.push(locale), onLocaleChange: cb => { listeners.set('ipc-locale', cb); } },
  });
  const initialConfig = options.initialLocale ? `{locale:${JSON.stringify(options.initialLocale)}}` : '{}';
  vm.runInContext(`window = globalThis; let cfg = ${initialConfig}; let saves = 0; const saveCfg = () => { saves++; };`, context);
  for (const file of JSON.parse(fs.readFileSync(path.join(__dirname, '../core/locales/manifest.json'), 'utf8'))) {
    // A legacy renderer can start while the registry script is unavailable;
    // locale packs must still be selectable instead of collapsing to Chinese.
    if ((options.withoutRegistry || options.registry) && file === 'locale-registry.js') continue;
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../core/locales', file), 'utf8'), context);
  }
  if (options.registry) context.SoduWorkLocaleRegistry = options.registry;
  vm.runInContext(script, context);
  return { api: context.SoduWorkI18n, context, storage, listeners, sent, read: code => vm.runInContext(code, context) };
}

test('new client profiles default to English while explicit locale choices remain intact', () => {
  const fresh = client({}, false, { initialLocale: null });
  assert.equal(fresh.api.getLocale(), 'en-US');
  assert.equal(fresh.context.document.documentElement.lang, 'en-US');
  const saved = client({}, false, { initialLocale: 'zh-CN' });
  assert.equal(saved.api.getLocale(), 'zh-CN');
  assert.deepEqual(saved.api.options().map(item => item.value), ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']);
});

test('ja-JP and ko-KR translate gap pages, localized templates and Issue terms', () => {
  const c = client();
  const contextScope = '最近一次上报的上下文用量，含缓存；不含待发送内容';
  for (const locale of ['en-US', 'ja-JP', 'ko-KR']) {
    c.api.setLocale(locale);
    assert.notEqual(c.api.translateText(contextScope), contextScope);
  }
  c.api.setLocale('ja-JP');
  assert.equal(c.api.translateText('文件已保存'), 'ファイルを保存しました');
  assert.equal(c.api.translateText('打开需求失败：网络超时'), '課題を開けませんでした：网络超时');
  assert.equal('claude' + c.api.translateText(' · 第 2 段') + c.api.translateText(' · 排队 3'), 'claude · 第 2 セグメント · 待機 3');
  assert.equal(c.api.translateText('每周一 09:00'), '毎週月曜日 09:00');
  assert.equal(c.api.translateText('· 已归档 · 5 条'), '· アーカイブ済み · 5 件');
  assert.equal(c.api.translateText('专业方法'), '専門手法');
  c.api.setLocale('ko-KR');
  assert.equal(c.api.translateText('文件已保存'), '파일을 저장했습니다');
  assert.equal(c.api.translateText('插件 12 · 连接器 4 · 技能 8'), '플러그인 12 · 커넥터 4 · 스킬 8');
  assert.equal(c.api.translateText('已建立自动化：' + c.api.translateText('每周一 09:00') + '按「周报生成」的方法自动执行，可在「定时任务」里调整'),
    '매주 월요일 09:00에 “周报生成” 방법으로 자동 실행이 생성되었습니다. 예약 작업에서 조정할 수 있습니다');
  c.api.setLocale('zh-CN');
  assert.equal(c.api.translateText('文件已保存'), '文件已保存');
});
test('gantt item counts and routine rhythm labels translate in all locales without term leakage', () => {
  const c = client();
  c.api.setLocale('zh-CN');
  assert.equal(c.api.translateText('任务 42 项'), '任务 42 项');
  c.api.setLocale('en-US');
  assert.equal(c.api.translateText('任务 42 项'), '42 items');
  assert.equal(c.api.translateText('42 项'), '42 items');
  assert.equal(c.api.translateText('↻ 写周报 · 每天'), '↻ 写周报 · Daily');
  assert.equal(c.api.translateText('写周报 · 计划'), '写周报 · Planned');
  assert.equal(c.api.translateText('写周报 · 实际'), '写周报 · Actual');
  c.api.setLocale('ja-JP');
  assert.equal(c.api.translateText('任务 42 项'), '課題 42 件');
  assert.equal(c.api.translateText('↻ 写周报 · 每周'), '↻ 写周报 · 毎週');
  assert.equal(c.api.translateText('写周报 · 例行'), '写周报 · 定例');
  c.api.setLocale('ko-KR');
  assert.equal(c.api.translateText('任务 42 项'), '이슈 42개');
  assert.equal(c.api.translateText('↻ 写周报 · 每月'), '↻ 写周报 · 매월');
  assert.equal(c.api.translateText('写周报 · 实际'), '写周报 · 실제');
  c.api.setLocale('zh-CN');
});
test('cloud environment UI translates complete messages while preserving command and server data', () => {
  const c = client(); c.api.setLocale('en-US');
  assert.equal(c.api.translateText('云端环境'), 'Cloud environments');
  assert.equal(c.api.translateText('执行中 2 / 8'), 'Running: 2 / 8');
  assert.equal(c.api.translateText('复制接入指令'), 'Copy setup command');
  assert.equal(c.api.translateText('需要执行机管理权限，请联系管理员接入团队服务器'),
    'Runner management permission is required. Ask an administrator to connect a team server.');
  assert.equal(c.api.translateText('团队共享服务器由管理员配置。你可以使用已接入且有权限的服务器。'),
    'Administrators configure shared team servers. You can use connected servers that you have permission to access.');
  const command = 'npm install -g @earendil-works/pi-coding-agent';
  assert.equal(c.api.translateText(command), command);
  assert.equal(c.api.translateText('研发服务器-保存-trial'), '研发服务器-保存-trial');
  c.api.setLocale('zh-CN');
  assert.equal(c.api.translateText('云端环境'), '云端环境');
});
test('complete dynamic templates retain data and safely escape HTML parameters', () => {
  const c = client(); c.api.setLocale('en-US');
  assert.equal(c.api.translateText('当前模型不接受图片输入，请切换支持图片的模型或启用视觉适配'),
    'This model rejected image input. Switch to an image-capable model or enable vision fallback.');
  assert.equal(c.api.translateText('本月已用 12 / 300 Tokens'), 'Used this month: 12 / 300 tokens');
  assert.equal(c.api.translateText('在此目录创建会话：D:/保存 & 删除'), 'Start a chat in: D:/保存 & 删除');
  assert.equal(c.api.translateText('在此目录创建会话：D:/保存  &  删除'), 'Start a chat in: D:/保存  &  删除');
  assert.equal(c.api.translateText('constructor'), 'constructor');
  const guard = require('../main/agent-runtime/protocol-guard');
  const notice = guard.reason({ code: guard.DEGENERATE_OUTPUT_CODE });
  assert.equal(c.api.translateText(notice), 'The model kept repeating the same action. SoduWork stopped the repetitive output and preserved your progress and tool results.');
  assert.equal(c.api.translateText(notice, 'zh-CN'), notice);
  const html = c.api.html('models.noResults', '', { query: '<img src=x onerror=alert(1)>保存' });
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('保存'));
});
test('language updates the lexical cfg and calls its persistence function', () => {
  const c = client();
  c.api.setLocale('en-US');
  assert.equal(c.read('cfg.locale'), 'en-US');
  assert.equal(c.read('saves'), 1);
  assert.equal(c.storage.get('soduwork_work_cfg_v5_locale'), 'en-US');
  assert.equal(c.api.t('settings'), 'Settings');
  assert.equal(c.context.document.documentElement.lang, 'en-US');
});
test('reload restores the selected language and migrates a mirror-only setting', () => {
  const c = client({ soduwork_work_cfg_v5_locale: 'en-US' });
  assert.equal(c.api.getLocale(), 'en-US');
  assert.equal(c.read('cfg.locale'), 'en-US');
  assert.equal(c.read('saves'), 0);
});
test('storage and IPC changes synchronize windows without rebroadcast loops', () => {
  const c = client();
  const initial = c.sent.length;
  c.listeners.get('storage')({ key: 'soduwork_work_cfg_v5_locale', newValue: 'en-US' });
  assert.equal(c.api.getLocale(), 'en-US');
  c.listeners.get('ipc-locale')('zh-CN');
  assert.equal(c.api.getLocale(), 'zh-CN');
  assert.equal(c.sent.length, initial);
  assert.equal(c.read('saves'), 0);
});
test('switching works when local storage is unavailable', () => {
  const c = client({}, true);
  c.api.setLocale('en-US');
  assert.equal(c.api.t('settings'), 'Settings');
  assert.equal(c.sent.at(-1), 'en-US');
});
test('accepted remote configuration updates the reload mirror without saving back to Hub', () => {
  const c = client();
  c.api.setLocale('en-US', { persist: false });
  assert.equal(c.storage.get('soduwork_work_cfg_v5_locale'), 'en-US');
  assert.equal(c.read('saves'), 0);
  assert.equal(c.sent.at(-1), 'en-US');
  c.listeners.get('ipc-locale')('zh-CN');
  assert.equal(c.storage.get('soduwork_work_cfg_v5_locale'), 'zh-CN');
  assert.equal(c.sent.at(-1), 'en-US');
});
test('native window titles follow locale while retaining the full user task title', () => {
  const c = client();
  c.api.setLocale('zh-CN');
  c.api.setWindowTitle('控制台', '保存 · （有会话）');
  assert.equal(c.context.document.title, 'SoduWork · 控制台 · 保存 · （有会话）');
  c.api.setLocale('en-US');
  assert.equal(c.context.document.title, 'SoduWork · Console · 保存 · （有会话）');
  c.api.setLocale('zh-CN');
  assert.equal(c.context.document.title, 'SoduWork · 控制台 · 保存 · （有会话）');
});
test('only complete UI messages translate and whitespace is retained', () => {
  const c = client();
  c.api.setLocale('en-US');
  assert.equal(c.api.translateText('  保存  '), '  Save  ');
  assert.equal(c.api.translateText('这是一个新的任务'), '这是一个新的任务');
  assert.equal(c.api.translateText('保存：我的项目'), '保存：我的项目');
  c.api.setLocale('zh-CN');
  assert.equal(c.api.translateText('保存'), '保存');
  assert.equal(c.api.normalize('xx-YY'), 'en-US');
  assert.equal(c.api.normalize('en-GB'), 'en-US');
});

test('additional locale packs switch without translating user content', () => {
  const c = client();
  assert.deepEqual(c.api.options().map(item => item.value), ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']);
  c.api.setLocale('ja-JP');
  assert.equal(c.api.getLocale(), 'ja-JP');
  assert.equal(c.api.translateText('设置'), '設定');
  assert.equal(c.api.translateText('模型清单'), 'モデル一覧');
  assert.equal(c.api.translateText('项目-保存'), '项目-保存');
  assert.equal(c.api.normalize('ja'), 'ja-JP');
  c.api.setLocale('ko');
  assert.equal(c.api.getLocale(), 'ko-KR');
  assert.equal(c.api.translateText('设置'), '설정');
  assert.equal(c.api.translateText('模型清单'), '모델 목록');
  c.api.setLocale('zh-CN');
});

test('additional locales remain selectable when a legacy renderer misses the registry script', () => {
  const c = client({}, false, { withoutRegistry: true });
  assert.deepEqual(c.api.options().map(item => item.value), ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']);
  c.api.setLocale('ja-JP');
  assert.equal(c.api.getLocale(), 'ja-JP');
  assert.equal(c.api.translateText('设置'), '設定');
  c.api.setLocale('ko-KR');
  assert.equal(c.api.getLocale(), 'ko-KR');
  assert.equal(c.api.translateText('设置'), '설정');
  c.api.setLocale('zh-CN');
});

test('a cached two-language registry cannot hide newer shipped locale packs', () => {
  const legacy = client({}, false, { registry: {
    defaultLocale: 'zh-CN',
    locales: {
      'zh-CN': { label: '简体中文', fallback: null },
      'en-US': { label: 'English', fallback: 'zh-CN' },
    },
  } });
  assert.deepEqual(legacy.api.options().map(item => item.value), ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']);
  legacy.api.setLocale('ja-JP');
  assert.equal(legacy.api.translateText('设置'), '設定');
});

test('settings exposes language choices through one native select', () => {
  const html = fs.readFileSync(path.join(__dirname, '../desk.html'), 'utf8');
  const settings = fs.readFileSync(path.join(__dirname, '../components/settings/settings.js'), 'utf8');
  assert.match(html, /<select id="localeSelect"/);
  assert.match(html, /data-i18n="languageJa"/);
  assert.match(html, /data-i18n="languageKo"/);
  assert.doesNotMatch(html, /id="localeSeg"/);
  assert.match(settings, /_syncLocaleSelect/);
  assert.match(settings, /localeSelect\.addEventListener\('change'/);
});
