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
  vm.runInNewContext(read('components/panels/skill-catalog-sync.js'), { window, Promise });
  function fireNext() {
    const entry = timers.entries().next().value;
    if (!entry) throw new Error('no timer scheduled');
    timers.delete(entry[0]);
    entry[1].fn();
    return entry[1].delay;
  }
  return { api: window.SoduWorkSkillCatalogSync, timers, fireNext };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

test('skill selection auto-saves and refreshes the live runtime inventory', async () => {
  const { api, timers, fireNext } = runtime();
  let selected = ['browser-use'];
  let saved = [];
  let runtimeRefreshes = 0;
  const states = [];
  const controller = api.create({
    saveDelay: 350,
    isDirty: () => selected.join() !== saved.join(),
    selection: () => [...selected],
    saveSelection: async (value) => { assert.deepEqual(value, ['browser-use']); },
    onSaved: (value) => { saved = [...value]; },
    refreshRuntime: async () => { runtimeRefreshes += 1; },
    onState: (value) => states.push(value),
  });

  controller.scheduleSave();
  assert.equal(timers.size, 1);
  assert.equal(fireNext(), 350);
  await flush();

  assert.deepEqual(saved, ['browser-use']);
  assert.equal(runtimeRefreshes, 1);
  assert.equal(controller.state().dirty, false);
  assert.equal(controller.state().saving, false);
  assert.ok(states.some((value) => value.saving));
});

test('skill auto-save coalesces a second toggle while the first request is running', async () => {
  const { api, timers, fireNext } = runtime();
  let selected = ['a'];
  let saved = [];
  let releaseFirst;
  const writes = [];
  const controller = api.create({
    saveDelay: 10,
    isDirty: () => selected.join() !== saved.join(),
    selection: () => [...selected],
    saveSelection(value) {
      writes.push([...value]);
      if (writes.length === 1) {
        return new Promise((resolve) => { releaseFirst = resolve; });
      }
      return Promise.resolve();
    },
    onSaved: (value) => { saved = [...value]; },
  });

  controller.scheduleSave();
  fireNext();
  await flush();
  selected = ['a', 'b'];
  controller.scheduleSave();
  fireNext();
  await flush();
  assert.deepEqual(writes, [['a']]);

  releaseFirst();
  await flush();
  assert.equal(timers.size, 1);
  assert.equal(fireNext(), 0);
  await flush();
  assert.deepEqual(writes, [['a'], ['a', 'b']]);
  assert.deepEqual(saved, ['a', 'b']);
});

test('live Skill discovery polls only while the Skill panel is active', async () => {
  const { api, timers, fireNext } = runtime();
  let active = true;
  let refreshes = 0;
  const controller = api.create({
    refreshInterval: 30000,
    isActive: () => active,
    isDirty: () => false,
    refreshCatalog: async () => { refreshes += 1; return { skills: [] }; },
    refreshRuntime: async () => {},
  });

  controller.sync();
  assert.equal(timers.size, 1);
  assert.equal(fireNext(), 30000);
  await flush();
  assert.equal(refreshes, 1);
  assert.equal(timers.size, 1);

  active = false;
  controller.sync();
  assert.equal(timers.size, 0);
});

test('a late discovery response cannot overwrite a newer toggle', async () => {
  const { api, fireNext } = runtime();
  let selected = ['a'], saved = ['a'], finishCatalog;
  let applied = 0;
  const controller = api.create({
    isDirty: () => selected.join() !== saved.join(),
    selection: () => [...selected],
    saveSelection: async () => ({}),
    onSaved: value => { saved = [...value]; },
    refreshCatalog: () => new Promise(resolve => { finishCatalog = resolve; }),
    onRefreshed: () => { applied++; selected = ['a']; },
  });
  const refresh = controller.refresh();
  selected = []; controller.scheduleSave(); fireNext(); await flush();
  finishCatalog({ skills: [{ name: 'a', enabled: true }] });
  assert.equal(await refresh, false);
  assert.equal(applied, 0);
  assert.deepEqual(selected, []);
  assert.deepEqual(saved, []);
});

test('authoritative save result is delivered without discarding a later choice', async () => {
  const { api, fireNext } = runtime();
  let selected = ['a'], saved = [], release;
  const receipts = [];
  const controller = api.create({
    isDirty: () => selected.join() !== saved.join(), selection: () => [...selected],
    saveSelection: () => new Promise(resolve => { release = resolve; }),
    onSaved: (value, result, unchanged) => {
      receipts.push({ value, result, unchanged }); saved = result.enabled;
    },
  });
  controller.scheduleSave(); fireNext();
  selected = ['b']; controller.scheduleSave();
  release({ enabled: [] }); await flush();
  assert.deepEqual(receipts, [{ value: ['a'], result: { enabled: [] }, unchanged: false }]);
  assert.deepEqual(selected, ['b']);
  assert.equal(controller.state().dirty, true);
});

test('both Electron surfaces load the Skill controller before the catalog shell', () => {
  const shell = read('components/panels/panels-capabilities.js');
  const controller = read('components/panels/skill-catalog-sync.js');
  for (const page of ['index.html', 'desk.html']) {
    const html = read(page);
    assert.ok(html.indexOf('skill-catalog-sync.js') >= 0);
    assert.ok(html.indexOf('skill-catalog-sync.js') < html.indexOf('panels-capabilities.js'));
  }
  assert.match(shell, /SoduWorkSkillCatalogSync\.create/);
  assert.match(shell, /skillController\(\)\.scheduleSave\(\)/);
});
