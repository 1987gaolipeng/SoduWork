'use strict';
// Business data is shared by installed apps within one SoduWork account.
// There is no per-app sharing ACL. Credential storage is a different API.
const store = require('./app-settings-store.cjs');
const pages = require('../core/plugin-package-page.cjs');
const contract = require('../core/jiyong-contract.cjs');
const definition = installed => installed.jiyong || installed.localDraft?.jiyong;
function id(value) {
  if (typeof value !== 'string' || !/^(?:local:)?[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(value)) throw Error('目标即用标识无效');
  return value;
}
async function available(deps,assertCurrent) {
  const rows = require('./personal-plugins').catalog(deps.app,true);
  let remoteUnavailable = false;
  if (deps.identityOf || deps.authenticatedIdentityOf) {
    try {
      const remote = await require('./app-installed-remote.cjs').catalog(deps,assertCurrent);
      rows.push(...remote.filter(p => p.installed && p.enabled !== false && p.permissions?.canUse === true && p.installedVersionAvailable !== false)
        .map(p => ({...p,jiyong:p.conversationJiyong || p.jiyong})));
    } catch (_) { remoteUnavailable = true; }
  }
  assertCurrent();
  return {ok:true,remoteUnavailable,apps:rows.filter(p => definition(p)).map(p => ({appId:p.pluginId,name:p.name,
    collections:contract.normalize(definition(p)).collections.map(c => ({key:c.key,indexes:c.indexes}))}))};
}
async function request(deps,sourceBound,sourceInstalled,method,input,assertCurrent = () => {}) {
  assertCurrent();
  const ownerScope = store.scope(sourceBound);
  const check = () => { assertCurrent(); if (store.scope(sourceBound) !== ownerScope) throw Error('SoduWork 账号已变化'); };
  if (method === 'data.apps') {
    if (Object.keys(input || {}).length) throw Error('数据发现接口不接受账号或目录参数');
    return available(deps,check);
  }
  const {appId,...params} = input;
  const targetId = appId == null ? sourceBound.pluginId : id(appId);
  let installed = sourceInstalled;
  if (targetId !== sourceBound.pluginId) installed = targetId.startsWith('local:')
    ? require('./personal-plugins').get(deps.app,targetId)
    : await require('./app-installed-remote.cjs').get(deps,targetId,check);
  check();
  const schema = definition(installed);
  if (!schema) throw Error('目标即用未声明宿主数据集合');
  // A package-derived storage identity is stable across page URLs and app upgrades.
  const target = {pluginId:targetId,origin:pages.origin(targetId)};
  const revision = installed.checksum || installed.versionId;
  const current = () => {
    check();
    if (targetId.startsWith('local:') && require('./personal-plugins').get(deps.app,targetId).checksum !== revision) throw Error('目标即用版本已变化');
  };
  const initialization=await require('./jiyong-initialization.cjs').script(deps,installed,current);
  const result = schema.storage?.location === 'cloud'
    ? await require('./jiyong-cloud-data.cjs').execute(deps,target,installed,method,params,current,initialization)
    : await require('./jiyong-data.cjs').execute(deps.app,target,schema,method,params,current,initialization);
  check();
  return result;
}
module.exports = {request,available};
