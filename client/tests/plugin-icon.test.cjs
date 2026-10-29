'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const icon = require('../core/plugin-icon');
const personal = require('../main/personal-plugins');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxqkAAAAASUVORK5CYII=';
const body = {template:'method',key:'icon-demo',name:'图标演示',version:'1.0.0',description:'图标保存验证',instructions:'整理工作进展。'};

test('only bounded embedded PNG is accepted; unsafe or broken values use the default', () => {
  assert.equal(icon.normalize(png), png);
  assert.equal(icon.normalize(undefined), '');
  assert.match(icon.image(png), /<img class="cap-plugin-custom-icon"/);
  for (const value of ['https://example.com/logo.png','file:///private.png','javascript:alert(1)',
    'data:image/svg+xml,<svg onload="alert(1)"/>', '<img src=x onerror=alert(1)>', {},
    'data:image/png;base64,AAAA', png + 'A', 'data:image/png;base64,'+'A'.repeat(140000)]) {
    assert.throws(() => icon.normalize(value)); assert.equal(icon.image(value), '');
  }
  const bytes=Buffer.from(png.split(',')[1],'base64'); bytes.writeUInt32BE(257,16);
  assert.throws(()=>icon.normalize('data:image/png;base64,'+bytes.toString('base64')), /尺寸/);
});

test('catalog icon lookup accepts the published manifest shape and keeps a polished fallback', () => {
  assert.equal(icon.source({ manifest: { icon: png } }), png);
  assert.match(icon.imageFor({ body: { manifest: { icon: png } } }), /cap-plugin-custom-icon/);
  assert.match(icon.markup({ name: 'Connector', capabilities: { mcpServers: ['demo'] } }), /<svg/);
  assert.doesNotMatch(icon.markup({ name: 'Connector', icon: 'https://example.com/icon.png' }), /https:/);
});

test('default body and manifest remain unchanged; custom icon is versioned and portable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-icon-contract-'));
  const app={getPath:()=>path.join(root,'one')}, other={getPath:()=>path.join(root,'two')};
  try {
    const baseline=personal.build(body);
    assert.equal(Object.hasOwn(baseline.body,'icon'),false);
    assert.equal(Object.hasOwn(baseline.manifest,'icon'),false);
    assert.equal(personal.build({...body,icon:''}).checksum,baseline.checksum);
    const first=personal.create(app,body).plugin;
    assert.throws(()=>personal.create(app,{...body,icon:png}),/同一版本/);
    const custom=personal.create(app,{...body,version:'1.0.1',icon:png}).plugin;
    assert.equal(custom.icon,png);
    assert.equal(personal.get(app,custom.pluginId).localDraft.icon,png);
    const exported=personal.exportDraft(app,custom.pluginId);
    assert.equal(exported.icon,png);
    const imported=personal.create(other,exported).plugin;
    assert.equal(imported.icon,png);
    assert.equal(imported.checksum,custom.checksum);
    assert.equal(personal.catalog(app).find(x=>x.pluginId===custom.pluginId).icon,png);
    assert.notEqual(custom.checksum,first.checksum);
    const restored=personal.create(app,{...exported,version:'1.0.2',icon:''}).plugin;
    assert.equal(restored.icon,undefined);
    assert.equal(personal.setVersion(app,custom.pluginId,'1.0.1').plugin.icon,png);
    assert.equal(personal.setVersion(app,custom.pluginId,'1.0.0').plugin.icon,undefined);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('shared icon support is loaded before the editor in both client renderers', () => {
  for (const file of ['index.html','desk.html']) {
    const source=fs.readFileSync(path.join(__dirname,'..',file),'utf8');
    assert.ok(source.indexOf('core/plugin-icon.js')>=0);
    assert.ok(source.indexOf('core/plugin-icon.js')<source.indexOf('panels-plugin-maker.js'));
  }
});
