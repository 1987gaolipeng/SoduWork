'use strict';

const assert = require('assert');
global.window = global;
global.WorkIntent = require('./work-intent');
const tools = require('./panels-chat-tools');
require('./panels-chat-workspace');
delete global.window;

const running = (name, args, extra) => ({
  id: name + '-1', name, args, state: 'running', partial: '', result: '', ...(extra || {}),
});

assert.match(tools.status({ tools: [running('write', { path: 'C:/work/方案.md' })] }, ''), /稳稳写进 方案\.md/);
assert.match(tools.status({ tools: [running('read', { path: 'C:/work/资料.pdf' })] }, ''), /翻阅 资料\.pdf/);
assert.match(tools.status({ tools: [running('bash', { command: 'npm run dev' })] }, ''), /服务启动/);
assert.match(tools.status({ messages: [], tools: [] }, '做一个网页'), /接上工作区/);
assert.doesNotMatch(tools.status({ messages: [
  { role: 'assistant', blocks: [{ kind: 'text', text: '旧结果' }] },
  { role: 'user', text: '再改一下', blocks: [] },
], tools: [] }, ''), /结果讲清楚/, '新一轮不能沿用上一轮状态');
assert.match(tools.status({
  messages: [{ role: 'assistant', blocks: [{ kind: 'text', text: '结果' }] }], tools: [],
}, ''), /结果讲清楚/);

const service = tools._services([running('bash', { command: 'npm run dev' }, {
  partial: 'VITE ready\nLocal: http://0.0.0.0:5173/',
})]);
assert.equal(service.length, 1);
assert.equal(service[0].url, 'http://127.0.0.1:5173/');
assert.equal(service[0].state, '运行中');
assert.equal(tools._services([running('bash', { command: 'curl https://example.com' })]).length, 0,
  '普通命令里的网址不能被误报成服务');
const deduped = tools._services([
  running('bash', { command: 'npm run dev' }, { id: 'server-a', partial: 'http://127.0.0.1:5173/' }),
  running('bash', { command: 'npm run dev' }, { id: 'server-b', partial: 'http://127.0.0.1:5173/' }),
]);
assert.equal(deduped.length, 1, '同一运行地址在成果总览里只能出现一次');

const changed = tools._changes([
  running('write', { path: 'C:/work/index.html' }, { state: 'done' }),
  running('edit', { path: 'C:/work/app.js' }),
  running('read', { path: 'C:/work/readme.md' }),
]);
assert.deepEqual(changed.map((item) => item.action), ['新建', '修改']);
assert.equal(changed[0].name, 'index.html');
assert.equal(changed[1].state, '进行中');

assert.equal(tools._previewKind({ name: 'index.html' }), 'web');
assert.equal(tools._previewKind({ name: '说明.md' }), 'markdown');
assert.equal(tools._previewKind({ name: '报告.docx' }), 'external');
assert.equal(tools._fileUrl('C:\\work\\a b.html'), 'file:///C:/work/a%20b.html');
assert.equal(tools._fileUrl('\\\\server\\share\\index.html'), 'file://server/share/index.html');
assert.equal(tools._normalizeAddress('localhost:5173'), 'http://localhost:5173');
assert.equal(tools._normalizeAddress('example.com'), 'https://example.com');

assert.equal(tools.commandSummary('cd "C:/very/long/workspace" && npm run build'), 'npm run build');
assert.equal(tools.commandSummary('cd C:/workspace && ls -la && node --version'), 'ls -la');
assert.equal(tools.commandSummary('python -m http.server 8123 > server.log 2>&1'), 'python -m http.server 8123');
assert.ok(tools.commandSummary('powershell -NoProfile -Command "do something with a very long argument that should collapse"').length <= 38);
const phases = tools.timeline([
  running('read', { path: 'C:/work/brief.md' }, { id: 'read-phase' }),
  running('write', { path: 'C:/work/index.html' }, { id: 'write-phase' }),
  running('bash', { command: 'npm run build' }, { id: 'verify-phase' }),
], []).filter((item) => item.note);
assert.equal(phases.length, 3);
assert.match(phases[0].note, /\u5de5\u4f5c\u533a/);
assert.match(phases[1].note, /\u4ea4\u4ed8\u5185\u5bb9/);
assert.match(phases[2].note, /\u5b8c\u6210\u6807\u51c6/);

const batchItems = [
  running('bash', { command: 'npm run build' }, { id: 'cmd-1', state: 'done' }),
  running('bash', { command: 'npm test' }, { id: 'cmd-2', state: 'error' }),
  running('bash', { command: 'npm run lint' }, { id: 'cmd-3', state: 'running' }),
];
const batch = tools.batchSummary(batchItems);
assert.equal(batch.total, 3);
assert.equal(batch.complete, 2);
assert.equal(batch.errors, 1);
assert.equal(batch.state, 'running');
assert.equal(batch.title, '正在运行命令');
assert.equal(batch.detail, '正在运行命令');
const batchMarkup = tools.batchHtml(batchItems, 'round-1', true,
  () => { throw Error('Command summaries must not render child rows'); });
assert.match(batchMarkup, /data-tool-node="batch:commands:round-1"/);
assert.doesNotMatch(batchMarkup, /data-tool-group|aria-expanded|ntool-batch-caret|ntool-batch-body|<button/);
assert.match(batchMarkup, /1 项异常/, '其他命令运行时仍保留异常提示');
assert.doesNotMatch(batchMarkup, /npm test|npm run lint|npm run build/);
assert.doesNotMatch(batchMarkup, /title=/);
assert.match(batchMarkup, />3 项</);
assert.doesNotMatch(batchMarkup, /ntool-batch-bar/);
assert.doesNotMatch(batchMarkup, /2\/3/);

const commandOne = running('bash', { command: 'npm run build' }, { id: 'command-one', after: 1, state: 'done' });
const commandTwo = running('bash', { command: 'npm test' }, { id: 'command-two', after: 2, state: 'running' });
const commandThree = running('bash', { command: 'npm run lint' }, { id: 'command-three', after: 4, state: 'running' });
const toolCallOnly = [
  { role: 'user', text: '执行检查', blocks: [] },
  { role: 'assistant', blocks: [{ kind: 'toolcall', text: '' }] },
  { role: 'assistant', blocks: [{ kind: 'toolcall', text: '' }] },
  { role: 'assistant', blocks: [{ kind: 'text', text: '检查完成，继续处理。' }] },
  { role: 'assistant', blocks: [{ kind: 'toolcall', text: '' }] },
];
const groupedCommands = tools.groupConsecutiveCommands(
  [commandOne, commandTwo, commandThree], toolCallOnly);
assert.deepEqual(groupedCommands.map((item) => item.after), [1, 1, 4],
  '连续命令应锚定到同一组，可见的助手文本会切断分组');
assert.equal(commandTwo.after, 2, '分组不能改写快照中的原始工具位置');

const localLink = tools._linkTarget('site/index.html', [
  { name: 'index.html', relative: 'site/index.html', path: 'C:/work/site/index.html' },
]);
assert.equal(localLink.kind, 'file');
assert.equal(localLink.file.name, 'index.html');
assert.equal(tools._linkTarget('https://example.com/docs', []).kind, 'url');
assert.equal(tools._linkTarget('javascript:alert(1)', []), null);
const outputHits = tools._outputMentions('已完成，研发计划排期表.xlsx 现在可以打开。', [
  { name: '研发计划排期表.xlsx', path: 'C:/work/研发计划排期表.xlsx', at: 2 },
]);
assert.equal(outputHits.length, 1, '对话中的真实成果文件名应被识别');
assert.equal(outputHits[0].file.path, 'C:/work/研发计划排期表.xlsx');
assert.equal(tools._outputMentions('只有说明.xlsx.bak', [
  { name: '说明.xlsx', path: 'C:/work/说明.xlsx' },
]).length, 0, '不能把另一个更长文件名的一部分误识别为成果');
assert.equal(tools._outputMentions('不存在.xlsx', [
  { name: '真实.xlsx', path: 'C:/work/真实.xlsx' },
]).length, 0, '只允许链接当前会话真实存在的成果');
const windowsHit = tools._outputMentions('见 reports\\研发计划排期表.xlsx', [
  { name: '研发计划排期表.xlsx', relative: 'reports/研发计划排期表.xlsx', path: 'C:/work/reports/研发计划排期表.xlsx' },
]);
assert.equal(windowsHit[0].text, 'reports\\研发计划排期表.xlsx', 'Windows 相对路径也应整体可点');
assert.equal(tools._hasVisibleTabs([]), false, '没有页签时成果承载区必须关闭');
assert.equal(tools._hasVisibleTabs([{ id: 'web-1' }]), true, '存在运行页签时才显示成果承载区');

const stagedParts = [];
const stagedProgress = [
  { progressIndex: 1, phase: 'understand', html: '<div data-stage=1></div>' },
  { progressIndex: 2, phase: 'plan', html: '<div data-stage=2></div>' },
  { progressIndex: 3, phase: 'execute', html: '<div data-stage=3></div>' },
  { progressIndex: 4, phase: 'verify', html: '<div data-stage=4></div>' },
];
const stagedState = { index: 0 };
const stagedTools = [
  running('bash', { command: 'npm run build' }, { id: 'stage-command-1', state: 'done', goalProgressCount: 3 }),
  running('bash', { command: 'npm test' }, { id: 'stage-command-2', state: 'done', goalProgressCount: 4 }),
];
tools.appendTimeline(stagedParts, stagedTools, [], 'goal-run', true,
  item => '<div data-command=' + item.id + '></div>', new Set(), stagedProgress, stagedState);
const stagedMarkup = stagedParts.join('');
assert.ok(stagedMarkup.indexOf('data-stage=1') < stagedMarkup.indexOf('data-command=stage-command-1'));
assert.ok(stagedMarkup.indexOf('data-stage=3') < stagedMarkup.indexOf('data-command=stage-command-1'));
assert.ok(stagedMarkup.indexOf('data-command=stage-command-1') < stagedMarkup.indexOf('data-stage=4'));
assert.ok(stagedMarkup.indexOf('data-stage=4') < stagedMarkup.indexOf('data-command=stage-command-2'));
assert.equal((stagedMarkup.match(/data-tool-group=/g) || []).length, 0, '不同阶段的单条命令不能合并成一组');

const goalRows = tools.goalProgressRows(true, {
  phases: [
    { key: 'understand', state: 'completed' }, { key: 'plan', state: 'completed' },
    { key: 'execute', state: 'completed' }, { key: 'verify', state: 'running' },
    { key: 'deliver', state: 'pending' },
  ],
  progress: [
    { id: 'p1', type: 'run.started', summary: '启动', at: 1 },
    { id: 'p2', type: 'plan.ready', summary: '计划', at: 2 },
    { id: 'p3', type: 'action.started', summary: '执行一', at: 3 },
    { id: 'p4', type: 'action.observed', summary: '执行二', at: 4 },
    { id: 'p5', type: 'verification.started', summary: '验收一', at: 5 },
    { id: 'p6', type: 'verification.failed', summary: '验收二', at: 6 },
  ],
}, {}, false);
assert.equal(goalRows.length, 4, '同一阶段反复更新只能保留一条过程说明');
assert.deepEqual(goalRows.map((row) => row.key),
  ['phase:understand', 'phase:plan', 'phase:execute', 'phase:verify']);
assert.equal(goalRows.find((row) => row.phase === 'execute').label, '本轮实施完成');
assert.equal(goalRows.find((row) => row.phase === 'execute').progressIndex, 4);
assert.equal(goalRows.find((row) => row.phase === 'verify').state, 'running',
  '验收发现缺口后仍在自动补齐，不应画成最终失败');
assert.match(goalRows.find((row) => row.phase === 'verify').reason, /核对结果/);

const splitAgents = tools.groupConsecutiveCommands([
  {...commandOne,sourceAgent:{agentId:'pi',nodeKey:'first',runId:'r'}},
  {...commandTwo,sourceAgent:{agentId:'qwen',nodeKey:'second',runId:'r'}},
], toolCallOnly);
assert.deepEqual(splitAgents.map(item=>item.after), [commandOne.after,commandTwo.after],
  '不同节点的连续命令不能合到同一个 Agent 标识下');
console.log('conversation workspace checks passed');
