'use strict';
// An installed app may opt into direct schedule creation. Reuse the ordinary
// renderer host/API; retain uncertain receipts so a retry cannot create twice.
const crypto = require('node:crypto');
const stores = new WeakMap();
const pendingComposers = new Map();
async function authorize(sender, id) {
  const row = pendingComposers.get(id);
  if (!row || row.sender !== sender) throw Error('创建请求已失效');
  await row.authorize();
  return { ok: true };
}
function finish(sender, payload) {
  const row = pendingComposers.get(payload?.id);
  if (!row || row.sender !== sender) return { ok: false };
  pendingComposers.delete(payload.id);
  row.resolve(payload.result && typeof payload.result === 'object' ? payload.result :
    { ok: false, uncertain: true, reason: '创建回执无效，请到自动化页面核对' });
  return { ok: true };
}
const appOwner = require('./work-preview-app-owner.cjs');
async function submit({ owner, item, request, deps }) {
  appOwner.assertCurrent(item);
  const pluginId = String(item.appBridge.appId || '').replace(/^plugin:/, '');
  const authorized = await require('./work-preview-app-connection.cjs').authorize(item,deps,'automation.create');
  const installed = authorized.installed;
  authorized.assertCurrent();
  if (!installed.jiyong && !request.params.context.spaceId) throw Error('请选择有效的当前空间');
  const source = installed.ui?.contributions?.find(row => row.id === item.appBridge.contributionId)?.source;
  const origin = source?.type === 'package' ? require('../core/plugin-package-page.cjs').origin(pluginId) : source?.type === 'external' ? new URL(source.url).origin : '';
  if (installed.enabled === false || origin !== item.appBridge.origin ||
      !source.bridge?.capabilities?.includes('automation.create')) throw Error('应用未获准直接创建自动化，请更新应用');
  if (!owner.sender || owner.sender.isDestroyed()) throw Error('SoduWork 工作区已关闭');
  const page = new URL(request.params.context.page || (source.type === 'package' ? origin + '/' + source.entry : source.url));
  if (page.origin !== item.appBridge.origin || page.username || page.password) throw Error('任务页面必须属于当前即用来源');
  page.search = ''; page.hash = ''; if (request.params.context.spaceId) page.searchParams.set('space', request.params.context.spaceId);
  const scope = require('./app-settings-store.cjs').scope({ pluginId, origin: item.appBridge.origin });
  let receipts = stores.get(owner);
  if (!receipts) { receipts = new Map(); stores.set(owner, receipts); }
  const key = scope + ':' + request.params.requestId, content = JSON.stringify(request.params);
  const previous = receipts.get(key);
  if (previous) return previous.content === content ? previous.promise : Promise.resolve({ ok: false, reason: '请求编号已用于其他任务，请重新发起' });
  if (receipts.size >= 200) throw Error('本窗口创建请求过多，请重新打开即用');
  const id = 'automation-' + crypto.randomUUID();
  const promise = new Promise(resolve => {
    const pending = owner.pendingAppRequests ||= new Map();
    const timer = setTimeout(() => {
      pending.delete(id); pendingComposers.delete(id); resolve({ ok: false, uncertain: true, reason: '创建结果尚未确认，请先到 SoduWork 自动化管理中核对，勿重复创建' });
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
    const root=item.appWindowRoot || item, composer=root.composer?.view?.webContents;
    const envelope={ version: 1, id, tabId: (item.appWindowRoot || item).id,
      appId: item.appBridge.appId, contributionId: item.appBridge.contributionId, method: 'automation.create',
      params: { ...request.params, command: '/自动化', context: { ...request.params.context,
        page: page.href, appName: installed.name,
        sourceApp:{pluginId:installed.pluginId,key:installed.key,name:installed.name,icon:installed.icon || '',characterName:request.params.context.characterName || ''},
        ...(installed.jiyong ? {pluginId:installed.pluginId,pluginKey:installed.key,pluginVersion:installed.version,pluginChecksum:installed.checksum} : {}) } } };
    if(composer && !composer.isDestroyed()){
      pending.get(id).parentId=composer.id;
      pendingComposers.set(id,{sender:composer,authorize:async()=>{
        const current=await require('./work-preview-app-connection.cjs').authorize(item,deps,'automation.create');
        current.assertCurrent();
        if(current.installed.version!==installed.version || current.installed.checksum!==installed.checksum || scope!==require('./app-settings-store.cjs').scope({pluginId,origin:item.appBridge.origin}))throw Error('即用版本或账号已变化，请重新发起');
      },resolve:result=>{
        const row=pending.get(id);pending.delete(id);if(row)row.resolve(result);
      }});
      deps.expandComposer?.(owner,root);
      composer.send('app-composer-automation',envelope);
    }else owner.sender.send('work-preview-app-request',envelope);
  });
  receipts.set(key, { content, promise });
  return promise;
}
module.exports = { submit, finish, authorize };
