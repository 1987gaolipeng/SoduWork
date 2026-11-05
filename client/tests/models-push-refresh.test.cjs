'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const settle = () => new Promise(resolve => setImmediate(resolve));
const catalog = revision => ({revision, providers: [{id: 'personal', name: 'Visible provider', personal: true,
  baseUrl: 'https://fixture.invalid/v1', kind: 'openai-compat', authMode: 'key', modelNames: []}], usable: [], myModels: []});

// Execute the real panel, renderer and input handlers against a narrow DOM port.
// These tests do not replace _mdLoad, _mdRender or the push event handler.
function fixture() {
  const listeners = new Map(), requests = [];
  let scope = 'hub/device/alice', writes = 0;
  function element(attrs = {}) {
    const events = new Map(), classes = new Set();
    return { value: attrs.value || '', disabled: false, textContent: '',
      getAttribute: key => attrs[key], setAttribute: (key, value) => { attrs[key] = value; },
      removeAttribute: key => { delete attrs[key]; },
      addEventListener: (type, callback) => events.set(type, callback),
      fire: type => events.get(type)?.(), querySelector: () => null, querySelectorAll: () => [],
      classList: {add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value)} };
  }
  const box = element(), panel = element(), save = element(), retry = element();
  const nodes = new Map([['mdBody', box], ['mdPanel', panel], ['mdSave', save], ['mdRetry', retry]]);
  let html = '', fields = [];
  Object.defineProperty(box, 'innerHTML', {get: () => html, set(value) {
    writes++; html = value;
    fields = [...value.matchAll(/<input\b([^>]+)>/g)].map(match => element(
      Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(attr => [attr[1], attr[2]]))));
  }});
  box.querySelectorAll = selector => {
    const match = /^\[(data-pkey|data-pname|data-purl)(?:="([^"]*)")?\]$/.exec(selector);
    return match ? fields.filter(field => field.getAttribute(match[1]) !== undefined &&
      (match[2] === undefined || field.getAttribute(match[1]) === match[2])) : [];
  };
  box.querySelector = selector => box.querySelectorAll(selector)[0] || null;
  panel.classList.add('show');
  const context = { document: {getElementById: id => nodes.get(id) || null}, URL, structuredClone,
    esc: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'),
    setTimeout, clearTimeout, addEventListener: (name, callback) => listeners.set(name, callback),
    SoduWorkAPI: {taskStorageKey: () => scope, myModels: () => new Promise((resolve, reject) => requests.push({resolve, reject}))} };
  context.window = context;
  vm.createContext(context);
  for (const file of ['model-capabilities.js', 'model-catalog-editor.js', 'panels-models.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels', file), 'utf8'), context, {filename: file});
  }
  return {context, box, save, retry, requests, writes: () => writes, eval: source => vm.runInContext(source, context),
    scope(value) {scope = value;}, async load() {const pending = context._mdLoad(); await settle(); requests.shift().resolve(catalog(1)); await pending;},
    async push() {listeners.get('soduwork-domain-changed')({detail: {domain: 'models'}}); await settle();},
    async reply(value) {const pending = vm.runInContext('_mdRefreshFlight', context); requests.shift().resolve(value); await pending;} };
}

test('a model push retains the visible catalog and credentials typed while its read is pending', async () => {
  const f = fixture(); await f.load(); const html = f.box.innerHTML, writes = f.writes();
  await f.push(); assert.equal(f.box.innerHTML, html); assert.equal(f.writes(), writes);
  const key = f.box.querySelector('[data-pkey="personal"]'); key.value = 'fixture-unsaved-key'; key.fire('input');
  assert.equal(f.save.disabled, false);
  await f.reply(catalog(2));
  assert.equal(f.eval('_mdKeyEdits.personal'), 'fixture-unsaved-key'); assert.equal(key.value, 'fixture-unsaved-key');
  assert.equal(f.eval('_mdData.revision'), 1); assert.equal(f.writes(), writes); assert.equal(f.save.disabled, false);
});

test('a background response cannot overwrite a provider edit made through the real input handler', async () => {
  const f = fixture(); await f.load(); await f.push(); const writes = f.writes();
  const url = f.box.querySelector('[data-purl="personal"]'); url.value = 'https://local-edit.invalid/v1'; url.fire('input');
  await f.reply(catalog(2));
  assert.equal(f.eval('_mdData.providers[0].baseUrl'), url.value); assert.equal(f.eval('_mdDirty'), true);
  assert.equal(f.writes(), writes); assert.equal(f.save.disabled, false);
});

test('a failed or unchanged background read preserves DOM, saved catalog and the ready state', async () => {
  const f = fixture(); await f.load(); const html = f.box.innerHTML, writes = f.writes();
  await f.push(); const failed = f.eval('_mdRefreshFlight'); f.requests.shift().reject(Error('offline')); await failed;
  assert.equal(f.box.innerHTML, html); assert.equal(f.writes(), writes); assert.equal(f.eval('_mdLoadState'), 'ready');
  await f.push(); await f.reply(catalog(1));
  assert.equal(f.box.innerHTML, html); assert.equal(f.writes(), writes);
  await f.push(); await f.reply(catalog(2)); assert.equal(f.eval('_mdData.revision'), 2); assert.equal(f.writes(), writes + 1);
});

test('an account switch, new provider editor or model draft blocks a late background result', async () => {
  for (const action of [f => f.scope('hub/device/bob'), f => f.context._mdAddService(),
    f => f.eval('_mdDrafts.set("personal", {open:true, fields:{model:"unsaved"}})')]) {
    const f = fixture(); await f.load(); await f.push(); action(f); const writes = f.writes();
    await f.reply(catalog(2)); assert.equal(f.eval('_mdData.revision'), 1); assert.equal(f.writes(), writes);
  }
});

test('foreground load failures and the user retry keep their existing visible behavior', async () => {
  const f = fixture(), pending = f.context._mdLoad(); await settle();
  f.requests.shift().reject(Error('offline')); assert.equal(await pending, false);
  assert.match(f.box.innerHTML, /data-md-load-error/); assert.equal(f.eval('_mdLoadState'), 'error');
  const retry = f.retry.fire('click'); await settle(); f.requests.shift().resolve(catalog(3)); await retry;
  assert.equal(f.eval('_mdData.revision'), 3); assert.equal(f.eval('_mdLoadState'), 'ready');
  assert.doesNotMatch(f.box.innerHTML, /data-md-load-error/);
});
