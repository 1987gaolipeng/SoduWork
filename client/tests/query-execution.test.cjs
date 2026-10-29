'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const policies = require('../main/access-control/policy');

test('Windows queries discover custom Git utilities and reject workspace installations and shadows', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'query-git-discovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'), custom = path.join(root, 'custom-git');
  for (const base of [workspace, custom]) {
    fs.mkdirSync(path.join(base, 'cmd'), { recursive: true });
    fs.mkdirSync(path.join(base, 'usr/bin'), { recursive: true });
    fs.writeFileSync(path.join(base, 'cmd/git.exe'), 'fixture');
    fs.writeFileSync(path.join(base, 'usr/bin/cat.exe'), 'fixture');
  }
  fs.writeFileSync(path.join(workspace, 'cat.exe'), 'shadow');
  const env = { PATH: [workspace, path.join(workspace, 'cmd'), path.join(custom, 'cmd')].join(path.delimiter) };
  const file = path.resolve(__dirname, '../main/access-control/query-execution.js');
  const context = { module: { exports: {} }, require: createRequire(file), process: { platform: 'win32', env } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  const resolve = () => context.module.exports.trustedProgram('cat', workspace, policies.canonical, policies.within);
  assert.equal(resolve(), policies.canonical(path.join(custom, 'usr/bin/cat.exe')));
  fs.unlinkSync(path.join(custom, 'cmd/git.exe'));
  assert.equal(resolve(), '', 'a workspace Git must never grant executable access');
});
