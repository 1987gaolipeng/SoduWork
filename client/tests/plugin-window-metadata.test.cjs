'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const personal = require('../main/personal-plugins');
const sizing = require('../core/app-window-sizing');
const reader = require('../main/plugin-package-reader.cjs');
const base = { template: 'method', key: 'window-fixture', name: '窗口样例', version: '1.0.0',
  description: '测试随插件保存的窗口默认值', instructions: '显示工作页面。', ui: { contributions: [{
    id: 'main', title: '样例', slot: 'workspace.navigation', source: { type: 'external', url: 'https://example.invalid/' },
  }] } };

test('optional author window metadata survives installation, catalog, export/import and immutable version changes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-window-metadata-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root };
  const appWindow = { width: '90vw', height: '80vh', maxWidth: 2680, maxHeight: 17800,
    rules: [{ maxScreenWidth: 1366, width: '100vw', height: '100vh' }] };
  const expected = sizing.normalize(appWindow);
  const item = personal.create(app, { ...base, appWindow }).plugin;
  assert.deepEqual(item.appWindow, expected);
  assert.deepEqual(personal.get(app, item.pluginId).localDraft.appWindow, expected);
  assert.deepEqual(personal.catalog(app).find(x => x.pluginId === item.pluginId).appWindow, expected);
  const archivePath = path.join(root, 'fixture.soduwork-plugin');
  await personal.exportToFile(app, { showSaveDialog: async () => ({ filePath: archivePath }) }, item.pluginId);
  const restored = reader.readPersonalArchive(fs.readFileSync(archivePath));
  assert.deepEqual(restored.appWindow, expected);
  assert.deepEqual(personal.preflight(restored).manifest.appWindow, expected);
  assert.throws(() => personal.create(app, { ...base, appWindow: { width: 800 } }), /版本|内容/);
  const next = personal.create(app, { ...base, version: '1.0.1' }).plugin;
  assert.equal(next.appWindow, undefined);
  personal.setVersion(app, next.pluginId, '1.0.0');
  assert.deepEqual(personal.get(app, next.pluginId).appWindow, expected);
});
test('missing metadata stays absent in old plugin manifests; malformed metadata is rejected at preflight', () => {
  assert.equal(personal.preflight(base).manifest.appWindow, undefined);
  for (const appWindow of [false, '100vw', { width: 'calc(100vw)' }, { minHeight: 900, maxHeight: 800 }]) {
    assert.throws(() => personal.preflight({ ...base, appWindow }));
  }
});

test('cover artwork URL survives portable export and catalog; unsafe URLs are rejected', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-cover-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const app={getPath:()=>root},coverUrl='https://example.invalid/app-cover.jpg';
  const item=personal.create(app,{...base,coverUrl}).plugin;
  assert.equal(item.coverUrl,coverUrl);
  const archive=path.join(root,'cover.soduwork-plugin');
  await personal.exportToFile(app,{showSaveDialog:async()=>({filePath:archive})},item.pluginId);
  assert.equal(reader.readPersonalArchive(fs.readFileSync(archive)).coverUrl,coverUrl);
  for(const value of ['javascript:alert(1)','file:///private.png','https://user:secret@example.com/image.png','https://example.com/a b'])assert.throws(()=>personal.preflight({...base,coverUrl:value}));
});
