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
function fixture(settings = {}) {
  let owner = 'hub/device/alice', changed;
  const node = () => ({ hidden: true, dataset: {}, style: {}, handlers: new Map(), innerHTML: '', textContent: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, callback) { this.handlers.set(type, callback); },
    setAttribute() {}, removeAttribute() {}, focus() {}, contains: () => false, querySelector: () => null,
    getBoundingClientRect: () => ({ left: 200, right: 300, top: 500 }) });
  const queue = node(), pop = node(), button = node(), label = node(), wrap = node(), el = node(), field = node();
  pop.querySelector = () => field; button.querySelector = () => label;
  wrap.querySelector = selector => selector === 'button' ? button : selector === '.nmodel-pop' ? pop : null;
  el.querySelector = selector => selector === '#nchatQueue' ? queue : selector === '#nchatModel' ? wrap : null;
  const state = { ref: 'chat', adapterId: 'qwen', model: { id: 'selected', label: 'Selected' } };
  const requests = [], calls = [], selections = [];
  const window = { ...node(), innerWidth: 1000, innerHeight: 800, SoduWorkModelChoice: require('../core/model-choice'),
    setTimeout: settings.clock?.setTimeout || setTimeout, clearTimeout: settings.clock?.clearTimeout || clearTimeout,
    SoduWorkAPI: { taskStorageKey: () => owner, myModels: options => {
      const item = { ...deferred(), options }; requests.push(item); return item.promise;
    } },
    soduWorkAPI: { conversationSession: {
      runtimes: async () => settings.runtimes ? settings.runtimes() : ({ ok: true, runtimes: [{ id: 'pi', modelMode: 'managed' }, { id: 'qwen', modelMode: 'managed' }, { id: 'codex', modelMode: 'account' }] }),
      runtimeModels: async (id, ref) => { calls.push(id); return settings.runtimeModels ? settings.runtimeModels(id, ref) : { models: [{ id: 'account-choice' }] }; },
      selectModel: async (ref, name) => { selections.push({ ref, name });
        if (settings.selectModel) return settings.selectModel(ref, name);
        return { ok: true, selection: { name, model: { id: name, label: name } } }; },
      onModelsChanged: fn => { changed = fn; return () => {}; },
    } } };
  if (settings.nativeEffort) window.ComposeModelPicker = { nativeEffort: { paint() {}, levels: () => [],
    html: () => '<div class="cp-effort-card"></div>' } };
  if (settings.runtimeWait) window.ChatRuntimePicker = { create: () => ({
    render() {}, wait: settings.runtimeWait, reset() {}, destroy() {},
  }) };
  vm.runInNewContext(source, { window, SoduWorkModelChoice: window.SoduWorkModelChoice, document: node(), AbortController });
  const controls = window.ChatComposerControls.create(el, { state: () => state, say() {},
    draft: { ready: () => true, destroy() {}, selectModel: (name, label) => ({ ok: true, selection: { name, model: { id: name, label } } }) },
    modelSelected: selection => { state.selection = selection; },
    modelAvailabilityChanged: selection => { state.selection = selection; } }); controls.render();
  return { state, requests, calls, selections, field, label, controls, button, pop, changed: () => changed(),
    owner: value => { owner = value; controls.render(); },
    open: () => button.handlers.get('click')(),
  };
}
const catalog = { usable: [{ name: 'managed', label: 'Managed choice' }, { name: 'local:private', localOnly: true, label: 'Private choice' }] };

function preview(f, name, model = {}) {
  Object.assign(f.state, { devicePreview: true, draftOnly: true, archivedModelName: name,
    selection: { name, model: { id: name, label: name, ...model } } });
  f.controls.render();
}

test('opening an authorized history shows the saved choice immediately and refreshes its exact Hub label', async () => {
  const f = fixture(); preview(f, 'managed');
  assert.equal(f.label.textContent, 'managed'); await tick();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].options.refreshManaged, true); assert.equal(f.requests[0].options.localDefaults, false);
  f.requests[0].resolve(catalog); await tick();
  assert.equal(f.label.textContent, 'Managed choice'); assert.equal(f.state.selection.name, 'managed');
  assert.deepEqual(f.selections, []); f.controls.destroy();
});

test('an authoritative deletion blocks preview continuation until the user explicitly picks a model', async () => {
  const f = fixture(); preview(f, 'deleted-hub', { label: 'Old choice' }); await tick();
  f.requests[0].resolve(catalog); await tick();
  assert.match(f.label.textContent, /不可用/); assert.equal(f.state.selection.model.unavailable, true);
  const send = f.controls.waitForAccess(); await tick(); f.requests[1].resolve(catalog);
  await assert.rejects(send, { code: 'MODEL_UNAVAILABLE' }); assert.equal(f.state.selection.name, 'deleted-hub');
  const open = f.open(); await tick(); f.requests[2].resolve(catalog); await open;
  assert.match(f.field.innerHTML, /Managed choice/);
  await f.pop.handlers.get('click')({ stopPropagation() {}, target: {
    closest: selector => selector === '[data-model-name]' ? { dataset: { modelName: 'managed' } } : null } });
  assert.equal(f.state.selection.name, 'managed'); assert.deepEqual(f.selections, [], 'preview choices must not mutate a live handle');
  const ready = f.controls.waitForAccess(); await tick(); f.requests.at(-1).resolve(catalog);
  assert.equal(await ready, true); f.controls.destroy();
});

test('partial catalogs keep the saved Hub choice and a late reply cannot repaint the next account or conversation', async () => {
  const f = fixture(); preview(f, 'managed', { label: 'Original' }); await tick();
  f.state.ref = 'other-chat'; f.owner('other-hub/device/bob'); await tick();
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve({ usable: [], managedCatalogUnavailable: true }); await tick();
  f.requests[0].resolve({ usable: [{ name: 'managed', label: 'Alice private label' }] }); await tick();
  assert.equal(f.label.textContent, 'Original'); assert.equal(f.state.selection.model.unavailable, undefined);
  assert.deepEqual(f.selections, []); f.controls.destroy();
});

test('opening an archived local choice uses its supplied label without consulting the Hub', async () => {
  for (const unavailable of [false, true]) {
    const f = fixture(); preview(f, 'local:model-id', { label: unavailable ? '原本地模型已删除或不可用' : 'Local GLM', unavailable });
    await tick(); assert.equal(f.requests.length, 0); assert.equal(f.calls.length, 0);
    assert.equal(f.label.textContent, f.state.selection.model.label); assert.deepEqual(f.selections, []);
    f.controls.destroy();
  }
});

test('a model change refreshes a visible local history label and marks deletion without replacing its saved id', async () => {
  const f = fixture(); preview(f, 'local:private', { label: 'Original local name' }); await tick();
  assert.equal(f.requests.length, 0);
  f.changed(); await tick(); assert.equal(f.requests.length, 1);
  f.requests[0].resolve(catalog); await tick(); assert.equal(f.label.textContent, 'Private choice');
  f.changed(); await tick(); f.requests[1].resolve({ usable: [{ name: 'replacement', label: 'Alternative' }] }); await tick();
  assert.match(f.label.textContent, /不可用/); assert.equal(f.state.selection.name, 'local:private');
  assert.equal(f.state.selection.model.unavailable, true); assert.deepEqual(f.selections, []); f.controls.destroy();
});

test('historical local aliases match only an authoritative catalog choice and keep the original archive selection', async () => {
  const opaque = 'local:model-0123456789abcdef0123456789abcdef';
  for (const image of [false, true]) {
    const f = fixture();
    const oldName = image ? 'image::demo::local:demo:glm' : 'local:demo:glm';
    const catalogName = image ? 'image::device:demo::' + opaque : opaque;
    const row = { providerId: 'device:demo', name: opaque, label: 'Current local label', localOnly: true };
    const data = image ? { usable: [], mediaUsable: { image: [row] } } : { usable: [row] };
    f.state.adapterId = 'pi'; preview(f, oldName);
    const open = f.open(); await tick();
    assert.equal(f.requests[0].options.historyChoice, oldName);
    f.requests[0].resolve({ ...data, historyChoiceName: catalogName }); await open;
    assert.match(f.label.textContent, /Current local label/);
    assert.match(f.field.innerHTML, /aria-selected="true"/);
    const ready = f.controls.waitForAccess(); await tick();
    f.requests[1].resolve({ ...data, historyChoiceName: catalogName }); assert.equal(await ready, true);
    assert.equal(f.state.selection.name, oldName); assert.deepEqual(f.selections, []);
    if (image) preview(f, 'image::different-provider::' + opaque);
    const blocked = f.controls.waitForAccess(); await tick();
    f.requests[2].resolve({ ...data, historyChoiceName: '' });
    await assert.rejects(blocked, { code: 'MODEL_UNAVAILABLE' });
    assert.equal(f.state.selection.model.unavailable, true); assert.deepEqual(f.selections, []);
    f.controls.destroy();
  }
});

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

test('runtime discovery times out visibly without allowing a late response to start model discovery', async () => {
  const time = clock(), runtime = deferred();
  const f = fixture({ clock: time, runtimes: () => runtime.promise });
  const pending = f.controls.waitForAccess();
  const rejected = assert.rejects(pending, { code: 'MODEL_CATALOG_TIMEOUT', message: /读取模型列表超时/ });
  await tick(); time.expire(); await rejected;
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

test('an open Codex chat distinguishes a cold Runner from an empty list and recovers the same chat catalog', async () => {
  const results = [{ ok: false, models: [] }, { ok: true, models: [], catalogAvailable: true },
    { ok: true, models: [{ id: 'found', label: 'Found model' }], catalogAvailable: true }];
  const refs = [];
  const f = fixture({ nativeEffort: true, runtimeModels: (adapter, ref) => { refs.push(ref); return results.shift(); } });
  f.state.adapterId = 'codex'; f.state.selection = { name: 'saved', model: { id: 'saved', label: 'Saved model' } };
  f.controls.render(); await f.open();
  assert.match(f.button.title, /暂时无法读取/);
  assert.doesNotMatch(f.pop.innerHTML, /data-native-refresh|data-native-catalog-note/);
  const click = key => f.pop.handlers.get('click')({ stopPropagation() {}, target: { closest: selector => selector === key } });
  await click('[data-native-list]'); await tick();
  assert.match(f.button.title, /暂未提供可切换的模型/);
  assert.doesNotMatch(f.field.innerHTML, /data-model-name=/);
  assert.equal(f.state.selection.name, 'saved');
  f.changed(); await tick();
  assert.match(f.field.innerHTML, /Found model/);
  assert.deepEqual(refs, ['chat', 'chat', 'chat']);
  assert.deepEqual(f.selections, []);
});
