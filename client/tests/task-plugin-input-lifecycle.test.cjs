'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '../components/panels', file), 'utf8');
const plugin = {pluginId: 'report', bindingId: 'report-v1', name: 'Report',
  inputs: [{key: 'audience', type: 'text', required: true}, {key: 'runDate', type: 'text', required: true}]};
const request = () => ({plugin, instruction: 'Create the report'});
const tick = () => new Promise(r => setImmediate(r));
function fixture(options = {}) {
  let account = options.account === undefined ? 'hub-a:user-a' : options.account, host = null;
  const records = new Map(), listeners = new Map(), surfaces = [], opened = [];
  const mounts = [], notices = [], starts = [];
  class Node {
    constructor() {
      this.dataset = {}; this.isConnected = true; this.children = new Map(); this.handlers = new Map();
      this.elements = {audience: {value: ''}, runDate: {value: ''}};
      this.classList = {toggle() {}}; this.html = '';
    }
    set innerHTML(value) { this.html = value; }
    get innerHTML() { return this.html; }
    querySelector(selector) {
      if (!this.children.has(selector)) this.children.set(selector, new Node());
      return this.children.get(selector);
    }
    querySelectorAll() { return []; }
    addEventListener(type, fn) { this.handlers.set(type, fn); }
    focus() {}
    scrollIntoView() {}
  }
  const context = {
    tasks: [{id: 'same', title: 'Report'}, {id: 'other', title: 'Other'}],
    setTimeout: fn => { fn(); return 1; }, clearTimeout() {}, console,
    FormData: class {constructor(form) {this.form = form;} get(key) {return this.form.elements[key]?.value;}},
    localStorage: {setItem: (key, value) => records.set(key, value), getItem: key => records.get(key) || null,
      removeItem: key => records.delete(key)},
    document: {querySelector(selector) {
      if (selector === '.rq-detail-content') return host;
      if (selector === '.rq-detail-materials') return host?.querySelector(selector) || null;
      if (selector === '.rq-detail-content .pis-surface')
        return surfaces.find(row => row.host === host && !row.destroyed)?.root || null;
      return null;
    }},
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    SoduWorkAPI: {taskStorageKey: () => account, startTaskPlugin: async (id, body) => {starts.push({id, body}); return {ok: true};}},
    RequirementAssignment: {scope: () => account, inScope: value => value === account, completed: async () => {}},
    petSay: value => notices.push(value),
    RequirementsDetail: {open: id => {
      opened.push(id);
      if (options.open) return options.open(id);
      setHost(id); return Promise.resolve();
    }},
    PluginUIHost: {mount: cfg => {
      mounts.push(cfg);
      const row = {host: cfg.host, root: new Node(), content: new Node(), destroyed: false,
        destroy() {this.destroyed = true; this.root.isConnected = false;}};
      surfaces.push(row); return row;
    }},
  };
  function setHost(id) { host = id ? new Node() : null; if (host) host.dataset.taskId = id; }
  context.window = context;
  vm.runInNewContext(read('plugin-input-sheet.js'), context);
  vm.runInNewContext(read('panels-forward-options.js'), context);
  const api = context.TaskPluginInput;
  return {context, api, records, surfaces, opened, mounts, notices, starts, setHost,
    submit() {return this.current().content.querySelector('.pis-form').handlers.get('submit')({preventDefault() {}});},
    host: () => host, current: () => surfaces.filter(row => !row.destroyed).at(-1),
    switchAccount(value) {
      account = value;
      for (const fn of listeners.get('soduwork-data-scope-changed') || []) fn({});
    },
    fill(key, value) {
      const form = this.current().content.querySelector('.pis-form');
      form.elements[key].value = value; form.handlers.get('input')();
    },
    values() {
      const controls = this.current().content.querySelector('.pis-form').elements;
      return {audience: controls.audience.value, runDate: controls.runDate.value};
    },
  };
}

test('closing a requirement releases the real PluginInputSheet active handle and keeps its draft', async () => {
  const f = fixture(); f.setHost('same');
  assert.equal(f.api.open('same', request()), true);
  f.fill('audience', 'Team A');
  f.api.suspend('other');
  assert.ok(f.current(), 'another drawer must not close this form');
  f.api.suspend('same');
  assert.equal(f.current(), undefined);
  assert.equal(f.context.PluginInputSheet.close(), false, 'there must be no detached active reference');
  assert.equal(f.api.resume('same'), true);
  assert.equal(f.api.prepare('same', request()).plan.values.audience, 'Team A');
  f.api.suspend('same');
  assert.equal(f.api.resume('same'), true);
  assert.equal(f.api.prepare('same', request()).plan.values.audience, 'Team A');
  f.fill('runDate', '2026-10-03'); await f.submit();
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].id, 'same');
  assert.deepEqual(JSON.parse(JSON.stringify(f.starts[0].body.inputs)), {audience: 'Team A', runDate: '2026-10-03'});
  assert.equal(f.context.PluginInputSheet.close(), false);
});

test('switching account clears in-memory values and never restores the same task ID from another account', () => {
  const f = fixture(); f.setHost('same');
  f.api.open('same', request()); f.fill('audience', 'Private A audience');
  const firstKey = [...f.records.keys()][0];
  assert.ok(firstKey);
  f.switchAccount('hub-a:user-b');
  assert.equal(f.context.PluginInputSheet.close(), false);
  assert.equal(f.api.resume('same'), false);
  f.api.open('same', request());
  assert.equal(f.values().audience, '');
  const secondKey = [...f.records.keys()].find(key => key !== firstKey);
  assert.ok(secondKey, 'different accounts require different persisted draft keys');
  assert.equal(f.records.has(firstKey), true, 'switching accounts must not delete the prior user data');
});

test('an unknown identity cannot persist or restore a task plugin draft', () => {
  const f = fixture({account: ''}); f.setHost('same');
  assert.equal(f.api.queue('same', request()), false);
  assert.equal(f.api.open('same', request()), false);
  assert.equal(f.records.size, 0);
  f.api.suspend('same');
  assert.equal(f.api.resume('same'), false);
});

test('a delayed requirement open cannot attach a form to a different selected requirement', async () => {
  let finish; const pending = new Promise(r => {finish = r;});
  const f = fixture({open: () => pending});
  assert.equal(f.api.open('same', request()), true);
  f.setHost('other'); finish(); await tick();
  assert.equal(f.current(), undefined);
  assert.deepEqual(f.opened, ['same'], 'late resume must not reopen the old requirement');
});

test('a delayed requirement open cannot restore a previous account form', async () => {
  let finish; const pending = new Promise(r => {finish = r;});
  const f = fixture({open: () => pending});
  assert.equal(f.api.open('same', request()), true);
  f.switchAccount('hub-b:user-a'); f.setHost('same'); finish(); await tick();
  assert.equal(f.current(), undefined);
});

test('persisted forms restore only within the same verified account after renderer recreation', () => {
  const first = fixture(); first.setHost('same'); first.api.open('same', request());
  const saved = [...first.records.entries()];
  const second = fixture(); second.setHost('same');
  for (const [key, value] of saved) second.records.set(key, value);
  assert.equal(second.api.resume('same'), true);
  assert.equal(second.current().host, second.host());
});
