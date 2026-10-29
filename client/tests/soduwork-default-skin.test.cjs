'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const TaskSync = require('../core/task-sync.js');

const root = path.resolve(__dirname, '..');
const cfgKey = 'soduwork_work_cfg_v5';
const sources = ['core/store-lifecycle.js', 'core/store.js', 'core/skin-registry.js',
  'components/skin-manager/skin-model.js'].map(file => fs.readFileSync(path.join(root, file), 'utf8'));

function fixture(saved, api = {}) {
  const values = new Map(saved ? [[cfgKey, JSON.stringify(saved)]] : []);
  const attributes = {}, styles = new Map(), events = [], syncs = [];
  let broadcasts = 0;
  const context = {
    TaskSync, SoduWorkAPI: { ...api, syncConfig: async cfg => { syncs.push(cfg); return true; } },
    console, localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key),
    },
    document: { getElementById: () => null, querySelectorAll: () => [],
      documentElement: { setAttribute: (key, value) => { attributes[key] = value; },
        style: { setProperty: (key, value) => styles.set(key, value), removeProperty: key => styles.delete(key) } } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    WinSync: { pushCfg() { broadcasts++; } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    dispatchEvent: event => events.push(event),
  };
  context.window = context;
  vm.createContext(context);
  sources.forEach(source => vm.runInContext(source, context));
  const run = source => vm.runInContext(source, context);
  return { run, values, attributes, styles, events, syncs,
    Store: run('Store'), apply: () => run('applyTheme()'),
    select: id => run('applySkin(' + JSON.stringify(id) + ')'),
    saved: () => JSON.parse(values.get(cfgKey)), broadcasts: () => broadcasts };
}

test('fresh installs show the new default without queuing a config write', () => {
  const f = fixture();
  f.apply(); f.apply();
  assert.equal(f.Store.cfg.character, 'soduwork');
  assert.equal(f.run('currentSkinId()'), 'soduwork-logo');
  assert.equal(f.attributes['data-character'], 'soduwork');
  assert.equal(f.attributes['data-skin'], 'box');
  assert.equal(f.values.has(cfgKey), false);
  assert.equal(f.Store._cfgRevision, 0);
  assert.equal(f.broadcasts(), 0);
});

for (const [name, saved] of [
  ['previous box default', { character:'box', theme:'vivid', _lastSkinId:'box-biz' }],
  ['previous branded companion', { character:'soduwork', theme:'signature', _lastSkinId:'soduwork-signature' }],
  ['old partial config', { character:'box' }],
]) {
  test(name + ' upgrades once and preserves unrelated preferences and tasks', () => {
    const f = fixture({ ...saved, hubX:123, hubY:456, locale:'en-US', petVisible:false, fontScale:1.2 });
    const cfg = f.Store.cfg, tasks = f.Store.tasks;
    tasks.push({ id:'existing-task', title:'Preserved' });
    f.apply();
    assert.equal(f.Store.cfg, cfg);
    assert.equal(f.Store.tasks, tasks);
    assert.equal(tasks[0].title, 'Preserved');
    assert.equal(cfg._lastSkinId, 'soduwork-logo');
    assert.equal(f.run('currentSkinId()'), 'soduwork-logo');
    assert.equal(cfg.hubX, 123);
    assert.equal(cfg.hubY, 456);
    assert.equal(cfg.locale, 'en-US');
    assert.equal(cfg.petVisible, false);
    assert.equal(cfg.fontScale, 1.2);
    assert.equal(f.saved()._lastSkinId, 'soduwork-logo');
    assert.equal(f.broadcasts(), 1);
    f.apply();
    assert.equal(f.broadcasts(), 1);
    const restart = fixture(f.saved());
    restart.apply();
    assert.equal(restart.Store.cfg._lastSkinId, 'soduwork-logo');
    assert.equal(restart.broadcasts(), 0);
  });
}

for (const saved of [
  { character:'bear', theme:'vivid', _lastSkinId:'bear-vivid' },
  { character:'box', theme:'ruby', _lastSkinId:'box-ruby' },
  { character:'fox', theme:'night', _lastSkinId:'my-custom-fox' },
  { character:'box', theme:'vivid', tube:'neon', _lastSkinId:'box-biz' },
  { character:'box', theme:'vivid', _lastSkinId:'remote-box' },
]) {
  test('preserves selected skin ' + saved._lastSkinId + '/' + (saved.tube || 'glass'), () => {
    const f = fixture(saved);
    f.apply();
    assert.equal(f.Store.cfg._lastSkinId, saved._lastSkinId);
    assert.equal(f.Store.cfg.character, saved.character);
    assert.equal(f.Store.cfg.theme, saved.theme);
    assert.equal(f.broadcasts(), 0);
    assert.equal(f.Store._cfgRevision, 0);
  });
}

test('explicitly selecting a former default persists across restarts', () => {
  for (const id of ['box-biz', 'soduwork-signature']) {
    const f = fixture();
    f.select(id);
    assert.equal(f.Store.cfg._lastSkinId, id);
    assert.equal(f.broadcasts(), 1);
    const restart = fixture(f.saved());
    restart.apply();
    assert.equal(restart.Store.cfg._lastSkinId, id);
    assert.equal(restart.broadcasts(), 0);
    restart.select('soduwork-logo');
    assert.equal(restart.run('currentSkinId()'), 'soduwork-logo');
  }
});

test('a late server default cannot undo an already persisted upgrade', async () => {
  let resolve;
  const response = new Promise(done => { resolve = done; });
  const f = fixture({ character:'box', theme:'vivid', _lastSkinId:'box-biz' }, { getConfig: () => response });
  f.Store._loadConfig(f.Store._cfgRevision);
  const pending = f.Store._configPromise;
  f.apply();
  resolve({ character:'box', _lastSkinId:'box-biz' });
  await pending;
  assert.equal(f.Store.cfg._lastSkinId, 'soduwork-logo');
  assert.equal(f.syncs.at(-1)._lastSkinId, 'soduwork-logo');
});

test('a fresh default allows the server to restore a custom selected skin', async () => {
  const f = fixture(null, { getConfig: async () => ({ character:'bear', theme:'azure', _lastSkinId:'flat-azure-glass' }) });
  f.apply();
  f.Store._loadConfig(f.Store._cfgRevision);
  await f.Store._configPromise;
  f.apply();
  assert.equal(f.run('currentSkinId()'), 'flat-azure-glass');
  assert.equal(f.saved()._lastSkinId, 'flat-azure-glass');
  assert.equal(f.Store._cfgRevision, 0);
  assert.equal(f.broadcasts(), 0);
});

test('a server-restored old default also upgrades and is saved for the next start', async () => {
  const f = fixture(null, { getConfig: async () => ({ character:'box', theme:'vivid', _lastSkinId:'box-biz' }) });
  f.apply();
  f.Store._loadConfig(f.Store._cfgRevision);
  await f.Store._configPromise;
  f.apply();
  assert.equal(f.saved()._lastSkinId, 'soduwork-logo');
  assert.equal(f.broadcasts(), 1);
});
