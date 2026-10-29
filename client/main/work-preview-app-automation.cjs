'use strict';
// An installed app may opt into direct schedule creation. Reuse the ordinary
// renderer host/API; retain uncertain receipts so a retry cannot create twice.
const crypto = require('node:crypto');
const stores = new WeakMap();
const appOwner = require('./work-preview-app-owner.cjs');
function submit({ owner, item, request, deps }) {
  appOwner.assertCurrent(item);
  const pluginId = String(item.appBridge.appId || '').replace(/^plugin:/, '');
  const installed = require('./personal-plugins').get(deps.app, pluginId);
  const source = installed.ui?.contributions?.find(row => row.id === item.appBridge.contributionId)?.source;
  if (!installed.enabled || source?.type !== 'external' || new URL(source.url).origin !== item.appBridge.origin ||
      !source.bridge?.capabilities?.includes('automation.create')) throw Error('应用未获准直接创建自动化，请更新应用');
  if (!owner.sender || owner.sender.isDestroyed()) throw Error('SoduWork 工作区已关闭');
  const page = new URL(request.params.context.page || source.url);
  if (page.origin !== item.appBridge.origin || page.username || page.password) throw Error('任务页面必须属于当前应用来源');
  page.search = ''; page.hash = ''; page.searchParams.set('space', request.params.context.spaceId);
  const scope = require('./app-settings-store.cjs').scope({ pluginId, origin: item.appBridge.origin });
  let receipts = stores.get(owner);
  if (!receipts) { receipts = new Map(); stores.set(owner, receipts); }
  const key = scope + ':' + request.params.requestId, content = JSON.stringify(request.params);
  const previous = receipts.get(key);
  if (previous) return previous.content === content ? previous.promise : Promise.resolve({ ok: false, reason: '请求编号已用于其他任务，请重新发起' });
  if (receipts.size >= 200) throw Error('本窗口创建请求过多，请重新打开应用');
  const id = 'automation-' + crypto.randomUUID();
  const promise = new Promise(resolve => {
    const pending = owner.pendingAppRequests ||= new Map();
    const timer = setTimeout(() => {
      pending.delete(id); resolve({ ok: false, uncertain: true, reason: '创建结果尚未确认，请先到 SoduWork 自动化管理中核对，勿重复创建' });
    }, 180000);
    pending.set(id, { id, parentId: owner.sender.id, timer, item,
      assertActive: () => appOwner.assertCurrent(item), resolve(result) {
      clearTimeout(timer);
      try { appOwner.assertCurrent(item); }
      catch (error) { resolve({ ok: false, uncertain: true, code: error.code, reason: error.message }); return; }
      let currentScope = '';
      try { currentScope = require('./app-settings-store.cjs').scope({ pluginId, origin: item.appBridge.origin }); } catch (_) {}
      if (scope !== currentScope) {
        resolve({ ok: false, uncertain: true, reason: 'SoduWork 账号已变化，请切回原账号核对创建结果' }); return;
      }
      if (result?.ok === false && !result.uncertain) receipts.delete(key);
      resolve(result);
    } });
    owner.sender.send('work-preview-app-request', { version: 1, id, tabId: (item.appWindowRoot || item).id,
      appId: item.appBridge.appId, contributionId: item.appBridge.contributionId, method: 'automation.create',
      params: { ...request.params, command: '/自动化', context: { ...request.params.context,
        page: page.href, appName: installed.name } } });
  });
  receipts.set(key, { content, promise });
  return promise;
}
module.exports = { submit };
