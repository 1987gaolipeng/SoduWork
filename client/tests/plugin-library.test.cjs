'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = name => fs.readFileSync(path.join(__dirname, '..', 'components', 'panels', name), 'utf8');

function library() {
  const sandbox = { window: { SoduWorkPluginCatalogFormat: { processBadge: () => '' } } };
  vm.createContext(sandbox);
  vm.runInContext(read('panels-capability-directory.js'), sandbox);
  vm.runInContext(read('plugin-presentation.js'), sandbox);
  const model = sandbox.window.SoduWorkPluginPresentation.libraryModel;
  assert.equal(typeof model, 'function', 'the real presentation module exports the library model');
  const evaluate = (catalog, filters = {}, matches = search, stateFor = item => item.fixtureState || 'ready') =>
    model(catalog, filters, matches, stateFor);
  evaluate.presentation = sandbox.window.SoduWorkPluginPresentation;
  return evaluate;
}

function search(item, query) {
  const needle = String(query || '').trim().toLocaleLowerCase();
  return [item.name, item.description, item.key].some(value =>
    String(value || '').toLocaleLowerCase().includes(needle));
}

function ids(items) { return Array.from(items, item => item.pluginId); }
function plain(value) { return JSON.parse(JSON.stringify(value)); }

function fixture() {
  const row = (pluginId, personal, category, fixtureState, name) => ({
    pluginId, personal, installed: !personal, name, description: 'Knowledge and office work',
    enabled: fixtureState !== 'disabled', fixtureState,
    marketPolicy: { configured: true, category },
  });
  return {
    categories: [
      { key: 'research', name: 'Research', enabled: true, sort: 10 },
      { key: 'office', name: 'Office', enabled: true, sort: 20 },
      { key: 'empty', name: 'Empty', enabled: true, sort: 30 },
    ],
    items: [
      row('personal-ready', true, 'research', 'ready', 'Research helper'),
      row('personal-disabled', true, 'office', 'disabled', 'Office helper'),
      row('personal-setup', true, 'research', 'attention', 'Research setup'),
      row('enterprise-ready', false, 'office', 'ready', 'Office team helper'),
      row('enterprise-update', false, 'research', 'attention', 'Research update'),
      row('enterprise-disabled', false, 'research', 'disabled', 'Research paused'),
      { ...row('market-only', false, 'office', 'ready', 'Market helper'), installed: false },
    ],
    submissions: [],
  };
}

test('library lists each managed plugin once, excludes market-only items and keeps disabled plugins', () => {
  const model = library();
  const catalog = fixture();
  catalog.items.push({ ...catalog.items[0] }, { ...catalog.items[3] });
  const before = JSON.stringify(catalog);
  const view = model(catalog);
  assert.deepEqual(ids(view.managed), [
    'personal-ready', 'personal-disabled', 'personal-setup',
    'enterprise-ready', 'enterprise-update', 'enterprise-disabled',
  ]);
  assert.deepEqual(ids(view.items), ids(view.managed));
  assert.deepEqual(plain(view.counts), { all: 6, personal: 3, enterprise: 3 });
  assert.equal(view.source, 'all');
  assert.equal(view.status, 'all');
  assert.equal(view.category, '');
  assert.equal(view.filtered, false);
  assert.equal(JSON.stringify(catalog), before, 'rendering does not mutate the catalog');
});

test('source, category, state and text filters compose without duplicating or dropping eligible plugins', () => {
  const model = library();
  const catalog = fixture();
  const managed = catalog.items.filter(item => item.personal || item.installed);
  for (const source of ['all', 'personal', 'enterprise']) {
    for (const category of ['', 'research', 'office', 'empty']) {
      for (const status of ['all', 'ready', 'attention', 'disabled']) {
        for (const query of ['', 'helper', 'RESEARCH', 'no-match']) {
          const filters = { source, category, status, query };
          const expected = managed.filter(item =>
            (source === 'all' || (source === 'personal' ? item.personal : !item.personal)) &&
            (!category || item.marketPolicy.category === category) &&
            (status === 'all' || item.fixtureState === status) && search(item, query));
          const view = model(catalog, filters);
          assert.deepEqual(ids(view.items), ids(expected), JSON.stringify(filters));
          assert.equal(view.category, category, 'valid category remains selected even with zero results');
          assert.deepEqual(plain(view.counts), { all: 6, personal: 3, enterprise: 3 });
          assert.equal(view.filtered, source !== 'all' || category !== '' || status !== 'all' || query !== '');
        }
      }
    }
  }
});

test('classification is computed from the whole library and remains stable during search or source filtering', () => {
  const model = library();
  const catalog = fixture();
  const baseline = model(catalog);
  const categories = plain(baseline.categories);
  assert.equal(categories.find(row => row.key === 'research').count, 4);
  assert.equal(categories.find(row => row.key === 'office').count, 2);
  assert.equal(categories.find(row => row.key === 'empty').count, 0);
  const filters = { source: 'personal', category: 'office', status: 'ready', query: 'not present' };
  const view = model(catalog, filters);
  assert.deepEqual(plain(view.categories), categories);
  assert.deepEqual(ids(view.items), []);
  assert.equal(view.category, 'office');
  assert.deepEqual(filters, { source: 'personal', category: 'office', status: 'ready', query: 'not present' });
});

test('administrator category renames and disabled-but-used categories preserve stable selection', () => {
  const model = library();
  const catalog = fixture();
  catalog.categories[0] = { ...catalog.categories[0], name: 'New research name', enabled: false };
  const view = model(catalog, { category: 'research' });
  assert.equal(view.category, 'research');
  assert.equal(view.categories.find(row => row.key === 'research').name, 'New research name');
  assert.equal(view.categories.find(row => row.key === 'research').count, 4);
  assert.deepEqual(ids(view.items), ['personal-ready', 'personal-setup', 'enterprise-update', 'enterprise-disabled']);
});

test('a removed or disabled-unused category falls back without corrupting other active filters', () => {
  const model = library();
  const catalog = fixture();
  catalog.categories = catalog.categories.filter(row => row.key !== 'research');
  let view = model(catalog, { source: 'personal', category: 'research', status: 'attention', query: 'setup' });
  assert.equal(view.category, '');
  assert.equal(view.source, 'personal');
  assert.equal(view.status, 'attention');
  assert.deepEqual(ids(view.items), ['personal-setup']);
  catalog.categories.find(row => row.key === 'empty').enabled = false;
  view = model(catalog, { category: 'empty' });
  assert.equal(view.category, '');
  assert.ok(!view.categories.some(row => row.key === 'empty'));
});

test('invalid source and status filters fall back while an empty library remains usable', () => {
  const model = library();
  const view = model({ items: [], categories: [], submissions: [] }, {
    source: 'unknown', category: 'unknown', status: 'unknown', query: '',
  });
  assert.deepEqual(ids(view.managed), []);
  assert.deepEqual(ids(view.items), []);
  assert.deepEqual(plain(view.counts), { all: 0, personal: 0, enterprise: 0 });
  assert.equal(view.source, 'all');
  assert.equal(view.status, 'all');
  assert.equal(view.category, '');
  assert.equal(view.filtered, false);
});

test('duplicate plugin names remain distinct and unsafe-looking IDs or names stay inert data', () => {
  const model = library();
  const name = '<img src=x onerror="globalThis.executed=true">';
  const catalog = {
    categories: [{ key: 'constructor', name: '<svg onload="alert(1)">', enabled: true }],
    items: ['__proto__', 'constructor', 'toString', 'ordinary'].map(pluginId => ({
      pluginId, personal: true, installed: true, name, fixtureState: 'ready',
      marketPolicy: { configured: true, category: 'constructor' },
    })),
  };
  const view = model(catalog, { category: 'constructor', query: name });
  assert.deepEqual(ids(view.items), ['__proto__', 'constructor', 'toString', 'ordinary']);
  assert.equal(view.categories.find(row => row.key === 'constructor').name, catalog.categories[0].name);
  assert.equal(view.items[0].name, name, 'data stays raw until the rendering layer escapes it');
  assert.equal(Object.prototype.executed, undefined);
  assert.equal(model(catalog, { query: '.*' }).items.length, 0, 'search callback treats metacharacters as literal text');
});

test('search and availability decisions use the supplied capability callbacks', () => {
  const model = library();
  const catalog = fixture();
  const calls = [];
  const view = model(catalog, { status: 'attention', query: 'connector' }, (item, query) => {
    calls.push({ id: item.pluginId, query });
    return item.pluginId === 'enterprise-ready';
  }, item => item.pluginId === 'enterprise-ready' ? 'attention' : 'ready');
  assert.deepEqual(ids(view.items), ['enterprise-ready'], 'a connection issue overrides apparently-ready metadata');
  assert.ok(calls.some(row => row.id === 'enterprise-ready' && row.query === 'connector'));
  assert.ok(calls.every(row => row.id !== 'market-only'), 'uninstalled market plugins do not enter the library');
});

test('real plugin page keeps disabled plugins filterable when updates, setup or connections also need attention', async () => {
  const row = (pluginId, values = {}) => ({ pluginId, name: pluginId, installed: true, enabled: true, ...values });
  const catalog = { items: [
    row('disabled-update', { enabled: false, updateAvailable: true }),
    row('disabled-connection', { enabled: false, dependencyReadiness: { missingMcp: ['crm'] } }),
    row('disabled-setup', { enabled: false, setupState: 'needs_setup' }),
    row('default-disabled-update', { installationState: 'default_disabled', updateAvailable: true }),
    row('default-disabled-connection', { installationState: 'default_disabled', dependencyReadiness: { missingMcp: ['crm'] } }),
    row('default-disabled-setup', { installationState: 'default_disabled', setupState: 'needs_setup' }),
    row('personal-disabled-setup', { personal: true, enabled: false, setupState: 'needs_setup' }),
    row('enabled-update', { updateAvailable: true }),
    row('enabled-connection', { dependencyReadiness: { missingMcp: ['crm'] } }),
    row('enabled-setup', { setupState: 'needs_setup' }),
    row('enabled-ready'),
  ], categories: [], submissions: [] };
  const sandbox = { window: {}, document: { activeElement: null },
    SoduWorkAPI: { pluginCatalog: async () => catalog } };
  vm.createContext(sandbox);
  for (const file of ['plugin-catalog-format.js', 'plugin-dependency-ux.js', 'plugin-lifecycle.js',
    'panels-capability-directory.js', 'plugin-presentation.js', 'panels-capability-plugins.js']) {
    vm.runInContext(read(file), sandbox, { filename: file });
  }
  const realModel = sandbox.window.SoduWorkPluginPresentation.libraryModel;
  let currentView;
  sandbox.window.SoduWorkPluginPresentation.libraryModel = (...args) => {
    currentView = realModel(...args); return currentView;
  };
  const listeners = new Map();
  const statusControl = { addEventListener: (event, handler) => listeners.set(event, handler) };
  const content = { innerHTML: '', scrollTop: 0, contains: () => false,
    querySelector: selector => selector === '#capPluginStatus' ? statusControl : null,
    querySelectorAll: () => [] };
  const panel = sandbox.window.SoduWorkCapabilityPlugins;
  await panel.load();
  panel.render(content, '', {});
  const selectStatus = value => listeners.get('change')({ target: { value } });
  selectStatus('disabled');
  assert.deepEqual(ids(currentView.items), catalog.items.slice(0, 7).map(item => item.pluginId));
  selectStatus('attention');
  assert.deepEqual(ids(currentView.items), ['enabled-update', 'enabled-connection', 'enabled-setup']);
  selectStatus('ready');
  assert.deepEqual(ids(currentView.items), ['enabled-ready']);
  selectStatus('all');
  assert.equal(currentView.items.length, catalog.items.length);
  assert.deepEqual(plain(currentView.counts), { all: 11, personal: 1, enterprise: 10 });

  const { SoduWorkPluginDependencies: dependencies, SoduWorkPluginLifecycle: lifecycle } = sandbox.window;
  for (const [pluginId, expected] of [
    ['disabled-update', 'upgrade'], ['disabled-connection', 'connect'], ['disabled-setup', 'setup'],
  ]) {
    const item = catalog.items.find(candidate => candidate.pluginId === pluginId);
    assert.equal(lifecycle.resolve(item, dependencies.state(item)).code, expected,
      'library filtering must preserve the detailed lifecycle and recovery action');
  }
});

test('filter markup escapes category names and attribute values without changing their identities', () => {
  const model = library();
  const key = 'research" onfocus="alert(1)';
  const categoryName = '<img src=x onerror="alert(2)">';
  const catalog = { categories: [{ key, name: categoryName, enabled: true }], items: [{
    pluginId: 'one', personal: true, name: 'One', marketPolicy: { configured: true, category: key },
  }] };
  const view = model(catalog, { category: key });
  const html = model.presentation.libraryToolbar(view, []);
  assert.equal(view.category, key, 'the data identity is preserved');
  assert.ok(html.includes('value="research&quot; onfocus=&quot;alert(1)" selected'));
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(2)&quot;&gt;'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes(' onfocus="'));
});

function publicationFixture() {
  const elements = new Map();
  const events = [];
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const listeners = new Map();
    const node = {
      id, innerHTML: '', value: '', dataset: {}, listeners,
      classList: { add() {}, contains: () => false },
      addEventListener: (name, handler) => listeners.set(name, handler),
      setAttribute() {}, focus: () => events.push(['focus', id]),
      querySelector: selector => element(selector),
      querySelectorAll: selector => selector === '[data-submission]'
        ? Array.from(node.innerHTML.matchAll(/data-submission="([^"]+)"/g), match => {
          const button = element('record:' + match[1]);
          button.dataset.submission = match[1];
          return button;
        }) : [],
    };
    elements.set(id, node);
    return node;
  }
  const layer = element('layer');
  const owner = element('capPluginSubmissions');
  const sandbox = {
    window: {}, AbortController,
    document: { activeElement: owner, getElementById: id => element(id) },
  };
  vm.createContext(sandbox);
  vm.runInContext(read('plugin-publication-ux.js'), sandbox);
  vm.runInContext(read('plugin-presentation.js'), sandbox);
  const ctx = {
    openModal(title, subtitle, body) { events.push(['open', title]); layer.innerHTML = body; return layer; },
    closeModal() { layer.hidden = true; events.push(['close']); },
  };
  const open = rows => sandbox.window.SoduWorkPluginPresentation.records(rows, ctx,
    () => ['Reviewing', 'pending'], (item, recordContext, back) => events.push(['detail', item, recordContext, back]));
  return { open, element, events };
}

test('publication records include all submissions and preserve search when returning from a late record', () => {
  const fixture = publicationFixture();
  const rows = Array.from({ length: 8 }, (_, index) => ({
    pluginId: 'record-' + index, name: 'Research ' + index, version: '1.0.' + index,
    trustState: 'pending', reviewNote: index === 7 ? 'Need citation evidence' : '',
  }));
  fixture.open(rows);
  const list = fixture.element('#capRecordList');
  assert.equal(list.querySelectorAll('[data-submission]').length, 8);
  const search = fixture.element('#capRecordSearch');
  search.value = 'CITATION'; search.listeners.get('input')();
  const shown = list.querySelectorAll('[data-submission]');
  assert.equal(shown.length, 1);
  assert.equal(shown[0].dataset.submission, 'record-7');
  shown[0].listeners.get('click')();
  const detail = fixture.events.find(event => event[0] === 'detail');
  assert.equal(detail[1], rows[7], 'clicking the eighth record opens that exact submission');
  detail[3]();
  assert.equal(list.querySelectorAll('[data-submission]').length, 1, 'back navigation retains the query');
  assert.ok(fixture.element('layer').innerHTML.includes('value="CITATION"'));
  detail[2].closeModal();
  assert.deepEqual(fixture.events.at(-1), ['focus', 'capPluginSubmissions']);
});

test('publication records show distinct empty states and escape plugin and review content', () => {
  const fixture = publicationFixture();
  fixture.open([]);
  const list = fixture.element('#capRecordList');
  assert.ok(list.innerHTML.includes('还没有提交申请'));
  fixture.open([{
    pluginId: 'unsafe-id" onmouseover="alert(1)', name: '<img src=x onerror="alert(2)">',
    version: '<svg>', reviewNote: '<script>alert(3)</script>', trustState: 'pending',
  }]);
  assert.ok(list.innerHTML.includes('unsafe-id&quot; onmouseover=&quot;alert(1)'));
  assert.ok(list.innerHTML.includes('&lt;img src=x onerror=&quot;alert(2)&quot;&gt;'));
  assert.ok(list.innerHTML.includes('&lt;script&gt;alert(3)&lt;/script&gt;'));
  assert.ok(!/<img|<script|onmouseover="/.test(list.innerHTML));
  const search = fixture.element('#capRecordSearch');
  search.value = 'missing'; search.listeners.get('input')();
  assert.ok(list.innerHTML.includes('没有匹配的申请'));
});
