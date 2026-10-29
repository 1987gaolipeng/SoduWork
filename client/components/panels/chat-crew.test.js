'use strict';

const assert = require('assert');
global.window = global;
require('./agent-brand');
const crew = require('./chat-crew');
const AgentBrand = global.AgentBrand;

const src = (agentId, runId, nodeKey) => ({ agentId, runId, nodeKey });
const tool = (agentId, runId, state) => ({ id: agentId + '-' + runId, state, sourceAgent: src(agentId, runId, 'n') });
const msg = (role, agentId, runId) => ({ role, sourceAgent: role === 'assistant' ? src(agentId, runId, 'n') : null, blocks: [{ kind: 'text', text: 'x' }] });

/* ---- crewsOf: aggregate and dedupe by run; running comes from tool events; streaming active run injected; entries without runId stay out */
{
  const crews = crew.crewsOf(
    [msg('user', '', ''), msg('assistant', 'pi', 'r1'), msg('assistant', 'pi', 'r1'),
     msg('assistant', 'codex', 'r1'), msg('assistant', 'pi', '')],
    [tool('pi', 'r1', 'done'), tool('claude', 'r1', 'running'), tool('qwen', '', 'running')],
    '');
  assert.equal(crews.size, 1, 'tools and messages without a runId stay out of the crew');
  const r1 = crews.get('r1');
  assert.deepEqual(r1.agents.map((a) => a.id), ['pi', 'codex', 'claude'], 'deduped within one run, kept in appearance order');
  assert.equal(r1.agents.find((a) => a.id === 'claude').running, true, 'running tool event lights up the agent');
  assert.equal(r1.running, true, 'run is active when any agent inside is running');

  const streamed = crew.crewsOf([msg('assistant', 'pi', 'r9')], [], 'r9');
  assert.equal(streamed.get('r9').running, true, 'streaming active run counts as running');
}
/* ---- stackHtml: primary vs subs, running first, count bead, is-on/is-running, title */
{
  const crews = crew.crewsOf(
    [msg('assistant', 'pi', 'r1'), msg('assistant', 'codex', 'r1'),
     msg('assistant', 'opencode', 'r1'), msg('assistant', 'claude', 'r1')],
    [tool('claude', 'r1', 'running'), tool('codex', 'r1', 'done')], 'r1');
  const stack = crew.stackHtml(src('pi', 'r1', 'm0'), crews);
  assert.ok(stack.html.includes('crew-avatar'), 'primary bead present');
  assert.ok(stack.html.includes('agent-brand-claude crew-sub is-on'), 'running engine surfaces inline with is-on');
  assert.ok(stack.html.includes('agent-brand-codex'), 'other participants ordered running-first');
  assert.ok(!stack.html.includes('agent-brand-opencode'), 'beyond the inline limit no sub bead is drawn');
  assert.ok(stack.html.includes('crew-count">+1'), 'extra folded into the trailing count bead');
  assert.ok(stack.html.includes('is-running'), 'chain gets is-running when the run is active');
  assert.ok(stack.title.includes('Pi') && stack.title.includes('4 个底座'), 'title reads primary and total (4 including primary)');
  assert.equal(crew._crewTitle('pi', []), '由 Pi 主答');
}
/* ---- single participant: primary bead only, no count bead */
{
  const crews = crew.crewsOf([msg('assistant', 'pi', 'r2')], [tool('pi', 'r2', 'done')], '');
  const stack = crew.stackHtml(src('pi', 'r2', 'm0'), crews);
  assert.ok(stack.html.includes('crew-avatar') && !stack.html.includes('crew-sub'), 'single-bead crew');
  assert.ok(!stack.html.includes('crew-count'), 'no count bead');
  assert.ok(!stack.html.includes('is-running'), 'no pulse for inactive runs');
}
/* ---- unattributed fallback: empty source/agentId returns an empty string so transcript draws the pill; custom draws a single custom-shield bead */
{
  assert.equal(crew.stackHtml(null, new Map()).html, '');
  assert.equal(crew.stackHtml({ agentId: '' }, new Map()).html, '');
  const custom = crew.stackHtml({ agentId: 'unknown-thing', runId: 'r1', nodeKey: 'm' }, new Map());
  assert.ok(custom.html.includes('agent-brand-custom crew-avatar'), 'custom engine draws a single bead with unified identity language');
  assert.ok(custom.title.includes('自定义 Agent'), 'custom title uses the display name');
}
/* ---- transcript: message-head bead chains + run-level dedup; tool-group heads unaffected */
{
  const AgentBrandModule = require('./agent-brand');
  const htmlOf = (parts) => parts.join('');
  // two consecutive messages of the same run (different nodeKey) paint the chain head once
  const t = AgentBrandModule.transcript({ crewHtml: () => ({ html: '<span class="crew-stack"></span>', title: '由 Pi 主答，与 Codex 协作', taskId: 'T1' }) });
  const parts1 = [];
  t.before(parts1, src('pi', 'r1', 'n0'), 'message:0', true);
  t.before(parts1, src('pi', 'r1', 'n1'), 'message:1', true);
  assert.equal((htmlOf(parts1).match(/nchat-crew/g) || []).length, 1, 'same-run messages paint the chain once');
  assert.ok(htmlOf(parts1).includes('data-crew-run="r1"') && htmlOf(parts1).includes('data-crew-task="T1"'),
    'chain anchor carries runId/taskId');
  // no crewHtml (tool-group head path): bare single bead, name kept in title/aria-label
  const plain = [];
  t.before(plain, src('qwen', '', 'n2'), 'message:2:agent:x');
  assert.ok(plain.join('').includes('data-agent-brand="qwen"') && !plain.join('').includes('<span>'),
    'no crew callback falls back to a single bead (no text span)');
  assert.ok(plain.join('').includes('title="Qwen Code"') && plain.join('').includes('aria-label="Qwen Code"'),
    'tool-group head name kept in title/aria-label (hover and screen-reader reachable)');
  assert.ok(!plain.join('').includes('nchat-crew'), 'tool-group head is not a crew chain');
  // crew callback present but the chain is unavailable (custom): fall back to a single bead.
  // Plain chats without runId paint per message (every reply is attributed); same-run messages still share one fallback head.
  const parts3 = [];
  const t3 = AgentBrandModule.transcript({ crewHtml: () => null });
  t3.before(parts3, src('qwen', '', 'n3'), 'message:3', true);
  t3.before(parts3, src('qwen', '', 'n3'), 'message:4', true);
  const html3 = parts3.join('');
  assert.ok(html3.includes('data-agent-brand="qwen"') && !html3.includes('nchat-crew'), 'custom falls back to a single bead');
  assert.equal((html3.match(/nchat-agent-source/g) || []).length, 1, 'same-run fallback bead not duplicated');
}
/* ---- turn boundary: user messages break run attribution, new turns repaint the head */
{
  const AgentBrandModule = require('./agent-brand');
  const count = (parts, re) => (parts.join('').match(re) || []).length;
  const t4 = AgentBrandModule.transcript({ crewHtml: () => ({ html: '<span class="crew-stack"></span>', title: '由 Pi 主答', taskId: '' }) });
  // two consecutive same-engine plain replies within one turn (no user separator): head painted once
  // (legacy semantics locked; real data always has empty nodeKey)
  const sameTurn = [];
  t4.before(sameTurn, src('pi', '', ''), 'message:0', true);
  t4.before(sameTurn, src('pi', '', ''), 'message:1', true);
  assert.equal((sameTurn.join('').match(/nchat-crew/g) || []).length, 1, 'multi-segment output in one turn paints one head');
  // fig-1 regression: plain chats across turns (user separated) bead per message;
  // fig-2 regression: same runId repaints the crew head across turns
  const turnwise = [];
  t4.before(turnwise, src('pi', '', ''), 'message:0', true);          // turn 1 paints the head
  t4.breakRun();                                                       // user: another one
  t4.before(turnwise, src('pi', '', ''), 'message:1', true);          // new turn: repaint
  t4.before(turnwise, src('pi', 'r9', 'n2'), 'message:2', true);      // task turn 1
  t4.before(turnwise, src('pi', 'r9', 'n3'), 'message:3', true);      // second segment of same run: no duplicate
  t4.breakRun();                                                       // user: continue
  t4.before(turnwise, src('pi', 'r9', 'n4'), 'message:4', true);      // new turn: repaint
  const heads = (turnwise.join('').match(/nchat-crew/g) || []).length;
  assert.equal(heads, 3, 'plain chats head per turn; task same-run repainting after turn breaks');
  // multi-segment same-run output within one turn still paints one crew head (by design for multi-engine tasks)
  const within = [];
  const t5 = AgentBrandModule.transcript({ crewHtml: () => ({ html: '<span class="crew-stack"></span>', title: '', taskId: '' }) });
  t5.before(within, src('pi', 'r1', 'n0'), 'message:0', true);
  t5.before(within, src('codex', 'r1', 'n1'), 'message:1', true);
  t5.before(within, src('pi', 'r1', 'n2'), 'message:2', true);
  assert.equal((within.join('').match(/nchat-crew/g) || []).length, 1, 'same-run multi-segment output paints one crew head');
  // the tool-group dedup key also resets at turn boundaries: a previous turn's same-engine
  // tool-group head no longer swallows the new turn's
  const toolwise = [];
  const t6 = AgentBrandModule.transcript({ crewHtml: () => ({ html: '<span class="crew-stack"></span>', title: '', taskId: '' }) });
  t6.before(toolwise, src('pi', '', 'n0'), 'message:0:agent:t1');      // turn 1 tool-group head
  t6.breakRun();                                                       // user message
  t6.before(toolwise, src('pi', '', 'n1'), 'message:1:agent:t2');      // new turn, same engine tool group
  assert.equal((toolwise.join('').match(/nchat-agent-source/g) || []).length, 2, 'tool-group heads do not swallow each other across turns');
}
/* ---- popover details: executor fallback chain and state mapping (no DOM) */
{
  assert.equal(crew._agentKindOf({ resolved: { agentKind: 'local:claude' } }), 'claude');
  assert.equal(crew._agentKindOf({ requested: { agentKind: 'qwen' }, assignee: '某执行机' }), 'qwen');
  assert.equal(crew._agentKindOf({ assignee: 'Claude Code', provider: '' }), 'claude');
  assert.equal(crew._agentKindOf({}), 'custom');
  assert.equal(crew._modelOf({ resolved: { model: 'claude-opus-4' } }), 'claude-opus-4');
  const rows = crew._rowsHtml({ nodes: [
    { name: '方案设计', state: 'succeeded', executor: { resolved: { agentKind: 'codex', model: 'gpt-5.2-codex' } } },
    { name: '代码实现', state: 'running', executor: { resolved: { agentKind: 'pi', model: 'deepseek-v4' } } },
    { name: '人工审', state: 'waiting_human', executor: {} },
  ] });
  assert.ok(rows.includes('is-done">已完成'), 'done state badge');
  assert.ok(rows.includes('is-doing">') && rows.includes('执行中'), 'doing state badge + pulse dot');
  assert.ok(rows.includes('is-wait">待你确认'), 'unknown/waiting state in neutral color');
  /* Caption switched to engine names (product decision, replacing model names): nodes show
     Codex/Pi; the closing node without an engine (human review) shows no caption. */
  assert.ok(rows.includes('crew-pop-model">Codex<'), 'engine name shown (codex)');
  assert.ok(rows.includes('crew-pop-model">Pi<'), 'engine name shown (pi)');
  assert.ok(!rows.includes('deepseek-v4') && !rows.includes('gpt-5.2-codex'), 'model names no longer shown');
  assert.equal((rows.match(/crew-pop-model/g) || []).length, 2, 'only two nodes carry the engine caption');
}

console.log('chat-crew.test: all assertions passed');

/* ---- Session-head crew status bar: headInfo lists engines in plugin workflow node order
   (deduped, running lit in place); headHtml outputs the bead chain + summary text;
   undispatched/declared-only engines stay out of the bar */
{
  const node = (key, name, state, agentKind, model) => ({
    key, name, state, executor: agentKind ? { resolved: { agentKind, model: model || '' } } : {},
  });
  const trace = { runs: [{ id: 'run-1', nodes: [
    node('plan', '方案设计', 'succeeded', 'codex', 'gpt-5'),
    node('impl', '代码实现', 'succeeded', 'pi', 'pi-main'),
    node('review', '代码复核', 'succeeded', 'opencode', 'qwen3-coder'),
    node('scan', '安全扫描', 'running', 'claude', 'claude-sonnet'),
    node('notes', '发布说明', 'pending', '', ''),
    node('audit', '产出审阅', 'pending', 'pi', 'pi-main'),   // second appearance of the same engine → deduped
  ] }] };
  const ctx = { _activeCollabTaskId: 'T9', _collaborationTrace: trace,
    _collaborationTask: { title: '门户首屏性能优化' },
    _collabTasks: new Map([['T9', { taskId: 'T9', title: '门户首屏性能优化', task: { title: '门户首屏性能优化' } }]]) };
  const info = crew._headInfo(ctx);
  assert.ok(info, 'yields bar data when a trace and dispatched engines exist');
  assert.deepEqual(info.beads.map((b) => b.id), ['codex', 'pi', 'opencode', 'claude'],
    'engines deduped in workflow node order (first appearance); declared-only nodes stay out');
  assert.equal(info.beads.find((b) => b.id === 'claude').running, true, 'running engine lit');
  assert.equal(info.beads.find((b) => b.id === 'codex').running, false, 'completed engine not lit');
  assert.equal(info.running, true, 'run with a doing node → running');
  assert.equal(info.headline, '执行中', 'summary headline');
  assert.equal(info.detail, '节点 4/6', 'step progress matches the final prototype fold (first running node index)');
  assert.equal(info.taskId, 'T9', 'taskId from the active collaboration task');
  assert.equal(info.runId, 'run-1', 'runId from the active run');
  assert.equal(info.title, '门户首屏性能优化', 'task title from the collaboration task');

  const html = crew._headHtml(info);
  assert.ok(html.includes('agent-brand-codex crew-sub'), 'the first workflow node\'s engine leads');
  assert.ok(html.includes('agent-brand-claude crew-sub is-on is-run'), 'running bead carries is-run');
  assert.ok(html.includes('crew-dot'), 'running bead carries the state dot');
  assert.ok(html.includes('<b>执行中</b>'), 'summary headline bold');
  assert.ok(html.includes('节点 4/6'), 'summary text carries node progress');
  assert.ok(!html.includes('agent-brand-custom'), 'undispatched engines absent from the bar');

  /* no doing → completed; bad present → blocked; wait present → waiting for human */
  const doneTrace = { runs: [{ id: 'r2', nodes: [
    node('a', 'A', 'succeeded', 'pi', ''), node('b', 'B', 'succeeded', 'codex', '')] }] };
  const doneInfo = crew._headInfo({ _activeCollabTaskId: 'T9', _collaborationTrace: doneTrace });
  assert.equal(doneInfo.running, false, 'all done → not running');
  assert.equal(doneInfo.headline, '已完成', 'headline is completed');
  assert.equal(doneInfo.detail, '节点 2/2', 'done state shows nodes N/N like the prototype');
  const badTrace = { runs: [{ id: 'r3', nodes: [
    node('a', 'A', 'succeeded', 'pi', ''), node('b', 'B', 'failed', 'codex', '')] }] };
  assert.equal(crew._headInfo({ _activeCollabTaskId: 'T9', _collaborationTrace: badTrace }).headline, '受阻', 'failed node → blocked');
  const waitTrace = { runs: [{ id: 'r4', nodes: [
    node('a', 'A', 'succeeded', 'pi', ''), node('b', 'B', 'waiting_human', 'pi', '')] }] };
  assert.equal(crew._headInfo({ _activeCollabTaskId: 'T9', _collaborationTrace: waitTrace }).headline, '待确认', 'human confirmation → waiting');

  /* no trace / no dispatched engines → no bar */
  assert.equal(crew._headInfo({ _activeCollabTaskId: 'T9' }), null, 'no trace, no bar');
  assert.equal(crew._headInfo({ _activeCollabTaskId: 'T9', _collaborationTrace: { runs: [] } }), null, 'empty trace, no bar');
  assert.equal(crew._headInfo({ _activeCollabTaskId: 'T9',
    _collaborationTrace: { runs: [{ id: 'r5', nodes: [node('a', 'A', 'pending', '', '')] }] } }), null,
    'all engines undispatched, no bar');

  /* multiple runs: the active run (with doing) wins, else the last run */
  const multi = { runs: [
    { id: 'old', nodes: [node('a', 'A', 'succeeded', 'codex', '')] },
    { id: 'now', nodes: [node('b', 'B', 'running', 'claude', '')] }] };
  assert.equal(crew._headInfo({ _activeCollabTaskId: 'T9', _collaborationTrace: multi }).runId, 'now',
    'picks the run still having running nodes');
}

/* ---- Status bar data-source fallback chain (fig-4 regression): mirror missing reads the active
   entry, message-attribution fallback, on-demand fetch (in-flight dedupe, write-back to
   entry/mirror, empty-trace cooldown) ---- */
(async () => {
  const node = (key, name, state, agentKind) => ({
    key, name, state, executor: agentKind ? { resolved: { agentKind } } : {},
  });
  const trace = { runs: [{ id: 'run-9', nodes: [
    node('a', '方案设计', 'succeeded', 'codex'), node('b', '编写文档', 'running', 'pi')] }] };

  /* Mirror missing but the active entry carries a trace: the _loadCollabRun entry-only path still yields bar data */
  const viaEntry = crew._headInfo({ _activeCollabTaskId: 'T4', _collaborationTrace: null,
    _collabTasks: new Map([['T4', { trace }]]) });
  assert.ok(viaEntry, 'reads the active entry\'s trace when the mirror is missing');
  assert.equal(viaEntry.taskId, 'T4', 'taskId from the active collaboration task');
  assert.equal(viaEntry.headline, '执行中', 'fallback data yields the summary too');

  /* Message-attribution fallback: override taskId/trace wins (tasks created mid-session by the runtime) */
  const viaOverride = crew._headInfo({ _activeCollabTaskId: '', _collaborationTrace: null,
    _collabTasks: new Map() }, { taskId: 'T7', trace });
  assert.ok(viaOverride && viaOverride.taskId === 'T7' && viaOverride.headline === '执行中',
    'message-attribution taskId/trace overrides bar data');

  /* Attribution scan: latest assistant message with a taskId; user messages and empty values ignored */
  assert.equal(crew._latestTaskIdOf({ _snap: { messages: [
    { role: 'user', taskId: 'T0' }, { role: 'assistant', taskId: 'T7' },
    { role: 'assistant', taskId: '' }, { role: 'assistant', taskId: 'T8' }] } }), 'T8',
    'takes the latest assistant message with a taskId');
  assert.equal(crew._latestTaskIdOf({ _snap: { messages: [{ role: 'user', taskId: 'T0' }] } }), '',
    'a user message\'s taskId is not an attribution');

  /* crewInfoOf: no refetch when the active task already has a data source; light-cached traces yield data directly */
  const idleCtx = { _activeCollabTaskId: 'T7', _collaborationTrace: null, _collabTasks: new Map(),
    _snap: { messages: [{ role: 'assistant', taskId: 'T7' }] } };
  assert.equal(crew._crewInfoOf(idleCtx), null, 'active task uses the mirror/entry path, no refetch');
  crew._rememberTrace('T7', trace);
  const cached = crew._crewInfoOf({ _activeCollabTaskId: '', _collaborationTrace: null,
    _collabTasks: new Map(), _snap: { messages: [{ role: 'assistant', taskId: 'T7' }] } });
  assert.ok(cached && cached.taskId === 'T7', 'light-cached trace yields bar data');

  /* scheduleTraceFetch: in-flight dedupe, write-back to entry and mirror, one repaint */
  let calls = 0, renders = 0;
  const savedApi = global.SoduWorkAPI;
  global.SoduWorkAPI = { taskTrace: () => { calls += 1; return Promise.resolve(trace); } };
  const fetchCtx = { _activeCollabTaskId: 'T5', _collaborationTrace: null,
    _collabTasks: new Map([['T5', {}]]), _render: () => { renders += 1; } };
  crew._scheduleTraceFetch(fetchCtx, 'T5');
  crew._scheduleTraceFetch(fetchCtx, 'T5');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1, 'same taskId fetches once via in-flight dedupe');
  assert.ok(fetchCtx._collabTasks.get('T5').trace, 'trace written back to entry');
  assert.equal(fetchCtx._collaborationTrace, trace, 'mirror synced when empty');
  assert.equal(renders, 1, 'one repaint once the trace lands');

  /* Empty trace: no write-back, 30s cooldown, streaming renders do not hammer the API */
  let emptyCalls = 0;
  global.SoduWorkAPI = { taskTrace: () => { emptyCalls += 1; return Promise.resolve({ runs: [] }); } };
  const emptyCtx = { _collabTasks: new Map([['T6', {}]]), _render: () => {} };
  crew._scheduleTraceFetch(emptyCtx, 'T6');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(!emptyCtx._collabTasks.get('T6').trace, 'empty trace not written back');
  crew._scheduleTraceFetch(emptyCtx, 'T6');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(emptyCalls, 1, 'empty trace cools down, no refetch within 30s');

  /* ---- In-session plugin workflow fallback (local debug runs): messages carry runId without
     taskId; the bar fetches run nodes via SoduWorkAPI.debug and reshapes them into a trace
     (closing the same fig-4 gap) */
  const debugRun = {
    id: 'run-9', name: '文档生成流水线', status: 'running', revision: 14,
    nodes: [
      { key: 'collect', name: '资料收集', status: 'completed', agent: 'pi', model: '' },
      { key: 'analyze', name: '分析资料', status: 'completed', agent: 'codex-harness', model: '' },
      { key: 'write', name: '汇总撰写文档', status: 'running', agent: 'pi', model: '' },
      { key: 'review', name: '审核', status: 'pending', agent: 'codex-harness', model: '' },
      { key: 'publish', name: '办结', status: 'pending', agent: '', model: '' },
    ],
  };
  const debugTrace = crew._debugRunToTrace(debugRun);
  assert.ok(crew._usableTrace(debugTrace), 'debug run converts to a usable trace');
  assert.equal(debugTrace.runs[0].name, '文档生成流水线', 'plugin name rides the trace as bar title');
  assert.deepEqual(debugTrace.runs[0].nodes.map((node) => node.state),
    ['succeeded', 'succeeded', 'running', 'pending', 'pending'], 'node states map to trace enums');
  const debugCtx = { _activeCollabTaskId: '', _collaborationTrace: null, _collabTasks: new Map(),
    _snap: { messages: [
      { role: 'user' },
      { role: 'assistant', sourceAgent: { agentId: 'pi', runId: 'run-9', nodeKey: 'write' } },
    ] } };
  assert.equal(crew._latestRunIdOf(debugCtx), 'run-9', 'takes the latest assistant message with a runId');
  let debugCalls = 0, debugRenders = 0;
  global.SoduWorkAPI = { personalPlugins: { debug: (ref, options) => {
    debugCalls += 1;
    assert.equal(options.command, 'get', 'fetches the debug run snapshot per session');
    return Promise.resolve({ ok: true, run: debugRun });
  } } };
  const renderCtx = Object.assign(debugCtx, { _ref: 'ref-1', _render: () => { debugRenders += 1; } });
  assert.equal(crew._crewDebugInfoOf(renderCtx), null, 'fetch kicks off before any cache');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(debugCalls, 1, 'same session fetches once via in-flight dedupe');
  assert.equal(debugRenders, 1, 'one repaint once run nodes land');
  const debugInfo = crew._crewDebugInfoOf(renderCtx);
  assert.ok(debugInfo, 'bar yields data on cache hit');
  assert.equal(debugInfo.headline, '执行中', 'headline is running when nodes are running');
  assert.equal(debugInfo.detail, '节点 3/5', 'node index counts pending nodes per workflow');
  assert.equal(debugInfo.title, '文档生成流水线', 'title uses the plugin name');
  assert.deepEqual(debugInfo.beads.map((bead) => bead.id), ['pi', 'codex-harness'], 'engine beads deduped in first-appearance order');
  assert.ok(debugInfo.beads.find((bead) => bead.id === 'pi').running, 'running node lights its engine bead');
  assert.equal(debugInfo.taskId, '', 'no Hub task, taskId stays empty');

  global.SoduWorkAPI = savedApi;
  console.log('chat-crew.test: fallback assertions passed');
})().catch((error) => { console.error(error); process.exit(1); });
