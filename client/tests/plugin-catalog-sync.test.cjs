const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function runtime() {
  const timers = new Map();
  let nextTimer = 0;
  const window = {
    setTimeout(fn, delay) {
      const id = ++nextTimer;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(read('components/panels/plugin-catalog-sync.js'), { window, Promise });
  function fireNext() {
    const entry = timers.entries().next().value;
    if (!entry) throw new Error('no timer scheduled');
    timers.delete(entry[0]);
    entry[1].fn();
  }
  return { api: window.SoduWorkPluginCatalogSync, timers, fireNext };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

test('a policy push during an older catalog request refreshes again immediately', async () => {
  const { api } = runtime();
  let release, loads = 0;
  const updates = [];
  const controller = api.create({
    pollWhenIdle: true,
    load: () => ++loads === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve('revoked'),
    revision: value => value,
    onUpdate: value => updates.push(value),
  });
  controller.start('initial');
  const first = controller.refresh();
  await flush();
  controller.refresh({ policy: true, quiet: true });
  release('older-grant');
  await first; await flush();
  assert.equal(loads, 2);
  assert.equal(updates.at(-1), 'revoked');
  controller.stop();
});

test('pending plugin review refreshes quietly and only repaints real changes', async () => {
  const { api, timers, fireNext } = runtime();
  let pending = true;
  let loads = 0;
  let updates = 0;
  const controller = api.create({
    interval: 1500,
    isActive: () => true,
    canRefresh: () => true,
    hasPending: () => pending,
    load: async () => ({ revision: ++loads < 2 ? 'b' : 'b' }),
    revision: (value) => value.revision,
    onUpdate: () => { updates += 1; },
  });
  controller.start({ revision: 'a' });
  assert.equal(timers.size, 1);

  fireNext();
  await flush();
  assert.equal(loads, 1);
  assert.equal(updates, 1);
  assert.equal(timers.size, 1);

  fireNext();
  await flush();
  assert.equal(loads, 2);
  assert.equal(updates, 1);

  pending = false;
  fireNext();
  await flush();
  assert.equal(timers.size, 0);
  controller.stop();
});

test('catalog sync waits while a modal is editing and coalesces manual refreshes', async () => {
  const { api, timers, fireNext } = runtime();
  let blocked = true;
  let loads = 0;
  let resolveLoad;
  const manual = [];
  const controller = api.create({
    interval: 1000,
    isActive: () => true,
    canRefresh: () => !blocked,
    hasPending: () => true,
    load: () => {
      loads += 1;
      return new Promise((resolve) => { resolveLoad = resolve; });
    },
    revision: (value) => value.revision,
    onManualResult: (value, changed) => manual.push([value.revision, changed]),
  });
  controller.start({ revision: 'a' });
  fireNext();
  await flush();
  assert.equal(loads, 0);
  assert.equal(timers.size, 1);

  blocked = false;
  controller.refresh({ manual: true });
  controller.refresh({ manual: true });
  await flush();
  assert.equal(loads, 1);
  resolveLoad({ revision: 'b' });
  await flush();
  assert.deepEqual(manual, [['b', true]]);
  controller.stop();
});

test('catalog sync polls mutable admin categories without pending reviews', async () => {
  const { api, timers, fireNext } = runtime();
  let loads = 0;
  const controller = api.create({
    interval: 1000,
    pollWhenIdle: true,
    isActive: () => true,
    canRefresh: () => true,
    hasPending: () => false,
    load: async () => ({ revision: `category-${++loads}` }),
    revision: (value) => value.revision,
  });
  controller.start({ revision: 'category-0' });
  assert.equal(timers.size, 1);
  fireNext();
  await flush();
  assert.equal(loads, 1);
  assert.equal(timers.size, 1);
  controller.stop();
});

test('both Electron surfaces load the sync controller before the catalog shell', () => {
  const shell = read('components/panels/panels-capabilities.js');
  const catalog = read('components/panels/panels-capability-plugins.js');
  for (const page of ['index.html', 'desk.html']) {
    const html = read(page);
    assert.ok(html.indexOf('plugin-catalog-sync.js') >= 0);
    assert.ok(html.indexOf('plugin-catalog-sync.js') < html.indexOf('<script src="components/panels/panels-capabilities.js"'));
  }
  assert.match(shell, /id="capCatalogRefresh"/);
  assert.match(shell, /canRefresh: catalogCanRefresh/);
  assert.match(shell, /interval: 15000/);
  assert.match(shell, /pollWhenIdle: true/);
  assert.match(catalog, /function hasPendingReview\(\)/);
  assert.match(catalog, /function revision\(value\)/);
});
