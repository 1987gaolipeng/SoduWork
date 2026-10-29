'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function setup() {
  const events = {}, pending = [];
  const window = { SoduWorkPluginCatalogFormat: {}, addEventListener: (name, fn) => { events[name] = fn; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/panels-capability-plugins.js'), 'utf8'), {
    window, SoduWorkAPI: { pluginCatalog: () => new Promise((resolve, reject) => { resolve.reject = reject; pending.push(resolve); }) },
  });
  return { catalog: window.SoduWorkCapabilityPlugins, events, pending };
}
const snapshot = id => ({ items: [{ pluginId: id }], submissions: [], categories: [] });
test('an older plugin catalog cannot overwrite newer permission results', async () => {
  const s = setup();
  const older = s.catalog.load(), newer = s.catalog.load();
  s.pending[1](snapshot('new-grant')); await newer;
  s.pending[0](snapshot('old-denial')); await older;
  assert.equal(s.catalog.snapshot().items[0].pluginId, 'new-grant');
});
test('an account or Hub change clears cached permissions and ignores old identity replies', async () => {
  const s = setup();
  const initial = s.catalog.load(); s.pending[0](snapshot('account-a')); await initial;
  const pending = s.catalog.load();
  s.events['soduwork-data-scope-changed']?.();
  assert.equal(s.catalog.snapshot().items.length, 0);
  const current = s.catalog.load(); s.pending[2](snapshot('account-b')); await current;
  s.pending[1](snapshot('account-a')); await pending;
  assert.equal(s.catalog.snapshot().items[0].pluginId, 'account-b');
});

test('transient failure preserves same-scope catalog, but authorization failure clears it', async () => {
  const s = setup();
  const first = s.catalog.load(); s.pending[0](snapshot('owned')); await first;
  const retry = s.catalog.load(); s.pending[1].reject(Error('offline')); await retry;
  assert.equal(s.catalog.snapshot().items[0].pluginId, 'owned');
  assert.match(s.catalog.snapshot().remoteError, /offline/);
  const denied = s.catalog.load(); s.pending[2].reject(Object.assign(Error('denied'), { status: 403 })); await denied;
  assert.equal(s.catalog.snapshot().items.length, 0);
});

for (const event of ['soduwork-plugin-policy', 'soduwork:plugins-changed']) {
  test(event + ' immediately clears cached entries and fences pending replies', async () => {
    const s = setup();
    const first = s.catalog.load(); s.pending[0](snapshot('old')); await first;
    const stale = s.catalog.load(); s.events[event]();
    assert.equal(s.catalog.snapshot().items.length, 0);
    s.pending[1](snapshot('late')); await stale;
    assert.equal(s.catalog.snapshot().items.length, 0);
  });
}
