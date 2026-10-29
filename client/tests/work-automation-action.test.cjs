const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const automation = read('components', 'panels', 'work-automation-sheet.js');
const cardState = read('components', 'panels', 'work-automation-card-state.js');
const workEntry = read('components', 'panels', 'work-entry-sheet.js');
const css = read('components', 'panels', 'work-automation-sheet.css');

test('automation is the third built-in conversation work action', () => {
  const actions = [];
  const pluginHost = { registerAction: definition => actions.push(definition) };
  const window = {
    PluginUIHost: pluginHost,
  };
  vm.runInNewContext(automation, { window, PluginUIHost: pluginHost, Intl, setTimeout, clearTimeout });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].id, 'work.automation.create');
  assert.equal(actions[0].command, '自动化');
  assert.deepEqual(
    Array.from(actions[0].aliases),
    ['自动化任务', '定时任务', '定时', '巡检', 'automation'],
  );
  assert.equal(actions[0].priority, 30);
  assert.match(actions[0].description, /Agent/);
});

test('automation form uses the existing commercial schedule contract', () => {
  assert.match(cardState, /A\.listAIAgents/);
  assert.match(cardState, /A\.listRepos/);
  assert.match(automation, /SoduWorkAPI\.preflightSchedule/);
  assert.match(automation, /SoduWorkAPI\.createSchedule/);
  assert.match(automation, /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/);
  assert.match(automation, /personalPluginVersionPolicy: method \? 'pinned'/);
  assert.match(automation, /personalPluginChecksum:/);
  assert.match(automation, /requiredCapabilities:/);
  assert.match(automation, /retryDelayMinutes:/);
  assert.match(automation, /pluginInputs:/);
  assert.match(automation, /flow: Boolean\(value\.repoId && value\.flow\)/);
});

test('automation remains an iterative plugin form inside the conversation', () => {
  assert.match(automation, /PluginUIHost\.mount/);
  assert.match(automation, /PluginUIHost\.checkpointCurrent/);
  assert.match(automation, /async function refineNow/);
  assert.match(automation, /label: '自动化表单'/);
  assert.match(workEntry, /WorkAutomationSheet\.active\(\)/);
  assert.match(workEntry, /WorkAutomationSheet\.refine\(text, options/);
  assert.match(workEntry, /const automation = global\.WorkAutomationSheet/);
  assert.match(workEntry, /automation\.hasSurface\(\).*automation\.close\(silent\)/);
  // Inline sheets follow conversation content; standalone sheets own scrolling, with interaction boundaries covered by Electron tests.
  assert.match(css, /(?:^|\n)\.waz-body\{[^}]*overflow\s*:\s*visible/);
});

test('a requirement can seed the automation form without losing its acceptance contract', () => {
  const detail = read('components', 'requirements', 'requirements-detail.js');
  assert.match(detail, /data-rq-automation/);
  assert.match(detail, /WorkAutomationSheet\.open/);
  assert.match(automation, /fromContext\(s\.proposal \|\| \{\}, s\.bindingContext, context\)/);
  assert.match(automation, /proposalOf\(parsed, directive, prior, instruction, context\)/);
  assert.match(detail, /acceptanceCriteria/);
  assert.match(detail, /automationScheduleId:/);
  assert.match(detail, /requirementVersion:/);
});

test('both desktop entrypoints load automation styles and runtime in dependency order', () => {
  for (const name of ['desk.html', 'index.html']) {
    const html = read(name);
    assert.match(html, /work-automation-sheet\.css/);
    assert.match(html, /work-automation-sheet\.js/);
    for (const helper of ['work-automation-bindings.js', 'work-automation-view.js']) {
      assert.ok(html.indexOf(helper) >= 0 && html.indexOf(helper) < html.indexOf('work-automation-sheet.js'));
    }
    assert.ok(
      html.indexOf('plugin-ui-host.js') < html.indexOf('work-automation-sheet.js'),
      name + ' must load PluginUIHost first',
    );
    assert.ok(
      html.indexOf('panels-schedules-methods.js') < html.indexOf('work-automation-sheet.js'),
      name + ' must load schedule methods first',
    );
  }
});

test('automation payload permissions come from explicit choices and the selected method', () => {
  const context = { Intl, setTimeout, clearTimeout }; context.window = context;
  for (const name of ['schedule-timing.js', 'work-automation-bindings.js']) {
    vm.runInNewContext(read('components', 'panels', name), context);
  }
  const marker = '  global.WorkAutomationSheet = { open, active, refine, close };';
  vm.runInNewContext(automation.replace(marker,
    '  global.probe = { state, proposalOf, bodyOf };\n' + marker), context);
  const { state, proposalOf, bodyOf } = context.probe;
  state.agents = [{ id: 'local:pi', available: true }];
  for (const text of ['输出到桌面上', '用鼠标操作桌面软件', '浏览网页并生成Word报告']) {
    const draft = proposalOf({ title: '自动化', requiredCapabilities: ['computer'] }, text, {});
    assert.deepEqual(Array.from(draft.requiredCapabilities), []);
    assert.deepEqual(Array.from(bodyOf(draft).requiredCapabilities), []);
  }
  state.methods = [{ key: 'report', version: '1', capabilities: { runtime: ['office'] } }];
  const manual = proposalOf({}, '输出到桌面上', {
    personalPluginKey: 'report', requiredCapabilities: ['computer'],
  });
  assert.deepEqual(Array.from(manual.requiredCapabilities), ['computer']);
  assert.deepEqual(Array.from(bodyOf(manual).requiredCapabilities), ['computer', 'office']);
  assert.deepEqual(Array.from(manual.requiredCapabilities), ['computer'], 'derived method permissions stay out of editable choices');
});

test('rhythm parser reads Chinese clocks and preserves periodic scheduling', () => {
  const window = {};
  vm.runInNewContext(read('components','panels','schedule-timing.js'), {window,Intl});
  const rhythm = (text, previous) => {
    const r = window.ScheduleTiming.infer(text, previous);
    return r.every + ' ' + String(r.atHour).padStart(2, '0') + ':' +
      String(r.atMinute).padStart(2, '0');
  };

  assert.equal(rhythm('每天下午两点十分打卡'), 'daily 14:10');
  assert.equal(rhythm('每天上午九点整开晨会'), 'daily 09:00');
  assert.equal(rhythm('每天晚上十点半写日报'), 'daily 22:30');
  assert.equal(rhythm('每天八点一刻提醒喝水'), 'daily 08:15');
  assert.equal(rhythm('每天二十三点五十分睡觉'), 'daily 23:50');
  assert.equal(rhythm('每天中午十一点半吃饭'), 'daily 11:30');
  assert.equal(rhythm('每周五下午四点开周会'), 'weekly 16:00');
  /* Preserve numeric time parsing. */
  assert.equal(rhythm('每天14:10打卡提醒'), 'daily 14:10');
  assert.equal(rhythm('每天下午14:10打卡'), 'daily 14:10');
  assert.equal(rhythm('每天下午2点10分打卡'), 'daily 14:10');
  assert.equal(rhythm('每小时第10分巡检'), 'hourly 18:10');
  /* Use the default time only when no explicit time is present. */
  assert.equal(rhythm('每天提醒我喝水'), 'daily 18:00');
});
