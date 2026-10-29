const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { readFileSync } = require('./renderer-source.cjs');

const ROOT = path.join(__dirname, '..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');

function contract() {
  const sandbox = { window: {}, URL, CSS: { escape: String } };
  vm.runInNewContext(read('components/panels/plugin-install-setup.js'), sandbox);
  return sandbox.window.SoduWorkPluginInstallSetup;
}

test('plugin setup is version-bound, typed and separated from credentials', () => {
  const api = contract();
  const item = {
    setup: { preferences: [
      { key: 'language', type: 'select', default: 'zh-CN' },
      { key: 'enabled', type: 'boolean', default: false },
      { key: 'ignored', type: 'secret' },
    ] },
    dependencyReadiness: { requiredMcp: ['CRM', 'CRM', 'OA'] },
  };
  const normalized = api.__test.setupOf(item);
  assert.deepEqual(normalized.preferences.map((field) => field.key),
    ['language', 'enabled']);
  assert.deepEqual(Array.from(api.__test.requiredMcp(item)), ['CRM', 'OA']);
  assert.equal(api.__test.firstValue(normalized.preferences[1], {}), false);
  assert.equal(api.needs(item), true);

  const source = read('components/panels/plugin-install-setup.js');
  const apiSource = read('api.js');
  const css = read('components/panels/plugin-install-setup.css');
  assert.match(source, /将实际连接服务并获取工具清单，不会执行工具/);
  assert.match(source, /账号与密钥单独配置，不写入插件偏好；安装不会自动完成平台授权/);
  assert.match(source, /item\.versionId, config/);
  assert.match(source, /setupConfig \|\| \{\}/);
  assert.match(apiSource, /probeEnterprisePluginInstallation/);
  assert.match(apiSource, /expectedVersionId/);
  assert.match(css, /\.cap-setup-grid/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media\(max-width:680px\)/);
  assert.match(source, /openInline/);
  assert.match(source, /data-plugin-install-card/);
  assert.match(css, /\.pui-plugin-install/);
  assert.match(css, /prefers-reduced-motion/);
});

test('client owns setup authoring while admin reviews a frozen contract', () => {
  const index = read('index.html');
  const desk = read('desk.html');
  const detail = read(path.join('..', 'hub-frontend', 'src', 'screens', 'PluginDetailWorkspace.jsx'));
  const review = read(path.join('..', 'hub-frontend', 'src', 'screens', 'PluginInstallContract.jsx'));
  const author = read(path.join('..', 'hub-frontend', 'src', 'screens', 'PluginAuthoring.jsx'));
  for (const html of [index, desk]) {
    assert.match(html, /plugin-install-setup\.css/);
    assert.match(html, /plugin-install-setup\.js/);
  }
  assert.match(detail, /<PluginInstallContract version=\{version\} \/>/);
  assert.match(review, /version\?\.manifest\?\.setup/);
  assert.match(review, /setup\.preferences/);
  assert.match(review, /plugin-preview-setup/);
  assert.match(review, /SETUP_TYPES/);
  assert.match(review, /OAuth/);
  assert.doesNotMatch(review, /<(?:input|textarea|select|form)\b|onChange=|api\./);
  assert.doesNotMatch(author, /SETUP_FIELD_TYPES|author-setup-preview|PluginFormDesigner/);
});
