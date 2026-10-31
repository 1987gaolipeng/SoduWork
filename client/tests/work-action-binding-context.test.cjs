'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '../components/panels', name + '.js'), 'utf8');
const clone = value => value === undefined ? value : JSON.parse(JSON.stringify(value));
const plugin = () => ({ pluginId: 'local:game', key: 'game-dev', qualifiedKey: 'personal:game-dev',
  name: '小游戏插件', personal: true, version: '1.0.0', secret: 'must-not-transfer',
  instructions: 'private instructions', inputValues: { privateField: 'must-not-transfer' } });
function fixture() {
  let picks = [plugin()], info = { ref: 'ref-a', sessionId: 'chat-a', repoId: 'repo-a',
    projectId: 'project-a', adapterId: 'qwen', seatId: 'seat-must-not-be-assignee' };
  let opened, refined, release;
  const input = { value: '今天中午12点使用小游戏插件开发够级小游戏', style: {},
    addEventListener() {}, dispatchEvent() {}, focus() {}, isConnected: true,
    // showPending now removes previous pending cards and appends into the draft container.
    querySelector: () => null, appendChild() {} };
  const c = { Event: class { constructor(type) { this.type = type; } },
    document: { getElementById: () => input,
      createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, appendChild() {}, append() {},
        remove() {}, classList: { add() {}, remove() {}, toggle() {} } }) }, console };
  c.window = c;
  vm.createContext(c);
  for (const name of ['plugin-ui-host', 'panels-chat-work-actions', 'panels-compose-work-actions'])
    vm.runInContext(read(name), c);
  c.PluginUIHost.registerAction({ id: 'work.automation.create', command: '自动化',
    open: async seed => { opened = seed; return true; } });
  const action = c.PluginUIHost.actions()[0];
  const mention = { action: () => action, selected: () => picks, clearAction() {} };
  const mount = () => ({ querySelector: () => input });
  const context = { mount, dismissProposal() {}, bridge: () => ({}), model: () => 'fixture-model', mention };
  context.open = (command, options) => c.ChatWorkActions.open(command, options, context);
  c.NativeChat = { prepare() {}, clearDraft() {}, sessionInfo: () => info,
    openWorkAction: context.open };
  const options = { text: input.value, input, panel: { dataset: { stage: 'compose' } },
    hasAttachments: true, pluginMention: mention, mention,
    attachments: { analysis: () => new Promise(resolve => { release = resolve; }) } };
  return { c, input, mention, context, options, action,
    open: () => opened, refined: () => refined, info: value => { info = value; },
    picks: value => { picks = value; }, currentPicks: () => picks,
    finish: () => release([]),
    active() { c.WorkEntrySheet = { active: () => ({ actionId: action.id }),
      refine: async (text, details) => { refined = { text, details }; return true; } }; },
  };
}
const expected = (adapterId = 'qwen', repoId = 'repo-a', projectId = 'project-a') => ({
  adapterId, repoId, projectId, personalPluginKey: 'game-dev',
  plugins: [{ pluginId: 'local:game', key: 'game-dev', qualifiedKey: 'personal:game-dev',
    name: '小游戏插件', personal: true, version: '1.0.0' }],
});

for (const kind of ['compose', 'chat']) {
  test(kind + ' work action captures plugin and binding identities before attachment analysis', async () => {
    const f = fixture();
    f.options.bindingContext = { repoId: 'repo-a', projectId: 'project-a', adapterId: 'qwen',
      cwd: 'C:/not-a-repository', sidebarProjectId: 'local-group', seatId: 'device-seat' };
    const pending = kind === 'compose' ? f.c.ComposeWorkActions.route(f.options)
      : f.c.ChatWorkActions.route(f.options, f.context);
    f.options.bindingContext.repoId = 'repo-b';
    f.currentPicks()[0].key = 'changed-after-submit';
    f.picks([]);
    f.info({ ref: 'ref-b', sessionId: 'chat-b', repoId: 'repo-b', adapterId: 'codex-harness' });
    f.finish();
    assert.equal((await pending).accepted, true);
    assert.deepEqual(clone(f.open().bindingContext), expected());
    assert.doesNotMatch(JSON.stringify(f.open().bindingContext), /must-not-transfer|private instructions|inputValues|sidebarProjectId|seatId|cwd/);
  });
}

test('existing chat inherits only its actual structured repository, project and adapter', async () => {
  const f = fixture();
  const pending = f.c.ChatWorkActions.route(f.options, f.context);
  f.info({ ref: 'ref-b', sessionId: 'chat-b', repoId: 'repo-b', adapterId: 'codex-harness' });
  f.finish(); await pending;
  assert.deepEqual(clone(f.open().bindingContext), expected());
  assert.equal(f.open().bindingContext.assigneeId, undefined);
});

test('an unstarted native composer cannot turn its default adapter or seat into an automation binding', async () => {
  const f = fixture(); f.picks([]);
  f.info({ ref: '', sessionId: '', adapterId: 'pi', seatId: 'seat-a', cwd: 'C:/work', sidebarProjectId: 'local-project' });
  const pending = f.c.ChatWorkActions.route(f.options, f.context);
  f.finish(); await pending;
  assert.deepEqual(clone(f.open().bindingContext), {});
});

test('direct native action open snapshots the current picker without borrowing runtime active plugins', async () => {
  const f = fixture();
  await f.c.ChatWorkActions.open({ id: f.action.id, text: f.input.value }, {}, f.context);
  assert.deepEqual(clone(f.open().bindingContext), expected());
});

test('explicitly supplied empty bindings are not refilled from a later native view', async () => {
  const f = fixture();
  await f.c.ChatWorkActions.open({ id: f.action.id, text: f.input.value }, { bindingContext: {} }, f.context);
  assert.deepEqual(clone(f.open().bindingContext), {});
});

test('NativeChat work-intent adapter carries its live picker to direct action opens', async () => {
  const f = fixture();
  f.c.document.getElementById = id => id === 'nchatInput' ? f.input : null;
  vm.runInContext(read('chat-work-intent'), f.c);
  const intent = f.c.ChatWorkIntent.create({ _pluginMention: f.mention, _mount: f.context.mount,
    _taskAttachments: [], _sessionOptions: {} });
  await intent._openWorkAction({ id: f.action.id, text: f.input.value }, {});
  assert.deepEqual(clone(f.open().bindingContext), expected());
});

test('refinement receives the submission context while keeping form precedence with its controller', async () => {
  const f = fixture(); f.active();
  const pending = f.c.ChatWorkActions.route(f.options, f.context);
  f.picks([]); f.finish(); await pending;
  assert.deepEqual(clone(f.refined().details.bindingContext), expected());
});

test('multiple selected plugins remain explicit without silently choosing the first working method', () => {
  const f = fixture();
  const actual = f.c.PluginUIHost.captureBindingContext({}, [plugin(), { pluginId: 'team:other', key: 'other', personal: false }]);
  assert.equal(actual.plugins.length, 2);
  assert.equal(actual.personalPluginKey, undefined);
});

test('enterprise plugin identity is preserved without claiming a personal method by its name', () => {
  const f = fixture();
  const actual = f.c.PluginUIHost.captureBindingContext({ repoId: '', projectId: 'project-only',
    adapterId: '', seatId: 'seat', cwd: 'C:/repo', sidebarProjectId: 'sidebar' },
  [{ pluginId: 'team:game', name: '小游戏插件', key: 'game-dev', personal: false }]);
  assert.deepEqual(clone(actual), { projectId: 'project-only',
    plugins: [{ pluginId: 'team:game', name: '小游戏插件', key: 'game-dev', personal: false }] });
});

test('plugin-looking body text never becomes selected binding metadata', async () => {
  const f = fixture(); f.picks([]);
  f.input.value = '使用小游戏插件 /game-dev #game'; f.options.text = f.input.value;
  const pending = f.c.ChatWorkActions.route(f.options, f.context); f.finish(); await pending;
  const actual = clone(f.open().bindingContext);
  assert.equal(actual.personalPluginKey, undefined);
  assert.equal(actual.plugins, undefined);
});

test('blank compose passes the actual chosen adapter and independent engineering identities to its route', async () => {
  let received;
  const c = { _workspace: { repoId: 'repo-compose', projectId: 'project-compose', sidebarProjectId: 'local-group' },
    _composeViewSeq: 1, _menuSelectionSeq: 0, _pickedModel: 'model', _mode: 'standard', _skillPicker: null, _attachments: null,
    _pluginMention: {}, document: { getElementById: () => ({ value: 'create automation' }) },
    ComposeExecution: { value: () => 'local' }, ComposeRuntime: { value: () => 'codex-harness', accessSupported: () => false },
    ComposeWorkActions: { route: async options => { received = options; return { handled: true }; } },
    SoduWorkAPI: { taskStorageKey: () => 'owner' }, draftBridge: () => ({}), _panel: () => ({}),
  };
  c.window = c; c.global = c;
  const source = read('panels-compose');
  const start = source.indexOf('  async function makeDraft()');
  const end = source.indexOf('  function _openCreatedTask', start);
  assert(start >= 0 && end > start);
  vm.createContext(c); vm.runInContext(source.slice(start, end), c);
  await c.makeDraft();
  assert.equal(c._menuSelectionSeq, 1, 'submission invalidates a pending plugin menu selection');
  assert.deepEqual(clone(received.bindingContext), { repoId: 'repo-compose', projectId: 'project-compose', adapterId: 'codex-harness' });
});

test('new compose preserves an explicit repository and clears it on a later unbound entry', () => {
  let pickerClosures = 0;
  const panel = { classList: { add() {} }, dataset: {}, querySelector: () => ({ value: '' }) };
  const c = { _panel: () => panel, _rememberComposeDraft() {}, _restoreComposeDraft() {},
    _closeRequirementPicker() { pickerClosures++; },
    _chatOpenSeq: 0, _composeViewSeq: 0, _pluginResolveSeq: 0, _pluginSelectSeq: 0,
    _pluginResolveBusy: false, _pluginSelectError: '', _pluginSelectTask: null, _entryContextPrompts: [],
    _setupRevision: 0, _accessExplicit: false, _mode: 'standard', _workspace: { repoId: 'old-repo' },
    _usedAtts: [], _attachments: null, _skillPicker: null, _pluginMention: null, _intent: null,
    _accessConsent: null, _loadSetup() {}, setTab() {},
  };
  c.window = c; c.global = c; vm.createContext(c);
  vm.runInContext(read('compose-surface'), c);
  const source = read('panels-compose'), start = source.indexOf('  function openComposePanel(payload)');
  const end = source.indexOf('  function closeComposePanel()', start);
  assert(start >= 0 && end > start); vm.runInContext(source.slice(start, end), c);
  c.openComposePanel({ newSession: true, repoId: 'repo-current', projectId: 'project-current' });
  assert.equal(pickerClosures, 1, 'opening a new entry dismisses the previous requirement picker');
  assert.equal(c._workspace.repoId, 'repo-current');
  assert.equal(c._workspace.projectId, 'project-current');
  c.openComposePanel({ newSession: true, sidebarProjectId: 'sidebar-only' });
  assert.equal(pickerClosures, 2, 'the next entry also releases its previous picker');
  assert.equal(c._workspace.repoId, '');
  assert.equal(c._workspace.projectId, '');
});
