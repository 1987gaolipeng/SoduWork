'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const overviewSource = read('components/team/team-overview.js');
const members = [
  { name: '<Ada>', role: 'Lead', userId: 'one', color: '#abcdef', doing: 2, todo: 3, done: 4, cancel: 1, stuck: 1, cap: 4 },
  { name: 'Bo', role: '', userId: 'two', color: '#fedcba', doing: 0, todo: 0, done: 2, cancel: 0, stuck: 0, cap: 2 },
];
const week = { labels: ['Mon', 'Tue'], done: [2, 0] };
const tasks = [{ priority: 'critical' }, { priority: 'high' }, { priority: 'normal' }];
const escape = value => String(value == null ? '' : value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
function overview() {
  const context = vm.createContext({ window: {} });
  vm.runInContext(overviewSource, context);
  return context.window.SoduWorkTeamOverview;
}

test('the overview preserves baseline markup for unavailable, empty and populated team snapshots', () => {
  const render = overview().render;
  // Captured from the existing team panel before extracting its presentation.
  const cases = [
    [false, [], '01ff77de8f65db76dc83a9b83646561aa432df984618e822277ad0e8dd8cbf15'],
    [true, [], 'c3cef2afe49fc16409c90fa8388192ac5e49c2ca2678b624681da4e456d722a3'],
    [true, members, 'f4b2ff890cded19c1d156853823ef58fc5c684a9d626f88832650232e15d9149'],
  ];
  for (const [live, rows, expected] of cases) {
    const state = { members: rows, week, tasks, live }, before = JSON.stringify(state);
    const html = render(state, escape);
    assert.equal(crypto.createHash('sha256').update(html).digest('hex'), expected);
    assert.equal(JSON.stringify(state), before, 'a view must not reorder or rewrite the root panel state');
  }
});

test('overview actions delegate refresh and member/status navigation to the root owner', async () => {
  const button = attributes => ({ disabled: false, textContent: '', listeners: {},
    getAttribute: key => attributes[key], addEventListener(type, handler) { this.listeners[type] = handler; } });
  const retry = button({}), done = button({ 'data-jump': 'done' });
  const member = button({ 'data-jump-member': 'one', 'data-jump-name': '<Ada>' });
  const elements = { '[data-team-retry]': [retry], '[data-jump]': [done], '[data-jump-member]': [member] };
  let refreshes = 0;
  const navigation = [];
  overview().bind({ querySelectorAll: selector => elements[selector] }, {
    reload: async () => { refreshes++; }, navigate: (...args) => navigation.push(args),
  });
  await retry.listeners.click(); await retry.listeners.click();
  done.listeners.click(); member.listeners.click();
  assert.equal(refreshes, 1, 'a retry stays disabled until the root panel redraws');
  assert.deepEqual(JSON.parse(JSON.stringify(navigation)), [['done'], ['all', { uid: 'one', name: '<Ada>' }]]);
});

function element() {
  const classes = new Set();
  return { innerHTML: '', textContent: '', style: {}, scrollTop: 0,
    querySelectorAll: () => [], addEventListener() {},
    classList: { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name),
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } } };
}

test('the root panel still owns asynchronous refresh invalidation and supplies fresh overview data', async () => {
  const panel = element(), body = element();
  let finish;
  const context = vm.createContext({ console,
    document: { readyState: 'loading', body: element(), documentElement: { dataset: {} }, addEventListener() {},
      getElementById: id => id === 'teamPanel' ? panel : id === 'teamBody' ? body : null,
      querySelector: () => null, querySelectorAll: () => [] },
    SoduWorkAPI: { getTeam: () => new Promise(resolve => { finish = resolve; }),
      getTeamTasks: async () => ({ tasks, members: [] }), getTeamInbox: async () => ({ items: [] }) },
  });
  context.window = context;
  vm.runInContext(overviewSource, context);
  vm.runInContext(read('components/team/team.js'), context);
  context.openTeamPanel({ tab: 1 });
  const initial = body.innerHTML;
  context.closeTeamPanel();
  finish({ members, week, canManage: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(body.innerHTML, initial, 'closing invalidates the in-flight root request');
  context.SoduWorkAPI.getTeam = async () => ({ members, week, canManage: true });
  context.openTeamPanel({ tab: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(crypto.createHash('sha256').update(body.innerHTML).digest('hex'), 'f4b2ff890cded19c1d156853823ef58fc5c684a9d626f88832650232e15d9149');
  assert.match(body.innerHTML, /&lt;Ada&gt;/);
});

test('the workspace loads the overview before its root panel without adding it to the overlay window', () => {
  const desk = read('desk.html'), overlay = read('index.html');
  assert.ok(desk.indexOf('components/team/team-overview.js') < desk.indexOf('components/team/team.js'));
  assert.doesNotMatch(overlay, /<script src="components\/team\/team(?:-overview)?\.js"/);
});
