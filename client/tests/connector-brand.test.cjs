'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const brand = require('../core/connector-brand');
const dir = path.join(__dirname, '../assets/connector-brands');
test('every bundled commercial provider and native account has offline connector artwork with provenance', () => {
  const defs = path.join(__dirname, '../../skills/mcp-tools/connectors/providers');
  const ids = fs.readdirSync(defs).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(defs,f),'utf8')).id);
  const sources = JSON.parse(fs.readFileSync(path.join(dir,'sources.json'),'utf8'));
  for (const id of [...ids,'wecom','feishu','dingtalk']) {
    const file = brand.asset({templateKey:'connector-'+id}); assert.ok(file,id);
    assert.ok(sources[id]?.source.startsWith('https://'),id);
    const bytes = fs.readFileSync(path.join(dir,file)); assert.ok(bytes.length > 20 && bytes.length < 150000,id);
    if (file.endsWith('.svg')) {
      const svg = bytes.toString('utf8'); assert.match(svg,/<svg /);
      assert.doesNotMatch(svg,/<script|<foreignObject|<image|\bon[a-z]+\s*=|(?:xlink:)?href\s*=/i);
    } else if (file.endsWith('.png')) assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    else assert.equal(bytes.subarray(0,4).toString('hex'),'00000100');
  }
});

test('artwork with unverified redistribution terms is replaced without losing provider identity', () => {
  const sources = JSON.parse(fs.readFileSync(path.join(dir, 'sources.json'), 'utf8'));
  const replacements = ['excel-online', 'microsoft-teams', 'onedrive', 'sharepoint',
    'wecom', 'dingtalk', 'feishu', 'yuque', 'runway', 'kling', 'volcengine-ark',
    'tencent-meeting', 'tencent-cloud', 'volcengine-ecs', 'azure', 'outlook'];
  for (const [id, row] of Object.entries(sources)) {
    assert.equal(brand.asset(id), row.file, id);
    assert.ok(['MIT', 'CC0-1.0'].includes(row.license.type), id);
    if (replacements.includes(id)) {
      assert.equal(row.artworkOrigin, 'original-category-artwork', id);
      assert.equal(row.license.type, 'MIT', id);
      assert.match(row.file, /^category-(chat|documents|spreadsheet|cloud|video|meeting|email)\.svg$/, id);
      assert.equal(row.previousArtwork.status, 'not-distributed', id);
      assert.ok(!fs.existsSync(path.join(dir, row.previousArtwork.file)), id);
      assert.equal(brand.identify({templateKey: 'connector-' + id}), id);
      assert.match(brand.image(id), /width="28" height="28"/, id);
      assert.match(fs.readFileSync(path.join(dir, row.file), 'utf8'), /viewBox="0 0 28 28"/);
    } else {
      assert.equal(row.artworkOrigin, 'third-party-icon-collection', id);
      assert.equal(row.license.type, 'CC0-1.0', id);
      assert.match(row.rightsNote, /不授予产品商标权/, id);
    }
  }
  assert.equal(Object.values(sources).filter(row => row.artworkOrigin === 'original-category-artwork').length, replacements.length);
  const mapped = new Set(Object.values(brand.files));
  for (const file of fs.readdirSync(dir).filter(file => /\.(svg|png|ico)$/.test(file))) {
    assert.ok(mapped.has(file), 'unmapped artwork would still be shipped: ' + file);
  }
  const license = fs.readFileSync(path.join(dir, 'LICENSE.original-icons.txt'), 'utf8');
  assert.match(license, /Copyright \(c\) 2026 SoduWork contributors/);
  assert.match(license, /Permission is hereby granted, free of charge/);
});
test('renamed imported templates keep product identity without accepting remote artwork or lookalike hosts', () => {
  assert.equal(brand.identify({name:'我的设计工作区',templateKey:'connector-figma'}),'figma');
  assert.equal(brand.identify({name:'custom',command:'soduwork-connector',args:['github']}),'github');
  assert.equal(brand.identify({id:'soduwork-feishu-123'}),'feishu');
  assert.equal(brand.identify({url:'https://api.figma.com/mcp'}),'figma');
  for (const item of [{url:'https://api.figma.com.evil.test/mcp'}, {providerId:'../../secret'}, {icon:'https://evil.test/track.png'}, {providerId:'__proto__'}, {providerId:'toString'}]) assert.equal(brand.asset(item),'');
  assert.doesNotMatch(brand.image({providerId:'figma'}),/https?:/);
  assert.equal(brand.image({name:'unknown'}),'');
});
