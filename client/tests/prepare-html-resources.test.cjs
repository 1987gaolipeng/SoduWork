'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { prepareHtmlResources } = require('../scripts/prepare-html-resources.cjs');

const PI = 'resources/pi/node_modules/@earendil-works/pi-coding-agent';
const INDEX = PI + '/dist/core/export-html/index.js';
const CHUNK = PI + '/dist/bundle/chunks/chunk-fixture.js';
const TEMPLATE = PI + '/dist/core/export-html/template.html';
const FRAME = 'resources/skills/brainstorming/scripts/frame-template.html';
const SERVER = 'resources/skills/brainstorming/scripts/server.cjs';
const HTML = '<!DOCTYPE html>\r\n<html><body>中文 "quotes" \\ {{JS}} <!-- CONTENT --></body></html>\r\n';
const entry = 'function exportHtml(){const templateDir="fixture";const template = readFileSync(join(templateDir, "template.html"), "utf-8");return template;}';
const chunk = 'function exportHtml(){let templateDir="fixture",template=readFileSync3(join14(templateDir,"template.html"),"utf-8");return template;}';
const server = "const frameTemplate = fs.readFileSync(path.join(__dirname, 'frame-template.html'), 'utf-8');function exportHtml(){return frameTemplate;}";
async function write(root, relative, content) {
  const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content);
}
async function fixture(t, withTemplates = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-html-resources-'));
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('soduwork-html-resources-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  await write(root, 'resources/app.asar', 'packaged app');
  if (withTemplates) for (const [relative, content] of [[TEMPLATE, HTML], [INDEX, entry], [CHUNK, chunk], [FRAME, HTML], [SERVER, server]]) {
    await write(root, relative, content);
  }
  return root;
}
async function exists(root, relative) { return fs.lstat(path.join(root, relative)).then(() => true, () => false); }
function render(source) {
  // Any remaining disk/template read fails; the prepared consumer owns bytes.
  return vm.runInNewContext(source + '\nexportHtml()', { readFileSync() { throw Error('loose template read'); } });
}

test('both Pi entry points and brainstorm preserve exact template bytes without loose HTML', async t => {
  const root = await fixture(t), result = await prepareHtmlResources(root);
  assert.deepEqual(result.embeddedTemplates.map(x => x.consumers), [2, 1]);
  for (const file of [INDEX, CHUNK, SERVER]) {
    const result = render(await fs.readFile(path.join(root, file), 'utf8'));
    assert.deepEqual(Buffer.from(result), Buffer.from(HTML));
  }
  for (const file of [TEMPLATE, FRAME]) assert.equal(await exists(root, file), false);
  const first = await Promise.all([INDEX, CHUNK, SERVER].map(file => fs.readFile(path.join(root, file))));
  const secondResult = await prepareHtmlResources(root);
  const second = await Promise.all([INDEX, CHUNK, SERVER].map(file => fs.readFile(path.join(root, file))));
  assert.deepEqual(second, first); assert.ok(secondResult.embeddedTemplates.every(x => !x.changed));
});

test('optional frozen Runner brainstorm copy is prepared and empty minimal packages are allowed', async t => {
  const root = await fixture(t, false);
  assert.deepEqual(await prepareHtmlResources(root), { embeddedTemplates: [], excludedDocuments: [], remainingHtml: [] });
  const base = 'resources/runner/_internal/skills/brainstorming/scripts/';
  await write(root, base + 'frame-template.html', HTML); await write(root, base + 'server.cjs', server);
  const result = await prepareHtmlResources(root);
  assert.equal(result.embeddedTemplates[0].consumers, 1);
  assert.equal(render(await fs.readFile(path.join(root, base + 'server.cjs'), 'utf8')), HTML);
});

test('only reviewed dependency documentation is excluded; redistribution notices survive unchanged', async t => {
  const root = await fixture(t, false), docs = [
    PI + '/node_modules/bignumber.js/doc/API.html', PI + '/node_modules/tslib/tslib.es6.html', PI + '/node_modules/tslib/tslib.html',
  ];
  for (const file of [...docs, 'LICENSES.chromium.html', 'resources/vendor/LICENSE.html']) await write(root, file, HTML);
  const result = await prepareHtmlResources(root);
  assert.deepEqual(result.excludedDocuments.sort(), docs.sort());
  for (const file of docs) assert.equal(await exists(root, file), false);
  for (const file of ['LICENSES.chromium.html', 'resources/vendor/LICENSE.html']) {
    assert.equal(await fs.readFile(path.join(root, file), 'utf8'), HTML);
  }
});

test('unknown root and runtime HTML fail before deleting templates or rewriting consumers', async t => {
  for (const relative of ['unknown.htm', 'resources/skills/unknown/new.html', PI + '/node_modules/tslib/unreviewed.html']) {
    const root = await fixture(t); await write(root, relative, HTML);
    await assert.rejects(prepareHtmlResources(root), /Unreviewed loose HTML resource/);
    assert.equal(await fs.readFile(path.join(root, INDEX), 'utf8'), entry);
    assert.equal(await fs.readFile(path.join(root, TEMPLATE), 'utf8'), HTML);
  }
});

test('dependency reader drift, absent templates, and altered embedded bytes all fail closed', async t => {
  const root = await fixture(t);
  await write(root, CHUNK, chunk.replace('readFileSync3', 'readResource'));
  await assert.rejects(prepareHtmlResources(root), /Unsupported HTML template consumer layout/);
  assert.equal(await fs.readFile(path.join(root, INDEX), 'utf8'), entry);
  await write(root, CHUNK, chunk);
  await fs.unlink(path.join(root, TEMPLATE));
  await assert.rejects(prepareHtmlResources(root), /Unsupported HTML template consumer layout/);
  await write(root, TEMPLATE, HTML); await prepareHtmlResources(root);
  const original = await fs.readFile(path.join(root, INDEX), 'utf8');
  await write(root, INDEX, original.replace('中文', 'changed'));
  await assert.rejects(prepareHtmlResources(root), /Changed embedded HTML template/);
});

test('root must identify packaged output and no symlink target can be mutated', async t => {
  const root = await fixture(t), outside = await fixture(t);
  await assert.rejects(prepareHtmlResources('relative-output'), /absolute packaged application/);
  await fs.unlink(path.join(root, 'resources/app.asar'));
  await assert.rejects(prepareHtmlResources(root), /refusing to modify source resources/);
  await write(root, 'resources/app.asar', 'packaged app');
  await fs.symlink(outside, path.join(root, 'resources/linked'), 'junction');
  await assert.rejects(prepareHtmlResources(root), /symbolic link/);
  assert.equal(await fs.readFile(path.join(outside, TEMPLATE), 'utf8'), HTML);
  assert.equal(await fs.readFile(path.join(root, INDEX), 'utf8'), entry);
});

test('actual installed Pi dependency layouts embed without modifying the dependency source', async t => {
  const root = await fixture(t, false), sourceRoot = path.resolve(__dirname, '../node_modules/@earendil-works/pi-coding-agent');
  const paths = ['dist/core/export-html/index.js', 'dist/core/export-html/template.html'];
  const chunkRoot = path.join(sourceRoot, 'dist/bundle/chunks');
  for (const name of await fs.readdir(chunkRoot)) {
    if (!name.endsWith('.js')) continue;
    const source = await fs.readFile(path.join(chunkRoot, name), 'utf8');
    if (source.includes('template.html')) paths.push('dist/bundle/chunks/' + name);
  }
  assert.ok(paths.length > 2, 'actual RPC/CLI bundle consumer must be covered');
  const originals = new Map();
  for (const relative of paths) {
    const bytes = await fs.readFile(path.join(sourceRoot, relative)); originals.set(relative, bytes);
    await write(root, PI + '/' + relative, bytes);
  }
  const result = await prepareHtmlResources(root);
  assert.equal(result.embeddedTemplates[0].consumers, paths.length - 1);
  const expected = originals.get('dist/core/export-html/template.html');
  for (const relative of paths) {
    assert.deepEqual(await fs.readFile(path.join(sourceRoot, relative)), originals.get(relative), 'dependency source is read-only');
    if (relative.endsWith('.html')) continue;
    const source = await fs.readFile(path.join(root, PI, relative), 'utf8');
    const literal = /\/\* SODUWORK_HTML_TEMPLATE:pi-export:[a-f0-9]{64} \*\/\s*("(?:[^"\\]|\\[\s\S])*")/.exec(source)[1];
    assert.deepEqual(Buffer.from(JSON.parse(literal)), expected);
  }
  await prepareHtmlResources(root);
});
