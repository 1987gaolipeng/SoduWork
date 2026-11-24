const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('team view never substitutes fictional business data', () => {
  const source = read('components', 'team', 'team.js');
  assert.doesNotMatch(source, /SAMPLE_(TEAM|SOURCES|CLIENTS|WEEK)|useSample/);
  assert.doesNotMatch(source, /3 款皮肤|苏晓|林越|周桐|陈默/);
  assert.match(source, /useUnavailable/);
  assert.match(source, /SoduWork 不会用示例员工代替真实数据/);
});

function officeFixture(tasks) {
  const source = read('components', 'panels', 'panels-aidesk-office.js');
  const context = {
    _deskData: { tasks: tasks || [], reason: 'No runner is connected' },
    _dkPick: '__all__', _dkPhase: 'all',
    _DK_PHASE: {
      running: { cls: 'run', short: 'Working', name: 'Working' },
      waiting: { cls: 'wait', short: 'Waiting', name: 'Waiting' },
      failed: { cls: 'bad', short: 'Failed', name: 'Failed' },
      done: { cls: 'done', short: 'Done', name: 'Done' },
    },
    esc: (value) => String(value == null ? '' : value),
    _sinceTxt: () => 'now',
    _dkTasksFor: (desk) => desk && desk.tasks ? desk.tasks : (tasks || []),
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'panels-aidesk-office.js' });
  return {
    scene: vm.runInContext('_dkOfficeSceneHtml', context),
  };
}

test('idle AI office gives a truthful start path instead of a zero dashboard', () => {
  const office = officeFixture([]);
  const scene = office.scene([{ key: 'pi-1', name: 'Pi', online: true, tasks: [] }]);
  assert.match(scene, /aio-office is-idle/);
  assert.match(scene, /aio-flow-empty/);
  assert.match(scene, /从第一项工作开始/);
  assert.match(scene, /描述目标.*安排执行.*查看交付/);
  assert.match(scene, /data-office-new-chat="1"/);
  assert.match(scene, /data-open-task-center="1"/);
  assert.doesNotMatch(scene, /Agent 团队已经就绪|READY FOR WORK|aio-empty-connection/);
  assert.match(scene, /aio-work-list is-empty/);
  assert.match(scene, /aria-label="Agent 席位"/);
  assert.doesNotMatch(scene, /aio-seat|aio-meeting-table|aio-room-zone|协作会议室|把第一项工作放到桌上/);
});

test('new disconnected users see connection guidance, not a false ready claim', () => {
  const scene = officeFixture([]).scene([]);
  assert.match(scene, /从第一项工作开始/);
  assert.match(scene, /还没有在线 Agent/);
  assert.match(scene, /data-open-agents="1"/);
  assert.doesNotMatch(scene, /团队已经就绪|READY FOR WORK|class="aio-work-item/);
});

test('AI team keeps live work in the console and deliveries on the bottom shelf', () => {
  const tasks = Array.from({ length: 13 }, (_, i) => ({
    id: 'done-' + i, title: 'Delivery ' + i, phase: 'done', artifacts: 1,
  }));
  const scene = officeFixture(tasks).scene([]);
  assert.doesNotMatch(scene, /data-office-phase="done"/);
  assert.doesNotMatch(scene, /class="aio-work-item is-done/);
  assert.match(scene, /class="aio-deliveries"/);
  assert.equal((scene.match(/class="aio-delivery-item"/g) || []).length, 8);
  assert.match(scene, /全部 13 条/);
  assert.match(scene, /没有进行中的需求/);
  assert.doesNotMatch(scene, /从第一项工作开始/);
  assert.match(scene, /aria-expanded="false" aria-controls="aioDeliveryContent"/);
  assert.match(scene, /id="aioDeliveryContent" hidden/);
});

test('AI team uses a full-width work console without duplicate side controls', () => {
  const desk = read('components', 'panels', 'panels-desk.js');
  const css = read('components', 'panels', 'panels-aidesk-office.css');
  assert.doesNotMatch(desk, /id="dkInspectorToggle"|id="dkMulti"|>多路控制台</);
  assert.match(css, /not\(\.is-task-view\)[^{]*> \.dk-office-inspector\.dk-body \{display:none/);
  assert.match(css, /grid-template-rows:max-content minmax\(max-content,1fr\) max-content/);
  assert.match(css, /grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(css, /@container ai-team \(max-width:1040px\)/);
  assert.doesNotMatch(css, /minmax\(360px,420px\)/);
  assert.match(css, /\.aio-deliveries \{grid-column:1\/-1; grid-row:3/);
});

test('every active task card opens the shared AI work details', () => {
  const tasks = [
    { id: 'running', title: 'Quietly running', phase: 'running' },
    { id: 'waiting', title: 'Needs approval', phase: 'waiting', workflow: { waitingOn: ['Owner'] } },
    { id: 'done', title: 'Already delivered', phase: 'done' },
  ];
  const scene = officeFixture(tasks).scene([]);
  assert.match(scene, /data-office-enter-task="running"/);
  assert.match(scene, /data-office-enter-task="waiting"/);
  assert.doesNotMatch(scene, /data-office-preview|class="aio-work-item is-done/);
  assert.match(scene, /工作详情/);
});

test('shared task journey keeps a readable text floor', () => {
  const css = read('components', 'panels', 'task-trace-view.css');
  assert.match(css, /\.tfd-shell\{[^}]*font-size:max\(var\(--font-min-readable,\s*14\.5px\),\s*max\(var\(--text-base,14px\),14px\)\)/);
  assert.match(css, /\.tfd-confirm input\{height:36px;font-size:max\(var\(--font-min-readable,\s*14\.5px\),\s*13px\)\}/);
});
