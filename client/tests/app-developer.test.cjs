'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const personal = require('../main/personal-plugins');
const resources = require('../main/plugin-resources');
const drafts = require('../main/pi-session/plugin-draft');
const reader = require('../main/plugin-package-reader.cjs');
const { scaffold } = require('../../skills/app-developer/scripts/scaffold.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-app-authoring-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, app: { getPath: () => root }, out: path.join(root, 'candidate') };
}
function build(f) {
  return scaffold({ out: f.out, key: 'notes-demo', name: '便签应用', url: 'http://127.0.0.1:8098/' });
}
function collected(f) {
  const entry = { artifactId: 'app-draft', path: path.join(f.out, drafts.DRAFT_NAME), relative: drafts.DRAFT_NAME };
  return drafts.readSession({ cwd: f.out, sessionId: 'author', inFlight: () => false,
    outputSnapshot: () => ({ files: [entry], delivery: { items: [entry] } }) }, entry.artifactId);
}

test('built-in app developer inherits the current plugin contract and exact public SDK, without installation side effects', t => {
  const f = fixture(t), detail = personal.get(f.app, personal.APP_DEVELOPER_ID);
  assert.equal(detail.builtIn, true);
  assert.equal(detail.name, '应用开发');
  assert.equal(detail.entrypoints.automation, false);
  assert.deepEqual(detail.capabilities.runtime, ['files', 'terminal', 'browser']);
  assert.ok(personal.catalog(f.app).some(x => x.pluginId === personal.APP_DEVELOPER_ID));
  const bundle = resources.materialize(detail.localDraft.resources, f.root, detail.key);
  const folder = path.join(bundle.directory, 'references/developer');
  assert.equal(fs.readFileSync(path.join(folder, 'plugin-development.md'), 'utf8'), require('../main/plugin-builder-plugin.cjs').body().instructions);
  assert.deepEqual(fs.readFileSync(path.join(folder, 'sdk/soduwork-app.js')), fs.readFileSync(path.resolve(__dirname, '../sdk/soduwork-app.js')));
  const script = path.join(folder, 'scripts/scaffold.cjs');
  require(script).scaffold({ out: f.out, key: 'notes-demo', name: '便签应用', url: 'http://127.0.0.1:8098/' });
  const resolved = personal.resolve(f.app, [personal.APP_DEVELOPER_ID], { cwd: f.root });
  assert.match(resolved.items[0].context, /references\/developer\/SKILL.md/);
  assert.equal(fs.existsSync(path.join(f.root, 'personal-plugins.json')), false);
});

test('generated app installs from its own conversation artifact, exports and reimports with type and resources intact', async t => {
  const f = fixture(t); build(f);
  const read = collected(f); assert.equal(read.ok, true, read.reason);
  const checked = personal.preflight(read.body);
  assert.equal(checked.manifest.template, 'app');
  assert.equal(checked.capabilities.network, true);
  assert.equal(checked.capabilities.interactiveUi, true);
  assert.equal(checked.capabilities.entrypoints.automation, false);
  assert.equal(checked.manifest.appWindow, undefined);
  assert.deepEqual(checked.capabilities.mcpServers, [], 'standalone apps do not acquire an MCP prerequisite');
  assert.deepEqual(read.body.ui.contributions[0].source.bridge.capabilities, ['conversation.send', 'composer.control']);
  const standalone = require('../main/application-turn-context.cjs').describe({ pluginId: 'local:notes-demo',
    pageUrl: read.body.ui.contributions[0].source.url }, [{ pluginId: 'local:notes-demo',
    capabilities: checked.capabilities }], []);
  assert.equal(standalone.connection.status, 'not_declared', 'a standalone app needs no business credentials to prepare its conversation');
  const created = personal.create(f.app, read.body).plugin;
  assert.equal(created.template, 'app');
  const packagePath = path.join(f.root, 'notes.soduwork-plugin');
  await personal.exportToFile(f.app, { showSaveDialog: async () => ({ filePath: packagePath }) }, created.pluginId);
  const imported = reader.readPersonalArchive(fs.readFileSync(packagePath));
  assert.equal(imported.template, 'app');
  assert.equal(imported.resources.length, 3);
  assert.equal(personal.preflight(imported).manifest.template, 'app');
  assert.deepEqual(imported.ui, personal.get(f.app, created.pluginId).ui);
  assert.equal(personal.create(f.app, read.body).created, false);
  assert.throws(() => personal.create(f.app, { ...read.body, instructions: '修改了内容' }), /版本/);
});

test('default static H5 scaffold declares a bundled entry and survives portable export without a service URL', async t => {
  const f = fixture(t);
  scaffold({ out: f.out, key: 'static-demo', name: '单机便签', entry: 'ui/pages/index.html' });
  const read = collected(f); assert.equal(read.ok, true, read.reason);
  const source = read.body.ui.contributions[0].source;
  assert.equal(source.type, 'package'); assert.equal(source.entry, 'ui/pages/index.html'); assert.equal(source.url, undefined);
  assert.deepEqual(read.body.mcpServers, []);
  assert.match(fs.readFileSync(path.join(f.out, source.entry), 'utf8'), /src="\.\.\/soduwork-app.js"/);
  const created = personal.create(f.app, read.body).plugin;
  const file = path.join(f.root, 'static.soduwork-plugin');
  await personal.exportToFile(f.app, { showSaveDialog: async () => ({ filePath: file }) }, created.pluginId);
  const imported = reader.readPersonalArchive(fs.readFileSync(file));
  assert.equal(personal.preflight(imported).manifest.ui.contributions[0].source.type, 'package');
  assert.ok(imported.resources.some(row => row.path === 'ui/pages/index.html' && row.kind === 'ui'));
  for (const entry of ['../index.html', 'ui/../index.html', 'file:///index.html', '/ui/index.html', 'ui/index.js', 'ui/%2e%2e/index.html']) {
    const bad = structuredClone(read.body); bad.ui.contributions[0].source.entry = entry;
    assert.throws(() => personal.preflight(bad), /入口|路径/);
  }
  const missing = structuredClone(read.body); missing.resources = missing.resources.filter(row => row.path !== source.entry);
  assert.throws(() => personal.preflight(missing), /入口未包含/);
});

test('app discriminator rejects missing, external-only or credentialed pages and leaves old method manifests compatible', t => {
  const f = fixture(t); build(f); const { body } = collected(f);
  for (const ui of [undefined, { contributions: [] }, { contributions: [{ id: 'main', title: '应用', slot: 'workspace.navigation', source: { type: 'external', openMode: 'external', url: 'https://example.invalid/' } }] },
    { contributions: [{ id: 'main', title: '应用', slot: 'workspace.navigation', source: { type: 'external', url: 'https://user:pass@example.invalid/' } }] }]) {
    assert.throws(() => personal.preflight({ ...body, ui }));
  }
  const legacy = personal.preflight({ ...body, template: 'method' });
  assert.equal(legacy.manifest.template, undefined);
  assert.equal(legacy.capabilities.interactiveUi, true);
});

test('scaffolding never overwrites an existing directory, declares actual resources and never claims runtime testing', t => {
  const f = fixture(t), result = build(f);
  assert.equal(result.installed, false); assert.equal(result.runtimeTested, false);
  const manifest = require('../main/conversation/delivery-contract').readManifest(f.out);
  assert.equal(manifest.invalid, undefined);
  assert.equal(manifest.deliverables[0].path, 'soduwork-plugin-draft.json');
  assert.throws(() => build(f), /已经存在/);
  assert.equal(collected(f).body.resources.length, 3);
  fs.unlinkSync(path.join(f.out, 'ui/app.js'));
  assert.equal(collected(f).ok, false);
  for (const url of ['file:///tmp/a', 'https://u:p@example.invalid/', 'https://example.invalid/?token=hidden']) {
    assert.throws(() => scaffold({ out: path.join(f.root, 'other'), key: 'valid-key', name: '应用', url }));
    assert.equal(fs.existsSync(path.join(f.root, 'other')), false);
  }
});

test('app entry selects the built-in developer in a new conversation while retaining the plugin entry', () => {
  const calls = [], context = { window: { WorkspaceHost: { open: (route, payload) => calls.push({ route, payload }) } } };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../components/panels/panels-plugin-builder-entry.js'), 'utf8'), context);
  context.window.PluginBuilderEntry.openApp('开发便签');
  context.window.PluginBuilderEntry.open('周报');
  assert.equal(calls[0].route, 'create');
  assert.equal(calls[0].payload.pluginId, 'local:app-developer');
  assert.equal(calls[0].payload.prefill, '开发应用：开发便签');
  assert.equal(calls[0].payload.newSession, true);
  assert.equal(calls[0].payload.autoSend, undefined);
  assert.equal(calls[1].payload.pluginId, 'local:plugin-builder');
  const build = require('../package.json').build;
  assert.ok(build.files.includes('sdk/**/*'));
  assert.ok(build.files.includes('app-window-chrome.html'));
  assert.ok(build.extraResources.some(x => x.from === '../skills'));
});
