'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-shell-docs-'));
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('soduwork-shell-docs-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const script = path.resolve(__dirname, '../scripts/prepare-installer.cjs');
  const module = { exports: {} };
  vm.runInNewContext(await fs.readFile(script, 'utf8') + '\nmodule.exports.copyShellRuntime = copyShellRuntime;',
    { require: createRequire(script), module, __dirname: path.dirname(script), process, console });
  const project = path.join(root, 'project'), output = path.join(root, 'output');
  await fs.mkdir(project); await fs.mkdir(output);
  return { root, project, output, copy: module.exports.copyShellRuntime };
}
async function write(root, relative, text) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, text);
}
const DOC = 'usr/share/gtk-doc/html/p11-kit/index.html';
const LICENSE = 'usr/share/licenses/p11-kit/COPYING';

test('shell packaging removes optional manuals on fresh and cached output, preserving sources, licenses and commands', async t => {
  const f = await fixture(t), source = path.join(f.project, '.runtime/git'), shell = path.join(f.output, 'resources/shell');
  for (const [file, text] of [[DOC, '<html>documentation</html>'], [LICENSE, 'license'], ['bin/bash.exe', 'runtime']]) {
    await write(source, file, text);
  }
  await write(shell, DOC, 'old cached documentation');
  assert.equal(await f.copy(f.project, f.output), 2);
  await assert.rejects(fs.stat(path.join(shell, DOC)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(shell, LICENSE), 'utf8'), 'license');
  assert.equal(await fs.readFile(path.join(shell, 'bin/bash.exe'), 'utf8'), 'runtime');
  assert.equal(await fs.readFile(path.join(source, DOC), 'utf8'), '<html>documentation</html>');
  assert.equal(await f.copy(f.project, f.output), 0);
  const emptyProject = path.join(f.root, 'empty-project'); await fs.mkdir(emptyProject);
  await write(shell, DOC, 'prepackaged documentation');
  assert.equal(await f.copy(emptyProject, f.output), 0);
  await assert.rejects(fs.stat(path.join(shell, DOC)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(shell, LICENSE), 'utf8'), 'license');
});

test('shell documentation cleanup refuses source directories and linked output roots or ancestors', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside'), link = path.join(f.root, 'linked-output');
  await write(outside, 'resources/shell/' + DOC, 'preserve');
  await assert.rejects(f.copy(f.project, f.project), /Unsafe shell documentation output/);
  await fs.symlink(outside, link, 'junction');
  await assert.rejects(f.copy(f.project, link), /Unsafe shell documentation output/);
  await fs.symlink(path.join(outside, 'resources'), path.join(f.output, 'resources'), 'junction');
  await assert.rejects(f.copy(f.project, f.output), /symbolic links/);
  assert.equal(await fs.readFile(path.join(outside, 'resources/shell/' + DOC), 'utf8'), 'preserve');
});
