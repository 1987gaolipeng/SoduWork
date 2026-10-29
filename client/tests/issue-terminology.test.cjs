'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../core');
const shards = JSON.parse(fs.readFileSync(path.join(root, 'locales/manifest.json'), 'utf8'));
// These refer to specifications, not the assignable Issue record.
const specification = new Set([
  '需求基线', '形成并审批需求范围', '需求确认',
  '当前关卡已重新排队，已完成的需求、开发和测试不会重跑',
  '把零散需求整理成可验收的 HTML 产品原型',
]);
const canonical = new Map([
  ['需求池', 'Issues'], ['查看需求池', 'View issues'], ['需求', 'Issue'],
  ['新建需求', 'New issue'], ['创建需求', 'Create issue'], ['需求详情', 'Issue details'],
  ['选择需求', 'Choose an issue'], ['需求标题', 'Issue title'], ['安排执行', 'Assign issue'],
  ['搜索需求', 'Search issues'], ['最近需求', 'Recent issues'],
  ['展开最近需求', 'Expand recent issues'], ['收起最近需求', 'Collapse recent issues'],
  ['需求执行', 'Issue execution'],
  ['需求视图', 'Issue views'], ['关闭需求选择', 'Close issue picker'],
  ['需求队列未能保存，请重试', 'Could not save the issue queue. Try again.'],
  ['任务中心', 'Issues'], ['退回任务池', 'Return to Issues'],
  ['可添加的待办', 'Available issues'],
  ['/需求', '/issue'],
]);
function assertTerm(key, value, where) {
  assert.doesNotMatch(value, /\b(?:request|requirement|task|issue) (?:pool|center|centre)\b/i, `${where}: navigation is Issues`);
  if (canonical.has(key)) assert.equal(value, canonical.get(key), `${where}: ${key}`);
  if (!key.includes('需求') || specification.has(key)) return;
  assert.doesNotMatch(value, /\brequests?\b/i, `${where}: ${key}`);
  assert.doesNotMatch(value, /\btasks?\b/i, `${where}: ${key}`);
  assert.doesNotMatch(value, /\ba issue\b/i, `${where}: incorrect article`);
  assert.doesNotMatch(value, /\bissue pool\b/i, `${where}: navigation is Issues`);
}
function catalog() {
  const context = vm.createContext({
    document: { readyState: 'loading', documentElement: { dataset: {} }, querySelectorAll: () => [] },
    addEventListener() {}, dispatchEvent() {},
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    localStorage: { getItem: () => null, setItem() {} },
  });
  context.window = context;
  for (const file of shards) vm.runInContext(fs.readFileSync(path.join(root, 'locales', file), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'i18n.js'), 'utf8'), context);
  return { api: context.SoduWorkI18n, messages: context.SoduWorkLocaleMessages['en-US'] };
}

test('all original English client shards use Issue for the work item, even entries shadowed by later catalogs', () => {
  let checked = 0;
  // Flat catalog literals: read every pair, including duplicate keys in one shard.
  // Parse each quoted string independently so apostrophes/escapes remain intact.
  const literal = /('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")\s*:\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/g;
  for (const file of shards.filter(file => file.startsWith('en-US'))) {
    const source = fs.readFileSync(path.join(root, 'locales', file), 'utf8');
    for (const match of source.matchAll(literal)) {
      const key = vm.runInNewContext(match[1]), value = vm.runInNewContext(match[2]);
      if (key.includes('需求')) checked++;
      assertTerm(key, value, `${file}:${source.slice(0, match.index).split('\n').length}`);
    }
  }
  assert.ok(checked > 350, 'must cover source shards rather than only final overrides');
});

test('effective navigation, issue picker, details, queue and plural counts agree', () => {
  const { api, messages } = catalog();
  for (const [key, value] of Object.entries(messages)) assertTerm(key, value, 'effective catalog');
  api.setLocale('en-US');
  for (const [key, expected] of canonical) assert.equal(api.translateText(key), expected, key);
  assert.equal(api.t('nav.history'), 'Issues');
  assert.equal(api.t('eyebrow.requirement_detail'), 'ISSUE DETAILS');
  assert.equal(api.t('recentTasks'), 'Recent issues');
  assert.match(api.translateText('查看我的任务'), /\bissues\b/);
  assert.equal(api.translateText('· 12 条需求'), '· 12 issues');
  assert.equal(api.translateText('在待开始新建需求'), 'Create issue in 待开始');
  api.setLocale('zh-CN');
  assert.equal(api.t('nav.history'), '需求池');
  assert.equal(api.t('recentTasks'), '最近需求');
  assert.equal(api.translateText('需求详情'), '需求详情');
});

test('requests, applications, specifications and background jobs are not renamed into business issues', () => {
  const { api } = catalog(); api.setLocale('en-US');
  for (const key of ['请求已送达', '权限请求已失效', '提交共享审核', '共享申请提交失败',
    '服务未接受检测请求，请检查协议配置', '个人 Key 已配置 · {count} 位，请求会优先使用你的个人额度'])
    assert.match(api.translateText(key), /\brequests?\b/i, key);
  for (const key of specification) assert.match(api.translateText(key), /\brequirements\b/i, key);
  for (const key of ['升级任务缺少安全检查标识', '异步任务查询路径'])
    assert.match(api.translateText(key), /\btask\b/i, key);
  assert.equal(api.translateText('正在执行的工作不会被升级打断。'), 'Running work will not be interrupted by updates.');
  assert.equal(api.translateText('能力选择已保存，下一次任务生效'), 'Capabilities saved; applies to your next task');
  assert.match(api.t('models.keyLength', '', { count: 32 }), /Requests/);
});

test('issue messages preserve interpolated user titles and technical identifiers', () => {
  const { api } = catalog(); api.setLocale('en-US');
  const title = 'Customer Request / Task / Requirement 需求';
  assert.equal(api.translateText(`任务《${title}》没有打开协作会话，请从需求池重试`),
    `Could not open the collaboration chat for “${title}”. Retry from Issues.`);
  for (const literal of [title, 'Task API: /tasks/{taskId}', 'Customer request.md'])
    assert.equal(api.translateText(literal), literal);
});
