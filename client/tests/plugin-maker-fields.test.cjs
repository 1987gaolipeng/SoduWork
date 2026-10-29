'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');

function fixture(inputs = [], setup = {}) {
  const window = {}, context = vm.createContext({ window });
  for (const file of ['panels-plugin-maker-utils.js', 'panels-plugin-maker-fields.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'components/panels', file), 'utf8'), context, { filename: file });
  }
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', innerHTML: '', listeners: {},
      addEventListener(type, handler) { this.listeners[type] = handler; } });
    return nodes.get(id);
  };
  node('#capSetupTitle').value = setup.title || '';
  node('#capSetupDescription').value = setup.description || '';
  let changes = 0;
  const h = window.SoduWorkPluginMakerUtils.html;
  const fields = window.SoduWorkPluginMakerFields.create({ layer: { querySelector: node }, inputs, setup,
    option: (value, label, selected) => '<option value="' + h(value) + '"' + (value === selected ? ' selected' : '') + '>' + h(label) + '</option>',
    onChange: () => { changes++; } });
  fields.render();
  const edit = (kind, index, field, value) => {
    const target = { value, checked: value, dataset: { [kind === 'input' ? 'inputField' : 'setupField']: field },
      closest: () => ({ dataset: { [kind === 'input' ? 'inputIndex' : 'setupIndex']: String(index) } }) };
    node(kind === 'input' ? '#capInputRows' : '#capSetupRows').listeners.change({ target });
  };
  const remove = (kind, index) => node(kind === 'input' ? '#capInputRows' : '#capSetupRows').listeners.click({ target: {
    closest: () => ({ dataset: { [kind === 'input' ? 'inputRemove' : 'setupRemove']: String(index) } }),
  } });
  return { fields, node, edit, remove, changes: () => changes,
    plain: value => JSON.parse(JSON.stringify(value)) };
}

test('the field component preserves false, zero, aliases, limits and caller-owned drafts', () => {
  const inputs = [{ key: 'enabled', type: 'bool', default: false }, { key: 'count', type: 'number', default: 0 }];
  const setup = { title: ' 偏好 ', preferences: [
    { key: 'group', type: 'multiselect', options: ['one', 'two'], default: ['one'] },
    { key: 'length', type: 'number', minimum: 0, maximum: 5, default: 0 },
  ] };
  const before = JSON.stringify({ inputs, setup }), f = fixture(inputs, setup);
  assert.equal(f.fields.inputs()[0].default, false);
  assert.equal(f.fields.inputs()[1].default, 0);
  assert.equal(f.fields.setup().title, '偏好');
  assert.deepEqual(f.plain(f.fields.setup().preferences[0].default), ['one']);
  assert.equal(f.fields.setup().preferences[1].minimum, 0);
  assert.equal(f.fields.setup().preferences[1].maximum, 5);
  assert.equal(JSON.stringify({ inputs, setup }), before);
});

test('field add, change and remove events invalidate the parent preview and serialize current edits', () => {
  const f = fixture();
  f.node('#capInputAdd').listeners.click();
  f.edit('input', 0, 'type', 'select');
  f.edit('input', 0, 'options', 'brief | 简短\nfull | 完整');
  f.edit('input', 0, 'defaultValue', 'brief');
  assert.deepEqual(f.plain(f.fields.inputs()[0].options), [{ value: 'brief', label: '简短' }, { value: 'full', label: '完整' }]);
  assert.equal(f.fields.inputs()[0].default, 'brief');
  assert.equal(f.changes(), 4);
  assert.match(f.node('#capInputRows').innerHTML, /data-input-field="options"/);
  f.node('#capSetupAdd').listeners.click();
  f.edit('setup', 0, 'type', 'multiselect');
  f.edit('setup', 0, 'options', 'one,two');
  f.edit('setup', 0, 'defaultValue', 'one\ntwo');
  assert.deepEqual(f.plain(f.fields.setup().preferences[0].default), ['one', 'two']);
  f.edit('setup', 0, 'type', 'text');
  assert.equal(f.fields.setup().preferences[0].options, undefined);
  f.remove('input', 0); f.remove('setup', 0);
  assert.deepEqual(f.plain(f.fields.inputs()), []);
  assert.deepEqual(f.plain(f.fields.setup().preferences), []);
  assert.match(f.node('#capInputRows').innerHTML, /没有公开参数/);
});

test('separate maker instances never share edits and rendered field text stays escaped', () => {
  const initial = [{ key: 'text', label: '<img src=x>', default: 'first' }];
  const a = fixture(initial), b = fixture(initial);
  a.edit('input', 0, 'defaultValue', 'changed');
  assert.equal(a.fields.inputs()[0].default, 'changed');
  assert.equal(b.fields.inputs()[0].default, 'first');
  assert.equal(initial[0].default, 'first');
  assert.match(b.node('#capInputRows').innerHTML, /&lt;img src=x&gt;/);
  assert.doesNotMatch(b.node('#capInputRows').innerHTML, /<img/);
  b.node('#capSetupTitle').listeners.input();
  b.node('#capSetupDescription').listeners.input();
  assert.equal(b.changes(), 2);
});

test('both desktop script chains register field editing after helpers and before the maker', () => {
  for (const file of ['desk.html', 'index.html']) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    const scripts = [...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map(match => match[1]);
    const fields = scripts.indexOf('components/panels/panels-plugin-maker-fields.js');
    assert.ok(fields > scripts.indexOf('components/panels/panels-plugin-maker-utils.js'));
    assert.ok(fields < scripts.indexOf('components/panels/panels-plugin-maker.js'));
  }
});
