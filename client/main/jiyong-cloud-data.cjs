'use strict';
// Main-process transport only. Pages never receive a database URL or device credential.
const contract = require('../core/jiyong-contract.cjs');
const store = require('./app-settings-store.cjs');
const {fetchWithDeviceAuthRetry} = require('./device-auth-request');
let inflight=0,assetBytes=0;
async function send(deps, endpoint, body, assertCurrent = () => {}) {
  assertCurrent();
  const identity = await (deps.authenticatedIdentityOf || deps.identityOf)?.(deps.app);
  assertCurrent();
  if (!identity?.hub || !identity.clientId || !(identity.session || identity.secret)) throw Error('使用云端数据请先登录 SoduWork');
  let response;
  try {
    response = await fetchWithDeviceAuthRetry(identity, identity.hub.replace(/\/+$/, '') + '/api/v1/jiyong/' + endpoint, {
      method:body ? 'POST' : 'GET', redirect:'error', signal:AbortSignal.timeout(30000),
      headers:{Accept:'application/json',...(body ? {'Content-Type':'application/json'} : {})},
      ...(body ? {body:JSON.stringify(body)} : {}),
    }, deps.fetchImpl || global.fetch);
  } catch (_) {
    throw Error('云端数据请求未完成，请检查连接；写入结果不确定时先重新读取核对');
  }
  assertCurrent();
  let result;
  try { result = await response.json(); }
  catch (_) { throw Error('云端数据服务未返回有效 JSON，请检查 Hub 版本与连接'); }
  assertCurrent();
  if (!response.ok || result.ok !== true) {
    const detail = result.detail;
    throw Object.assign(Error(typeof detail === 'string' ? detail : detail?.message || '云端数据请求失败（HTTP '+response.status+'）'),
      {code:typeof detail === 'object' ? detail?.code : 'JIYONG_CLOUD_UNAVAILABLE'});
  }
  return result;
}
async function execute(deps,binding,installed,method,params,assertCurrent,initialization) {
  const budget=method==='data.assetPut' ? params.data?.byteLength || 0 : method==='data.assetGet' ? 8*1024*1024 : 0;
  if(inflight>=16 || assetBytes+budget>32*1024*1024)throw Error('云端数据请求繁忙，请稍后重试');
  inflight++;assetBytes+=budget;
  try{return await perform(deps,binding,installed,method,params,assertCurrent,initialization);}
  finally{inflight--;assetBytes-=budget;}
}
async function perform(deps,binding,installed,method,params,assertCurrent,initialization) {
  const declaration = contract.normalize(installed.jiyong || installed.localDraft?.jiyong);
  if (declaration.storage?.location !== 'cloud') throw Error('即用未声明云端数据');
  const scope = store.scope(binding);
  const check = () => { assertCurrent?.(); if (store.scope(binding) !== scope) throw Error('即用账号已变化'); };
  let input;
  if (method.startsWith('data.asset')) {
    input = contract.assetRequest(method,params);
    if (method === 'data.assetPut') input = {...input,data:Buffer.from(input.data).toString('base64')};
  } else input = method === 'initialize' ? {} : contract.dataRequest(method,params,declaration);
  const local = binding.pluginId.startsWith('local:');
  const result = await send(deps,'data',{
    appId:binding.pluginId, method, params:input,
    ...(local ? {packageKey:installed.localDraft?.key || binding.pluginId.slice(6),version:installed.version,
      checksum:installed.checksum,declaration,initialization} : {versionId:installed.versionId}),
  },check);
  if (method === 'data.assetGet' && result.asset) {
    if (typeof result.data !== 'string' || result.data.length > 11184812) throw Error('云端素材响应无效');
    const bytes = Buffer.from(result.data,'base64'), crypto = require('node:crypto');
    const hash = 'asset_'+crypto.createHash('sha256').update(result.asset.name+'\0'+result.asset.type+'\0').update(bytes).digest('hex');
    if (hash !== params.id || result.asset.size !== bytes.length || bytes.length > 8*1024*1024) throw Error('云端素材校验失败');
    result.data = new Uint8Array(bytes);
  }
  check();
  return result;
}
async function preflight(deps, body) {
  if (body.jiyong?.storage?.location !== 'cloud') return null;
  // Readiness probe only; no candidate declarations or seeds are sent to Hub.
  try {
    const identity = await (deps.authenticatedIdentityOf || deps.identityOf)?.(deps.app);
    const scope = require('./device-auth-request').accountScopeKey(identity);
    const check = () => {
      if (typeof deps.assertCurrent === 'function') deps.assertCurrent();
    };
    if (!scope && !identity?.secret) throw Error('使用云端数据请先登录 SoduWork');
    await send({...deps,authenticatedIdentityOf:async()=>identity},'status',null,check);
    const current = await (deps.authenticatedIdentityOf || deps.identityOf)?.(deps.app);
    if (current?.hub !== identity.hub || current?.clientId !== identity.clientId || require('./device-auth-request').accountScopeKey(current) !== scope) throw Error('SoduWork账号已变化，请重新检查');
    return {key:'cloud-readiness',ok:true,label:'云端数据服务及迁移版本就绪（只读检查，尚未创建应用库）'};
  } catch (error) { return {key:'cloud-readiness',ok:false,label:'云端数据服务未就绪：'+error.message}; }
}
module.exports = {execute,preflight};
