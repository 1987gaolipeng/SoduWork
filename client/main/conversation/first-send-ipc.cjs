'use strict';

const path = require('node:path');
const history = require('./history-access');
const runtime = require('../platform-connections/runtime.cjs');
const trusted = event => require('../access-control/preferences').isTrusted(event) &&
  !require('../work-preview').isAppComposer?.(event.sender);

function install({ app, session, ipcMain, BrowserWindow, identityOf, openConversation, sendConversation, attach, detach }) {
  function binding(captured) {
    if (!captured?.readScope || !captured.identity?.clientId) return '';
    return require('node:crypto').createHash('sha256').update(JSON.stringify([captured.readScope, captured.identity.clientId])).digest('hex');
  }
  async function actor(event, cachedOnly = false) {
    if (!trusted(event)) throw Error('请在工作台中查看或发送首条消息');
    const captured = history.actor(app);
    if (cachedOnly) {
      // Sidebar reads follow the offline history contract. A missing or
      // expired signed scope hides private drafts until the next login.
      try { return { event, captured, owner: runtime.connectionScope(captured.identity), cachedOnly: true }; }
      catch { return null; }
    }
    const identity = await identityOf(app);
    history.assertCurrent(app, captured, identity);
    return { event, captured, owner: runtime.connectionScope(identity), binding: binding(captured), identity };
  }
  async function assertCurrent(context) {
    const identity = context.cachedOnly ? require('./requirement-context').cachedIdentity(app) : await identityOf(app);
    history.assertCurrent(app, context.captured, identity);
    if (runtime.connectionScope(identity) !== context.owner || !trusted(context.event))
      throw Error('工作台或账号已变化，请重新打开会话');
  }
  const service = require('./first-send.cjs').create({
    root: path.join(app.getPath('userData'), 'first-send-requests'), actor, assertCurrent,
    async open(context, options) {
      // Use the ordinary foreground contract: expectedIdentity belongs to
      // non-interactive automation and rejects interactive full-access grants.
      await assertCurrent(context);
      const reply = await openConversation(context.event, options);
      if (reply?.ok && reply.ref) detach(reply.ref);
      return reply;
    },
    async send(context, ref, text, files, options, settled, sessionId, rememberTarget) {
      let dispatched = false;
      const handle = session.get(ref);
      const guard = async () => {
        await assertCurrent(context);
        if (!handle || handle.sessionId !== sessionId || session.get(ref) !== handle) throw Error('原会话已关闭，请重新打开');
      };
      const remember = () => rememberTarget(handle.adapterId, handle.nativeSessionId || handle.sessionId,
        () => handle.snapshot?.()?.modelSelection?.name);
      guard.beforeDispatch = () => {
        remember();
        dispatched = true;
      };
      try {
        // Keep the edited selection even if a preflight check refuses this retry.
        if (handle?.sessionId === sessionId) remember();
        const observe = promise => { void promise.then(settled, error => settled({ ok: false, reason: String(error?.message || error) })); };
        const reply = await sendConversation(ref, text, files, options, observe, undefined, guard);
        return reply?.ok || dispatched ? reply : { ...reply, notSent: true };
      } catch (error) {
        if (dispatched) throw error;
        return { ok: false, notSent: true, reason: error.message };
      }
    },
    received: (context, row) => require('./first-send-receipt.cjs').received({ app, session, row, owner: context.owner,
      guard: () => history.assertCurrent(app, context.captured) }),
    notify() {
      for (const win of BrowserWindow.getAllWindows()) {
        try { if (!win.isDestroyed()) win.webContents.send('pi-first-send-changed'); } catch { /* Closing window. */ }
      }
    },
  });
  ipcMain.handle('pi-first-send-retry-in-place', async (event, id, expected, ref, text, files, options) => {
    try {
      const handle = session.get(ref), attemptId = options?.submissionId;
      if (!handle?.sessionId || handle.localReplica || !/^ui-[a-z0-9-]{1,60}$/.test(attemptId || '') || attemptId === expected)
        throw Error('请从原会话恢复这条首发请求');
      return await service.start(event, { intentId: id, open: {}, text, attachments: files, turn: options },
        { expected, ref, sessionId: handle.sessionId, attemptId });
    } catch (error) { return { ok: false, reason: String(error.message || error) }; }
  });
  for (const action of ['start', 'list', 'wait', 'attach', 'associations', 'ack-associations', 'discard']) {
    ipcMain.handle('pi-first-send-' + action, async (event, input, sessionId) => {
      try {
        if (action === 'start') return await service.start(event, input);
        if (action === 'list') return await service.list(event);
        if (action === 'discard') return await service.discard(event, input, sessionId);
        if (action === 'associations') return await service.associations(event);
        if (action === 'ack-associations') return await service.ackAssociations(event, input, sessionId);
        if (action === 'attach') {
          const result = await service.act(event, input, 'attach', sessionId);
          return attach(event, result.row.sessionId);
        }
        return await service.act(event, input, action, sessionId);
      } catch (error) { return { ok: false, reason: String(error.message || error) }; }
    });
  }
  return (captured, sessionId) => {
    let owner;
    try { owner = runtime.connectionScope(captured.identity); } catch { /* Use this enrollment's verified offline binding. */ }
    service.forgetSession({ owner, binding: binding(captured) }, sessionId);
  };
}
module.exports = { install };
