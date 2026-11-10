'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { audit, anchors } = require('./check-docs.cjs');

function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-doc-links-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text);
  return root;
}
test('missing file, missing heading and escaping links fail', t => {
  const root = fixture(t, { 'README.md': '[a](missing.md) [b](README.md#missing) [c](../outside.md)\n' });
  assert.equal(audit(root, ['README.md'], []).errors.length, 3);
});
test('code samples do not create links or headings and duplicate headings get suffixes', () => {
  assert.deepEqual([...anchors('# Intro\n# Intro\n```md\n# Hidden\n```\n')], ['intro', 'intro-1']);
});
test('translations require reciprocal navigation near the top', t => {
  const root = fixture(t, { 'README.md': '[English](en.md)\n', 'en.md': '# English\n' });
  assert.equal(audit(root, ['README.md', 'en.md'], [['README.md', 'en.md']]).errors.length, 1);
  fs.appendFileSync(path.join(root, 'en.md'), '[Chinese](README.md)\n');
  assert.equal(audit(root, ['README.md', 'en.md'], [['README.md', 'en.md']]).ok, true);
});
test('external links and literal code examples do not require local files', t => {
  const root = fixture(t, { 'README.md': '[web](https://example.com/)\n```md\n[x](missing.md)\n```\n' });
  assert.equal(audit(root, ['README.md'], []).ok, true);
});
test('README HTML images must exist locally; remote images and fenced examples are skipped', t => {
  const root = fixture(t, {
    'README.md': '<p><img src="hero.gif"></p>\n<img width="80" src=\'logo.svg\'>\n' +
      '<img src="https://example.com/banner.png">\n```html\n<img src="example.png">\n```\n',
    'logo.svg': '<svg/>',
  });
  const result = audit(root, ['README.md'], []);
  assert.equal(result.checkedLinks, 2);
  assert.deepEqual(result.errors, ['README.md: missing or escaping link hero.gif']);
});
