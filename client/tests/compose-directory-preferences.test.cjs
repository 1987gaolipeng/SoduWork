'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/compose-directory-preferences.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// Public runtime/model contracts are controllable here. Electron cases exercise
// the actual controls and accepted send path; these cases stress owner/race and
// persistence boundaries independently of DOM timing.
function fixture(options = {}) {
  const saved = options.saved || new Map(), listeners = new Map(), notices = [], calls = [];
  let owner = 'https://hub-a/device-a/account-a', location = 'local';
  let workspace = { direct: true, dir: '/project-a', rootDir: '/temporary-root' };
  let adapterId = 'pi', modelName = 'default', reasoningEffort = '', thinkingLevel = '';
  let runtimeResult = true, modelResult = true, runtimeWait = null, modelWait = null;
  const storage = { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value) };
  const context = {
    SoduWorkAPI: { taskStorageKey: () => owner },
    addEventListener: (event, listener) => listeners.set(event, listener),
    ComposeRuntime: { value: () => adapterId, location: () => location,
      async resetNewDraft() { adapterId = 'pi'; },
      async restoreSelection(value, current) {
        calls.push({ kind: 'runtime', value, owner, location });
        if (runtimeWait) await runtimeWait;
        if (!current()) return false;
        if (runtimeResult) adapterId = value;
        return runtimeResult;
      } },
    ComposeModelPicker: { value: () => ({ modelName, reasoningEffort, thinkingLevel }),
      async resetNewDraft() { modelName = 'default'; reasoningEffort = ''; thinkingLevel = ''; },
      async resetDirectory() { modelName = 'default'; reasoningEffort = ''; thinkingLevel = ''; },
      releasePreference() {},
      async restoreSelection(value, current) {
        calls.push({ kind: 'model', value: { ...value }, owner, location });
        if (modelWait) await modelWait;
        if (!current()) return false;
        if (modelResult) ({ modelName, reasoningEffort, thinkingLevel } = value);
        return modelResult;
      } },
  };
  if (options.storage !== 'absent') context.localStorage = options.storage === 'throws'
    ? { getItem() { throw Error('Storage unavailable'); }, setItem() { throw Error('Storage unavailable'); } } : storage;
  context.window = context;
  vm.runInNewContext(source, context);
  const pref = context.ComposeDirectoryPreferences;
  pref.bind({ workspace: () => workspace, say: message => notices.push(message) });
  return { pref, saved, calls, notices, context,
    state: () => ({ adapterId, modelName, reasoningEffort, thinkingLevel }),
    automaticSelection(agent, model) { adapterId = agent; modelName = model; },
    choose(agent, model, effort = '', thinking = '') {
      pref.selectionStarted(); adapterId = agent; modelName = model; reasoningEffort = effort; thinkingLevel = thinking;
      pref.selectionCommitted();
    },
    workspace(value) { workspace = value; },
    location(value) { location = value; },
    owner(value, event = false) { owner = value; if (event) listeners.get('soduwork-data-scope-changed')?.(); },
    emit(event) { listeners.get(event)?.(); },
    unavailable(kind, value = false) { if (kind === 'runtime') runtimeResult = value; else modelResult = value; },
    delay(kind, value) { if (kind === 'runtime') runtimeWait = value; else modelWait = value; },
    async use(agent, model, effort = '', thinking = '') {
      await pref.begin(); this.choose(agent, model, effort, thinking); return pref.remember(pref.capture());
    },
  };
}
const pair = (adapterId, modelName, reasoningEffort = '', thinkingLevel = '') => ({ adapterId, modelName, reasoningEffort, thinkingLevel });

for (const workspace of ['temporary', 'explicit', 'remembered']) {
  test(`same-account auth refresh preserves the unsent runtime and model in a ${workspace} workspace`, async () => {
    const f = fixture();
    if (workspace === 'temporary') f.workspace({ direct: false, dir: '' });
    if (workspace === 'remembered') await f.use('qwen', 'previously-used');
    await f.pref.begin({ newSession: true });
    f.choose('codex', 'unsent-model', 'high', 'medium');
    const saved = [...f.saved.entries()];
    for (const event of ['soduwork-device-auth', 'soduwork-device-auth', 'soduwork-data-scope-changed']) {
      f.emit(event); await flush();
      assert.deepEqual(f.state(), pair('codex', 'unsent-model', 'high', 'medium'));
      assert.equal(await f.pref.ready(), true);
      assert.deepEqual([...f.saved.entries()], saved, 'refresh must not persist an unsent choice');
    }
  });
}

test('same-account auth refresh does not restart an in-flight directory restoration', async () => {
  const f = fixture(); await f.use('qwen', 'saved');
  const delayed = deferred(); f.delay('runtime', delayed.promise);
  const restoring = f.pref.begin(); await flush();
  try {
    f.emit('soduwork-device-auth'); f.emit('soduwork-device-auth'); await flush();
    assert.equal(f.calls.filter(call => call.kind === 'runtime').length, 1);
  } finally { delayed.resolve(); }
  await restoring;
  assert.equal(await f.pref.ready(), true);
  assert.deepEqual(f.state(), pair('qwen', 'saved'));
});

test('auth and scope events still restore the new account pair once when ownership changes', async () => {
  const f = fixture(); await f.use('qwen', 'account-a');
  f.owner('https://hub-a/device-a/account-b'); await f.use('codex', 'account-b');
  f.owner('https://hub-a/device-a/account-a'); await f.pref.begin();
  f.choose('qwen', 'unsent-a'); const calls = f.calls.length;
  f.owner('https://hub-a/device-a/account-b');
  f.emit('soduwork-data-scope-changed'); f.emit('soduwork-device-auth'); await flush();
  assert.deepEqual(f.state(), pair('codex', 'account-b'));
  assert.equal(f.calls.length - calls, 2, 'one runtime restore and one model restore');
  f.owner('https://hub-a/device-a/account-c'); f.emit('soduwork-device-auth'); await flush();
  assert.deepEqual(f.state(), pair('pi', 'default'), 'a new account cannot inherit another account draft');
});

test('auth refresh cannot reactivate directory restoration after leaving the new-chat composer', async () => {
  const f = fixture(); await f.use('qwen', 'saved');
  f.pref.stop(); f.choose('codex', 'historical-conversation');
  f.owner('https://hub-a/device-a/account-b');
  f.emit('soduwork-device-auth'); f.emit('soduwork-data-scope-changed'); await flush();
  assert.deepEqual(f.state(), pair('codex', 'historical-conversation'));
  assert.equal(f.pref.capture(), null);
});

test('directory preferences persist a complete successfully used pair across renderer restarts', async () => {
  const f = fixture();
  assert.equal(await f.use('qwen', 'chosen', 'high', 'medium'), true);
  f.workspace({ direct: true, dir: '/project-b' }); await f.use('codex', 'native-model');
  const restored = fixture({ saved: f.saved }); await restored.pref.begin();
  assert.deepEqual(restored.state(), pair('qwen', 'chosen', 'high', 'medium'));
  restored.workspace({ direct: true, dir: '/project-b' }); await restored.pref.begin();
  assert.deepEqual(restored.state(), pair('codex', 'native-model'));
  assert.equal(restored.saved.size, 2);
});

test('changing controls without a successful-use commit never persists an unsent draft', async () => {
  const f = fixture(); await f.use('qwen', 'used');
  await f.pref.begin(); f.choose('codex', 'unsent'); f.pref.capture();
  const restored = fixture({ saved: f.saved }); await restored.pref.begin();
  assert.deepEqual(restored.state(), pair('qwen', 'used'));
});

test('Hub account device scopes isolate preferences and cloud never consumes a local directory choice', async () => {
  const f = fixture(); await f.use('qwen', 'local-personal');
  f.location('cloud'); assert.equal(await f.use('codex', 'cloud-personal'), false);
  assert.deepEqual(f.state(), pair('codex', 'cloud-personal'));
  assert.equal(f.saved.size, 1);
  for (const owner of ['https://hub-b/device-a/account-a', 'https://hub-a/device-b/account-a', 'https://hub-a/device-a/account-b']) {
    const isolated = fixture({ saved: f.saved }); isolated.owner(owner);
    await isolated.pref.begin();
    assert.deepEqual(isolated.state(), pair('pi', 'default'));
    assert.equal(isolated.calls.length, 0);
  }
  const restored = fixture({ saved: f.saved }); await restored.pref.begin();
  assert.deepEqual(restored.state(), pair('qwen', 'local-personal'));
  restored.location('cloud'); restored.choose('codex', 'cloud-personal');
  assert.equal(await restored.pref.ready(), true);
  assert.deepEqual(restored.state(), pair('codex', 'cloud-personal'), 'cloud keeps its remote selection');
  assert.equal(restored.pref.capture(), null);
  restored.location('local'); await restored.pref.ready();
  assert.deepEqual(restored.state(), pair('qwen', 'local-personal'));
});

test('temporary workspaces never create a shared preference even when a root directory is present', async () => {
  const f = fixture(); f.workspace({ direct: false, dir: '/temporary-root/chat-old', rootDir: '/temporary-root' });
  assert.equal(await f.use('qwen', 'chosen'), false);
  assert.equal(f.pref.capture(), null); assert.equal(f.saved.size, 0);
  f.workspace({ direct: true, dir: '' }); assert.equal(await f.use('qwen', 'chosen'), false);
  assert.equal(f.saved.size, 0);
});

for (const missing of ['runtime', 'model']) test(`unavailable remembered ${missing} blocks readiness without rewriting the saved pair`, async () => {
  const f = fixture(); await f.use('qwen', 'chosen'); const before = [...f.saved.entries()];
  f.unavailable(missing); await f.pref.begin();
  assert.equal(await f.pref.ready(), false); assert.equal(f.pref.capture(), null);
  assert.ok(f.notices.length > 0); assert.deepEqual([...f.saved.entries()], before);
  f.unavailable(missing, true); await f.pref.begin();
  assert.deepEqual(f.state(), pair('qwen', 'chosen'));
  f.unavailable(missing); await f.pref.begin(); f.choose('pi', 'replacement');
  assert.equal(await f.pref.ready(), true);
  assert.equal(f.pref.remember(f.pref.capture()), true);
  assert.notDeepEqual([...f.saved.entries()], before);
});

for (const storage of ['absent', 'throws']) test(`${storage} localStorage keeps the successful pair in this renderer without breaking refresh`, async () => {
  const f = fixture({ storage }); assert.equal(await f.use('qwen', 'chosen'), true);
  f.choose('pi', 'draft'); await f.pref.begin();
  assert.deepEqual(f.state(), pair('qwen', 'chosen'));
  assert.equal(await f.pref.ready(), true);
});

test('a send snapshot cannot be written into the account or directory selected later', async () => {
  const f = fixture(); await f.pref.begin(); f.choose('qwen', 'chosen'); const original = f.pref.capture();
  f.workspace({ direct: true, dir: '/project-b' }); await f.pref.begin(); f.pref.remember(original);
  const restored = fixture({ saved: f.saved });
  restored.workspace({ direct: true, dir: '/project-b' }); await restored.pref.begin();
  assert.equal(restored.calls.length, 0, 'old send never becomes the new directory preference');
  const before = [...f.saved.entries()]; f.owner('https://hub-a/device-a/account-b');
  assert.equal(f.pref.remember(original), false); assert.deepEqual([...f.saved.entries()], before);
});

test('delayed directory restoration cannot replace the newly selected directory pair', async () => {
  const f = fixture(); await f.use('qwen', 'a');
  f.workspace({ direct: true, dir: '/project-b' }); await f.use('codex', 'b');
  const delayed = deferred(); f.delay('model', delayed.promise);
  f.workspace({ direct: true, dir: '/project-a' }); const old = f.pref.begin(); await flush();
  f.delay('model', null); f.workspace({ direct: true, dir: '/project-b' }); await f.pref.begin();
  delayed.resolve(); await old;
  assert.deepEqual(f.state(), pair('codex', 'b')); assert.equal(await f.pref.ready(), true);
});

test('delayed restoration yields to explicit choices and to entering a historical conversation', async () => {
  for (const action of ['explicit', 'history']) {
    const f = fixture(); await f.use('qwen', 'saved');
    const delayed = deferred(); f.delay('model', delayed.promise); const old = f.pref.begin(); await flush();
    if (action === 'history') f.pref.stop();
    f.choose('codex', 'current'); delayed.resolve(); await old;
    assert.deepEqual(f.state(), pair('codex', 'current'));
    if (action === 'history') assert.equal(f.pref.capture(), null);
  }
});

test('clicking an unavailable Agent during restore does not release Send with a fallback pair', async () => {
  const f = fixture(); await f.use('qwen', 'saved'); const before = [...f.saved.entries()];
  const delayed = deferred(); f.delay('runtime', delayed.promise);
  const old = f.pref.begin(); await flush();
  // The picker announces a click before probing; a rejected probe never commits it.
  f.pref.selectionStarted(); delayed.resolve(); await old;
  assert.equal(await f.pref.ready(), false); assert.equal(f.pref.capture(), null);
  assert.deepEqual([...f.saved.entries()], before);
  f.choose('codex', 'explicit'); assert.equal(await f.pref.ready(), true);
});

test('a later automatic runtime or model fallback cannot replace a restored pair', async () => {
  for (const changed of ['runtime', 'model']) {
    const f = fixture(); await f.use('qwen', 'saved'); await f.pref.begin();
    const before = [...f.saved.entries()];
    f.automaticSelection(changed === 'runtime' ? 'pi' : 'qwen', changed === 'model' ? 'fallback' : 'saved');
    assert.equal(await f.pref.ready(), false, changed); assert.equal(f.pref.capture(), null);
    assert.deepEqual([...f.saved.entries()], before);
    f.choose('pi', 'explicit'); assert.equal(await f.pref.ready(), true);
  }
});

test('automatic restoration preserves the explicit selection revision and a user choice advances it', async () => {
  const f = fixture(); await f.use('qwen', 'saved');
  const revision = f.pref.selectionRevision(); await f.pref.begin();
  assert.equal(f.pref.selectionRevision(), revision);
  f.pref.selectionStarted(); assert.ok(f.pref.selectionRevision() > revision);
  f.choose('pi', 'explicit'); assert.equal(await f.pref.ready(), true);
});

test('leaving local execution cancels a pending restore without changing the cloud selection', async () => {
  const f = fixture(); await f.use('qwen', 'local');
  const delayed = deferred(); f.delay('model', delayed.promise); const old = f.pref.begin(); await flush();
  f.location('cloud'); f.choose('codex', 'remote'); await f.pref.ready();
  delayed.resolve(); await old;
  assert.deepEqual(f.state(), pair('codex', 'remote')); assert.equal(f.pref.capture(), null);
});

test('old account restoration cannot replace the new account selection', async () => {
  const f = fixture(); await f.use('qwen', 'account-a');
  f.owner('https://hub-a/device-a/account-b'); await f.use('codex', 'account-b');
  f.owner('https://hub-a/device-a/account-a');
  const delayed = deferred(); f.delay('runtime', delayed.promise); const old = f.pref.begin(); await flush();
  f.delay('runtime', null); f.owner('https://hub-a/device-a/account-b', true); await f.pref.ready();
  delayed.resolve(); await old;
  assert.deepEqual(f.state(), pair('codex', 'account-b'));
});

test('malformed storage is ignored and account Agents without a model picker retain an empty model name', async () => {
  const f = fixture(); await f.use('custom-account', '');
  const restored = fixture({ saved: f.saved }); await restored.pref.begin();
  assert.deepEqual(restored.state(), pair('custom-account', ''));
  for (const value of ['{broken', 'null', JSON.stringify({ adapterId: '../invalid', modelName: 'private' })]) {
    const bad = new Map([...f.saved.keys()].map(key => [key, value]));
    const isolated = fixture({ saved: bad }); assert.equal(await isolated.pref.begin(), true);
    assert.deepEqual(isolated.state(), pair('pi', 'default'));
    assert.deepEqual([...bad.values()], [value], 'reading malformed preferences does not rewrite storage');
  }
});

test('an unknown Codex default during discovery failure does not overwrite a verified directory pair', async () => {
  const f = fixture(); await f.use('codex', 'verified'); const before = [...f.saved.entries()];
  await f.pref.begin(); f.choose('codex', '');
  assert.equal(f.pref.capture(), null);
  assert.equal(f.pref.remember(f.pref.capture()), false);
  assert.deepEqual([...f.saved.entries()], before);
});

test('directory identity preserves case and Unicode while normalizing Windows separators', async () => {
  const f = fixture(); f.workspace({ direct: true, dir: 'C:\\项目\\Alpha\\' }); await f.use('qwen', 'alpha');
  const restored = fixture({ saved: f.saved }); restored.workspace({ direct: true, dir: 'C:/项目/Alpha/' });
  await restored.pref.begin(); assert.deepEqual(restored.state(), pair('qwen', 'alpha'));
  const different = fixture({ saved: f.saved }); different.workspace({ direct: true, dir: 'C:/项目/alpha' });
  await different.pref.begin(); assert.equal(different.calls.length, 0);
});

test('POSIX backslashes and trailing spaces remain distinct filesystem directory names', async () => {
  for (const [original, different] of [['/projects/with\\slash', '/projects/with/slash'], ['/projects/name ', '/projects/name']]) {
    const f = fixture(); f.workspace({ direct: true, dir: original }); await f.use('qwen', 'private');
    const restored = fixture({ saved: f.saved }); restored.workspace({ direct: true, dir: different });
    await restored.pref.begin(); assert.equal(restored.calls.length, 0, original);
  }
});
