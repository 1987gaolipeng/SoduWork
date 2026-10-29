const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function loadLifecycle() {
  const context = { window: {}, console };
  vm.runInNewContext(read('components/panels/plugin-lifecycle.js'), context);
  return context.window.SoduWorkPluginLifecycle;
}

test('plugin lifecycle offers one next action for each usage state', () => {
  const lifecycle = loadLifecycle();
  assert.equal(lifecycle.resolve({ personal: true, enabled: true }).code, 'ready');
  assert.equal(lifecycle.resolve({ personal: true, enabled: false }).nextAction, 'enable');
  assert.equal(lifecycle.resolve({ installed: false, marketPolicy: {} }).nextAction, 'install');
  assert.equal(lifecycle.resolve({ installed: true, updateAvailable: true }).code, 'upgrade');
  assert.equal(lifecycle.resolve({ installed: true, setupState: 'required' }).nextAction, 'setup');
  assert.equal(lifecycle.resolve({ installed: true }, { missingMcp: ['gitlab'], installBlocked: false }).code, 'connect');
  assert.equal(lifecycle.resolve({ marketPolicy: { installation: 'not_available' } }).code, 'taskOnly');
  assert.equal(lifecycle.resolve({ trustState: 'revoked' }).code, 'revoked');
});

test('plugin cards and details expose state and next action without duplicate status stacks', () => {
  const panel = read('components/panels/panels-capability-plugins.js');
  const lifecycleSource = read('components/panels/plugin-lifecycle.js');
  const css = read('components/panels/panels-capability-plugins.css');
  for (const token of ['SoduWorkPluginLifecycle', 'function html', 'cap-plugin-next', 'cap-plugin-lifecycle']) {
    assert.match(panel + lifecycleSource + css, new RegExp(token));
  }
  assert.match(lifecycleSource, /当前状态/);
  assert.match(lifecycleSource, /下一步/);
  assert.match(css, /prefers-reduced-motion/);
});

test('both Electron pages load the lifecycle contract before the catalog shell', () => {
  for (const file of ['index.html', 'desk.html']) {
    const html = read(file);
    assert.match(html, /plugin-lifecycle\.js/);
    assert.ok(html.indexOf('plugin-lifecycle.js') < html.indexOf('panels-capability-plugins.js'));
  }
});