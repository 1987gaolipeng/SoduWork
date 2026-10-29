/* Execution crew bead chain for message heads: the primary agent bead leads,
   collaborator beads stack behind, and a count bead closes the chain;
   clicking (for task runs) expands that round's execution detail.
   Attribution trusts runtime metadata only (AgentBrand.canonical / sourceAgent);
   never guesses from text or the currently selected agent. All data comes from
   messages and tool events already in the session (grouped by runId); zero DB changes. */
(function (global) {
  'use strict';

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ---- Aggregation: engines actually present in one run (messages + tool events, deduped).
     Running has two levels: a running tool event for that engine > session-level streaming active run. */
  function crewsOf(messages, tools, streamingRunId) {
    const crews = new Map();
    const ensure = (runId) => {
      let crew = crews.get(runId);
      if (!crew) {
        crew = { id: runId, agents: [], byId: new Map(), running: false };
        crews.set(runId, crew);
      }
      return crew;
    };
    const add = (source, running) => {
      const runId = String((source && source.runId) || '');
      if (!runId) return;                       // replies without a runId stay out of the crew (single bead handled by stack)
      const agentId = global.AgentBrand && global.AgentBrand.canonical(source && source.agentId);
      if (!agentId || agentId === 'custom') return;
      const crew = ensure(runId);
      let agent = crew.byId.get(agentId);
      if (!agent) {
        agent = { id: agentId, at: crew.agents.length, running: false };
        crew.agents.push(agent);
        crew.byId.set(agentId, agent);
      }
      if (running) { agent.running = true; crew.running = true; }
    };
    (messages || []).forEach((message) => {
      if (message && message.role === 'assistant') add(message.sourceAgent, false);
    });
    (tools || []).forEach((tool) => add(tool && tool.sourceAgent,
      String((tool && tool.state) || '').toLowerCase() === 'running'));
    const live = crews.get(String(streamingRunId || ''));
    if (live) live.running = true;
    return crews;
  }

  // User turns, rather than provider runs, own the visible identity. Keep the
  // original sources untouched; a turn may contain several runs or tool-only agents.
  function turnsOf(messages, tools, streaming) {
    const empty = () => ({ agents: [], byId: new Map(), running: false, runs: new Map() });
    let current = empty();
    const byMessage = [];
    const add = (crew, row, running) => {
      const source = row && row.sourceAgent;
      if (!global.AgentBrand?.sourceKey(source)) return;
      const id = source.agentId;
      let agent = crew.byId.get(id);
      if (!agent) {
        agent = { id, at: crew.agents.length, running: false };
        crew.agents.push(agent); crew.byId.set(id, agent);
      }
      if (running) { agent.running = true; crew.running = true; }
      if (source.runId) {
        const taskId = String(row.taskId || '');
        crew.runs.set(source.runId, taskId || crew.runs.get(source.runId) || '');
      }
    };
    (messages || []).forEach((message, index) => {
      if (message.role === 'user') current = empty();
      byMessage[index] = current;
      if (message.role === 'assistant') add(current, message, false);
    });
    (tools || []).forEach(tool => {
      const after = Math.max(0, Number(tool.after) || 0);
      add(byMessage[after] || current, tool, tool.state === 'running');
    });
    if (streaming && current.agents.length) current.running = true;
    return { byMessage, tail: current };
  }

  /* ---- Bead chain: a 30px primary bead leads; up to 2 sub beads surface running engines
     first, the rest fold into the trailing count bead. A single participant is just the
     primary bead; unattributed sources return an empty string so transcript falls back to the pill head. */
  function stackHtml(source, crews, turnCrew) {
    const brand = global.AgentBrand;
    if (!source || !source.agentId || !brand) return { html: '', title: '' };
    const primary = brand.canonical(source.agentId);
    const crew = turnCrew || (crews && crews.get(String(source.runId || '')));
    const others = ((crew && crew.agents) || [])
      .filter((agent) => agent.id !== primary)
      .sort((a, b) => (b.running - a.running) || (a.at - b.at));
    const running = Boolean(crew && crew.running);
    const show = others.slice(0, 2);
    const extra = others.length - show.length;
    const avatar = '<span class="agent-brand agent-brand-' + esc(primary) + ' crew-avatar" role="img" aria-label="' + esc(brand.LABELS[primary] || primary) + '">' +
      brand.glyph(primary) + '</span>';
    const subs = show.map((agent) =>
      '<span class="agent-brand agent-brand-' + esc(agent.id) + ' crew-sub' +
      (agent.running ? ' is-on' : '') + '" role="img" aria-label="' + esc(brand.LABELS[agent.id] || agent.id) + '">' + brand.glyph(agent.id) + '</span>').join('');
    const count = extra > 0 ? '<span class="crew-count">+' + extra + '</span>' : '';
    const stack = '<span class="crew-stack' + (running ? ' is-running' : '') + '">' +
      avatar + subs + count + '</span>';
    return { html: stack, title: crewTitle(primary, others), running };
  }

  function crewTitle(primary, others) {
    const label = (id) => (global.AgentBrand && global.AgentBrand.LABELS[id]) || id;
    if (!others.length) return '由 ' + label(primary) + ' 主答';
    const names = others.slice(0, 2).map((agent) => label(agent.id));
    const more = others.length > 2 ? ' 等 ' + (others.length + 1) + ' 个底座' : '';
    return '由 ' + label(primary) + ' 主答，与 ' + names.join('、') + more + '协作';
  }

  /* ---- Detail popover: one global body-level instance; only task-run chains expand, plain chats keep title only. */
  const STATE_LABEL = {
    succeeded: ['已完成', 'done'], running: ['执行中', 'doing'], rework: ['返工中', 'doing'],
    failed: ['没有完成', 'bad'], blocked: ['受阻', 'bad'],
    waiting_human: ['待你确认', 'wait'], pending: ['排队中', 'wait'], created: ['排队中', 'wait'],
  };
  let pop = null;
  let popBound = false;
  let loader = null;

  function ensurePop() {
    if (pop && pop.isConnected) return pop;
    pop = global.document.getElementById('crewPop');
    if (!pop) {
      pop = global.document.createElement('div');
      pop.id = 'crewPop';
      pop.setAttribute('role', 'dialog');
      pop.setAttribute('aria-label', '执行阵容');
      pop.hidden = true;
      global.document.body.appendChild(pop);
    }
    return pop;
  }

  function agentKindOf(executor) {
    const data = executor || {};
    const chain = [data.resolved && data.resolved.agentKind, data.requested && data.requested.agentKind,
      data.assignee, data.provider];
    for (const item of chain) {
      if (!item) continue;
      const id = global.AgentBrand && global.AgentBrand.canonical(item);
      if (id && id !== 'custom') return id;
    }
    return global.AgentBrand ? global.AgentBrand.canonical(data.assignee || data.provider || '') : 'custom';
  }

  function modelOf(executor) {
    return String((executor && executor.resolved && executor.resolved.model) ||
      (executor && executor.requested && executor.requested.model) || '');
  }

  function rowsHtml(run) {
    return ((run && run.nodes) || []).map((node) => {
      const executor = node.executor || {};
      const kind = agentKindOf(executor);
      const labels = (global.AgentBrand && global.AgentBrand.LABELS) || {};
      /* Node row caption shows the engine name (product decision): closer to "who is working"
         than the model name. custom/unknown engines (e.g. closing nodes) show no caption, matching the prototype. */
      const brand = (kind && kind !== 'custom' && labels[kind]) || '';
      const [text, level] = STATE_LABEL[String(node.state || '')] || [String(node.state || '—'), 'wait'];
      return '<div class="crew-pop-row">' +
        '<span class="agent-brand agent-brand-' + esc(kind) + '">' + (global.AgentBrand ?
          global.AgentBrand.glyph(kind) : '') + '</span>' +
        '<span class="crew-pop-name">' + esc(node.name || node.key || '') + '</span>' +
        (brand ? '<span class="crew-pop-model">' + esc(brand) + '</span>' : '') +
        '<span class="crew-pop-state is-' + level + '">' +
        (level === 'doing' ? '<i aria-hidden="true"></i>' : '') + esc(text) + '</span></div>';
    }).join('');
  }

  function bodyHtml(trace, runId) {
    const run = ((trace && trace.runs) || []).find((row) =>
      String(row && row.id || '') === String(runId || ''));
    if (!run) {
      return '<div class="crew-pop-row is-empty">这一轮的执行明细已归档，可在任务详情查看完整链路。</div>';
    }
    return rowsHtml(run) || '<div class="crew-pop-row is-empty">这一轮还没有可展示的执行节点。</div>';
  }

  function position(anchor) {
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(392, global.innerWidth - 24);
    const height = Math.min(360, Math.max(160, pop.offsetHeight));
    pop.style.width = width + 'px';
    pop.style.top = Math.max(12, Math.min(rect.bottom + 8, global.innerHeight - height - 12)) + 'px';
    pop.style.left = Math.max(12, Math.min(rect.left, global.innerWidth - width - 12)) + 'px';
  }

  function close() {
    if (pop) pop.hidden = true;
  }

  /* Stores the loader injected by the panel: prefer the trace cached in the session, then fall back to the API. */
  function setLoader(fn) { loader = typeof fn === 'function' ? fn : null; }

  function open(options) {
    const opts = options || {};
    const anchor = opts.anchor;
    if (!anchor || (!opts.taskId && !opts.trace) || !global.document) return;
    if (opts.loadTrace) loader = opts.loadTrace;   // remember the panel loader so keyboard-triggered opens benefit too
    pop = ensurePop();
    pop._crewRunId = String(opts.runId || (opts.trace && opts.trace.runs && opts.trace.runs[0] && opts.trace.runs[0].id) || '');
    pop.innerHTML = '<div class="crew-pop-head"><b>执行阵容</b>' +
      '<span class="crew-pop-task">' + esc(opts.taskTitle || '') + '</span></div>' +
      '<div class="crew-pop-body"><div class="crew-pop-row is-empty">正在取这一轮的执行明细…</div></div>';
    position(anchor);
    pop.hidden = false;
    const load = opts.trace ? (() => Promise.resolve(opts.trace))
      : (opts.loadTrace || loader || ((id) => Promise.resolve(
        global.SoduWorkAPI && global.SoduWorkAPI.taskTrace ? global.SoduWorkAPI.taskTrace(id) : null)));
    Promise.resolve(load(opts.taskId)).then((trace) => {
      const view = trace && trace.trace ? trace.trace : trace;
      if (!view || !pop || pop.hidden) return;
      pop.querySelector('.crew-pop-body').innerHTML = bodyHtml(view, opts.runId);
      position(anchor.isConnected ? anchor : pop);
    }).catch(() => {
      if (!pop || pop.hidden) return;
      pop.querySelector('.crew-pop-body').innerHTML =
        '<div class="crew-pop-row is-empty">暂时拿不到执行明细，请稍后重试。</div>';
    });
  }

  /* ---- Session-head "crew status bar": list every engine the task uses, once, in plugin
     workflow node order; the engine currently executing per the workflow stays highlighted
     in place (accent pulse ring + orange dot) and does not shift with state.
     Data = task trace of the active collaboration task (same source as the detail popover);
     declared nodes not yet dispatched only appear in the popover. */
  function levelOf(node) {
    return (STATE_LABEL[String((node && node.state) || '')] || [])[1] || '';
  }

  /* Trace usability: only non-empty runs count; an empty trace defers to the fallback chain (fig-4 regression). */
  function usableTrace(trace) {
    return Boolean(trace && Array.isArray(trace.runs) && trace.runs.length);
  }

  /* Data source chain: override (message-attribution fallback) > ctx mirror > trace on the active entry.
     Plugin tasks created mid-session by the runtime go through _loadCollabRun, which writes
     entry.trace only, not the mirror; reading the mirror alone would blank the whole status bar (fig-4 regression). */
  function headInfo(ctx, override) {
    const activeId = String((override && override.taskId) || (ctx && ctx._activeCollabTaskId) || '');
    let trace = (override && override.trace) || (ctx && ctx._collaborationTrace);
    if (!usableTrace(trace) && ctx && ctx._collabTasks) {
      const bound = ctx._collabTasks.get(activeId);
      if (bound && usableTrace(bound.trace)) trace = bound.trace;
    }
    const runs = usableTrace(trace) ? trace.runs : [];
    let run = null;
    for (const row of runs) {   // active run: the last run still having executing nodes; otherwise the last run
      if (((row && row.nodes) || []).some((node) => levelOf(node) === 'doing')) run = row;
    }
    if (!run && runs.length) run = runs[runs.length - 1];
    if (!run) return null;
    const nodes = (run.nodes || []);
    const beads = new Map();   // engine dedup: order of first appearance = plugin workflow order
    nodes.forEach((node) => {
      const kind = agentKindOf(node.executor);
      if (!kind || kind === 'custom') return;
      const doing = levelOf(node) === 'doing';
      const bead = beads.get(kind);
      if (bead) bead.running = bead.running || doing;
      else beads.set(kind, { id: kind, running: doing });
    });
    if (!beads.size) return null;
    const total = nodes.length;
    const stepOf = (level) => nodes.findIndex((node) => levelOf(node) === level) + 1;
    const fold = (step) => '节点 ' + step + '/' + total;   // same fold format as the final prototype
    let running = false, headline = '已完成', detail = fold(total);
    const step = stepOf('doing');
    if (step) { running = true; headline = '执行中'; detail = fold(step); }
    else if (nodes.some((node) => levelOf(node) === 'bad')) {
      headline = '受阻'; detail = fold(stepOf('bad'));
    } else if (nodes.some((node) => levelOf(node) === 'wait')) {
      headline = '待确认'; detail = fold(stepOf('wait'));
    }
    const entry = ctx._collabTasks && ctx._collabTasks.get(activeId);
    return {
      taskId: activeId, runId: String(run.id || ''), trace,
      stale: Boolean(override && override.stale),   // previous round: new message-stream activity after the terminal freeze
      title: String((override && override.title) ||
        (entry && entry.task && entry.task.title) ||
        (ctx._collaborationTask && ctx._collaborationTask.title) || run.name || ''),
      running, headline, detail, total,
      beads: Array.from(beads.values()),
    };
  }

  function headHtml(info) {
    const brand = global.AgentBrand;
    const label = (id) => (brand && brand.LABELS[id]) || id;
    const headlineText = info.stale ? '上一轮 · ' + info.headline : info.headline;
    const stack = '<span class="crew-stack' + (info.running ? ' is-running' : '') + '">' +
      info.beads.map((bead) =>
        '<span class="agent-brand agent-brand-' + esc(bead.id) + ' crew-sub' +
        (bead.running ? ' is-on is-run' : '') + '" title="' + esc(label(bead.id)) + '">' +
        (brand ? brand.glyph(bead.id) : '') +
        (bead.running ? '<i class="crew-dot" aria-hidden="true"></i>' : '') + '</span>').join('') +
      '</span><span class="nchat-crewline-text"><b>' + esc(headlineText) + '</b>' +
      (info.detail ? '<span> · ' + esc(info.detail) + '</span>' : '') + '</span>';
    return stack;
  }

  /* ---- Fig-4 regression fallback: when the runtime creates a plugin task mid-session,
     the collaboration binding may not deliver the trace to the ctx mirror (_loadCollabRun
     writes entry.trace only). The status bar then locates the task straight from message
     attribution (taskId on assistant messages): entry.trace → light cache → one-off fetch.
     Fetches dedupe and cool down 30s after failure; success writes back to entry/mirror
     and triggers a repaint. */
  const traceCache = new Map();
  const traceInflight = new Map();
  const traceFailedAt = new Map();
  const TRACE_CACHE_MAX = 24;

  function latestTaskIdOf(ctx) {
    const messages = (ctx && ctx._snap && Array.isArray(ctx._snap.messages)) ? ctx._snap.messages : [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m && m.role === 'assistant' && m.taskId) return String(m.taskId);
    }
    return '';
  }

  function rememberTrace(taskId, trace) {
    traceCache.set(taskId, trace);
    if (traceCache.size > TRACE_CACHE_MAX) traceCache.delete(traceCache.keys().next().value);
  }

  function scheduleTraceFetch(ctx, taskId) {
    if (!global.SoduWorkAPI || typeof global.SoduWorkAPI.taskTrace !== 'function') return;
    if (traceInflight.has(taskId) || Date.now() - (traceFailedAt.get(taskId) || 0) < 30000) return;
    const request = Promise.resolve(global.SoduWorkAPI.taskTrace(taskId)).then((result) => {
      traceInflight.delete(taskId);
      const trace = result && (result.trace || result);
      if (!usableTrace(trace)) {
        traceFailedAt.set(taskId, Date.now());   // cool down on empty traces too, to avoid repeated fetches during streaming renders
        return;
      }
      rememberTrace(taskId, trace);
      const entry = ctx && ctx._collabTasks && ctx._collabTasks.get(taskId);
      if (entry) entry.trace = trace;
      if (ctx && String(ctx._activeCollabTaskId || '') === taskId && !usableTrace(ctx._collaborationTrace)) {
        ctx._collaborationTrace = trace;
      }
      if (ctx && typeof ctx._render === 'function') ctx._render();
    }).catch(() => {
      traceInflight.delete(taskId);
      traceFailedAt.set(taskId, Date.now());
    });
    traceInflight.set(taskId, request);
  }

  function crewInfoOf(ctx) {
    const taskId = latestTaskIdOf(ctx);
    if (taskId && taskId !== String((ctx && ctx._activeCollabTaskId) || '')) {
      const entry = ctx && ctx._collabTasks && ctx._collabTasks.get(taskId);
      const trace = (entry && entry.trace) || traceCache.get(taskId) || null;
      if (!usableTrace(trace)) { scheduleTraceFetch(ctx, taskId); return null; }
      try { return headInfo(ctx, { taskId, trace }); } catch (_) { return null; }
    }
    return crewDebugInfoOf(ctx);
  }

  /* ---- In-session plugin workflow fallback: local debug runs (mode=conversation) create no Hub
     task; messages carry only sourceAgent.runId without taskId, so the trace chain has no data
     (same root cause as fig-4: the head status bar disappears for the whole round). Fetch run
     nodes per session via SoduWorkAPI.debug and reshape them into a trace so the status bar and
     the detail popover reuse one renderer. */
  const DEBUG_STATE = {
    completed: 'succeeded', running: 'running', pending: 'pending',
    waiting: 'waiting_human', failed: 'failed', blocked: 'blocked', cancelled: 'failed',
  };
  const DEBUG_RUN_STATUS = { completed: 'succeeded', failed: 'failed', cancelled: 'failed' };
  /* Non-terminal runs must keep being followed: a plugin workflow can run for tens of minutes,
     and a single snapshot would leave the status bar stuck on the first node's stale state
     (observed: message stream already at node 2 while the popover still showed node 1 running). */
  const DEBUG_REFRESH_MS = 15000;
  /* Low-frequency recheck for terminal states: once a second workflow round starts in the same
     session the journal switches to a new run; the freeze only applies to one run, and rechecks
     surface the new run within 30s at latest (sooner when render cycles drive it). */
  const DEBUG_FINAL_CHECK_MS = 30000;
  const debugInflight = new Map();
  const debugFailedAt = new Map();
  const debugFetchedAt = new Map();   // ref -> last successful fetch time (throttle against high-frequency IPC during streaming renders)
  const debugFinalRun = new Map();    // ref -> { id, at, msgCount }: terminal freeze keyed by run id;
                                      // a new id (new round) unlocks automatically; msgCount/at feed the "previous round" check

  function debugRunToTrace(run) {
    if (!run || !Array.isArray(run.nodes) || !run.nodes.length) return null;
    const status = DEBUG_RUN_STATUS[String(run.status || '')] || 'running';
    return { status, runs: [{
      id: String(run.id || ''), name: String(run.name || ''),
      nodes: run.nodes.map((node) => ({
        key: node.key, name: node.name,
        state: DEBUG_STATE[String(node.status || '')] || 'pending',
        executor: { resolved: {
          agentKind: String(node.agent || ''), model: String(node.model || ''),
        } },
      })),
    }] };
  }

  function debugMessagesOf(ctx) {
    return (ctx && ctx._snap && Array.isArray(ctx._snap.messages)) ? ctx._snap.messages : [];
  }

  function latestRunIdOf(ctx) {
    const messages = debugMessagesOf(ctx);
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      const runId = m && m.role === 'assistant' && m.sourceAgent && m.sourceAgent.runId;
      if (runId) return String(runId);
    }
    return '';
  }

  function isFinalTrace(trace) {
    return Boolean(trace && (trace.status === 'succeeded' || trace.status === 'failed' || trace.status === 'blocked'));
  }

  /* Previous-round check: after the terminal freeze, when the message stream sees new activity
     (user sends again, AI produces more), the old run's "completed" no longer poses as current
     state — the bar downgrades to the lighter "previous round" style until a new run appears
     (debugFinalRun unlocked by the journal's new id). */
  function debugStaleOf(ctx, trace) {
    if (!isFinalTrace(trace)) return false;
    const ref = String((ctx && (ctx._ref || ctx._sessionId)) || '');
    const finalRun = debugFinalRun.get(ref);
    if (!finalRun || finalRun.id !== String((trace.runs[0] || {}).id || '')) return false;
    const messages = debugMessagesOf(ctx);
    const last = messages[messages.length - 1] || null;
    const ts = Number((last && (last.completedAt || last.sentAt)) || 0);
    return ts > finalRun.at || Boolean(ctx && ctx._pending) ||
      Boolean(ctx && Array.isArray(ctx._localQueue) && ctx._localQueue.length);
  }

  function scheduleDebugFetch(ctx, opts) {
    const api = global.SoduWorkAPI;
    /* The debug channel lives under personalPlugins on the preload bridge; the renderer-composed
       SoduWorkAPI lacks that namespace, so fall back to the native soduWorkAPI bridge. */
    const debugOf = (api && api.personalPlugins && api.personalPlugins.debug) ||
      (global.soduWorkAPI && global.soduWorkAPI.personalPlugins && global.soduWorkAPI.personalPlugins.debug);
    const ref = String((ctx && (ctx._ref || ctx._sessionId)) || '');
    if (typeof debugOf !== 'function' || !ref) return;
    if (debugInflight.has(ref)) return;
    if (Date.now() - (debugFailedAt.get(ref) || 0) < 30000) return;
    /* A run id in message attribution that the cache does not have (new round started) bypasses
       the throttle and fetches immediately; otherwise throttle is tiered by state:
       non-terminal follow 15s, terminal recheck 30s. */
    const expectRunId = String((opts && opts.expectRunId) || '');
    const freshRun = Boolean(expectRunId) && !traceCache.has('run:' + expectRunId);
    /* Tiered throttle: new round (unknown run) fetches immediately; 15s recheck while the
       previous-round check holds (session active); other terminal states recheck 30s;
       non-terminal follows at 15s. */
    const staleActive = Boolean(opts && opts.stale);
    const interval = freshRun ? 0 : staleActive ? DEBUG_REFRESH_MS :
      (debugFinalRun.has(ref) ? DEBUG_FINAL_CHECK_MS : DEBUG_REFRESH_MS);
    if (!freshRun && Date.now() - (debugFetchedAt.get(ref) || 0) < interval) return;
    const request = Promise.resolve(debugOf(ref, { command: 'get' })).then((result) => {
      debugInflight.delete(ref);
      const run = result && result.run;
      const trace = debugRunToTrace(run);
      if (!trace) { debugFailedAt.set(ref, Date.now()); return; }
      const runId = String(run.id || '');
      const terminal = run.status === 'completed' || run.status === 'cancelled' || run.status === 'failed';
      if (terminal) {
        const messages = debugMessagesOf(ctx);
        debugFinalRun.set(ref, { id: runId, at: Date.now(), msgCount: messages.length });
      } else {
        debugFinalRun.delete(ref);   // new round started: release the previous round's terminal freeze
      }
      debugFetchedAt.set(ref, Date.now());
      rememberTrace('run:' + runId, trace);
      /* If the popover is showing this same run's details, repaint its content in place (no re-click needed) */
      if (pop && !pop.hidden && pop._crewRunId === runId) {
        const body = pop.querySelector('.crew-pop-body');
        if (body) body.innerHTML = bodyHtml(trace, runId);
      }
      if (ctx && typeof ctx._render === 'function') ctx._render();
      /* Non-terminal runs keep self-renewing the 15s follow (naturally cools down when the ctx is
         destroyed or the session closed); terminal states stop self-renewing and rely on
         crewDebugInfoOf low-frequency rechecks inside render cycles (30s throttle). */
      if (!terminal) {
        const timer = setTimeout(() => {
          if (!debugFinalRun.has(ref)) { try { scheduleDebugFetch(ctx); } catch (_) { /* session no longer exists */ } }
        }, DEBUG_REFRESH_MS + 50);
        if (timer && typeof timer.unref === 'function') timer.unref();   // do not hold tests/process exit
      }
    }).catch(() => {
      debugInflight.delete(ref);
      debugFailedAt.set(ref, Date.now());
    });
    debugInflight.set(ref, request);
  }

  function crewDebugInfoOf(ctx) {
    const runId = latestRunIdOf(ctx);
    if (!runId) return null;
    const trace = traceCache.get('run:' + runId) || null;
    if (!usableTrace(trace)) { scheduleDebugFetch(ctx, { expectRunId: runId }); return null; }
    /* Non-terminal 15s follow, terminal keeps low-frequency rechecks (tiered inside scheduleDebugFetch):
       after a second round starts in the same session the bar switches over automatically,
       no longer blocked by a single terminal freeze. */
    scheduleDebugFetch(ctx, { expectRunId: runId, stale: debugStaleOf(ctx, trace) });
    try { return headInfo(ctx, { taskId: '', trace, stale: debugStaleOf(ctx, trace) }); }
    catch (_) { return null; }
  }

  let headBar = null;

  /* Session-head status bar entry: idempotent repaint per render cycle, removed when no active task. */
  function paintHead(ctx) {
    if (!global.document) return;
    const actions = global.document.querySelector('.nchat-head-actions');
    if (!actions) return;
    if (headBar && !headBar.isConnected) headBar = null;
    let info = null;
    try { info = headInfo(ctx); } catch (_) { info = null; }
    if (!info) { try { info = crewInfoOf(ctx); } catch (_) { info = null; } }   // fig-4 regression: message-attribution fallback
    if (!info) { if (headBar) { headBar.remove(); headBar = null; } return; }
    const html = headHtml(info);
    if (!headBar) {
      headBar = global.document.createElement('button');
      headBar.type = 'button';
      headBar.className = 'nchat-crewline';
      headBar.setAttribute('aria-haspopup', 'dialog');
      headBar.addEventListener('click', () => {
        const info = headBar._crewInfo || {};
        if (!info.taskId && !info.trace) return;   // in-session debug runs have no taskId, but the trace can expand directly
        const list = ctx && ctx._collabEntries ? ctx._collabEntries() : [];
        const entry = list.find((row) => row.taskId === info.taskId);
        open({ taskId: info.taskId || '', runId: info.runId, trace: info.trace || null, anchor: headBar,
          taskTitle: (entry && entry.title) || headBar.dataset.crewTitle || '',
          loadTrace: (id) => {
            const live = ctx && ctx._collabEntries ? ctx._collabEntries().find((row) => row.taskId === id) : null;
            if (live && live.trace) return live.trace;
            if (traceCache.has(id)) return traceCache.get(id);
            return global.SoduWorkAPI && global.SoduWorkAPI.taskTrace ? global.SoduWorkAPI.taskTrace(id) : null;
          } });
      });
      actions.insertBefore(headBar, actions.firstChild);
    }
    headBar._crewInfo = info;   // used on click: both the taskId fallback chain and the debug-run chain go through here
    if (headBar.dataset.crewHtml === html && headBar.dataset.crewTask === info.taskId) return; // debounce high-frequency renders while streaming
    headBar.dataset.crewHtml = html;
    headBar.innerHTML = html;
    headBar.classList.toggle('is-stale', Boolean(info.stale));   // dim previous rounds to distinguish from current state
    headBar.title = info.title ? '任务阵容 · ' + info.title : '任务阵容';
    headBar.dataset.crewTask = info.taskId;
    headBar.dataset.crewRun = info.runId;
    headBar.dataset.crewTitle = info.title;
  }

  /* Global one-time binding: outside click closes, Escape closes, bead chain keyboard reachable (Enter/Space to expand). */
  function bind() {
    if (popBound || !global.document || !global.document.addEventListener) return;
    popBound = true;
    global.document.addEventListener('click', (event) => {
      if (!pop || pop.hidden) return;
      if (event.target.closest('#crewPop') || event.target.closest('[data-crew-run]')) return;
      close();
    });
    global.document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && pop && !pop.hidden) { close(); return; }
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const anchor = event.target.closest && event.target.closest('[data-crew-run]');
      if (!anchor) return;
      event.preventDefault();
      open({ taskId: anchor.getAttribute('data-crew-task'), runId: anchor.getAttribute('data-crew-run'),
        anchor, taskTitle: anchor.getAttribute('data-crew-title') });
    });
  }

  const api = { crewsOf, turnsOf, stackHtml, open, close, bind, setLoader, paintHead,
    _crewTitle: crewTitle, _agentKindOf: agentKindOf, _modelOf: modelOf, _rowsHtml: rowsHtml,
    _headInfo: headInfo, _headHtml: headHtml,
    _usableTrace: usableTrace, _latestTaskIdOf: latestTaskIdOf, _latestRunIdOf: latestRunIdOf,
    _debugRunToTrace: debugRunToTrace,
    _rememberTrace: rememberTrace, _scheduleTraceFetch: scheduleTraceFetch, _crewInfoOf: crewInfoOf,
    _crewDebugInfoOf: crewDebugInfoOf, _debugStaleOf: debugStaleOf };
  global.ChatCrew = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
