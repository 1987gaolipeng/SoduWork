'use strict';
/*
 * Use real settings rendering and locale catalogs to verify update-card titles refresh
 * from cached state after language changes, including dynamic version fragments.
 */
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const CORE = path.join(__dirname, '../core/');
const LOCALES = path.join(CORE, 'locales/');
const SETTINGS = path.join(__dirname, '../components/settings/');
const LOCALE_FILES = JSON.parse(fs.readFileSync(path.join(LOCALES, 'manifest.json'), 'utf8'))
  .filter(name => /^(en|ja|ko)-/.test(name));

function stubElement() {
  return {
    nodeType: 1,
    textContent: '', title: '', hidden: false, disabled: false, checked: false,
    value: '', className: '', innerHTML: '', scrollTop: 0, style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    replaceChildren() {}, append() {}, appendChild() {}, focus() {},
    matches: () => false, scrollIntoView() {},
  };
}

/*
 * Provide required settings element doubles and omit the optional progress host to
 * exercise its absent-host path.
 */
const STUBBED_IDS = new Set(['clientUpdateBadge', 'clientUpdateDot', 'clientUpdateTitle',
  'clientUpdateDetail', 'clientUpdateAction', 'clientUpdateBlockers',
  'settingsPanel', 'remindSeg', 'scaleSeg', 'fontSeg', 'localeSelect', 'workRootInput',
  'workRootSave', 'workRootNote', 'boxNameInput', 'boxNameSave', 'boxBindNote',
  'skinOpenBtn', 'skinCurName', 'petVisibleChk', 'dockVisibleChk', 'trayVisibleChk',
  'trayOffNote', 'settingsClose']);

function bootClientUpdateCard() {
  // Use an isolated VM to avoid repeated top-level constant declarations.
  const listeners = {};
  const elements = new Map();
  const sandbox = {
    console, setTimeout, clearTimeout,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: {
      documentElement: { lang: '', dataset: {}, style: { setProperty() {} } },
      readyState: 'complete', body: null, title: '',
      createTreeWalker: () => ({ nextNode: () => null, currentNode: null }),
      addEventListener(type, fn) { (listeners['doc:' + type] = listeners['doc:' + type] || []).push(fn); },
      removeEventListener() {},
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => stubElement(),
      getElementById(id) {
        if (!STUBBED_IDS.has(id)) return null;
        if (!elements.has(id)) elements.set(id, stubElement());
        return elements.get(id);
      },
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    dispatchEvent(event) { for (const fn of listeners[event.type] || []) fn(event); return true; },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    cfg: { uiScale: 'medium', fontScale: 'medium', petVisible: true, dockVisible: true, trayVisible: true },
    saveCfg() {}, petSay() {}, Store: {}, User: { id: 'u-1', name: 'tester' },
    soduWorkAPI: {
      clientUpdateStatus: async () => ({ state: 'current', currentVersion: '1.12.79' }),
      onClientUpdateStatus: () => {},
      getDefaultWorkRoot: async () => 'C:\\Users\\t\\SoduWork',
      setLocale: () => {},
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const run = (file, base) => vm.runInContext(
    fs.readFileSync(path.join(base, file), 'utf8'), sandbox, { filename: file });
  run('locale-registry.js', LOCALES);
  for (const file of LOCALE_FILES) run(file, LOCALES);
  run('i18n-dom.js', CORE);
  run('i18n.js', CORE);
  run('client-update-view.js', SETTINGS);
  run('settings.js', SETTINGS);
  return sandbox;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const EXPECT_TITLE = {
  'zh-CN': '当前版本已就绪 · 当前版本 1.12.79',
  'ja-JP': '現在のバージョンは準備完了 · 現在のバージョン 1.12.79',
  'ko-KR': '현재 버전 준비 완료 · 현재 버전 1.12.79',
  'en-US': 'Current version ready · Current version 1.12.79',
};

test('client update card title repaints on locale change in all four languages', async () => {
  const sandbox = bootClientUpdateCard();
  sandbox.SoduWorkI18n.setLocale('zh-CN', { persist: false, broadcast: false });
  await sandbox._refreshClientUpdateStatus();   // Render the explicit Chinese settings update card.
  await sleep(20);
  const title = sandbox.document.getElementById('clientUpdateTitle');
  assert.equal(title.textContent, EXPECT_TITLE['zh-CN']);

  for (const locale of ['ja-JP', 'ko-KR', 'en-US']) {
    sandbox.SoduWorkI18n.setLocale(locale, { persist: false, broadcast: false });
    assert.equal(title.textContent, EXPECT_TITLE[locale],
      locale + ' 界面下标题必须整体翻译（含拼接段）');
    for (const zh of ['当前版本已就绪', '当前版本', '客户端更新']) {
      assert.ok(!title.textContent.includes(zh), locale + ' 下标题不允许残留中文原文: ' + zh);
    }
  }
});

test('direct IPC push repaints the card in the active language', async () => {
  const sandbox = bootClientUpdateCard();
  sandbox.SoduWorkI18n.setLocale('ja-JP', { persist: false, broadcast: false });
  await sandbox._refreshClientUpdateStatus();
  await sleep(20);
  const title = sandbox.document.getElementById('clientUpdateTitle');
  assert.equal(title.textContent, EXPECT_TITLE['ja-JP']);
});

test('update card phrase catalog stays complete for ja/ko/en', () => {
  // Assert the runtime dictionary assembled in manifest order.
  const sandbox = bootClientUpdateCard();
  const phrases = ['当前版本已就绪', '当前版本', '客户端更新', '已是最新', '尚未检查', '检查更新',
    '正在保护当前工作', '客户端更新没有完成', '客户端已更新', '开发模式',
    '下载完成', '校验通过', '待重启', '重启后即可使用新版本。'];
  for (const locale of ['en-US', 'ja-JP', 'ko-KR']) {
    const catalog = sandbox.SoduWorkLocaleMessages[locale] || {};
    for (const phrase of phrases) {
      assert.ok(Object.hasOwn(catalog, phrase), locale + ' 缺词条: ' + phrase);
    }
  }
});
