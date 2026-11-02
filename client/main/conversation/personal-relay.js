'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fetchWithDeviceAuthRetry, accountScopeKey } = require('../device-auth-request');

function fingerprint(handle) {
  const value = handle.snapshot();
  return JSON.stringify({ messages: value.messages, status: value.status,
    adapterId: handle.adapterId, cwd: handle.cwd, modelSelection: value.modelSelection,
    accessControl: value.accessControl, activePlugins: value.activePlugins,
    taskRef: handle.taskRef, skills: handle.ui?.selectedSkills });
}

// The Hub grants admission once. A durable local fence is written before send;
// a process crash can never cause an automatic second native submission.
function create({ app, identityOf, find, open, send, sync, fetch = fetchWithDeviceAuthRetry,
  intervalMs = 5000, autoStart = true }) {
  let closed = false, timer = null, running = null;
  const root = path.join(app.getPath('userData'), 'personal-conversation-relay');
  const scope = identity => JSON.stringify([String(identity?.hub || '').replace(/\/+$/, ''),
    identity?.clientId || '', accountScopeKey(identity)]);
  async function assertIdentity(identity) {
    const current = await identityOf();
    if (scope(current) !== scope(identity)) throw Error('账号或服务已切换，请在来源电脑重新确认');
  }
  function ledger(identity, id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('Invalid relay identity');
    const directory = path.join(root, crypto.createHash('sha256').update(scope(identity)).digest('hex'));
    return { directory, file: path.join(directory, id + '.json') };
  }
  function read(identity, id) {
    const { file } = ledger(identity, id);
    if (!fs.existsSync(file)) return null;
    // A damaged fence is not permission to resend.
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  function write(identity, id, receipt) {
    const { directory, file } = ledger(identity, id);
    fs.mkdirSync(directory, { recursive: true });
    const temp = file + '.' + crypto.randomUUID() + '.tmp';
    const fd = fs.openSync(temp, 'wx');
    try { fs.writeFileSync(fd, JSON.stringify(receipt)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  }
  async function request(identity, route, body = {}) {
    await assertIdentity(identity);
    const response = await fetch(identity, String(identity.hub).replace(/\/+$/, '') +
      '/api/v1/personal-conversation-relay/' + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw Error('接力服务暂不可用 (' + response.status + ')');
    const result = await response.json();
    await assertIdentity(identity);
    return result;
  }
  async function process(identity, job) {
    if (job.targetClientId !== identity.clientId || !job.sourceSessionId || !job.conversationId) return;
    const prior = read(identity, job.id);
    if (prior || job.phase !== 'prepared') {
      const receipt = prior?.phase === 'accepted' || prior?.phase === 'rejected' ? prior :
        { phase: 'uncertain', reason: '上次接力是否发送尚未确认，请在来源电脑核对；不会自动重发' };
      await request(identity, 'acks/' + job.id, receipt);
      return;
    }
    let handle, captured, failure = '';
    try {
      await assertIdentity(identity);
      handle = find(job.sourceSessionId);
      if (!handle) {
        const result = await open({ chatId: job.sourceSessionId, nativeRelay: true }, identity);
        if (!result?.ok) throw Error(result?.reason || '原生会话不能恢复，请在来源电脑打开后重试');
        handle = find(job.sourceSessionId);
      }
      if (!handle || handle.sessionId !== job.sourceSessionId || handle.passiveCloudView ||
          handle.snapshot()?.execution?.accountConversation || handle.snapshot()?.cloudHandoff) {
        throw Error('当前记录不是可继续的本机原生会话');
      }
      if (handle.inFlight?.() || handle.snapshot()?.status === 'responding') throw Error('原会话正在执行，请结束后重试');
      if (handle.snapshot()?.runtimeUnavailable) throw Error('来源电脑底座已中断，请先在电脑恢复会话');
      if (handle.taskRef || handle.activeTaskId || handle.taskIds?.length) {
        throw Error('需求执行会话请从需求入口继续，不能作为普通聊天接力');
      }
      captured = fingerprint(handle);
      const synced = await sync();
      if (synced?.ok === false) throw Error('来源聊天尚未同步完成，请稍后重试');
      await assertIdentity(identity);
    } catch (error) { failure = String(error.message || error); }
    // Claim after flushing the source transcript. Hub compares its durable
    // epoch/revision and rejects a stale phone draft before any native effect.
    await request(identity, 'claims/' + job.id);
    let receipt;
    if (failure) receipt = { phase: 'rejected', reason: failure };
    else {
      write(identity, job.id, { phase: 'sending' });
      try {
        await assertIdentity(identity);
        const result = await send(handle.ref, job.instruction, [], {
          submissionId: 'personal-relay-' + job.id,
          // Plugins remain selected in the native session archive. Resolve
          // skills again through the existing per-turn authorization path.
          skills: [...(handle.ui?.selectedSkills || [])],
          // This function cannot cross renderer IPC; it is a main-process fence
          // checked again immediately before the existing submit boundary.
          nativeRelayGuard: async () => {
            await assertIdentity(identity);
            if (closed || find(job.sourceSessionId) !== handle || handle.inFlight?.() ||
                fingerprint(handle) !== captured) throw Error('原会话已变化，本次接力未发送');
          },
        });
        receipt = result?.ok && result?.accepted ? { phase: 'accepted', reason: '' } :
          { phase: 'rejected', reason: String(result?.reason || '原会话没有接收本次要求').slice(0, 500) };
      } catch (_) {
        receipt = { phase: 'uncertain', reason: '发送结果尚未确认，请在来源电脑查看；不会自动重发' };
      }
    }
    write(identity, job.id, receipt);
    await request(identity, 'acks/' + job.id, receipt);
    await sync();
  }
  function tick() {
    if (closed) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      const identity = await identityOf();
      if (!identity?.session || !identity?.clientId || !identity?.hub) return;
      const response = await request(identity, 'poll');
      for (const job of response.requests || []) {
        if (closed) break;
        try { await process(identity, job); }
        catch (_) { /* Retry only discovery/acknowledgment, never native send. */ }
      }
    })().finally(() => { running = null; });
    return running;
  }
  function schedule() {
    if (closed) return;
    timer = setTimeout(() => { tick().catch(() => {}).finally(schedule); }, intervalMs);
    timer.unref?.();
  }
  if (autoStart) schedule();
  return { tick, close() { closed = true; clearTimeout(timer); } };
}

module.exports = { create, fingerprint };
