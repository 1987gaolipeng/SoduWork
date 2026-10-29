'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/panels-compose.js'), 'utf8');

function fixture({ ready, supported = true, confirm, enter, route, goalSupported = () => true, runtimeReady, runtimeId, execution, modelReady } = {}) {
  const opened = [], taskOpened = [], drafts = [], confirmations = [], revoked = [], notices = [], handlers = new Map();
  let onPreference;
  const element = id => ({ addEventListener: (event, fn) => handlers.set(id + ':' + event, fn),
    getBoundingClientRect: () => ({ left: 12, top: 24, width: 100, height: 32 }) });
  const panel = { dataset: {}, querySelector: element, querySelectorAll: () => [] };
  const input = { value: 'Isolated task', style: {} };
  const ctx = { window: null,
    document: { getElementById: id => id === 'cpInput' ? input : null, querySelectorAll: () => [] },
    ComposeSurface: { create: () => ({ _panel: () => panel }) },
    ComposeWorkActions: { route: route || (async () => ({ handled: false })) },
    ComposeDraft: { open: (_text, options) => drafts.push(options) },
    ComposeCapabilities: { summary: () => '' },
    ComposeRuntime: { ready: runtimeReady || (async () => {}), goalSupported, accessSupported: () => supported,
      value: runtimeId || (() => supported ? 'pi' : 'claude'), paint() {}, bind() {} },
    ...(execution ? { ComposeExecution: { bind() {}, ...execution } } : {}),
    ...(modelReady ? { ComposeModelPicker: { ready: modelReady, value: () => ({ modelName: 'test-model' }), refresh() {} } } : {}),
    AccessPreferences: { ready: ready || (async () => ({ mode: 'full', revision: 1 })),
      subscribe: fn => { onPreference = fn; } },
    petSay: message => notices.push(message),
    soduWorkAPI: { conversationSession: {
      confirmNewChatAccess: async options => { confirmations.push(options); return confirm ? confirm(options) : { ok: true, consentId: 'native-receipt' }; },
      revokeNewChatAccess: async options => { revoked.push(options); return { ok: true }; },
    } },
    NativeChat: { enter: async (...args) => { opened.push(args); return enter ? enter(...args) : true; },
      hasSession: () => false, openTask: async (...args) => { taskOpened.push(args); return true; } },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels/panels-compose-skills.js'), 'utf8'), ctx);
  const surfaceStub = ctx.ComposeSurface;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels/compose-surface.js'), 'utf8'), ctx);
  const createSurface = ctx.ComposeSurface.create;
  ctx.ComposeSurface.create = context => ({ ...createSurface(context), ...surfaceStub.create(context) });
  // Expose only the existing entry points for timing tests, without changing
  // production behavior. NativeChat is the runtime boundary of this fixture.
  vm.runInContext(source.replace('})(window);', 'global.testEntry = { enter: _enterChat, bridge: draftBridge, pickSkills: names => { _skillPicker={selected:()=>names.slice(),consume:sent=>{names=names.filter(name=>!sent.includes(name));}}; }, submitTask: () => { _intent={current:()=>({mode:"task"}),reset(){}}; return makeDraft(); }, bind: _bindSetup, reset: () => { _composeViewSeq++; _accessConsent.reset(); _mode="standard"; _accessExplicit=false; } }; })(window);'), ctx);
  ctx.testEntry.bind(panel);
  return { opened, taskOpened, drafts, confirmations, revoked, notices, reset: ctx.testEntry.reset, enter: ctx.testEntry.enter,
    bridge: ctx.testEntry.bridge, submitTask: ctx.testEntry.submitTask, pickSkills: ctx.testEntry.pickSkills,
    publish: value => onPreference(value),
    choose: mode => handlers.get('#cpPermissionPop:click')({ target: { closest: () => ({ dataset: { mode } }) } }) };
}

for (const location of ['local', 'cloud']) test('new ' + location + ' sends carry only picked skill metadata and preserve numbered body text', async () => {
  for (const picked of [[], ['company-research']]) {
    let cloud;
    const f = fixture({ ...(location === 'cloud' ? { execution: { value: () => 'cloud', start: async options => {
      cloud = { text: options.text, ...(await options.prepare()) }; return true;
    } } } : {}) });
    f.pickSkills(picked);
    const body = '#1 帮我写一篇500字的作文\n#2 帮我去AI味\n#web-audit 仅为正文示例';
    assert.equal(await f.enter(body), true);
    const sent = location === 'cloud' ? cloud : { text: f.opened[0][0], ...f.opened[0][2] };
    assert.equal(sent.text, body);
    assert.deepEqual(Array.from(sent.skills), picked);
  }
});

test('an accepted cloud first send consumes its selected skills before a subsequent ordinary send', async () => {
  const calls = [], f = fixture({ execution: { value: () => 'cloud', start: async options => {
    calls.push({ text: options.text, ...(await options.prepare()) }); return true;
  } } });
  f.pickSkills(['company-research']);
  assert.equal(await f.enter('第一轮工作'), true);
  assert.equal(await f.enter('#company-research 只是普通正文'), true);
  assert.deepEqual(Array.from(calls[0].skills), ['company-research']);
  assert.deepEqual(Array.from(calls[1].skills), []);
});

test('the device full default reaches a task conversation without manually reselecting full access', async () => {
  const f = fixture();
  f.publish({ mode: 'full', revision: 1 });
  await f.submitTask(); f.drafts[0].onCreated('task-one', 'Isolated task');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.taskOpened[0][2].sessionOptions?.accessMode, 'full');
  assert.equal(f.confirmations.length, 0, 'the task must perform its own scoped confirmation at the main boundary');
});

test('creating a task from the composer carries its selected permission into the new task conversation', async () => {
  for (const mode of ['full', 'readonly', 'standard']) {
    const f = fixture();
    await f.choose(mode);
    await f.submitTask(); f.drafts[0].onCreated('task-one', 'Isolated task');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.taskOpened.length, 1);
    assert.equal(f.taskOpened[0][2].sessionOptions?.accessMode, mode);
    assert.equal('accessConsentId' in f.taskOpened[0][2].sessionOptions, false);
    assert.equal('accessDraftId' in f.taskOpened[0][2].sessionOptions, false);
  }
});

test('task creation retains the submitted permission even if the composer changes before persistence finishes', async () => {
  const f = fixture();
  await f.choose('full');
  await f.submitTask(); const pending = f.drafts[0];
  await f.choose('standard');
  pending.onPersisted('task-one', 'Isolated task');
  pending.onCreated('task-one', 'Isolated task');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.taskOpened.length, 1);
  assert.equal(f.taskOpened[0][2].sessionOptions?.accessMode, 'full');
});

test('a permission change during attachment analysis cannot rewrite the submitted task bridge', async () => {
  let release, submitted;
  const f = fixture({ route: options => { submitted = options.bridge; return new Promise(resolve => { release = resolve; }); } });
  await f.choose('full');
  const sending = f.submitTask();
  await new Promise(resolve => setImmediate(resolve));
  await f.choose('readonly');
  release({ handled: false }); await sending;
  assert.equal(f.drafts[0], submitted);
  f.drafts[0].onCreated('task-one', 'Isolated task');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.taskOpened[0][2].sessionOptions?.accessMode, 'full');
});

test('standalone task sheets do not inherit a prior composer or device full choice', async () => {
  const f = fixture();
  f.publish({ mode: 'full', revision: 1 });
  f.bridge().onCreated('task-one', 'Standalone task');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.taskOpened[0][2].sessionOptions, undefined);
});

test('a transfer or a runtime without unified permissions does not inherit composer full access', async () => {
  const transferred = fixture();
  await transferred.choose('full');
  await transferred.submitTask(); transferred.drafts[0].onPersisted('task-one', 'Transferred task', { handedOff: true });
  assert.equal(transferred.taskOpened.length, 0);
  const unsupported = fixture({ supported: false });
  await unsupported.submitTask(); unsupported.drafts[0].onCreated('task-two', 'Native-account task');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(unsupported.taskOpened.length, 1);
  assert.equal(unsupported.taskOpened[0][2].sessionOptions?.accessMode, undefined);
});

test('quick send waits for the device default before opening the model session', async () => {
  let release;
  const loading = new Promise(resolve => { release = resolve; });
  const f = fixture({ ready: () => loading });
  const sending = f.enter('hello', '');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.opened.length, 0);
  release({ mode: 'readonly', revision: 1 });
  assert.equal(await sending, true);
  assert.equal(f.opened[0][2].accessMode, 'readonly');
  assert.equal(f.opened[0][2].mode, 'readonly');
});

test('changing execution location while local preparation waits never starts the old local request', async () => {
  for (const stage of ['policy', 'model']) {
    let release, location = 'local', revision = 0;
    const gate = () => new Promise(resolve => { release = resolve; });
    const f = fixture({ [stage === 'policy' ? 'ready' : 'modelReady']: gate,
      execution: { value: () => location, revision: () => revision, paint() {} } });
    const sending = f.enter('Keep this draft and its files', '');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof release, 'function');
    location = 'cloud'; revision++;
    release(stage === 'policy' ? { mode: 'standard' } : true);
    assert.equal(await sending, false); assert.equal(f.opened.length, 0);
  }
});

test('switching away and back invalidates the pending send; a later explicit send still uses local Pi', async () => {
  let release, location = 'local', revision = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ ready: () => gate,
    execution: { value: () => location, revision: () => revision, paint() {} } });
  const pending = f.enter('The original prompt', '');
  await new Promise(resolve => setImmediate(resolve));
  location = 'cloud'; revision++; location = 'local'; revision++;
  release({ mode: 'readonly' });
  assert.equal(await pending, false); assert.equal(f.opened.length, 0);
  assert.equal(await f.enter('The original prompt', ''), true);
  assert.equal(f.opened[0][0], 'The original prompt');
  assert.equal(f.opened[0][2].adapterId, 'pi');
  assert.equal(f.opened[0][2].accessMode, 'readonly');
});

test('changing Agent during local preparation does not open a runtime with another Agent\'s prepared selections', async () => {
  let release, agent = 'pi';
  const f = fixture({ ready: () => new Promise(resolve => { release = resolve; }), runtimeId: () => agent });
  const pending = f.enter('Keep the selected local task', '');
  await new Promise(resolve => setImmediate(resolve));
  agent = 'codex'; release({ mode: 'standard' });
  assert.equal(await pending, false); assert.equal(f.opened.length, 0);
});

test('a retained goal draft cannot be sent with a chat-only Agent, but ordinary chat remains available', async () => {
  const f = fixture({ goalSupported: () => false });
  const draft = { intent: 'goal', goal: 'Deliver the report', acceptance: 'Verified data' };
  assert.equal(await f.enter('Keep this prompt', '', draft), false);
  assert.equal(f.opened.length, 0);
  assert.match(f.notices[0], /不支持目标模式/);
  assert.equal(draft.acceptance, 'Verified data');
  assert.equal(await f.enter('Ordinary chat', ''), true);
  assert.equal(f.opened.length, 1);
});

test('changing to a chat-only Agent during preparation is checked again before entering chat', async () => {
  let readyCalls = 0, supported = true;
  const f = fixture({ goalSupported: () => supported,
    runtimeReady: async () => { if (++readyCalls === 2) supported = false; } });
  assert.equal(await f.enter('Keep this prompt', '', { intent: 'goal', goal: 'Deliver' }), false);
  assert.equal(readyCalls, 2);
  assert.equal(f.opened.length, 0);
  assert.match(f.notices[0], /不支持目标模式/);
});

test('full access is confirmed on selection and sends only the native draft receipt', async () => {
  const f = fixture();
  assert.equal(await f.choose('full'), true);
  assert.equal(f.confirmations.length, 1);
  assert.equal(f.opened.length, 0, 'choosing permission does not start a session');
  await f.enter('hello', '');
  assert.equal(f.opened[0][2].accessMode, 'full');
  assert.equal(f.opened[0][2].accessConsentId, 'native-receipt');
  assert.equal(f.opened[0][2].accessDraftId, f.confirmations[0].draftId);
  assert.equal(f.confirmations.length, 1, 'sending does not request another confirmation');
});

test('cancelled consent retains readonly and does not consume a queued send', async () => {
  let answer;
  const f = fixture({ confirm: () => new Promise(resolve => { answer = resolve; }) });
  await f.choose('readonly');
  const choosing = f.choose('full');
  const sending = f.enter('hello', '');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.opened.length, 0);
  answer({ ok: false, cancelled: true });
  assert.equal(await choosing, false);
  assert.equal(await sending, false);
  assert.equal(f.notices.length, 0);
  await f.enter('hello', '');
  assert.equal(f.opened[0][2].accessMode, 'readonly');
  assert.equal('accessConsentId' in f.opened[0][2], false);
});

test('duplicate clicks share consent and send waits until that consent completes', async () => {
  let answer;
  const f = fixture({ confirm: () => new Promise(resolve => { answer = resolve; }) });
  const first = f.choose('full'), second = f.choose('full'), sending = f.enter('hello', '');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.confirmations.length, 1);
  assert.equal(f.opened.length, 0);
  f.publish({ mode: 'readonly', revision: 2 });
  answer({ ok: true, consentId: 'native-receipt' });
  assert.equal(await first, true); assert.equal(await second, true); assert.equal(await sending, true);
  assert.equal(f.opened[0][2].accessMode, 'full');
});

test('stale consent cannot promote a different draft or a downgraded choice', async () => {
  for (const action of ['reset', 'downgrade', 'history']) {
    let answer;
    const f = fixture({ ready: async () => ({ mode: 'standard' }), confirm: () => new Promise(resolve => { answer = resolve; }) });
    const choosing = f.choose('full');
    await new Promise(resolve => setImmediate(resolve));
    if (action === 'reset') f.reset();
    else if (action === 'downgrade') await f.choose('standard');
    else await f.enter('', 'history-chat');
    answer({ ok: true, consentId: 'stale-receipt' });
    assert.equal(await choosing, false);
    await f.enter('hello', '');
    assert.equal(f.opened.at(-1)[2].accessMode, 'standard');
    assert.equal('accessConsentId' in f.opened.at(-1)[2], false);
    assert.ok(f.revoked.some(item => item.draftId === f.confirmations[0].draftId));
  }
});

test('a failed open keeps the confirmed draft available for retry; downgrade revokes it', async () => {
  const f = fixture({ enter: () => false });
  await f.choose('full');
  await f.enter('hello', ''); await f.enter('hello', '');
  assert.equal(f.confirmations.length, 1);
  assert.equal(f.opened[0][2].accessConsentId, f.opened[1][2].accessConsentId);
  await f.choose('standard'); await f.enter('hello', '');
  assert.equal('accessConsentId' in f.opened[2][2], false);
  assert.equal(f.revoked.length, 1);
});

test('confirmation failure leaves the original choice intact and shows a retryable reason', async () => {
  const f = fixture({ confirm: () => { throw Error('isolated unavailable'); } });
  await f.choose('readonly');
  assert.equal(await f.choose('full'), false);
  await f.enter('hello', '');
  assert.equal(f.opened[0][2].accessMode, 'readonly');
  assert.deepEqual(f.notices, ['isolated unavailable']);
});

test('an explicit per-chat choice wins over late loading and cross-window setting updates', async () => {
  let release;
  const f = fixture({ ready: () => new Promise(resolve => { release = resolve; }) });
  const sending = f.enter('hello', '');
  await new Promise(resolve => setImmediate(resolve));
  f.choose('standard');
  f.publish({ mode: 'full', revision: 2 });
  release({ mode: 'full', revision: 2 });
  assert.equal(await sending, true);
  assert.equal(f.opened[0][2].accessMode, 'standard');
});

test('unsupported adapters keep their native mode and historical chats do not inherit a composer default', async () => {
  const native = fixture({ supported: false });
  assert.equal(await native.enter('hello', ''), true);
  assert.equal(native.opened[0][2].accessMode, '');
  assert.equal(native.opened[0][2].mode, 'full');
  const history = fixture({ ready: () => { throw Error('history must not load a new default'); } });
  assert.equal(await history.enter('', 'old-chat'), true);
  assert.equal('accessMode' in history.opened[0][2], false);
});
