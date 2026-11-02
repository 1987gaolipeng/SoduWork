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
  pageSize = 20, pagesPerExecution = 4, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let closed = false, timer = null, running = null, generation = 0, owner = '', after = '';
  let lastError = '', lastSuccess = 0;
  async function capture() {
    const identity = await identityOf(app), next = scope(identity);
    if (next !== owner) { owner = next; generation++; after = ''; lastError = ''; lastSuccess = 0; }
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
    running = (async () => {
      const captured = await capture();
      if (!captured.owner) return { ok: true, signedOut: true };
      const page = await request(captured.identity, '/cloud-execution-sync?limit=' + pageSize + '&after=' + encodeURIComponent(after));
      await assertCurrent(captured);
      if (page?.mode !== 'reconcile' || !Array.isArray(page.items) || typeof page.hasMore !== 'boolean' ||
          (page.hasMore && (!page.next || page.next <= after))) throw Error('云端同步目录无效');
      let failed = false;
      for (const row of page.items) {
        await assertCurrent(captured);
        let projection;
        try {
          projection = await open(row, captured.identity, () => assertCurrent(captured));
          for (let i = 0; i < pagesPerExecution; i++) {
            const details = await request(captured.identity, '/cloud-execution-sync/' + encodeURIComponent(row.id) +
              '?ref=' + encodeURIComponent(projection.ref) + '&since=' + projection.cursor + '&limit=400');
            await assertCurrent(captured);
            await projection.apply(details);
            await assertCurrent(captured);
            changed(projection.presence());
            if (details.page?.historyGap) { failed = true; lastError = HISTORY_GAP_MESSAGE; break; }
            if (!details.page?.hasMore) break;
            await pause(0);
          }
        } catch (error) {
          await assertCurrent(captured);
          failed = true; lastError = String(error.message || error);
          if (projection) changed(projection.presence());
        } finally { projection?.close(); }
        await pause(0);
      }
      await assertCurrent(captured);
      after = page.hasMore ? page.next : '';
      if (!failed) { lastError = ''; lastSuccess = Date.now(); }
      return { ok: !failed, hasMore: page.hasMore, count: page.items.length };
    })().catch(error => { lastError = String(error.message || error); return { ok: false, reason: lastError }; })
      .finally(() => { running = null; });
    return running;
  }
  function schedule(delay) {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      const result = await tick();
      schedule(result.hasMore ? 50 : interval);
    }, delay);
    timer.unref?.();
  }
  return { tick, start() { schedule(0); }, wake() { schedule(0); },
    async close() { closed = true; generation++; clearTimeout(timer); timer = null; await running; },
    status: () => ({ syncing: Boolean(running), error: lastError, lastSuccess }) };
}
module.exports = { create, scope, HISTORY_GAP_MESSAGE, ARTIFACT_RETRY_MESSAGE };
