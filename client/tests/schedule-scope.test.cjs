'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture() {
  const events = {}, queues = {};
  const call = name => {
    const item = deferred(); (queues[name] ||= []).push(item); return item.promise;
  };
  const c = { console, Intl, Event, setTimeout, clearTimeout, esc: String,
    document: { getElementById: () => null },
    addEventListener: (name, fn) => { (events[name] ||= []).push(fn); },
    SoduWorkAPI: Object.fromEntries(['listSchedules', 'taskExecutionOptions', 'listRepos',
      'automationPlugins', 'listScheduleTemplates', 'listScheduleRuns'].map(name => [name, () => call(name)])),
    soduWorkAPI: { personalPlugins: { list: () => call('personal') } },
  };
  c.window = c; vm.createContext(c);
  for (const file of ['panels-schedules-methods.js', 'panels-schedules.js', 'panels-schedules-editor.js', 'panels-schedules-runs.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels', file), 'utf8'), c);
  c._renderSchPanel = () => {}; c._schRenderRunDrawer = () => {}; c._schRenderEditorDrawer = () => {};
  const run = source => vm.runInContext(source, c);
  const changeScope = () => (events['soduwork-data-scope-changed'] || []).forEach(fn => fn());
  function resolveLoad(index, label) {
    queues.listSchedules[index].resolve([{ id: label }]);
    queues.taskExecutionOptions[index].resolve({ substrates: [{ key: 'local:' + label }], availability: { agentReason: label } });
    queues.listRepos[index].resolve([{ id: label }]);
    queues.automationPlugins[index].resolve({ items: [{ bindingId: label, entrypoints: { automation: true } }] });
    queues.listScheduleTemplates[index].resolve([{ id: label }]);
    queues.personal[index].resolve({ items: [{ key: label, entrypoints: { automation: true } }] });
  }
  return { c, queues, run, changeScope, resolveLoad };
}

test('identity change clears automation catalogs, plans and run history', async () => {
  const f = fixture(), load = f.c._loadSch(); f.resolveLoad(0, 'old'); await load;
  f.run('_schRunRows.old = [{id:"old-run"}]; _schRunErrors.old = "old error"');
  f.changeScope();
  assert.equal(f.run('_schRows'), null);
  for (const name of ['_schAgents', '_schRepos', '_schTemplates', '_schmItems']) assert.equal(f.run(name + '.length'), 0, name);
  for (const name of ['_schPluginCache', '_schRunRows', '_schRunErrors']) assert.equal(f.run('Object.keys(' + name + ').length'), 0, name);
});

test('late old-identity loads cannot populate new catalogs or clear their in-flight requests', async () => {
  const f = fixture(), old = f.c._loadSch(); f.changeScope();
  const fresh = f.c._loadSch();
  assert.equal(f.queues.listSchedules.length, 2);
  f.resolveLoad(0, 'old'); await old;
  assert.equal(f.run('_schRows'), null);
  assert.ok(f.run('_schLoading')); assert.ok(f.run('_schAgentLoading')); assert.ok(f.run('_schmLoading'));
  assert.equal(f.run('Object.keys(_schPluginCache).length'), 0);
  f.resolveLoad(1, 'fresh'); await fresh;
  assert.equal(f.run('_schRows[0].id'), 'fresh');
  assert.equal(f.run('_schAgents[0].id'), 'local:fresh');
  assert.equal(f.run('_schRepos[0].id'), 'fresh');
  assert.equal(f.run('_schTemplates[0].id'), 'fresh');
  assert.equal(f.run('_schmItems[0].key'), 'fresh');
  assert.equal(f.run('_schPluginCache["\"][0].bindingId'), 'fresh');
});

test('late old-identity run history cannot reappear in the current account', async () => {
  const f = fixture();
  const old = f.c._schToggleRuns('old', true); f.changeScope();
  f.queues.listScheduleRuns[0].resolve([{ id: 'private-old-run' }]); await old;
  assert.equal(f.run('Object.keys(_schRunRows).length'), 0);
  assert.equal(f.run('_schRunOpen'), '');
});

test('late run submission cannot fetch history or reopen a drawer in another account', async () => {
  const f = fixture(), pending = deferred();
  f.run('_schRows = [{id:"old", title:"Old account work"}]');
  f.c.SoduWorkAPI.runSchedule = () => pending.promise;
  const old = f.c._schAct('run', 'old', { disabled: false, setAttribute() {} });
  f.changeScope(); pending.resolve({ ok: true });
  // A broken implementation issues dependent requests; settle them to expose
  // the stale state without leaving asynchronous work behind.
  await new Promise(resolve => setImmediate(resolve));
  if (f.queues.listSchedules) f.resolveLoad(0, 'unexpected');
  if (f.queues.listScheduleRuns) f.queues.listScheduleRuns[0].resolve([]);
  await old;
  assert.equal(f.queues.listScheduleRuns, undefined);
  assert.equal(f.run('_schRunOpen'), '');
});

test('legacy direct creation cannot clear or notify a new identity after its old save finishes', async () => {
  const f = fixture(), pending = deferred(), input = { value: 'Original draft', style: {} }, notices = [];
  f.c.document.getElementById = id => id === 'cpInput' ? input : null;
  f.c.petSay = text => notices.push(text);
  f.c._schLoadExecutionAgents = async () => [{ id: 'local:pi' }];
  f.c.SoduWorkAPI.createSchedule = () => pending.promise;
  const old = f.c._schmCreateAutomation('Original draft', { schedule: { every: 'daily' } });
  await new Promise(resolve => setImmediate(resolve));
  f.changeScope(); input.value = 'New account draft'; pending.resolve({ id: 'old-plan' });
  assert.equal(await old, false); assert.equal(input.value, 'New account draft'); assert.deepEqual(notices, []);
});

test('legacy creation checks its initiating view before saving and after receiving a receipt', async () => {
  for (const stage of ['options', 'save']) {
    const f = fixture(), pending = deferred(), notices = []; let current = true, creates = 0;
    f.c.petSay = text => notices.push(text);
    f.c._schLoadExecutionAgents = () => stage === 'options' ? pending.promise : Promise.resolve([{ id: 'local:pi' }]);
    f.c.SoduWorkAPI.createSchedule = () => { creates++; return pending.promise; };
    const old = f.c._schmCreateAutomation('Old view', { schedule: { every: 'daily' } }, { isCurrent: () => current });
    await new Promise(resolve => setImmediate(resolve)); current = false;
    pending.resolve(stage === 'options' ? [{ id: 'local:pi' }] : { id: 'old-plan' });
    assert.equal(await old, false);
    assert.equal(creates, stage === 'options' ? 0 : 1); assert.deepEqual(notices, []);
  }
});
