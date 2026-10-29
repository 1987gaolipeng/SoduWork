global.window = global;
const assert = require('assert');
require('./agent-brand');
const crew = require('./chat-crew');

/* ---- Second round in the same session (root-cause regression): terminal freeze keyed by run id;
   terminal low-frequency recheck throttled; previous-round terminal downgrades to the lighter
   "previous round" style; a new run fetches immediately and switches the bar ---- */
(async () => {
  const mkRun = (id, status, states) => ({
    id, name: '文档生成流水线', status,
    nodes: states.map((s, i) => ({ key: 'n' + i, name: '节点' + (i + 1), status: s, agent: 'pi', model: '' })),
  });
  const runA = mkRun('run-A', 'completed', ['completed', 'completed']);
  const runB = mkRun('run-B', 'running', ['completed', 'running']);
  const seq = [runA, runB];
  let calls = 0;
  const savedApi = global.SoduWorkAPI;
  /* The previous async test block restores its own saved API; wait for it to fully finish
     before installing this block's mock, so the two concurrent IIFEs do not overwrite
     global.SoduWorkAPI on top of each other. */
  await new Promise((resolve) => setTimeout(resolve, 30));
  global.SoduWorkAPI = { personalPlugins: { debug: () => {
    calls += 1;
    return Promise.resolve({ ok: true, run: seq[Math.min(calls - 1, seq.length - 1)] });
  } } };
  const mkCtx = (runId) => ({ _ref: 'ref-round2', _activeCollabTaskId: '', _collaborationTrace: null,
    _collabTasks: new Map(), _render: () => {},
    _snap: { messages: [{ role: 'user' }, { role: 'assistant', sourceAgent: { agentId: 'pi', runId } }] } });

  /* First round terminal: fetch, freeze, display completed normally */
  const ctxA = mkCtx('run-A');
  assert.equal(crew._crewDebugInfoOf(ctxA), null, 'fetch kicks off before the terminal run is cached');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const finalInfo = crew._crewDebugInfoOf(ctxA);
  assert.ok(finalInfo && finalInfo.headline === '已完成' && finalInfo.detail === '节点 2/2', 'first terminal round still displays completed');
  const callsAtFinal = calls;
  assert.ok(!finalInfo.stale, 'no previous-round flag without new activity after the freeze');

  /* Terminal recheck of the same run is throttled 30s: consecutive render cycles do not refetch */
  assert.equal(crew._crewDebugInfoOf(ctxA).headline, '已完成', 'cache hit still yields data for terminal states');
  assert.equal(calls, callsAtFinal, 'same-run terminal recheck throttled by the terminal interval');

  /* New activity after the terminal freeze (user sends again, optimistic bubble in flight) → previous-round light style */
  const staleCtx = mkCtx('run-A');
  staleCtx._pending = '给我一份关于北京天气的说明报告';
  const staleInfo = crew._crewDebugInfoOf(staleCtx);
  assert.ok(staleInfo && staleInfo.stale === true, 'new activity after terminal state marks the previous round');
  assert.ok(crew._headHtml(staleInfo).includes('上一轮'), 'previous-round prefix lands in bar text');
  assert.ok(crew._debugStaleOf(staleCtx, crew._debugRunToTrace(runA)), 'previous-round check directly reusable');

  /* New round starts: attribution switches to the new run → bypass the throttle and fetch
     immediately; the bar switches to running without the previous-round mark */
  const ctxB = mkCtx('run-B');
  assert.equal(crew._crewDebugInfoOf(ctxB), null, 'fetch kicks off immediately for the uncached new round');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const switched = crew._crewDebugInfoOf(ctxB);
  assert.ok(switched && switched.headline === '执行中' && switched.detail === '节点 2/2',
    'bar switches to running once the new run appears (terminal freeze no longer blocks)');
  assert.equal(switched.stale, false, 'non-terminal new run does not mark previous round');
  assert.ok(calls > callsAtFinal, 'terminal freeze unlocked by the new run, recheck channel restored');

  global.SoduWorkAPI = savedApi;
  console.log('chat-crew.test: round2 assertions passed');
})().catch((error) => { console.error(error); process.exit(1); });
