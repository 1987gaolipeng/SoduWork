'use strict';

function install({ app, ipcMain, session, identityOf, memories, cloud, publish }) {
  const trusted = require('../access-control/preferences').isTrusted;
  async function current(event, ref) {
    if (!trusted(event)) throw Error('请在 SoduWork 客户端中切换 Agent');
    const handle = session.get(ref);
    if (!handle) throw Error('会话已关闭，请重新打开');
    const identity = await identityOf(app);
    if (!identity) throw Error('请先登录');
    if (session.get(ref) !== handle) throw Error('会话已关闭，请重新打开');
    memories.assertOwner(identity, handle.sessionId);
    require('../conversation/requirement-context').identityMatches(handle, identity);
    return handle;
  }
  ipcMain.handle('pi-session-select-agent', async (event, ref, agentId) => {
    try {
      const handle = await current(event, ref);
      const result = cloud.guard(handle) ? await cloud.selectExecution(handle, { agentId })
        : await handle.selectAgent(String(agentId || ''), { identity: await identityOf(app),
          validate: async () => {
            if (await current(event, ref) !== handle || cloud.guard(handle)) throw Error('会话归属已变化，请重新打开');
          } });
      if (result?.ok) publish(handle, { kind: 'runtime-changed' }, handle.snapshot());
      return result;
    } catch (error) { return { ok: false, reason: String(error.message || error) }; }
  });
  ipcMain.handle('pi-session-conversation-runtimes', async (event, ref, options) => {
    try {
      const handle = await current(event, ref);
      if (cloud.guard(handle)) return cloud.executionRuntimes(handle);
      if (typeof session.availableRuntimes === 'function') return await session.availableRuntimes(app, options || {});
      const catalog = session.runtimes();
      return { ok: true, runtimes: catalog,
        availableRuntimes: catalog.filter(row => row && row.id === 'pi'),
        missing: catalog.filter(row => row && row.id !== 'pi') };
    } catch (error) { return { ok: false, reason: String(error.message || error) }; }
  });
  ipcMain.handle('pi-session-select-model', async (event, ref, name) => {
    try {
      const handle = await current(event, ref);
      if (cloud.guard(handle)) return await cloud.selectExecution(handle, { modelName: name });
      if (typeof handle.selectModel !== 'function') return { ok: false, reason: '当前会话暂不支持切换模型，请更新客户端后重试' };
      return await handle.selectModel(name);
    } catch (error) { return { ok: false, reason: String(error.message || error) }; }
  });
  ipcMain.handle('pi-session-set-thinking', async (event, ref, value) => {
    // Preserve Pi's boolean contract; native effort strings require the same
    // trusted account and local-runtime checks as model and Agent selection.
    if (typeof value !== 'string') {
      const handle = session.get(ref);
      return !handle || typeof handle.setThinkingMode !== 'function'
        ? { ok: false, reason: '当前会话暂不支持思考模式' } : handle.setThinkingMode(Boolean(value));
    }
    try {
      const handle = await current(event, ref);
      if (cloud.guard(handle) || handle.adapterId !== 'codex' || typeof handle.setThinkingLevel !== 'function')
        return { ok: false, reason: '当前会话暂不支持调整推理强度' };
      return await handle.setThinkingLevel(value);
    } catch (error) { return { ok: false, reason: String(error.message || error) }; }
  });
  return { current };
}
module.exports = { install };
