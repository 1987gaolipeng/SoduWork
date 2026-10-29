'use strict';

// An automation is one ordinary message in a new ordinary chat. This worker
// only hands off the immutable trigger and records its receipt; the chat engine
// owns tools, streaming, permissions, history and subsequent user messages.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { resultState } = require('./pi-session/task-turn');
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const keyOf = (identity, runId) => crypto.createHash('sha256')
  .update(String(identity.hub).replace(/\/+$/, '') + '\n' + identity.clientId + '\n' + runId).digest('hex');

function diskJournal(directory) {
  fs.mkdirSync(directory, { recursive: true });
  function filename(key) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw Error('Invalid automation journal key');
    return path.join(directory, key + '.json');
  }
  return {
    read(key) {
      try { return JSON.parse(fs.readFileSync(filename(key), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    write(key, record) {
      const target = filename(key), temporary = target + '.tmp';
      const fd = fs.openSync(temporary, 'w', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporary, target);
    },
  };
}

function pluginSelection(spec, catalog) {
  if (!spec || !spec.key) return null;
  const plugin = catalog.find(item => item.key === spec.key && item.enabled !== false);
  if (!plugin || !plugin.entrypoints || !plugin.entrypoints.automation) {
    throw Error('该个人插件未安装、已停用或不支持自动化，请检查插件设置');
  }
  if (spec.versionPolicy === 'pinned' &&
      (plugin.version !== spec.version || plugin.checksum !== spec.checksum)) {
    throw Error('个人插件版本与计划锁定的版本不一致，本次未执行；请检查插件版本设置');
  }
  return { pluginId: plugin.pluginId, version: plugin.version, checksum: plugin.checksum };
}

function createWorker({ identityOf, request, journal, conversation, catalog,
  instanceId = crypto.randomUUID(), onError = () => {} }) {
  let ticking = false, stopped = false;
  let authBlockedUntil = 0, authBlockedIdentity = '', authNoticeSent = false;
  const jobs = new Map();
  const identityKey = identity => identity && identity.hub && identity.clientId
    ? String(identity.hub).replace(/\/+$/, '') + '\n' + identity.clientId : '';
  const isAuthError = error => !!(error && (error.authRequired || error.permissionRequired ||
    error.status === 401 || error.status === 403));
  function blockIdentity(identity, error) {
    const key = identityKey(identity);
    if (key !== authBlockedIdentity) authNoticeSent = false;
    authBlockedIdentity = key;
    authBlockedUntil = Date.now() + 60_000;
    if (!authNoticeSent) {
      authNoticeSent = true;
      onError(error && error.permissionRequired ? '当前连接没有自动化权限，请重新登录或联系管理员' : '登录已过期，自动化已暂停，请重新连接 SoduWork 服务');
    }
  }
  function save(key, record) { journal.write(key, record); return record; }
  async function acknowledge(identity, id, record) {
    try {
      await request(identity, '/automation-conversations/' + encodeURIComponent(id) + '/state', {
        instanceId, conversationId: record.conversationId || '', state: record.state,
        error: record.error || '',
      });
    } catch (_) { throw Object.assign(Error('回执连接暂不可用'), { code: 'RECEIPT_UNAVAILABLE' }); }
  }
  async function processRun(identity, row) {
    const key = keyOf(identity, row.id);
    const claimed = await request(identity, '/automation-conversations/' + encodeURIComponent(row.id) + '/claim', { instanceId });
    if (claimed.terminal) { jobs.delete(key); return; }
    if (!claimed.ok || claimed.busy) return;
    let record = journal.read(key);
    if (record && TERMINAL.has(record.state)) {
      await acknowledge(identity, row.id, record); jobs.delete(key); return;
    }
    if (record && record.phase === 'sending' && !jobs.has(key)) {
      // A crash between submit and completion is ambiguous. Never replay tools
      // automatically. The saved ordinary chat is still available to continue.
      record = save(key, { ...record, state: 'failed',
        error: '客户端执行被中断；为避免重复操作未自动重发，请打开原对话查看并继续。' });
      await acknowledge(identity, row.id, record); return;
    }
    if (jobs.has(key)) {
      const handle = conversation.find(record.conversationId);
      const status = handle && (typeof handle.status === 'function' ? handle.status() : handle.status);
      record = save(key, { ...record, state: record.needsInput || status === 'waiting-user' ? 'waiting' : 'running' });
      await acknowledge(identity, row.id, record); return;
    }
    const input = claimed.input || {};
    try {
      if (claimed.conversationId && (!record || record.conversationId !== claimed.conversationId)) {
        record = { conversationId: claimed.conversationId };
        throw Error('此触发已在另一客户端创建对话，请打开原对话确认；本次没有重复执行');
      }
      if (input.runId !== row.id || !String(input.text || '').trim()) throw Error('自动化输入不完整，本次未执行');
      if (input.text.length > 50000) throw Error('自动化内容超过单轮长度限制，请精简材料后重试；内容未被截断');
      if (!record && typeof conversation.captureAutomationAccess === 'function') {
        const accessChoice = await conversation.captureAutomationAccess({ adapterId: input.adapterId }, identity, row.id, claimed.trigger);
        // Persist the first choice before any await that can create a runtime.
        // Existing journals without a choice retain their original contract.
        record = save(key, { phase: 'prepared', state: 'running', accessChoice });
      }
      const plugin = pluginSelection(input.personalPlugin, await catalog());
      const options = {
        ...(record && record.conversationId ? { chatId: record.conversationId } : {}),
        adapterId: input.adapterId, modelName: input.modelName, intent: 'chat',
        cwd: input.cwd || '', capabilities: input.capabilities && input.capabilities.length ? input.capabilities : undefined,
        skills: input.skills,
        ...(plugin ? { pluginLock: plugin } : {}),
      };
      if (record?.accessChoice && claimed.trigger !== 'manual') throw Error('本次自动化授权来源已变化，请重新运行');
      const opened = record?.accessChoice
        ? await conversation.openAutomation(options, identity, record.accessChoice, row.id)
        : await conversation.open(options, identity);
      if (!opened || !opened.ok) throw Error('普通对话未能启动，请检查当前 Agent、模型与工作目录后重试');
      const available = new Set((opened.capabilities || []).map(item => item.id));
      if ((input.capabilities || []).some(id => !available.has(id))) {
        throw Error('本次自动化所需能力尚未安装或授权，请检查能力配置后重试');
      }
      record = save(key, { ...record, phase: 'created', state: 'running', conversationId: opened.sessionId });
      await acknowledge(identity, row.id, record);
      const currentIdentity = await identityOf();
      if (stopped || !currentIdentity || keyOf(currentIdentity, row.id) !== key) throw Error('客户端停止或连接环境已切换，本次消息未发送');
      if (record.accessChoice && !require('./access-control/automation-access').matches(record.accessChoice, currentIdentity)) throw Error('连接账号已切换，本次消息未发送');
      // Persist BEFORE submitting. Lost completion acknowledgements only retry
      // the receipt, never the original message or its external side effects.
      record = save(key, { ...record, phase: 'sending' });
      const sent = await conversation.send(opened.ref, input.text, input.attachments || [], {
        submissionId: 'automation-' + row.id, projectId: input.projectId || '',
        plugins: plugin ? [{ pluginId: plugin.pluginId }] : [],
      });
      if (!sent || !sent.ok) throw Error('自动化消息未被接收，请打开对话查看原因后重试');
      jobs.set(key, true);
      Promise.resolve(sent.completion).then(result => {
        const state = { completed: 'succeeded', failed: 'failed', stopped: 'cancelled', waiting: 'waiting' }[resultState(result)];
        save(key, { ...record, state, needsInput: state === 'waiting',
          error: state === 'failed' ? '本轮执行未完成，请打开对话查看详细原因并继续。' : '' });
      }, () => save(key, { ...record, state: 'failed', error: '本轮执行中断，请打开对话查看并继续。' }))
        .catch(() => onError('自动化回执未能写入，本次内容不会自动重发'));
    } catch (error) {
      if (isAuthError(error)) throw error;
      if (error.code === 'RECEIPT_UNAVAILABLE') throw error;
      // Never echo provider errors, local paths, instruction contents or credentials.
      const reason = error.code ? '自动化本地记录暂不可用，请检查客户端后重试' : String(error.message || '自动化未启动').slice(0, 300);
      record = save(key, { ...record, state: 'failed', error: reason });
      await acknowledge(identity, row.id, record);
    }
  }
  async function tick() {
    if (ticking || stopped) return;
    ticking = true;
    let identity;
    try {
      identity = await identityOf();
      if (!identity || !identity.hub || !identity.clientId) return;
      const key = identityKey(identity);
      if (key !== authBlockedIdentity) { authBlockedIdentity = key; authBlockedUntil = 0; authNoticeSent = false; }
      if (authBlockedUntil > Date.now()) return;
      const inbox = await request(identity, '/automation-conversations/inbox', {});
      for (const row of inbox.items || []) {
        if (stopped) break;
        try { await processRun(identity, row); }
        catch (_) { onError('自动化连接或回执同步暂不可用，稍后重试'); }
      }
    } catch (error) {
      if (isAuthError(error)) blockIdentity(identity, error);
      /* Offline/old Hub: no fallback to a second execution route. */
    }
    finally { ticking = false; }
  }
  return { tick, stop() { stopped = true; } };
}

function install({ app, ipcMain, identityOf, conversation, platformConnections }) {
  require('./automation-preflight.cjs').install({ app, ipcMain, identityOf, platformConnections });
  let worker, timer;
  app.whenReady().then(() => {
    worker = createWorker({ identityOf: () => identityOf(app),
      request: require('./pi-session/task-input').request,
      journal: diskJournal(path.join(app.getPath('userData'), 'automation-conversations')),
      conversation, catalog: () => require('./personal-plugins').catalog(app),
      onError: message => console.warn('[automation-conversation]', message),
    });
    timer = setInterval(() => worker.tick(), 5000); timer.unref(); worker.tick();
  });
  app.on('before-quit', () => { clearInterval(timer); if (worker) worker.stop(); });
}
module.exports = { createWorker, diskJournal, pluginSelection, keyOf, install };
