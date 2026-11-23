'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'core/locales/manifest.json'), 'utf8'));

// global-search.js is a standalone multi-language UI copy file (not a per-locale
// dictionary) that native-locale.cjs never loads; it is intentionally outside the
// manifest catalog. Only per-locale dictionaries and builtin packs belong there.
const NON_CATALOG_FILES = new Set(['global-search.js']);
function localeFilesLoadedBy(htmlFile) {
  const html = fs.readFileSync(path.join(root, htmlFile), 'utf8');
  const files = [];
  const re = /<script src="core\/locales\/([^"]+\.js)"><\/script>/g;
  let match;
  while ((match = re.exec(html)) !== null) files.push(match[1]);
  return files;
}

test('every locale file loaded by desk.html and index.html is listed in manifest.json', () => {
  for (const htmlFile of ['desk.html', 'index.html']) {
    const loaded = localeFilesLoadedBy(htmlFile);
    for (const file of loaded) {
      if (NON_CATALOG_FILES.has(file)) continue;
      assert.ok(manifest.includes(file),
        `${htmlFile} loads core/locales/${file} but it is missing from core/locales/manifest.json`);
    }
  }
});

test('ko-KR native menus translate 重装 to 재설치 using the real native-locale module', () => {
  const locale = require('../main/native-locale.cjs');
  const original = locale.getLocale();
  try {
    locale.setLocale('ko-KR');
    assert.equal(locale.translate('重装'), '재설치');
  } finally {
    locale.setLocale(original);
  }
});
test('ko-KR native menus match the page result for keys shared with other ko-KR catalogs', () => {
  const locale = require('../main/native-locale.cjs');
  const agentPages = require('../core/locales/ko-KR-agent-pages.js');
  const otherKoKr = {};
  for (const file of manifest) {
    if (!file.startsWith('ko-KR-') || file === 'ko-KR-agent-pages.js') continue;
    Object.assign(otherKoKr, require('../core/locales/' + file));
  }
  const shared = Object.keys(agentPages).filter(key => Object.hasOwn(otherKoKr, key));
  assert.ok(shared.length > 0, 'expected at least one key shared with other ko-KR catalogs');
  assert.ok(shared.includes('走我的额度'), 'expected 走我的额度 to be a shared key');
  const original = locale.getLocale();
  try {
    locale.setLocale('ko-KR');
    for (const key of shared) {
      assert.equal(locale.translate(key), agentPages[key],
        `ko-KR native menu for ${JSON.stringify(key)} must match the agent-pages page result`);
    }
  } finally {
    locale.setLocale(original);
  }
});
