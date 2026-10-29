'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {check, digest, ROOTS, INVENTORY} = require('./check-source-provenance.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-provenance-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  function write(file, content) { const full = path.join(root, file); fs.mkdirSync(path.dirname(full), {recursive: true}); fs.writeFileSync(full, content); }
  const code = 'client/vendor/example.js', notice = 'third-party/example-LICENSE.txt';
  write(code, 'module.exports = 1;\n'); write(notice, 'Original copyright and permission\n');
  const inventory = {schema: 1, roots: ROOTS, components: [{id: 'example', license: 'MIT',
    source: 'https://example.invalid/upstream', reviewBasis: 'Isolated test fixture',
    notices: [{path: notice, sha256: digest('Original copyright and permission\n')}],
    files: [{path: code, sha256: digest('module.exports = 1;\n')}]}]};
  const save = () => write(INVENTORY, JSON.stringify(inventory)); save();
  return {root, code, notice, inventory, write, save};
}
test('vendor changes and new imports require review even when the source manifest is regenerated', t => {
  const f = fixture(t); assert.equal(check(f.root).ok, true);
  f.write(f.code, 'module.exports = 2;\n');
  assert.match(check(f.root).errors.join('\n'), /Changed vendored source/);
  f.write('client/vendor/unreviewed.js', 'new import');
  assert.match(check(f.root).errors.join('\n'), /Unreviewed vendored file/);
});
test('copyright deletion fails while CRLF-only conversion preserves evidence', t => {
  const f = fixture(t); f.write(f.notice, 'Original copyright and permission\r\n');
  assert.equal(check(f.root).ok, true); f.write(f.notice, 'Permission without original copyright\n');
  assert.match(check(f.root).errors.join('\n'), /Changed original notice/);
});
test('missing notices, duplicate files, unsafe paths and unreviewed licenses fail closed', t => {
  const f = fixture(t), component = f.inventory.components[0];
  component.files.push({...component.files[0]}); f.save();
  assert.match(check(f.root).errors.join('\n'), /Duplicate provenance file/);
  component.files.pop(); component.notices[0].path = '../outside.txt'; f.save();
  assert.match(check(f.root).errors.join('\n'), /Unsafe provenance path/);
  component.notices = []; f.save(); assert.equal(check(f.root).ok, false);
  component.notices = [{path: f.notice, sha256: digest('Original copyright and permission\n')}];
  component.license = 'LicenseRef-Unverified'; f.save(); assert.equal(check(f.root).ok, false);
});
test('the inventory cannot narrow its roots to conceal newly imported code', t => {
  const f = fixture(t); f.inventory.roots = ['client/vendor/']; f.save();
  assert.match(check(f.root).errors.join('\n'), /Invalid source provenance scope/);
});
test('a symlink cannot substitute code or move a protected directory outside the checkout', t => {
  const f = fixture(t), elsewhere = path.join(f.root, 'outside');
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, 'other.js'), 'unreviewed');
  const link = path.join(f.root, 'client/vendor/link');
  try { fs.symlinkSync(elsewhere, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Host cannot create an isolated symlink'); throw error; }
  assert.match(check(f.root).errors.join('\n'), /Unreviewed symbolic link/);
});
