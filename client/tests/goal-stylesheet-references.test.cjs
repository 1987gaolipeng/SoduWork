'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const verifier = require('../main/conversation/goal-verifier');

function site(t, css, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-goal-css-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'index.html'), '<link rel="stylesheet" href="style.css"><h1>Fixture</h1>');
  fs.writeFileSync(path.join(root, 'style.css'), css);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text);
  return verifier.websiteProbe(root, { path: path.join(root, 'index.html') }, {}, {});
}

test('website goal verification ignores URLs inside CSS strings and comments', t => {
  for (const css of ['body::after{content:"url(missing.png)"}',
    '/* url(missing.png) @import "missing.css"; */ body{color:red}']) {
    assert.equal(site(t, css).pass, true);
  }
});

test('website goal verification rejects a missing import after CSS comments', t => {
  const result = site(t, '@import /* annotation */ "missing.css"; body{color:red}');
  assert.equal(result.pass, false);
  assert.match(result.gaps.join('\n'), /missing\.css/);
});

test('website goal verification follows comment-separated imports to missing nested assets', t => {
  const result = site(t, '@import /* annotation */ "theme.css";',
    { 'theme.css': 'body{background:url("missing.png")}' });
  assert.equal(result.pass, false);
  assert.match(result.gaps.join('\n'), /missing\.png/);
});

test('website goal verification resolves escaped CSS paths with the original file spelling', t => {
  assert.equal(site(t, 'body{background:url("icon\\20 1.svg")}',
    { 'icon 1.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }).pass, true);
});

test('website goal verification still rejects actual missing and undeclared remote CSS resources', t => {
  assert.equal(site(t, 'body{background:url("missing.png")}').pass, false);
  assert.equal(site(t, 'body{background:url("https://fixture.invalid/image.png")}').pass, false);
});
