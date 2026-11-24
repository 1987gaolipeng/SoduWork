'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '../components/panels', name + '.js'), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  let owner = 'alice'; const events = [], layers = [], calls = { parse: 0, preflight: 0, create: 0 };
  const context = { Intl, setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame: fn => fn(),
    addEventListener: (name, fn) => events.push([name, fn]), PluginUIHost: { registerAction() {} },
    _schmLoad: async () => [{ key: 'report', name: '报告', version: '1', inputs: [] }],
    SoduWorkAPI: { taskStorageKey: () => owner,
      taskExecutionOptions: async () => ({ substrates: [{ key: 'local:pi', name: 'Pi' }], repos: [] }),
      parseTaskText: async () => { calls.parse++; return { title: '新自动化', note: '完整说明' }; },
      preflightSchedule: async (_body, options) => { assert.equal(options.force, true); calls.preflight++; return { state: 'ready' }; },
      createSchedule: async body => { calls.create++; return { ...body, id: 'saved-1' }; },
    } };
  context.window = context;
  context.FormData = class {
    constructor(form) { this.fields = form.elements; }
    get(key) { const field = this.fields[key]; return !field || field.disabled || field.type === 'checkbox' && !field.checked ? null : field.value; }
  };
  context.harnessMount = state => {
    const body = { _text: '', set innerHTML(value) { this._text = value; layer.form = null; }, get innerHTML() { return this._text; }, insertAdjacentHTML(_where, html) { this._text += html; } };
    const button = { disabled: false, textContent: '', classList: { remove() {} } }, error = { hidden: true, textContent: '' };
    const probe = { className: '', title: {}, detail: {}, querySelector(selector) { return selector === 'b' ? this.title : this.detail; } };
    const layer = { isConnected: true, body, button, probe, form: null, classList: { remove() {} },
      querySelector: selector => selector === '#wazProbe' ? probe : selector === '#wazBody' ? body : selector === '#wazForm' ? layer.form : selector === '#wazError' ? error : button,
      querySelectorAll: () => [button, ...Object.values(layer.form?.elements || {})] };
    state.layer = layer; state.surface = { inline: true, destroy() { layer.isConnected = false; } }; layers.push(layer); return body;
  };
  context.harnessRender = (state, error) => {
    const p = state.proposal, layer = state.layer, fields = {};
    for (const key of ['title', 'note', 'every', 'assigneeId', 'repoId', 'personalPluginKey', 'retryLimit', 'retryDelayMinutes', 'weekday'])
      fields[key] = { value: String(p[key] ?? ''), disabled: false };
    fields.acceptance = { value: (p.acceptance || []).join('\n') }; fields.clock = { value: `${p.atHour || 0}:${p.atMinute || 0}` };
    fields.minute = { value: String(p.atMinute || 0) }; fields.runAt = { value: context.ScheduleTiming.localInput(p.runAt, p.timeZone) };
    for (const key of ['flow', 'enabled']) fields[key] = { type: 'checkbox', checked: !!p[key], value: 'on' };
    layer.form = { elements: fields, querySelector: () => ({}), querySelectorAll: selector => selector === '[data-waz-method-input]'
      ? Object.entries(p.pluginInputs || {}).map(([key, value]) => ({ dataset: { wazMethodInput: key, inputType: typeof value }, value, checked: value })) : [] };
    layer.body._text = error || 'rendered';
  };
  vm.createContext(context);
  for (const name of ['schedule-timing', 'work-automation-bindings', 'work-automation-card-state']) vm.runInContext(read(name), context);
  const source = read('work-automation-sheet').replace('  global.WorkAutomationSheet = { open, active, refine, close };',
    '  mount = seed => harnessMount(state, seed); render = error => harnessRender(state, error); global.probe = {state,save,onChange,refreshAgents};\n  global.WorkAutomationSheet = { open, active, refine, close };');
  vm.runInContext(source, context);
  return { context, api: context.SoduWorkAPI, sheet: context.WorkAutomationSheet, probe: context.probe, calls, layers,
    switchOwner() { owner = 'bob'; events.filter(([name]) => name === 'soduwork-data-scope-changed').forEach(([, fn]) => fn()); } };
}
const proposal = { title: '原始计划', note: '完整要求', acceptance: ['检查完成'], every: 'once', runAt: '2099-10-16T04:00:00.000Z',
  timeZone: 'Asia/Shanghai', assigneeId: 'local:pi', repoId: '', personalPluginKey: 'report', pluginInputs: { audience: '研发组', includeDetail: true },
  retryLimit: 2, retryDelayMinutes: 5, enabled: true, requiredCapabilities: [] };
const restored = extra => ({ version: 1, cardId: 'card-a', phase: 'draft', proposal, ...extra });

test('unconfirmed drafts accept repeated relative-time edits without a parser and preserve the latest time on restore', async () => {
  const f = fixture();
  const sentAt = Date.parse('2099-11-16T12:13:00Z');
  const original = {...proposal, title:'5分钟后发送一句话提醒', runAt:'2099-11-16T12:18:00.000Z',
    note:'关键约束：\n1. 时间：5分钟后（相对时间，自需求提出时刻起算）；\n2. 内容：分析5分钟采样日志；',
    acceptance:['确认5分钟倒计时的起始时间点','保留5分钟采样日志']};
  await f.sheet.open({cardId:'repeat',cardState:restored({cardId:'repeat',proposal:original})});
  let parses = 0;
  f.api.parseTaskText = async () => { parses++; throw Error('parser unavailable'); };
  assert.equal(await f.sheet.refine('修改为10分钟以后', {requestedAt:sentAt}), true);
  let updated = f.sheet.capture().proposal;
  assert.equal(updated.runAt, '2099-11-16T12:23:00.000Z');
  assert.equal(updated.title, '10分钟后发送一句话提醒');
  assert.match(updated.note, /时间：10分钟后/);
  assert.match(updated.note, /分析5分钟采样日志/);
  assert.deepEqual(Array.from(updated.acceptance), ['确认10分钟倒计时的起始时间点','保留5分钟采样日志']);
  assert.equal(await f.sheet.refine('再改为十五分钟后', {requestedAt:sentAt + 60000}), true);
  updated = f.sheet.capture().proposal;
  assert.equal(updated.runAt, '2099-11-16T12:29:00.000Z');
  assert.equal(updated.title, '15分钟后发送一句话提醒');
  assert.match(updated.note, /时间：15分钟后/);
  assert.equal(updated.acceptance[0], '确认15分钟倒计时的起始时间点');
  assert.equal(updated.pluginInputs.audience, '研发组');
  assert.equal(parses, 0); assert.equal(f.calls.create, 0);
  const snapshot = f.sheet.capture(); f.sheet.close(true);
  await f.sheet.open({cardId:'repeat',cardState:snapshot});
  assert.equal(f.sheet.capture().proposal.runAt, updated.runAt);
  assert.equal(f.sheet.capture().phase, 'draft');
});

test('saved automation edits update the original ID and cancelling edits restores its receipt', async () => {
  const f = fixture(), updates = [];
  f.api.updateSchedule = async (id, body) => { updates.push({id, body}); return {...proposal, id, ...body}; };
  await f.sheet.open({cardId:'card-a', cardState:restored()});
  await f.probe.save();
  assert.equal(f.calls.create, 1);
  assert.match(f.probe.state.layer.body.innerHTML, /data-waz-edit/);
  assert.match(f.probe.state.layer.body.innerHTML, /data-waz-pause/);
  assert.equal(f.sheet.acceptsFollowup('修改这个自动化'), true);
  assert.equal(f.sheet.acceptsFollowup('今天聊聊别的事情'), false);
  f.api.parseTaskText = async () => ({title:proposal.title,note:proposal.note});
  const sentAt = Date.parse('2099-11-16T08:00:00Z');
  assert.equal(await f.sheet.refine('改为十分钟后', {requestedAt:sentAt}), true);
  assert.equal(f.sheet.capture().proposal.runAt, '2099-11-16T08:10:00.000Z');
  assert.equal(updates.length, 0, 'preview must not write before confirmation');
  assert.equal(f.sheet.cancel(), true);
  assert.equal(f.sheet.capture().phase, 'succeeded');
  assert.equal(f.sheet.capture().proposal.runAt, proposal.runAt);
  await f.sheet.refine('改为十分钟后', {requestedAt:sentAt});
  await f.probe.save();
  assert.equal(f.calls.create, 1, 'editing must not create a second schedule');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, 'saved-1');
  assert.equal(updates[0].body.runAt, '2099-11-16T08:10:00.000Z');
  assert.equal(Object.hasOwn(updates[0].body, 'note'), false, 'unchanged work must not overwrite server updates');
  assert.equal(f.sheet.capture().editBase, null);
});

test('pausing a saved automation only writes enabled=false to the original ID', async () => {
  const f = fixture(), updates = [];
  f.api.updateSchedule = async (id, body) => { updates.push({id,body}); return {...proposal,id,...body}; };
  await f.sheet.open({cardId:'card-a',cardState:restored({phase:'succeeded',createdId:'existing',receipt:{...proposal,id:'existing'}})});
  await f.probe.save(true);
  assert.equal(f.calls.create, 0); assert.equal(f.calls.preflight, 0);
  assert.equal(updates[0].id, 'existing');
  assert.deepEqual(JSON.parse(JSON.stringify(updates[0].body)), {enabled:false});
  assert.match(f.probe.state.layer.body.innerHTML, /自动化已停用/);
  assert.doesNotMatch(f.probe.state.layer.body.innerHTML, /data-waz-pause/);
});

test('editing can remove an unavailable plugin without validating or reapplying its old binding', async () => {
  const f=fixture(), updates=[];
  await f.sheet.open({cardId:'existing',cardState:restored({phase:'succeeded',createdId:'existing',receipt:{...proposal,id:'existing'}})});
  f.api.updateSchedule=async(id, body)=>{updates.push(body);return {...proposal,id,...body};};
  f.probe.state.methods=[];
  f.sheet.startEdit();
  const field=f.probe.state.layer.form.elements.personalPluginKey;
  field.value='';field.name='personalPluginKey';field.closest=()=>f.probe.state.layer.form;
  f.probe.onChange({type:'change',target:field});
  await f.probe.save();
  assert.equal(updates.length,1);assert.equal(updates[0].personalPluginKey,'');
  assert.equal(updates[0].personalPluginVersion,'');assert.equal(updates[0].personalPluginChecksum,'');
  assert.equal(f.sheet.capture().phase,'succeeded');assert.equal(f.calls.create,0);
});

test('cancelling during initial parsing persists cancellation and ignores the late result', async () => {
  const f = fixture(), pending = deferred(); let last;
  f.api.parseTaskText = () => pending.promise;
  const opening = f.sheet.open({cardId:'cancel-card',text:'五分钟后生成日报',onCardState:s => {last=s;}});
  await tick();
  assert.equal(f.sheet.cancel(), true);
  assert.equal(last.phase, 'cancelled');
  pending.resolve({title:'迟到的计划',note:'生成日报'}); await opening;
  assert.equal(last.phase, 'cancelled'); assert.equal(f.calls.create, 0);
  await f.sheet.open({cardId:'cancel-card',cardState:last});
  assert.equal(f.sheet.active(), null); assert.equal(f.sheet.acceptsFollowup('改为十分钟后'), false);
});

test('a conversational cancel dismisses a draft, while cancelling a saved task previews disabling it', async () => {
  const f=fixture(); let last;
  await f.sheet.open({cardId:'new',cardState:restored(),onCardState:s=>{last=s;}});
  assert.equal(await f.sheet.refine('取消这个自动化'),true);
  assert.equal(last.phase,'cancelled');assert.equal(f.sheet.hasSurface(),false);assert.equal(f.calls.create,0);
  await f.sheet.open({cardId:'saved',cardState:restored({phase:'succeeded',createdId:'saved',receipt:{...proposal,id:'saved'}})});
  assert.equal(await f.sheet.refine('取消这个自动化'),true);
  assert.equal(f.sheet.capture().phase,'draft');assert.equal(f.sheet.capture().proposal.enabled,false);
  assert.equal(f.sheet.capture().editBase.proposal.enabled,true);
});

test('messages arriving during initial parsing and consecutive refinements keep their order and timestamp', async () => {
  const f = fixture(), initial = deferred(), firstEdit = deferred(); let calls=0;
  f.api.parseTaskText = async () => ++calls === 1 ? initial.promise : firstEdit.promise;
  const sentAt = Date.parse('2099-11-16T08:00:00Z');
  const opening = f.sheet.open({cardId:'queued',text:'五分钟后生成日报',requestedAt:sentAt});
  await tick();
  const first = f.sheet.refine('改为十分钟后', {requestedAt:sentAt + 60000});
  const second = f.sheet.refine('增加来源链接', {requestedAt:sentAt + 120000});
  initial.resolve({title:'日报',note:'生成日报'}); await opening; await tick();
  firstEdit.resolve({title:'日报',note:'生成日报并附链接'});
  assert.equal(await first, true); assert.equal(await second, true);
  assert.equal(calls, 2);
  assert.equal(f.sheet.capture().proposal.runAt, '2099-11-16T08:11:00.000Z');
  assert.equal(f.sheet.capture().proposal.note, '生成日报并附链接');
});

test('initial parser latency cannot move a relative deadline and restoring the card does not reanchor it', async () => {
  const f = fixture(), pending=deferred(); let clock=Date.parse('2099-11-16T08:00:00Z');
  f.context.Date = class extends Date {static now() {return clock;}};
  f.api.parseTaskText = () => pending.promise;
  const opening = f.sheet.open({cardId:'relative',text:'五分钟后生成日报'});
  await tick(); clock+=120000;
  pending.resolve({title:'日报',note:'生成日报'}); await opening;
  assert.equal(f.sheet.capture().proposal.runAt, '2099-11-16T08:05:00.000Z');
  const snapshot=f.sheet.capture(); f.sheet.close(true); clock+=60000;
  await f.sheet.open({cardId:'relative',cardState:snapshot});
  assert.equal(f.sheet.capture().proposal.runAt, '2099-11-16T08:05:00.000Z');
});

test('cancelling an in-flight edit preserves the saved task and cannot be undone by its parser', async () => {
  const f = fixture(), pending=deferred();
  await f.sheet.open({cardId:'existing',cardState:restored({phase:'succeeded',createdId:'existing',receipt:{...proposal,id:'existing'}})});
  f.api.parseTaskText = () => pending.promise;
  const updating = f.sheet.refine('修改任务内容'); await tick();
  assert.equal(f.sheet.cancel(), true);
  pending.resolve({title:'不能覆盖',note:'迟到结果'});
  assert.equal(await updating, false);
  assert.equal(f.sheet.capture().phase, 'succeeded');
  assert.equal(f.sheet.capture().proposal.title, proposal.title);
  assert.equal(f.calls.create, 0);
});

test('a recovered automation catalog replaces a deleted model with its first available model', async () => {
  const f = fixture(), name = 'local:model-0123456789abcdef0123456789abcdef';
  f.api.myModels = async () => { throw Error('Temporary secure catalog failure'); };
  await f.sheet.open({ proposal: { ...proposal, modelName: '' } });
  assert.equal(f.probe.state.proposal.modelName, '');
  f.api.myModels = async () => ({ usable: [{ name, localOnly: true }], defaultModelErrors: { pi: 'No Hub default' } });
  await f.probe.refreshAgents({ disabled: false });
  assert.equal(f.probe.state.proposal.modelName, name);
  const removed = 'local:model-fedcba9876543210fedcba9876543210';
  f.probe.state.proposal.modelName = removed;
  await f.probe.refreshAgents({ disabled: false });
  assert.equal(f.probe.state.proposal.modelName, name);
});

test('an older automation catalog response cannot overwrite a newer refresh and its automatic single model', async () => {
  const f = fixture(); await f.sheet.open({ proposal: { ...proposal, modelName: '' } });
  const old = deferred(), newer = deferred(); let calls = 0;
  f.api.taskExecutionOptions = () => (++calls === 1 ? old.promise : newer.promise);
  const a = f.probe.refreshAgents({ disabled: false }), b = f.probe.refreshAgents({ disabled: false });
  const result = name => ({ substrates: [{ key: 'local:pi', cli: 'pi', modelPick: true }], modelOptions: [{ name }] });
  newer.resolve(result('new-model')); await b;
  old.resolve(result('old-model')); await a;
  assert.equal(f.probe.state.proposal.modelName, 'new-model');
  assert.deepEqual(Array.from(f.probe.state.modelOptions, row => row.name), ['new-model']);
});

test('ordinary enabled automation receipts with empty provenance remain ordinary', async () => {
  const f = fixture(); let submitted;
  await f.sheet.open({proposal: {...proposal, sourceRequirement: {}}});
  assert.equal(f.sheet.capture().proposal.enabled, true);
  f.api.createSchedule = async body => {submitted = body; return {...body, id: 'ordinary', sourceRequirement: {}};};
  await f.probe.save();
  assert.equal(submitted.enabled, true);
  assert.equal(Object.hasOwn(submitted, 'sourceRequirement'), false);
  const html = f.context.WorkAutomationCardState.savedHtml({...proposal, sourceRequirement: {}}, null, null, String);
  assert.match(html, /自动化已创建/);
  assert.doesNotMatch(html, /草稿|尚未启用|来源需求/);
});

test('automation option loading preserves managed and native model choices', async () => {
  const f = fixture();
  f.api.taskExecutionOptions = async () => ({
    substrates: [
      { key: 'local:pi', name: 'Pi', modelPick: true },
      { key: 'local:codex', name: 'Codex', nativeModelPick: true },
    ],
    modelOptions: [{ name: 'configured-model', label: 'Configured model' }],
    defaultModel: 'configured-model', repos: [],
  });
  f.api.myModels = async () => ({ usable: [
    { id: 'local:model-0123456789abcdef0123456789abcdef', name: 'local:model-0123456789abcdef0123456789abcdef',
      modelName: 'glm5.2', label: 'glm5.2', providerName: '自己模型', localOnly: true },
  ] });
  f.context.soduWorkAPI = {
    conversationSession: {
      runtimeModels: async () => ({ models: [{ id: 'codex-account-model', label: 'Codex account model' }] }),
    },
  };

  const loaded = await f.context.WorkAutomationCardState.loadOptions({ text: 'daily report' });
  assert.equal(loaded.modelOptions[0].name, 'local:model-0123456789abcdef0123456789abcdef');
  assert.equal(loaded.modelOptions[0].localOnly, true);
  assert.equal(loaded.modelOptions[1].name, 'configured-model');
  assert.equal(loaded.defaultModel, 'local:model-0123456789abcdef0123456789abcdef');
  assert.equal(loaded.agents[0].modelPick, true);
  assert.equal(loaded.agents[0].nativeModelPick, false);
  assert.equal(loaded.agents[1].nativeModelPick, true);
  assert.deepEqual(loaded.agents[1].modelOptions, [{ id: 'codex-account-model', label: 'Codex account model' }]);
  assert.doesNotMatch(read('work-automation-sheet'), /本机模型仅支持本机对话；后台自动化需要 Hub 托管模型/);
});

test('automation defaults to a local model when the available managed base is not Pi', async () => {
  const f = fixture();
  f.api.taskExecutionOptions = async () => ({
    substrates: [{ key: 'local:qwen', name: 'Qwen Code', cli: 'qwen', modelPick: true,
      locationMode: 'local', available: true }],
    modelOptions: [], defaultModel: '', repos: [],
  });
  f.api.myModels = async () => ({ usable: [
    { id: 'local:model-abcdefabcdefabcdefabcdefabcdefab', name: 'local:model-abcdefabcdefabcdefabcdefabcdefab',
      modelName: 'qwen-local', label: 'Qwen Local', providerName: '本地服务', localOnly: true },
  ] });

  const loaded = await f.context.WorkAutomationCardState.loadOptions({ text: 'local automation' });
  assert.equal(loaded.defaultModel, 'local:model-abcdefabcdefabcdefabcdefabcdefab');
  assert.equal(loaded.agents[0].id, 'local:qwen');
});

for (const source of ['local', 'Hub']) test('new automation cards choose their only ' + source + ' model without inventing a default placeholder', async () => {
  const f = fixture(), name = source === 'local' ? 'local:model-0123456789abcdef0123456789abcdef' : 'only-hub-model';
  f.api.taskExecutionOptions = async () => ({ substrates: [{ key: 'local:qwen', cli: 'qwen', modelPick: true }],
    modelOptions: source === 'Hub' ? [{ name }] : [], defaultModel: '' });
  f.api.myModels = async () => ({ usable: source === 'local' ? [{ name, localOnly: true }] : [],
    defaultModels: {}, defaultModelErrors: { qwen: 'No default is configured' } });
  assert.equal((await f.context.WorkAutomationCardState.loadOptions({})).defaultModel, name);
  f.api.myModels = async () => ({ usable: source === 'local' ? [{ name, localOnly: true }] : [],
    defaultModels: { qwen: 'local:model-fedcba9876543210fedcba9876543210' }, defaultModelErrors: { qwen: 'Deleted Agent default' } });
  assert.equal((await f.context.WorkAutomationCardState.loadOptions({})).defaultModel, name,
    'a new automation chooses its sole model rather than inheriting an old unavailable Agent default');
  const catalogs = { agents: [{ id: 'local:codex', cli: 'codex', modelPick: false }], modelOptions: [{ name }] };
  assert.equal(f.context.WorkAutomationCardState.defaultModelFor(catalogs, 'local:codex'), '');
  catalogs.agents[0].nativeModelPick = true; catalogs.agents[0].modelOptions = [{ id: 'account-model' }];
  assert.equal(f.context.WorkAutomationCardState.defaultModelFor(catalogs, 'local:codex'), '');
  assert.equal(f.context.WorkAutomationCardState.defaultModelFor(catalogs, 'local:codex', 'account-model'), 'account-model');
});

test('automation cards default to the first local model while explicit available choices remain selectable', async () => {
  const f = fixture(), first = 'local:model-0123456789abcdef0123456789abcdef', preferred = 'local:model-fedcba9876543210fedcba9876543210';
  f.api.taskExecutionOptions = async () => ({ substrates: [
    { key: 'local:qwen', cli: 'qwen', modelPick: true },
    { key: 'runner:other:qwen', cli: 'qwen', locationMode: 'remote', modelPick: true },
  ], modelOptions: [{ name: 'managed-model' }], defaultModel: 'managed-model' });
  const catalog = { usable: [{ name: first, localOnly: true }, { name: preferred, localOnly: true }],
    defaultModels: { qwen: preferred }, defaultModelErrors: {} };
  f.api.myModels = async () => catalog;
  let loaded = await f.context.WorkAutomationCardState.loadOptions({});
  assert.equal(loaded.defaultModel, first);
  assert.equal(f.context.WorkAutomationCardState.defaultModelFor(loaded, 'runner:other:qwen'), 'managed-model');
  catalog.usable = [{ name: first, localOnly: true }]; catalog.defaultModelErrors.qwen = 'Deleted';
  loaded = await f.context.WorkAutomationCardState.loadOptions({});
  assert.equal(loaded.defaultModel, first);
});

test('automation cards preserve concrete local and remote Runner identities and query only local account catalogs', async () => {
  const f = fixture(), queried = [];
  f.api.taskExecutionOptions = async () => ({ substrates: [
    { key: 'local:qwen', cli: 'qwen', modelPick: true, locations: [
      { assigneeId: 'runner:desk:qwen', mode: 'local', clientId: 'current-device', runnerId: 'desk', label: 'Local desk' },
      { assigneeId: 'runner:cloud:qwen', mode: 'remote', clientId: 'other-device', runnerId: 'cloud', label: 'Cloud' },
    ] },
    { key: 'local:codex', cli: 'codex', nativeModelPick: true, locations: [
      { assigneeId: 'runner:desk:codex', mode: 'local', clientId: 'current-device' },
      { assigneeId: 'runner:cloud:codex', mode: 'remote', clientId: 'other-device' },
    ] },
  ] });
  f.context.soduWorkAPI = { conversationSession: { runtimeModels: async id => { queried.push(id); return { models: [{ id: 'account-model' }] }; } } };
  const loaded = await f.context.WorkAutomationCardState.loadOptions({ text: 'report' });
  assert.deepEqual(Array.from(loaded.agents, row => row.id), ['runner:desk:qwen', 'runner:cloud:qwen', 'runner:desk:codex', 'runner:cloud:codex']);
  assert.equal(loaded.agents[0].clientId, 'current-device');
  assert.equal(loaded.agents[0].mode, 'local');
  assert.equal(loaded.agents[1].mode, 'remote');
  assert.equal(loaded.agents[3].nativeModelPick, false);
  assert.deepEqual(queried, ['codex']);
});

for (const phase of ['options', 'models', 'native']) test('automation catalog discards stale account responses during ' + phase, async () => {
  const f = fixture(), wait = deferred(); let fallback = 0;
  f.api.listAIAgents = async () => { fallback++; return { agents: [] }; };
  const result = { substrates: [{ key: 'local:codex', cli: 'codex', nativeModelPick: true }] };
  f.api.taskExecutionOptions = () => phase === 'options' ? wait.promise : Promise.resolve(result);
  f.api.myModels = () => phase === 'models' ? wait.promise : Promise.resolve({ usable: [] });
  f.context.soduWorkAPI = { conversationSession: { runtimeModels: () => phase === 'native' ? wait.promise : Promise.resolve({ models: [] }) } };
  const pending = f.context.WorkAutomationCardState.loadOptions({ text: 'old account report' });
  await tick(); f.switchOwner(); wait.resolve(phase === 'options' ? result : phase === 'models' ? { usable: [] } : { models: [] });
  await assert.rejects(pending, error => error.code === 'STALE_TASK_SCOPE');
  assert.equal(fallback, 0);
});

test('requirement entry is an independent disabled draft and cancel creates nothing', async () => {
  const f = fixture();
  const source = {id: 'requirement-one', title: '<Original requirement>', requirementVersion: 3};
  await f.sheet.open({sourceRequirement: source, proposal: {...proposal, enabled: true}});
  assert.equal(f.sheet.capture().proposal.enabled, false);
  assert.equal(f.calls.create, 0); assert.equal(f.calls.parse, 0);
  f.sheet.close();
  assert.equal(f.calls.create, 0);
  await f.sheet.open({sourceRequirement: source, proposal: {...proposal, enabled: true}});
  const bodies = [];
  f.api.createSchedule = async body => {bodies.push(body); return {...body, id: 'saved-source', sourceRequirement: source};};
  f.probe.state.layer.form.elements.enabled.checked = true;
  await f.probe.save();
  assert.equal(bodies.length, 1); assert.equal(bodies[0].enabled, false);
  assert.deepEqual(JSON.parse(JSON.stringify(bodies[0].sourceRequirement)), {id: source.id, requirementVersion: 3});
  assert.match(bodies[0].creationRequestId, /^automation-/);
  assert.match(f.probe.state.layer.body.innerHTML, /自动化草稿已保存/);
  assert.match(f.probe.state.layer.body.innerHTML, /&lt;Original requirement&gt;/);
  assert.doesNotMatch(f.probe.state.layer.body.innerHTML, /<Original requirement>/);
});

test('requirement draft retry retains the same creation identity after a lost response', async () => {
  const f = fixture(), bodies = [];
  await f.sheet.open({sourceRequirement: {id: 'source', title: 'Original', requirementVersion: 3}, proposal});
  f.api.createSchedule = async body => {
    bodies.push(JSON.parse(JSON.stringify(body)));
    if (bodies.length === 1) throw new Error('Response lost after save');
    return {...body, id: 'one-draft'};
  };
  await f.probe.save();
  assert.equal(f.sheet.capture().uncertain, false);
  await f.probe.save();
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1], bodies[0]);
  assert.equal(f.sheet.capture().createdId, 'one-draft');
});

test('account switching during requirement preflight prevents its creation', async () => {
  const f = fixture(), preflight = deferred();
  f.api.preflightSchedule = () => preflight.promise;
  await f.sheet.open({sourceRequirement: {id: 'source', title: 'Original', requirementVersion: 3}, proposal});
  const saving = f.probe.save();
  f.switchOwner(); preflight.resolve({state: 'ready'}); await saving;
  assert.equal(f.calls.create, 0);
});

test('恢复原时间、参数和手动字段，不再次解析或推断相对日期', async () => {
  const f = fixture(), snapshots = [];
  f.context.ScheduleTiming.infer = () => { throw Error('恢复不能重新推断日期'); };
  await f.sheet.open({ cardId: 'card-a', text: '今天中午执行', cardState: restored(), onCardState: s => snapshots.push(s) });
  assert.equal(f.calls.parse, 0); assert.equal(f.sheet.capture().proposal.runAt, proposal.runAt);
  assert.equal(f.sheet.capture().proposal.pluginInputs.audience, '研发组');
  f.probe.state.layer.form.elements.note.value = '最新手动修改';
  assert.equal(f.sheet.capture().proposal.note, '最新手动修改');
  assert.equal(snapshots.at(-1).proposal.note, '最新手动修改');
  assert.doesNotThrow(() => JSON.stringify(f.sheet.capture()));
});

test('保存中切走再回来保持原值和单次请求，完成回执自动更新恢复的卡片', async () => {
  const f = fixture(), preflight = deferred(), created = deferred(), snapshots = []; let onCreated = 0;
  f.api.preflightSchedule = async () => { f.calls.preflight++; return preflight.promise; };
  f.api.createSchedule = async body => { f.calls.create++; assert.equal(body.note.startsWith('完整要求'), true); return created.promise; };
  await f.sheet.open({ cardId: 'card-a', cardState: restored(), onCardState: s => snapshots.push(s), onCreated: () => onCreated++ });
  const saving = f.probe.save(), snapshot = f.sheet.capture();
  assert.equal(snapshot.phase, 'submitting'); assert.equal(snapshot.proposal.note, '完整要求');
  f.sheet.close(true); await f.sheet.open({ cardId: 'card-a', cardState: snapshot });
  await f.probe.save(); assert.equal(f.calls.preflight, 1); assert.equal(f.sheet.capture().phase, 'submitting');
  preflight.resolve({ state: 'ready' }); await tick(); assert.equal(f.calls.create, 1);
  created.resolve({ id: 'schedule-one', title: '原始计划' }); await saving;
  assert.equal(f.sheet.capture().phase, 'succeeded'); assert.equal(f.sheet.capture().createdId, 'schedule-one');
  assert.equal(snapshots.at(-1).phase, 'succeeded'); assert.equal(onCreated, 0);
  assert.match(f.probe.state.layer.body.innerHTML, /自动化已创建/);
});

test('迟到创建结果写回原卡，不污染新会话或调用旧页面回调', async () => {
  const f = fixture(), created = deferred(), a = [], b = []; let callback = 0;
  f.api.createSchedule = () => created.promise;
  await f.sheet.open({ cardId: 'card-a', cardState: restored(), onCardState: s => a.push(s), onCreated: () => callback++ });
  const saving = f.probe.save(); await tick(); f.sheet.close(true);
  await f.sheet.open({ cardId: 'card-b', cardState: restored({ cardId: 'card-b', proposal: { ...proposal, title: '另一条计划' } }), onCardState: s => b.push(s) });
  created.resolve({ id: 'schedule-a' }); await saving;
  assert.equal(a.at(-1).createdId, 'schedule-a'); assert.equal(f.sheet.capture().proposal.title, '另一条计划');
  assert.equal(f.sheet.capture().phase, 'draft'); assert.equal(b.some(s => s.createdId), false); assert.equal(callback, 0);
});

test('跨重启恢复未确认的提交只允许查询，不当作未创建重新发送', async () => {
  const f = fixture(); await f.sheet.open({ cardId: 'card-a', cardState: restored({ phase: 'submitting' }) });
  const snapshot = f.sheet.capture(); assert.equal(snapshot.phase, 'error'); assert.equal(snapshot.uncertain, true);
  assert.match(snapshot.error, /查询.*重复提交/); assert.equal(f.probe.state.layer.button.disabled, true);
  await f.probe.save(); assert.equal(f.calls.create, 0); assert.equal(f.calls.preflight, 0);
});

test('导航卸载不通知关闭；显式关闭保留草稿并回调原卡', async () => {
  const f = fixture(); let closed = 0, legacyClosed = 0;
  const seed = { cardId: 'card-a', cardState: restored(), onCardClose: s => { closed++; assert.equal(s.proposal.title, proposal.title); }, onClose: () => legacyClosed++ };
  await f.sheet.open(seed); assert.equal(f.sheet.hasSurface(), true); f.sheet.close(true);
  assert.equal(closed, 0); assert.equal(legacyClosed, 0); assert.equal(f.sheet.hasSurface(), false);
  await f.sheet.open(seed); f.sheet.close(); assert.equal(closed, 1); assert.equal(legacyClosed, 1);
});

test('迟到解析可保留原卡结果，账号切换后不得保存旧账号回执', async () => {
  const f = fixture(), parsed = deferred(), states = [];
  f.api.parseTaskText = () => parsed.promise;
  const opening = f.sheet.open({ cardId: 'card-a', text: '每天检查', onCardState: s => states.push(s) });
  await tick(); f.sheet.close(true);
  await f.sheet.open({ cardId: 'card-b', cardState: restored({ cardId: 'card-b' }) });
  parsed.resolve({ title: '原卡解析结果', note: '原要求' }); await opening;
  assert.equal(states.at(-1).proposal.title, '原卡解析结果'); assert.equal(f.sheet.capture().cardId, 'card-b');
  const created = deferred(); f.api.createSchedule = () => created.promise;
  const seed = { cardId: 'card-c', cardState: restored({ cardId: 'card-c' }), onCardState: s => states.push(s) };
  await f.sheet.open(seed); const saving = f.probe.save(); await tick(); const count = states.length;
  f.switchOwner(); created.resolve({ id: 'old-account' }); await saving;
  assert.equal(states.length, count); assert.equal(f.sheet.capture(), null);
});

test('预检失败保留草稿并可重试，创建请求失败则先确认服务端结果', async () => {
  const f = fixture(); let attempts = 0;
  f.api.preflightSchedule = async () => { attempts++; return { state: 'blocked', message: 'Runner 不在线' }; };
  await f.sheet.open({ cardId: 'card-a', cardState: restored() });
  await f.probe.save();
  assert.equal(f.sheet.capture().phase, 'error'); assert.equal(f.sheet.capture().uncertain, false);
  assert.equal(f.sheet.capture().proposal.note, proposal.note); assert.equal(f.calls.create, 0);
  await f.probe.save(); assert.equal(attempts, 2);
  f.api.preflightSchedule = async () => ({ state: 'ready' });
  f.api.createSchedule = async () => { f.calls.create++; throw Error('连接在响应前中断'); };
  await f.probe.save();
  assert.equal(f.sheet.capture().uncertain, true); assert.match(f.sheet.capture().error, /查询/);
  await f.probe.save(); assert.equal(f.calls.create, 1);
});

test('跨重启恢复整理中的卡片不重新调用模型，原字段保持可编辑', async () => {
  const f = fixture();
  await f.sheet.open({ cardId: 'card-a', cardState: restored({ phase: 'loading' }) });
  assert.equal(f.calls.parse, 0); assert.equal(f.sheet.capture().phase, 'error');
  assert.match(f.sheet.capture().error, /整理未完成/); assert.equal(f.sheet.capture().proposal.runAt, proposal.runAt);
});

test('补充解析失败保留原手动字段及错误状态，不能把网关失败标成整理成功', async () => {
  const f = fixture(); let refined = 0;
  await f.sheet.open({ cardId: 'card-a', cardState: restored(), onRefined: () => refined++ });
  f.api.parseTaskText = async () => ({ _parseError: '模型网关暂时不可用' });
  const accepted = await f.sheet.refine('标题改为下周巡检');
  assert.equal(accepted, false); assert.equal(f.sheet.capture().phase, 'error');
  assert.equal(f.sheet.capture().proposal.title, proposal.title);
  assert.equal(f.sheet.capture().proposal.pluginInputs.audience, '研发组'); assert.equal(refined, 0);
});

test('refinement retains the safe provider cause instead of reporting an automation creation failure', async () => {
  const f=fixture();
  f.context._humanErr=(_error,fallback)=>fallback;
  await f.sheet.open({cardId:'parse-error',cardState:restored()});
  f.api.parseTaskText=async()=>({_parseError:'本地模型服务返回错误（HTTP 401），请检查模型服务凭据'});
  assert.equal(await f.sheet.refine('标题改为巡检'),false);
  assert.match(f.sheet.capture().error,/HTTP 401.*模型服务凭据/);
  assert.doesNotMatch(f.sheet.capture().error,/没有创建成功/);
  assert.equal(f.calls.create,0);
});

test('创建前等待提交意图写入会话，写入失败不调用服务端且允许明确重试', async () => {
  const f = fixture(), persisted = deferred(); let attempts = 0;
  await f.sheet.open({ cardId: 'card-a', cardState: restored(), onBeforeSubmit: snapshot => {
    attempts++; assert.equal(snapshot.phase, 'submitting'); assert.equal(snapshot.proposal.note, proposal.note);
    return attempts === 1 ? persisted.promise : Promise.resolve();
  } });
  const saving = f.probe.save(); await tick();
  assert.equal(attempts, 1); assert.equal(f.calls.create, 0);
  persisted.reject(Error('会话存储写入失败')); await saving;
  assert.equal(f.sheet.capture().phase, 'error'); assert.equal(f.sheet.capture().uncertain, false);
  assert.match(f.sheet.capture().error, /存储写入失败/); assert.equal(f.calls.create, 0);
  await f.probe.save(); assert.equal(attempts, 2); assert.equal(f.calls.create, 1);
  assert.equal(f.sheet.capture().phase, 'succeeded');
});
