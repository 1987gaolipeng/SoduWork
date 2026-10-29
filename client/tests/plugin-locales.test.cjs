'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const locales = require('../core/plugin-locales');
const personal = require('../main/personal-plugins');
const reader = require('../main/plugin-package-reader.cjs');
const translations = {
  'zh-CN': { name: '运营助手', description: '处理运营工作', ui: { main: { title: '工作台' } } },
  'en-US': { name: 'Operations', description: 'Manage operations', ui: { main: { title: 'Workspace' } },
    inputs: { mode: { label: 'Mode', options: { auto: 'Automatic' } } },
    setup: { title: 'Preferences', preferences: { notify: { label: 'Notify' } } } },
  'ko-KR': { name: '운영 도우미' },
};
function body() { return { template: 'app', key: 'locale-app', name: '旧名称', description: '旧用途', version: '1.0.0',
  instructions: '处理当前用户明确要求的工作。', locales: structuredClone(translations),
  inputs: [{ key: 'mode', type: 'select', label: '模式', default: 'auto', options: [{ value: 'auto', label: '自动' }] }],
  setup: { title: '偏好', preferences: [{ key: 'notify', label: '提醒', type: 'boolean', default: false }] },
  ui: { contributions: [{ id: 'main', title: '旧入口', slot: 'workspace.navigation', source: { type: 'external', url: 'https://example.invalid/' } }] } }; }

test('language fallback, optional Korean and presentation overlays preserve execution and values', () => {
  const base = body(), before = JSON.stringify(base);
  assert.equal(locales.present(base, 'zh-TW').name, '运营助手');
  for (const lang of ['en-GB', 'fr-FR', 'de', '']) {
    const view = locales.present(base, lang);
    assert.equal(view.name, 'Operations'); assert.equal(view.ui.contributions[0].title, 'Workspace');
    assert.equal(view.inputs[0].label, 'Mode'); assert.equal(view.inputs[0].default, 'auto');
    assert.deepEqual(view.inputs[0].options, [{ value: 'auto', label: 'Automatic' }]);
    assert.equal(view.setup.preferences[0].default, false);
    assert.deepEqual(view.ui.contributions[0].source, base.ui.contributions[0].source);
  }
  assert.equal(locales.present(base, 'ko').name, '운영 도우미');
  assert.equal(locales.present(base, 'ko').description, 'Manage operations');
  assert.equal(JSON.stringify(base), before);
  const legacy = { name: '兼容名称' }; assert.equal(locales.present(legacy, 'en'), legacy);
});

test('declared locale blocks require bilingual metadata and reject executable overrides or poisoned keys', () => {
  assert.ok(locales.normalize(translations)['en-us']);
  for (const value of [{}, { en: translations['en-US'] }, { ...translations, 'en_US': translations['en-US'] },
    { ...translations, en: { name: 'Test', source: { url: 'https://evil.invalid' } } },
    { ...translations, ko: { inputs: { x: { default: 'altered' } } } },
    { ...translations, ko: { ui: JSON.parse('{"__proto__":{"title":"bad"}}') } }]) assert.throws(() => locales.normalize(value));
  assert.equal(locales.normalize(null), null);
});

test('local install, export, import and built-in developers retain bilingual metadata', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-locale-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, installed = personal.create(app, body()).plugin;
  assert.equal(installed.locales['en-us'].name, 'Operations');
  const filePath = path.join(root, 'app.soduwork-plugin');
  await personal.exportToFile(app, { showSaveDialog: async () => ({ filePath }) }, installed.pluginId);
  const imported = reader.readPersonalArchive(fs.readFileSync(filePath));
  assert.deepEqual(imported.locales, installed.locales);
  assert.deepEqual(personal.preflight(imported).manifest.locales, installed.locales);
  for (const id of [personal.BUILDER_ID, personal.APP_DEVELOPER_ID]) {
    const plugin = personal.get(app, id);
    assert.ok(plugin.locales['en-us'].name);
    assert.match(plugin.localDraft.instructions, /最低.*双语/);
    assert.ok(plugin.localDraft.instructions.length <= 8000);
    const spec = plugin.localDraft.resources.find(item => item.path === 'references/plugin-locales.md');
    assert.match(Buffer.from(spec.content, 'base64').toString('utf8'), /zh-CN.*en-US/);
  }
});

test('catalog API localizes local and Hub entries and pinned conversation metadata', async () => {
  let locale = 'en-US';
  const window = { navigator: { language: 'zh-CN' }, SoduWorkPluginLocales: locales, SoduWorkI18n: { getLocale: () => locale },
    soduWorkAPI: { personalPlugins: { list: async () => ({ items: [{ ...body(), personal: true }] }) } } };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../core/api-work-plugins.js'), 'utf8'), { window });
  const api = window.SoduWorkPluginAPI.create({ jfetch: async () => ({ items: [{ ...body(), conversationName: '旧名', conversationLocales: translations, conversationInputs: body().inputs }] }),
    taskStorageKey: () => 'scope', registrationEpoch: () => 1, mark() {}, markFromError() {}, registrationBoundaryError: () => false });
  const english = await api.pluginCatalog();
  assert.equal(english.items[0].name, 'Operations'); assert.equal(english.items[1].conversationName, 'Operations');
  locale = 'zh-CN'; assert.equal((await api.pluginCatalog()).items[0].name, '运营助手');
});
