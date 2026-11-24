'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/chat-composer-controls.js'), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function clock() {
  let next = 0;
  const timers = new Map();
  return { setTimeout: callback => { const id = ++next; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
    expire() { for (const [id, callback] of [...timers]) if (timers.delete(id)) callback(); } };
}
function timeline() {
  let now = 0, next = 0;
  const timers = new Map();
  class FakeDate extends Date { static now() { return now; } }
  return {
    Date: FakeDate,
    setTimeout(callback, delay) { const id = ++next; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout: id => timers.delete(id),
    pending: () => timers.size,
    async advance(milliseconds) {
      const end = now + milliseconds;
      for (;;) {
        const first = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!first) break;
        const [id, timer] = first; timers.delete(id); now = timer.at; timer.callback(); await tick();
      }
      now = end; await tick();
    },
  };
}
function fixture(settings = {}) {
  let owner = 'hub/device/alice', changed;
  const node = () => ({ hidden: true, dataset: {}, style: {}, handlers: new Map(), innerHTML: '', textContent: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, callback) { this.handlers.set(type, callback); },
    setAttribute() {}, removeAttribute() {}, focus() {}, contains: () => false, querySelector: () => null,
    getBoundingClientRect: () => ({ left: 200, right: 300, top: 500 }) });
  const queue = node(), pop = node(), button = node(), label = node(), wrap = node(), el = node(), field = node(), search = node();
  search.value = '';
  let markup = '';
  Object.defineProperty(pop, 'innerHTML', { get: () => markup, set(value) {
    markup = value;
    field.innerHTML = value.match(/<div class="nmodel-options"[^>]*>([\s\S]*?)<\/div>/)?.[1] || '';
  } });
  pop.querySelector = selector => selector === '.nmodel-options' ? field :
    ['input', '[data-model-search]'].includes(selector) ? search : null;
  pop.querySelectorAll = () => [];
  button.querySelector = () => label;
  wrap.querySelector = selector => selector === 'button' ? button : selector === '.nmodel-pop' ? pop : null;
  el.querySelector = selector => selector === '#nchatQueue' ? queue : selector === '#nchatModel' ? wrap : null;
  const state = { ref: 'chat', adapterId: 'qwen', model: { id: 'selected', label: 'Selected' } };
  const requests = [], calls = [], selections = [], runtimeCalls = [], statuses = [];
  const window = { ...node(), innerWidth: 1000, innerHeight: 800, SoduWorkModelChoice: require('../core/model-choice'),
    setTimeout: settings.clock?.setTimeout || setTimeout, clearTimeout: settings.clock?.clearTimeout || clearTimeout,
    SoduWorkAPI: { taskStorageKey: () => owner, myModels: () => { const item = deferred(); requests.push(item); return item.promise; } },
    soduWorkAPI: { conversationSession: {
      runtimes: async options => { runtimeCalls.push(options); return settings.runtimes ? settings.runtimes(options) : ({ ok: true, runtimes: [{ id: 'pi', modelMode: 'managed' }, { id: 'qwen', modelMode: 'managed' }, { id: 'codex', modelMode: 'account' }] }); },
      runtimeModels: async id => { calls.push(id); return { models: [{ id: 'account-choice' }] }; },
      selectModel: async (ref, name) => { selections.push({ ref, name });
        if (settings.selectModel) return settings.selectModel(ref, name);
        return { ok: true, selection: { name, model: { id: name, label: name } } }; },
      onModelsChanged: fn => { changed = fn; return () => {}; },
    } } };
  if (settings.runtimeWait) window.ChatRuntimePicker = { create: () => ({
    render() {}, wait: settings.runtimeWait, reset() {}, destroy() {},
  }) };
  vm.runInNewContext(source, { window, SoduWorkModelChoice: window.SoduWorkModelChoice, document: node(), AbortController, Date: settings.clock?.Date || Date });
  const controls = window.ChatComposerControls.create(el, { state: () => state, say() {},
    catalogChanged: status => statuses.push(status),
    modelSelected: selection => { state.selection = selection; },
    modelAvailabilityChanged: selection => { state.selection = selection; } }); controls.render();
  return { state, requests, calls, selections, field, label, controls, pop, search, runtimeCalls, statuses, changed: () => changed(),
    owner: value => { owner = value; controls.render(); },
    open: () => button.handlers.get('click')(),
    retry: () => pop.handlers.get('click')({ target: {
      closest: selector => selector === '[data-model-retry]' ? node() : null,
    }, preventDefault() {}, stopPropagation() {} }),
  };
}
const catalog = { usable: [{ name: 'managed', label: 'Managed choice' }, { name: 'local:private', localOnly: true, label: 'Private choice' }] };

test('existing local managed conversations show both model sources while committed cloud conversations exclude device models', async () => {
  for (const cloud of [false, true]) {
    const f = fixture(); if (cloud) f.state.cloudHandoff = { phase: 'committed' };
    f.controls.render();
    const pending = f.open(); await tick(); f.requests[0].resolve(catalog); await pending;
    assert.match(f.field.innerHTML, /Managed choice/);
    assert.equal(f.field.innerHTML.includes('Private choice'), !cloud);
  }
});

for (const id of ['codex']) test('existing ' + id + ' conversations query only the account catalog', async () => {
  const f = fixture(); f.state.adapterId = id;
  f.controls.render();
  await f.open(); assert.deepEqual(f.calls, [id]); assert.equal(f.requests.length, 0);
  assert.match(f.field.innerHTML, /account-choice/);
  assert.doesNotMatch(f.field.innerHTML, /Private choice|Managed choice/);
});

test('late existing-chat model catalogs cannot overwrite a newer directory or another account', async () => {
  const f = fixture(); const first = f.open(); await tick(); f.changed(); await tick();
  f.requests[1].resolve({ usable: [{ name: 'fresh', label: 'Fresh' }] }); await tick();
  f.requests[0].resolve({ usable: [{ name: 'old', label: 'Old' }] }); await first;
  assert.match(f.field.innerHTML, /Fresh/); assert.doesNotMatch(f.field.innerHTML, />Old</);
  f.changed(); await tick(); f.owner('hub/device/bob');
  f.requests[2].resolve({ usable: [{ name: 'alice-private', label: 'Alice private' }] }); await tick();
  assert.doesNotMatch(f.field.innerHTML, /Alice private/);
  assert.equal(f.label.textContent, 'fresh');
});

test('a confirmed local model deletion selects the first usable replacement but storage failure does not', async () => {
  const f = fixture(); f.state.selection = { name: 'local:private', model: { id: 'local:private', label: 'Private model', localOnly: true } };
  const opened = f.open(); await tick(); f.requests[0].resolve(catalog); await opened;
  assert.equal(f.state.selection.model.unavailable, undefined);
  f.changed(); await tick(); f.requests[1].reject(Error('Secure storage unavailable')); await tick();
  assert.equal(f.state.selection.model.unavailable, undefined, 'a failed lookup is not a deletion');
  f.changed(); await tick(); f.requests[2].resolve({ usable: [{ name: 'managed', label: 'Hub default' }] }); await tick();
  assert.equal(f.state.selection.name, 'managed');
  assert.equal(f.state.selection.model.unavailable, undefined);
  assert.deepEqual(f.selections, [{ ref: 'chat', name: 'managed' }]);
  assert.equal(f.label.textContent, 'Hub default');
});

test('a catalog requested before an explicit model change cannot invalidate the new selection', async () => {
  const f = fixture(); f.state.selection = { name: 'local:old', model: { id: 'local:old', label: 'Old model' } };
  const opened = f.open(); await tick();
  f.state.selection = { name: 'local:new', model: { id: 'local:new', label: 'New model' } };
  f.requests[0].resolve({ usable: [{ name: 'managed', label: 'Hub model' }] }); await opened;
  assert.equal(f.state.selection.name, 'local:new');
  assert.equal(f.state.selection.model.unavailable, undefined);
  assert.equal(f.label.textContent, 'New model');
});

test('removing an active local image model selects an available replacement through normal IPC', async () => {
  const f = fixture(), reference = 'local:model-0123456789abcdef0123456789abcdef';
  const choice = 'image::private::' + reference;
  f.state.adapterId = 'pi';
  f.state.selection = { name: choice, model: { id: reference, label: 'Private image', modality: 'image', localOnly: true } };
  const opened = f.open(); await tick();
  f.requests[0].resolve({ usable: [], mediaUsable: { image: [{ providerId: 'device:private', name: reference, label: 'Private image', localOnly: true }] } });
  await opened;
  assert.equal(f.state.selection.model.unavailable, undefined);
  f.changed(); await tick(); f.requests[1].resolve({ usable: [{ name: 'managed', label: 'Hub model' }], mediaUsable: { image: [] } }); await tick();
  assert.equal(f.state.selection.name, 'managed');
  assert.equal(f.state.selection.model.id, 'managed');
  assert.equal(f.state.selection.model.unavailable, undefined);
  assert.equal(f.label.textContent, 'Hub model');
});

test('sending refreshes the directory and replaces a removed choice with the first local model', async () => {
  const f = fixture();
  f.state.selection = { name: 'managed', model: { id: 'managed', label: 'Managed' } };
  const opened = f.open(); await tick(); f.requests[0].resolve(catalog); await opened;
  assert.deepEqual(f.selections, [], 'A valid current choice stays selected');
  const ready = f.controls.waitForAccess(); await tick();
  f.requests[1].resolve({ usable: [{ name: 'hub-other' }, { name: 'local:first', localOnly: true },
    { name: 'local:second', localOnly: true }] });
  assert.equal(await ready, true);
  assert.deepEqual(f.selections, [{ ref: 'chat', name: 'local:first' }]);
  assert.equal(f.state.selection.name, 'local:first');
});

test('an existing conversation without a selected model chooses the first local row instead of a Hub default', async () => {
  const f = fixture(); f.state.model = null; f.state.selection = { name: '' };
  const pending = f.controls.waitForAccess(); await tick();
  f.requests[0].resolve({ usable: [{ name: 'hub' }, { name: 'local:first', localOnly: true },
    { name: 'local:second', localOnly: true }], defaultModels: { qwen: 'hub' } });
  assert.equal(await pending, true);
  assert.equal(f.state.selection.name, 'local:first');
  assert.deepEqual(f.selections, [{ ref: 'chat', name: 'local:first' }]);
});

test('rendering a restored conversation without a model displays its first available model before Send', async () => {
  const f = fixture(); f.state.model = null; f.state.selection = { name: '' }; f.controls.render(); await tick();
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve(catalog); await tick();
  assert.equal(f.state.selection.name, 'local:private');
  assert.equal(f.label.textContent, 'Private choice');
});

test('partial and rejected catalogs preserve an absent Hub choice while local offline choices remain available', async () => {
  const f = fixture(); f.state.selection = { name: 'hub', model: { id: 'hub', label: 'Hub' } };
  const partial = { usable: [{ name: 'local:first', localOnly: true }], managedCatalogUnavailable: true };
  let pending = f.controls.waitForAccess(); await tick(); f.requests[0].resolve(partial);
  await assert.rejects(pending, { code: 'MODEL_CATALOG_UNAVAILABLE' }); assert.equal(f.state.selection.name, 'hub'); assert.deepEqual(f.selections, []);
  pending = f.controls.waitForAccess(); await tick(); f.requests[1].resolve({ ok: false, usable: partial.usable });
  await assert.rejects(pending, { code: 'MODEL_CATALOG_UNAVAILABLE' }); assert.equal(f.state.selection.name, 'hub'); assert.deepEqual(f.selections, []);
  f.state.selection = { name: 'local:first', model: { id: 'local:first' } };
  pending = f.controls.waitForAccess(); await tick(); f.requests[2].resolve(partial);
  assert.equal(await pending, true); assert.deepEqual(f.selections, []);
  f.state.selection = { name: '' }; f.state.model = null;
  pending = f.controls.waitForAccess(); await tick(); f.requests[3].resolve(partial);
  assert.equal(await pending, true); assert.equal(f.state.selection.name, 'local:first');
});

test('a same-scope directory refresh preserves the pending IPC acknowledgement and revalidates before send readiness', async () => {
  const request = deferred(), f = fixture({ selectModel: () => request.promise });
  const pending = f.controls.waitForAccess(); await tick(); f.requests[0].resolve(catalog); await tick();
  f.changed(); await tick(); f.requests[1].resolve(catalog); await tick();
  request.resolve({ ok: true, selection: { name: 'local:private', model: { id: 'local:private' } } });
  await tick();
  assert.equal(f.requests.length, 3);
  f.requests[2].resolve(catalog);
  assert.equal(await pending, true);
  assert.equal(f.state.selection.name, 'local:private');
  assert.equal(f.selections.length, 1);
});

test('a delayed automatic choice cannot overwrite a newer explicit choice or a different owner', async () => {
  for (const changeOwner of [false, true]) {
    const request = deferred(), f = fixture({ selectModel: () => request.promise });
    const pending = f.controls.waitForAccess(); await tick(); f.requests[0].resolve(catalog); await tick();
    f.state.selection = { name: 'new-choice', model: { id: 'new-choice' } };
    if (changeOwner) f.owner('hub/device/bob');
    request.resolve({ ok: true, selection: { name: 'local:private', model: { id: 'local:private' } } });
    if (changeOwner) assert.equal(await pending, false);
    else await assert.rejects(pending, { code: 'MODEL_SELECTION_FAILED' });
    assert.equal(f.state.selection.name, 'new-choice');
  }
});

test('sending fails closed on a storage error and an empty confirmed catalog without changing the saved choice', async () => {
  const f = fixture();
  f.state.selection = { name: 'local:private', model: { id: 'local:private', label: 'Private' } };
  const failed = f.controls.waitForAccess(); await tick(); f.requests[0].reject(Error('Secure storage unavailable'));
  await assert.rejects(failed, { code: 'MODEL_CATALOG_UNAVAILABLE' }); assert.deepEqual(f.selections, []);
  assert.equal(f.state.selection.name, 'local:private');
  const empty = f.controls.waitForAccess(); await tick(); f.requests[1].resolve({ usable: [] });
  await assert.rejects(empty, { code: 'MODEL_UNAVAILABLE' }); assert.deepEqual(f.selections, []);
  assert.equal(f.state.selection.model.unavailable, true);
  const restored = f.controls.waitForAccess(); await tick();
  f.requests[2].resolve({ usable: [{ name: 'local:first' }, { name: 'local:private', localOnly: true }] });
  assert.equal(await restored, true);
  assert.equal(f.state.selection.name, 'local:private', 'A restored current model stays selected even when it is not first');
  assert.equal(f.state.selection.model.unavailable, undefined);
  assert.deepEqual(f.selections, [{ ref: 'chat', name: 'local:private' }]);
});

test('concurrent send checks and an opened picker share one live catalog read', async () => {
  const f = fixture();
  const opened = f.open(), first = f.controls.waitForAccess(), second = f.controls.waitForAccess();
  await tick();
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve({ usable: [{ name: 'selected' }] });
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  await opened;
  assert.deepEqual(f.selections, []);
});

test('a model-change push wakes send admission and only the newer catalog can select a replacement', async () => {
  const f = fixture();
  const pending = f.controls.waitForAccess(); await tick();
  f.changed(); await tick();
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve({ usable: [{ name: 'selected', label: 'Latest choice' }] });
  assert.equal(await pending, true, 'The superseded response need not settle before the current catalog admits Send');
  f.requests[0].resolve({ usable: [{ name: 'local:obsolete', localOnly: true }] }); await tick();
  assert.deepEqual(f.selections, []);
  assert.equal(f.label.textContent, 'Latest choice');
});

test('closing a picker does not invalidate a same-conversation send catalog read', async () => {
  const f = fixture();
  const opened = f.open(); await tick();
  await f.open();
  const pending = f.controls.waitForAccess(); await tick();
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve({ usable: [{ name: 'selected' }] });
  assert.equal(await pending, true); await opened;
  assert.deepEqual(f.selections, []);
});

test('exhausted runtime discovery ignores late responses and a later send can retry', async () => {
  const time = timeline(), runtime = deferred();
  const f = fixture({ clock: time, runtimes: () => runtime.promise });
  const pending = f.controls.waitForAccess();
  const rejected = assert.rejects(pending, { code: 'MODEL_CATALOG_TIMEOUT', message: /读取模型列表超时/ });
  await tick(); await time.advance(24000); await rejected;
  assert.equal(f.requests.length, 0);
  runtime.resolve({ ok: true, runtimes: [{ id: 'qwen', modelMode: 'managed' }] }); await tick();
  assert.equal(f.requests.length, 0); assert.deepEqual(f.selections, []);
  const retry = f.controls.waitForAccess(); await tick();
  f.requests[0].resolve({ usable: [{ name: 'selected' }] });
  assert.equal(await retry, true);
});

test('timed-out model discovery cannot apply a late replacement and a later send can retry', async () => {
  const time = clock(), f = fixture({ clock: time });
  const pending = f.controls.waitForAccess();
  const rejected = assert.rejects(pending, { code: 'MODEL_CATALOG_TIMEOUT', message: /输入已保留/ });
  await tick(); time.expire(); await rejected;
  assert.deepEqual(f.selections, []);
  f.requests[0].resolve({ usable: [{ name: 'local:late', localOnly: true }] }); await tick();
  assert.deepEqual(f.selections, []); assert.equal(f.state.model.id, 'selected');
  const retry = f.controls.waitForAccess(); await tick();
  f.requests[1].resolve({ usable: [{ name: 'selected' }] });
  assert.equal(await retry, true);
});

test('selection timeout retains the in-flight mutation and requires its acknowledgement before retry admission', async () => {
  const time = clock(), selection = deferred(), f = fixture({ clock: time, selectModel: () => selection.promise });
  const pending = f.controls.waitForAccess();
  const rejected = assert.rejects(pending, { code: 'MODEL_SELECTION_UNCONFIRMED', message: /仍在确认中/ });
  await tick(); f.requests[0].resolve({ usable: [{ name: 'local:replacement', localOnly: true }] }); await tick();
  assert.equal(f.selections.length, 1);
  time.expire(); await rejected;
  assert.equal(f.state.model.id, 'selected'); assert.equal(f.state.selection, undefined);
  let ready = false;
  const retry = f.controls.waitForAccess().then(value => { ready = value; return value; }); await tick();
  assert.equal(ready, false); assert.equal(f.requests.length, 1); assert.equal(f.selections.length, 1);
  selection.resolve({ ok: true, selection: { name: 'local:replacement', model: { id: 'local:replacement' } } }); await tick();
  assert.equal(f.state.selection.name, 'local:replacement', 'An authoritative late ACK still describes the committed selection');
  assert.equal(f.requests.length, 2); assert.equal(ready, false);
  f.requests[1].resolve({ usable: [{ name: 'local:replacement', localOnly: true }] });
  assert.equal(await retry, true); assert.equal(f.selections.length, 1);
});

test('catalog failures are actionable when the picker is closed without exposing provider diagnostics', async () => {
  const f = fixture();
  const pending = f.controls.waitForAccess();
  const rejected = assert.rejects(pending, error => {
    assert.equal(error.code, 'MODEL_CATALOG_UNAVAILABLE');
    assert.match(error.message, /检查连接或模型配置/);
    assert.doesNotMatch(error.message, /private-endpoint|synthetic-provider-key/);
    return true;
  });
  await tick();
  f.requests[0].reject(Object.assign(Error('private-endpoint synthetic-provider-key'), { code: 'MODEL_INTERNAL' }));
  await rejected;
  assert.deepEqual(f.selections, []); assert.equal(f.state.model.id, 'selected');
});

test('sending during a background automatic selection surfaces its failure instead of silently returning false', async () => {
  for (const superseded of [false, true]) {
    const selection = deferred(), f = fixture({ selectModel: () => selection.promise });
    f.changed(); await tick(); f.requests[0].resolve({ usable: [{ name: 'local:replacement', localOnly: true }] }); await tick();
    const pending = f.controls.waitForAccess();
    const rejected = assert.rejects(pending, { code: 'MODEL_SELECTION_FAILED', message: /模型切换未能确认/ });
    await tick();
    if (superseded) {
      f.changed(); await tick(); f.requests[1].resolve({ usable: [{ name: 'selected' }] }); await tick();
    }
    selection.resolve({ ok: false, reason: 'private provider diagnostic' }); await rejected;
    assert.equal(f.state.selection, undefined); assert.equal(f.selections.length, 1);
  }
});

test('a destroyed composer cannot release send admission after a delayed execution-option acknowledgement', async () => {
  for (const adapterId of ['qwen', 'codex']) {
    const runtime = deferred(), f = fixture({ runtimeWait: () => runtime.promise });
    f.state.adapterId = adapterId;
    const pending = f.controls.waitForAccess(); await tick();
    f.controls.destroy(); runtime.resolve(true);
    assert.equal(await pending, false); assert.equal(f.requests.length, 0);
  }
});

test('a cancelled execution-option choice remains a refusal without starting model discovery', async () => {
  const f = fixture({ runtimeWait: async () => false });
  assert.equal(await f.controls.waitForAccess(), false);
  assert.equal(f.requests.length, 0); assert.deepEqual(f.selections, []);
});


test('send timeout leaves a later valid directory response able to finish the open picker', async () => {
  const time = timeline(), runtime = deferred();
  const f = fixture({ clock: time, runtimeWait: () => runtime.promise });
  const send = f.controls.waitForAccess();
  const refused = assert.rejects(send, { code: 'MODEL_CATALOG_TIMEOUT' });
  await tick(); await time.advance(1000); runtime.resolve(true); await tick();
  assert.equal(f.requests.length, 1);
  const opened = f.open(); await tick();
  assert.match(f.field.innerHTML, /\u6b63\u5728\u52a0\u8f7d/);
  await time.advance(11000); await refused;
  await time.advance(500);
  f.requests[0].resolve({ usable: [{ name: 'selected', label: 'Recovered choice' }] });
  await opened;
  assert.match(f.field.innerHTML, /Recovered choice/);
  assert.doesNotMatch(f.field.innerHTML, /\u6b63\u5728\u52a0\u8f7d/);
  assert.equal(f.requests.length, 1, 'finishing the shared read does not start another request');
  assert.deepEqual(f.selections, [], 'a late catalog must not repeat or replace a confirmed selection');
  assert.equal(time.pending(), 0);
});

test('a confirmed empty directory ends loading and keeps the saved model identity', async () => {
  const f = fixture();
  const opened = f.open(); await tick(); f.requests[0].resolve({ usable: [] }); await opened;
  assert.doesNotMatch(f.field.innerHTML, /\u6b63\u5728\u52a0\u8f7d/);
  assert.match(f.field.innerHTML, /\u6682\u65e0\u53ef\u7528\u6a21\u578b/);
  assert.equal(f.state.selection.name, 'selected');
  assert.equal(f.state.selection.model.unavailable, true);
  assert.equal(f.controls.modelCatalogState().blocked, true);
  assert.equal(f.statuses.at(-1).status, 'empty');
  assert.deepEqual(f.selections, []);
});

test('model directory discovery reads runtime metadata without probing unrelated Agents', async () => {
  const f = fixture();
  const opened = f.open(); await tick(); f.requests[0].resolve({ usable: [{ name: 'selected' }] }); await opened;
  assert.equal(f.runtimeCalls.length, 1);
  assert.equal(f.runtimeCalls[0]?.catalogOnly, true);
});


test('a timed-out directory retries once and ignores the obsolete response after recovery', async () => {
  const time = timeline(), f = fixture({ clock: time });
  const opened = f.open(); await tick();
  await time.advance(12000);
  assert.equal(f.requests.length, 2, 'one automatic retry follows the first read timeout');
  f.requests[1].resolve({ usable: [{ name: 'selected', label: 'Fresh catalog' }] }); await opened;
  assert.match(f.field.innerHTML, /Fresh catalog/);
  f.requests[0].resolve({ usable: [{ name: 'local:obsolete', label: 'Obsolete' }] }); await tick();
  assert.doesNotMatch(f.field.innerHTML, /Obsolete/);
  assert.deepEqual(f.selections, []);
  assert.equal(f.controls.modelCatalogState().status, 'ready');
  await time.advance(24000); assert.equal(f.requests.length, 2);
  assert.equal(time.pending(), 0);
});

test('repeated directory timeouts end loading and a visible retry recovers without changing the valid choice', async () => {
  const time = timeline(), f = fixture({ clock: time });
  const opened = f.open(); await tick(); await time.advance(24000); await opened;
  assert.equal(f.requests.length, 2, 'automatic retries are bounded');
  assert.match(f.field.innerHTML, /data-model-retry/);
  assert.doesNotMatch(f.field.innerHTML, /\u6b63\u5728\u52a0\u8f7d/);
  assert.equal(f.controls.modelCatalogState().status, 'error');
  assert.equal(time.pending(), 0);
  const retried = f.retry(); await tick();
  assert.equal(f.requests.length, 3);
  f.requests[2].resolve({ usable: [{ name: 'selected', label: 'Manual recovery' }] }); await retried; await tick();
  assert.match(f.field.innerHTML, /Manual recovery/);
  assert.equal(f.controls.modelCatalogState().status, 'ready');
  assert.deepEqual(f.selections, []);
});

test('storage and authentication failures stay visible without automatic retry or model deletion', async () => {
  for (const code of ['LOCAL_STORAGE_UNAVAILABLE', 'AUTH_REQUIRED', 'UNSUPPORTED_FORMAT']) {
    const time = timeline(), f = fixture({ clock: time });
    const opened = f.open(); await tick();
    f.requests[0].reject(Object.assign(Error('private diagnostic'), { code })); await opened;
    assert.equal(f.requests.length, 1);
    assert.equal(f.controls.modelCatalogState().status, 'error');
    assert.match(f.field.innerHTML, /data-model-retry/);
    assert.doesNotMatch(f.field.innerHTML, /private diagnostic/);
    assert.equal(f.state.model.id, 'selected'); assert.deepEqual(f.selections, []);
    const failureMarkup = f.field.innerHTML;
    f.pop.handlers.get('input')({ target: { value: 'query', matches: selector => selector === 'input[type=search]' } });
    assert.equal(f.field.innerHTML, failureMarkup, 'search cannot replace a failed load with a misleading empty result');
    await time.advance(24000); assert.equal(f.requests.length, 1);
  }
});

test('closing and reopening during the automatic retry shares the current directory request', async () => {
  const time = timeline(), f = fixture({ clock: time });
  const first = f.open(); await tick(); await time.advance(12000);
  await f.open(); assert.equal(f.pop.hidden, true);
  const reopened = f.open(); await tick();
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve({ usable: [{ name: 'selected', label: 'Current choice' }] });
  await Promise.all([first, reopened]);
  assert.equal(f.pop.hidden, false);
  assert.match(f.field.innerHTML, /Current choice/);
  assert.deepEqual(f.selections, []);
});

test('an account change during automatic retry prevents old models from entering the new picker', async () => {
  const time = timeline(), f = fixture({ clock: time });
  const old = f.open(); await tick(); await time.advance(12000);
  f.owner('hub/device/bob');
  const current = f.open(); await tick(); assert.equal(f.requests.length, 3);
  f.requests[2].resolve({ usable: [{ name: 'selected', label: 'Bob choice' }] }); await current;
  f.requests[1].resolve({ usable: [{ name: 'local:alice', label: 'Alice private' }] });
  f.requests[0].resolve({ usable: [{ name: 'local:alice-old', label: 'Alice previous' }] }); await old;
  assert.match(f.field.innerHTML, /Bob choice/);
  assert.doesNotMatch(f.field.innerHTML, /Alice/);
  assert.deepEqual(f.selections, []);
  assert.equal(f.controls.modelCatalogState().status, 'ready');
});


test('a pending model selection shows the loaded directory without replaying the mutation', async () => {
  const time = timeline(), selection = deferred();
  const f = fixture({ clock: time, selectModel: () => selection.promise });
  const opened = f.open(); await tick();
  f.requests[0].resolve({ usable: [{ name: 'local:replacement', label: 'Replacement' }] }); await tick();
  assert.match(f.field.innerHTML, /Replacement/);
  assert.equal(f.controls.modelCatalogState().status, 'ready');
  const refused = assert.rejects(f.controls.waitForAccess(), { code: 'MODEL_SELECTION_UNCONFIRMED' });
  await tick(); await time.advance(24000); await refused;
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.selections, [{ ref: 'chat', name: 'local:replacement' }]);
  selection.resolve({ ok: true, selection: { name: 'local:replacement', model: { id: 'local:replacement', label: 'Replacement' } } });
  await opened;
  assert.equal(f.state.selection.name, 'local:replacement');
  assert.equal(f.selections.length, 1);
});

test('destroying a picker during retry prevents late selections and additional requests', async () => {
  const time = timeline(), f = fixture({ clock: time });
  const opened = f.open(); await tick(); await time.advance(12000);
  assert.equal(f.requests.length, 2);
  f.controls.destroy(); await opened;
  f.requests[1].resolve({ usable: [{ name: 'local:late', label: 'Late choice' }] }); await tick();
  await time.advance(24000);
  assert.deepEqual(f.selections, []);
  assert.equal(f.requests.length, 2);
  assert.equal(f.state.model.id, 'selected');
  assert.equal(time.pending(), 0);
});


test('catalog state blocks an unconfigured draft until a usable model is selected', async () => {
  const f = fixture(); f.state.model = null; f.state.selection = { name: '' }; f.controls.render(); await tick();
  assert.equal(f.controls.modelCatalogState().status, 'loading');
  assert.equal(f.controls.modelCatalogState().blocked, true);
  const opened = f.open(); f.requests[0].resolve({ usable: [] }); await opened;
  assert.equal(f.controls.modelCatalogState().blocked, true);
  const retried = f.retry(); await tick();
  f.requests[1].resolve({ usable: [{ name: 'available', label: 'Available' }] }); await retried;
  assert.equal(f.controls.modelCatalogState().status, 'ready');
  assert.equal(f.controls.modelCatalogState().blocked, false);
  assert.equal(f.state.selection.name, 'available');
});

test('ordinary renders cannot restart failed catalog reads for an unconfigured draft', async () => {
  const time = timeline(), f = fixture({ clock: time });
  f.state.model = null; f.state.selection = { name: '' }; f.controls.render(); await tick();
  const opened = f.open(); await time.advance(24000); await opened;
  assert.equal(f.requests.length, 2);
  for (let i = 0; i < 5; i++) { f.controls.render(); await tick(); }
  assert.equal(f.requests.length, 2);
  assert.equal(f.controls.modelCatalogState().status, 'error');
  assert.equal(f.controls.modelCatalogState().blocked, true);
  assert.match(f.field.innerHTML, /data-model-retry/);
});
