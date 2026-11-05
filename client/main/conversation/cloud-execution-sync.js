'use strict';

// Directory cursors last for one bounded scan only. Every completed scan starts
// again at the beginning so commits behind its position are never lost.
const crypto = require('node:crypto');
const { accountId } = require('../device-auth-request');
const HISTORY_GAP_MESSAGE = '部分历史记录尚未同步，已有记录已保留；可在原执行机核对。';
const ARTIFACT_RETRY_MESSAGE = '云端成果尚未完成同步，将自动重试；已收到的过程记录已保留。';
function scope(identity) {
  const user = accountId(identity);
  if (!user || !identity?.hub) return '';
  return crypto.createHash('sha256').update(new URL(identity.hub).origin + '\0' + user).digest('hex');
}

function create({ app, identityOf, request, open, changed = () => {}, interval = 15000,
  pageSize = 20, pagesPerExecution = 4, pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
  discovery = require('../native-discovery.cjs'), now = Date.now, reconcileMs = 60000,
  setTimeout: later = setTimeout, clearTimeout: cancel = clearTimeout }) {
  let closed = false, timer = null, running = null, generation = 0, owner = '', after = '';
  let timerDue = 0, lastStartedAt = -Infinity, retryAfter = 0;
  let authScope = '', currentIdentity = null, epoch = 0, wakePending = false, started = false;
  const dirty = new Map(), completed = new Map();
  const topic = 'cloud-execution-sync';
  const confirmed = () => Boolean(currentIdentity && discovery.confirmed(currentIdentity, topic));
  let lastError = '', lastSuccess = 0;
  async function capture() {
    const identity = await identityOf(app), next = scope(identity);
    const nextAuth = require('../native-discovery.cjs').scopeOf(identity);
    if (next !== owner || nextAuth !== authScope) {
      owner = next; authScope = nextAuth; generation++; after = ''; lastError = ''; lastSuccess = 0;
      completed.clear(); dirty.clear(); epoch++;
    }
    currentIdentity = identity;
    return { identity, owner: next, generation };
  }
  async function assertCurrent(captured) {
    const current = await capture();
    if (closed || !captured.owner || current.owner !== captured.owner || current.generation !== captured.generation)
      throw Error('云端同步连接已切换');
    return current.identity;
  }
  async function tick() {
    if (closed) return { ok: false, closed: true };
    if (running) return running;
    lastStartedAt = now();
    running = (async () => {
      const captured = await capture();
      if (!captured.owner) return { ok: true, signedOut: true };
      const page = await request(captured.identity, '/cloud-execution-sync?limit=' + pageSize + '&after=' + encodeURIComponent(after));
      await assertCurrent(captured);
      if (page?.mode !== 'reconcile' || !Array.isArray(page.items) || typeof page.hasMore !== 'boolean' ||
          (page.hasMore && (!page.next || page.next <= after))) throw Error('云端同步目录无效');
      let failed = false, pending = false;
      for (const row of page.items) {
        await assertCurrent(captured);
        let projection;
        try {
          projection = await open(row, captured.identity, () => assertCurrent(captured));
          const key = String(row.receipt?.taskId || ''), stamp = dirty.get(key) || 0, capturedEpoch = epoch;
          const fingerprint = JSON.stringify(row), previous = completed.get(row.id);
          // A directory timestamp is not an attachment/approval/message watermark.
          // Push invalidates the task, and a bounded full detail read repairs any
          // missing hint even when every field in the directory is unchanged.
          if (confirmed() && previous && previous.fingerprint === fingerprint &&
              previous.epoch === capturedEpoch && previous.stamp === stamp &&
              previous.cursor === projection.cursor && now() - previous.at < reconcileMs &&
              await projection.reusable?.()) continue;
          let settled = false;
          for (let i = 0; i < pagesPerExecution; i++) {
            const details = await request(captured.identity, '/cloud-execution-sync/' + encodeURIComponent(row.id) +
              '?ref=' + encodeURIComponent(projection.ref) + '&since=' + projection.cursor + '&limit=400');
            await assertCurrent(captured);
            const applied = await projection.apply(details);
            await assertCurrent(captured);
            changed(projection.presence());
            if (applied?.restarted) { await pause(0); continue; }
            if (details.page?.historyGap) { failed = true; lastError = HISTORY_GAP_MESSAGE; break; }
            if (!details.page?.hasMore) { settled = true; break; }
            await pause(0);
          }
          if (settled) {
            completed.delete(row.id);
            completed.set(row.id, { fingerprint, epoch: capturedEpoch, stamp, cursor: projection.cursor, at: now() });
            if (completed.size > 1000) completed.delete(completed.keys().next().value);
          } else { completed.delete(row.id); pending = true; }
        } catch (error) {
          await assertCurrent(captured);
          failed = true; lastError = String(error.message || error);
          completed.delete(row.id);
          if (projection) changed(projection.presence());
        } finally { projection?.close(); }
        await pause(0);
      }
      await assertCurrent(captured);
      after = page.hasMore ? page.next : '';
      if (!failed) { lastError = ''; lastSuccess = Date.now(); }
      return { ok: !failed, hasMore: page.hasMore, pending, count: page.items.length };
    })().catch(error => { lastError = String(error.message || error); return { ok: false, reason: lastError }; })
      .then(result => {
        // Backoff begins after completion. A stream of hints cannot turn a
        // slow failed request into immediate retries against an unhealthy Hub.
        retryAfter = result.ok === false ? now() + Math.max(1000, interval) : 0;
        return result;
      })
      .finally(() => { running = null; });
    return running;
  }
  function schedule(delay) {
    if (closed || !started) return;
    const due = Math.max(now() + Math.max(0, delay), lastStartedAt + 1000, retryAfter);
    // A later hint may pull a quiet timer forward; it must never postpone an
    // already queued refresh, including during a continuous event stream.
    if (timer && timerDue <= due) return;
    if (timer) cancel(timer);
    timerDue = due;
    timer = later(async () => {
      timer = null; timerDue = 0;
      if (!after) wakePending = false;
      const result = await tick();
      // Finish the current bounded scan before restarting. A hot early task
      // must not starve later directory pages by constantly resetting `after`.
      if (result.hasMore) schedule(50);
      else if (wakePending) { after = ''; schedule(50); }
      else schedule(result.ok === false ? interval : result.pending ? 1000 : confirmed() ? reconcileMs : interval);
    }, Math.max(0, due - now()));
    timer.unref?.();
  }
  function wake(event) {
    const task = typeof event?.taskId === 'string' ? event.taskId : '';
    if (task && task.length <= 80) {
      dirty.set(task, (dirty.get(task) || 0) + 1);
      if (dirty.size > 1000) { dirty.clear(); completed.clear(); epoch++; }
    } else epoch++;
    // Coalesce a push during a request; never clear a newer invalidation when
    // that request completes, and restart the directory to catch late commits.
    wakePending = true;
    if (!running) schedule(100);
  }
  const unregister = discovery.register(topic, wake);
  return { tick, start() { started = true; schedule(0); }, wake,
    async close() { closed = true; generation++; unregister(); if (timer) cancel(timer); timer = null; await running; },
    status: () => ({ syncing: Boolean(running), error: lastError, lastSuccess }) };
}
module.exports = { create, scope, HISTORY_GAP_MESSAGE, ARTIFACT_RETRY_MESSAGE };
