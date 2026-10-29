'use strict';

// Reconfigure a running SDK session without resubmitting the user's prompt.
// Tools which already started settle before aborting the model request. Their
// recorded results are carried into the replacement session, never replayed.
function create({ current, transition, changed = () => {}, stopped = () => false }) {
  let changing = null, generation = 0, cancelled = 0, closed = false, activeRuns = 0, continuing = false;
  const resume = () => current().session.sendCustomMessage({
    customType: 'soduwork.access.changed', display: false,
    content: 'The user changed this session access policy to ' + (current().policy?.mode || 'standard') +
      '. It is effective now. Continue the unfinished current request from the recorded progress. ' +
      'Do not repeat completed tools or external side effects. Calls blocked solely for the permission transition were not executed; reassess them under the new policy. Do not mention this internal control message.',
  }, { triggerTurn: true });
  async function idleTools(live) {
    if (live.access?.suspend) return live.access.suspend();
    // Historic sessions have no approval hook. Wait for their current native
    // tool batch instead of terminating a tool with an uncertain side effect.
    if (!live.session.agent?.state.pendingToolCalls?.size) return;
    await new Promise(resolve => {
      const off = live.session.subscribe(event => {
        if (event.type === 'tool_execution_end' && !live.session.agent.state.pendingToolCalls.size) { off(); resolve(); }
      });
    });
  }
  return {
    changing: () => Boolean(changing),
    view(snapshot) {
      // The old SDK emits agent_settled between abort and continuation. An
      // intentional restart without prose is not a model/no-output failure.
      if (activeRuns && continuing && !closed && !stopped() &&
          ['no-output', 'idle'].includes(snapshot.status)) {
        return { ...snapshot, status: 'streaming', statusText: '' };
      }
      return snapshot;
    },
    wait: () => changing || Promise.resolve({ ok: true }),
    change(policy, revision) {
      if (closed) return Promise.resolve({ ok: false, reason: '会话已经关闭' });
      if (changing) return Promise.resolve({ ok: false, reason: '正在更新权限…' });
      // A permission-only upgrade has no runtime boundary: keep streaming,
      // already executing tools, and the exact call awaiting human approval.
      try {
        const upgraded = transition.upgrade?.(policy, revision);
        if (upgraded) return Promise.resolve(upgraded);
      } catch (error) {
        return Promise.resolve({ ok: false, reason: '权限变更未生效：' + String(error?.message || error) });
      }
      const live = current();
      transition.schedule(policy, revision);
      generation++;
      if (activeRuns) continuing = true;
      changing = (async () => {
        // Suspend synchronously before any preload can run. Resource discovery
        // can overlap a tool finishing, but replacement/history must wait.
        const idle = idleTools(live);
        const resources = Promise.resolve().then(() => transition.preload?.())
          .then(() => ({ ok: true }), error => ({ error }));
        await idle;
        await live.session.abort();
        if (closed) throw Error('会话已经关闭');
        const loaded = await resources;
        if (loaded.error) throw loaded.error;
        await transition.apply();
        return { ok: true, effective: 'current-turn' };
      })().catch(error => {
        transition.discard?.();
        live.access?.resume?.();
        return { ok: false, reason: '权限变更未生效：' + String(error?.message || error) };
      }).finally(() => { changing = null; changed(); });
      changed(); return changing;
    },
    async run(operation) {
      activeRuns++;
      try {
        let seen = generation, cancellation = cancelled, value, failure;
        try { value = await operation(); } catch (error) { failure = error; }
        while (changing || seen !== generation) {
          const work = changing; seen = generation;
          if (work) await work;
          if (closed || cancellation !== cancelled || stopped()) return value;
          // An aborted model/permission wait is continued once, in the same
          // native history. No new user turn or conversation queue item is made.
          failure = null;
          try { value = await resume(); } catch (error) { failure = error; }
        }
        if (failure) throw failure;
        return value;
      } finally { activeRuns--; if (!activeRuns) continuing = false; changed(); }
    },
    cancel() { cancelled++; continuing = false; },
    close() { closed = true; cancelled++; },
  };
}
module.exports = { create };
