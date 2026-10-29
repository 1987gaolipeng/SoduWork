'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function fixture() {
  const context = { addEventListener() {}, esc: value => String(value || '') };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,
    '../components/panels/panels-agents.js'), 'utf8'), context);
  return context;
}
const broken = { key: 'dsh', name: 'DeepSeek Harness', state: 'missing', installed: false,
  bin: 'dsh-acp.cmd', warnNow: 'Runtime missing', why: 'Runtime missing' };

test('incomplete installations offer repair on both card and details, including old Runner responses', () => {
  const f = fixture();
  // Main now uses one canonical installation state across cards and drawers.
  assert.equal(f._agState(broken), 'broken');
  for (const html of [f._agRowHtml(broken, { runnerId: 'office' }),
    f._agBodyHtml(broken, f._agState(broken), 'office~dsh')]) {
    assert.match(html, /需要修复/);
    assert.match(html, /data-ainstall="office~dsh"[^>]*>修复安装/);
    assert.doesNotMatch(html, /data-aprobe=/);
  }
  const absent = { ...broken, bin: '' };
  assert.equal(f._agState(absent), 'missing');
  assert.match(f._agBodyHtml(absent, 'missing'), /data-ainstall="dsh"/);
  assert.doesNotMatch(f._agRowHtml(absent), /data-arepair=/);
  assert.equal(f._agState({ ...broken, key: 'harness2', bundled: true,
    warnNow: 'Google Harness² 需要 OpenCode 执行组件，请点「装上」自动准备。' }), 'setup');
  const ready = { ...broken, installed: true, state: 'ready' };
  assert.equal(f._agState(ready), 'ready');
  assert.match(f._agRowHtml(ready), /data-aprobe="dsh"/);
});

test('repair routes to the selected machine and blocks duplicate actions while accepting the job', async () => {
  const f = fixture(), calls = [];
  let accept;
  f.SoduWorkAPI = { agentInstall: (...args) => {
    calls.push(args); return new Promise(resolve => { accept = resolve; });
  } };
  f._agRender = () => {};
  f._agPoll = () => {};
  const started = f._agRun('office~dsh', 'repair');
  await f._agRun('office~dsh', 'repair');
  await f._agRun('office~dsh', 'install');
  assert.deepEqual(calls, [['dsh', 'update', 'office']]);
  for (const html of [f._agRowHtml(broken, { runnerId: 'office' }),
    f._agBodyHtml(broken, 'repair', 'office~dsh')]) {
    assert.match(html, /data-ainstall="office~dsh" disabled/);
  }
  accept({ jobId: 'accepted' });
  await started;
  assert.equal(vm.runInContext('_agJobs["office~dsh"].jobId', f), 'accepted');
  assert.match(f._agJobHtml({ key: 'office~dsh', action: 'repair', state: 'running' }), /正在修复安装/);
  assert.match(f._agJobHtml({ key: 'office~dsh', action: 'repair', state: 'done', ok: false }), /修复未完成/);
});

test('failed repair submission leaves an enabled retry without claiming success', async () => {
  const f = fixture();
  f.SoduWorkAPI = { agentInstall: async () => { throw Error('offline'); } };
  f._agRender = () => {};
  await f._agRun('office~dsh', 'repair');
  assert.equal(vm.runInContext('_agJobs["office~dsh"].ok', f), false);
  assert.doesNotMatch(f._agRowHtml(broken, { runnerId: 'office' }), /data-ainstall="office~dsh" disabled/);
});

test('reopening Agent management resumes the existing installation job without submitting another', () => {
  const f = fixture();
  let active = 0, next = 0;
  f.setInterval = () => { active++; return ++next; };
  f.clearInterval = () => { active--; };
  f.document = { getElementById: id => id === 'agPanel' ? { classList: { add() {}, remove() {} } } : null };
  f._agLoad = f._agRender = f._agDrawerSync = f._agSyncHeader = f._agArmRunnerRefresh = () => {};
  vm.runInContext('_agJobs = { "office~dsh": { state: "running", jobId: "existing" } }', f);
  f.openAgentsPanel();
  assert.equal(active, 1);
  f.closeAgentsPanel();
  assert.equal(active, 0);
  f.openAgentsPanel();
  f.openAgentsPanel();
  assert.equal(active, 1, 'Reopening must keep one polling timer');
  assert.equal(vm.runInContext('_agJobs["office~dsh"].jobId', f), 'existing');
  f.closeAgentsPanel();
});
