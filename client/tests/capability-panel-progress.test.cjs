'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../components/panels/panels-capabilities.js'), 'utf8');

function setup(capabilities) {
  const listeners = new Map();
  const context = {
    window: { addEventListener: (name, fn) => listeners.set(name, fn) },
    document: { getElementById: () => null },
    SoduWorkSkillCatalogSync: { runtimeApi: () => ({ capabilities }), runtimeMap: rows => new Map(rows) },
  };
  vm.runInNewContext(source.replace('  window.openSkillPanel =', `
    window.fixture = {
      refreshRuntime, inventory: () => Array.from(runtimeSkills.keys()),
      renderEmptySkills(content) { data = { skills: [] }; renderSkills(content); }
    };
    window.openSkillPanel =`), context);
  return { api: context.window.fixture, listeners };
}

test('skills renders a section with a real zero even before the runner replies', () => {
  const { api } = setup();
  const content = { querySelectorAll: () => [] };
  api.renderEmptySkills(content);
  assert.match(content.innerHTML, /可用技能/);
  assert.match(content.innerHTML, /<em>0 项<\/em>/);
});

test('a slow initial runtime response cannot overwrite a newer forced refresh', async () => {
  let finishInitial;
  const { api } = setup(options => options?.force
    ? Promise.resolve([['new', {}]])
    : new Promise(resolve => { finishInitial = resolve; }));
  const initial = api.refreshRuntime(false);
  await api.refreshRuntime(true);
  finishInitial([['old', {}]]);
  await initial;
  assert.deepEqual(Array.from(api.inventory()), ['new']);
});

test('switching scope discards an outstanding runtime response', async () => {
  let finish;
  const { api, listeners } = setup(() => new Promise(resolve => { finish = resolve; }));
  const pending = api.refreshRuntime(true);
  listeners.get('soduwork-data-scope-changed')();
  finish([['old-account', {}]]);
  await pending;
  assert.deepEqual(Array.from(api.inventory()), []);
});
