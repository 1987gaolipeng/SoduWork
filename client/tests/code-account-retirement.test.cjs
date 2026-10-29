'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function render(git) {
  const box = { innerHTML: '' };
  const context = vm.createContext({
    window: { addEventListener() {} },
    document: { getElementById: () => box },
    esc: value => String(value).replace(/[&<>"']/g, ''),
    console,
  });
  const source = fs.readFileSync(path.join(__dirname, '../components/panels/panels-codeacct.js'), 'utf8');
  vm.runInContext(source, context);
  context.fixtureGit = git;
  vm.runInContext(`_caData = { git: fixtureGit, repos: [] }; _caOpen = 'identity';
    _caBind = () => {}; _caMark = () => {}; _caRender();`, context);
  return box.innerHTML;
}

test('historical Gerrit-only credentials do not offer an active credential tab or ready state', () => {
  const html = render({ name: 'Fixture', email: 'fixture@example.test', gerritTokenSet: true });
  assert.doesNotMatch(html, /data-caopen="gerrit"/);
  assert.doesNotMatch(html, /可以提交/);
  assert.match(html, /待完善/);
  assert.match(html, /data-caopen="token"/);
  assert.match(html, /data-caopen="ssh"/);
});

test('GitLab token and SSH accounts retain the active ready state', () => {
  for (const configured of [{ tokenSet: true }, { keySet: true }]) {
    assert.match(render({ name: 'Fixture', email: 'fixture@example.test', ...configured }), /可以提交/);
  }
});
