'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const window = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/library-preview-archive.js'), 'utf8'), { window });
const entry = files => window.SoduWorkLibraryArchive.findEntry(files)?.path || null;
const files = (...paths) => paths.map(path => ({ path, filename: path.split('/').pop(), isDirectory: path.endsWith('/') }));

test('website archive opens its root index before nested pages or legacy htm', () => {
  assert.equal(entry(files('pages/index.html', 'index.htm', 'index.html', 'README.md')), 'index.html');
});
test('a single website wrapper can contain nested wrappers and platform metadata', () => {
  assert.equal(entry(files('__MACOSX/._demo', '.DS_Store', 'demo/', 'demo/.DS_Store', 'demo/site/index.html', 'demo/site/css/main.css')), 'demo/site/index.html');
});
test('mixed documents or multiple sites remain in folder browsing mode', () => {
  assert.equal(entry(files('README.md', 'site/index.html')), null);
  assert.equal(entry(files('first/index.html', 'second/index.html')), null);
  assert.equal(entry(files('site/index.html', 'empty/')), null);
});
test('an archive without a homepage never guesses an arbitrary HTML file', () => {
  assert.equal(entry(files('demo/about.html', 'demo/data.json')), null);
  assert.equal(entry([]), null);
});
test('an uppercase homepage and htm extension are recognized without changing its path', () => {
  assert.equal(entry(files('Demo/INDEX.HTML', 'Demo/style.css')), 'Demo/INDEX.HTML');
  assert.equal(entry(files('index.htm')), 'index.htm');
});
