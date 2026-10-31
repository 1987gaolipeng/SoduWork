'use strict';
const {Worker} = require('node:worker_threads');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./app-settings-store.cjs');
const contract = require('../core/jiyong-contract.cjs');
const workers = new Map();
const closing = new Map();
const waiting = new Set();
let assetBytes = 0;
function wake() { for (const done of [...waiting]) done(); }
function park(id,row) {
  if (workers.get(id)!==row || row.pending.size) return;
  clearTimeout(row.timer); row.worker.unref();
  row.timer=setTimeout(()=>release(id),30000);row.timer.unref();
}
function release(id,reason) {
  const row = workers.get(id);
  if (!row) return;
  workers.delete(id); clearTimeout(row.timer); wake();
  for (const pending of row.pending.values()) { clearTimeout(pending.timer); pending.reject(reason || Error('即用数据服务已退出，请重试')); }
  row.pending.clear();
  const stopped = row.worker.terminate().finally(() => { if (closing.get(id) === stopped) closing.delete(id); wake(); });
  closing.set(id,stopped);return stopped;
}
async function execute(app,binding,declaration,method,params,assertCurrent = () => {},initialization = {schemaVersion:1,migrations:[]}) {
  assertCurrent();
  const scope = store.scope(binding), schema = contract.normalize(declaration);
  if (method.startsWith('data.asset')) contract.assetRequest(method,params);
  else if (!['backup','initialize'].includes(method)) contract.dataRequest(method,params,schema);
  const digest = crypto.createHash('sha256').update(JSON.stringify({collections:schema.collections,initialization})).digest('hex');
  const id = path.resolve(app.getPath('userData')) + ':' + scope;
  await closing.get(id);assertCurrent();if(store.scope(binding)!==scope)throw Error('即用账号已变化');
  let row = workers.get(id);
  if (row && row.digest !== digest) { await release(id); row = workers.get(id); }
  if (!row) {
    const deadline = Date.now()+10000;
    while (!row && workers.size >= 8) {
      const idle = [...workers.entries()].find(([,value])=>!value.pending.size);
      if (idle) { await release(idle[0]); row=workers.get(id); continue; }
      if (waiting.size >= 64 || Date.now() >= deadline) throw Error('即用数据服务繁忙，请稍后重试');
      await new Promise(resolve=>{
        const done=()=>{clearTimeout(timer);waiting.delete(done);resolve();};
        const timer=setTimeout(done,Math.max(1,deadline-Date.now()));waiting.add(done);
      });
      assertCurrent();
      if (store.scope(binding)!==scope) throw Error('即用账号已变化');
      row=workers.get(id);
    }
  }
  if (!row) {
    const file = path.join(app.getPath('userData'),'jiyong-data',scope,'data.sqlite');
    const worker = new Worker(path.join(__dirname,'jiyong-data-worker.cjs'),{workerData:{file,declaration:schema,initialization}});
    row = {worker,digest,pending:new Map(),sequence:0}; workers.set(id,row);
    worker.on('message',message => {
      const pending = row.pending.get(message.id); if (!pending) return;
      row.pending.delete(message.id); clearTimeout(pending.timer); wake();
      if (message.error) pending.reject(Object.assign(Error(message.error.message),{code:message.error.code})); else pending.resolve(message.result);
    });
    worker.on('error',error => { if (workers.get(id) === row) release(id,error); });
    worker.on('exit',() => { if (workers.get(id) === row) release(id); });
  }
  clearTimeout(row.timer); row.worker.ref();
  if (row.pending.size >= 32) throw Error('即用数据请求过多，请稍后重试');
  const budget = method.startsWith('data.asset') ? (method === 'data.assetPut' ? params.data.byteLength : 8*1024*1024) : 0;
  if (assetBytes+budget > 32*1024*1024) { park(id,row); throw Error('素材正在传输，请稍后重试'); }
  assetBytes += budget;
  const result = await new Promise((resolve,reject) => {
    const requestId = ++row.sequence;
    const timer = setTimeout(() => { row.pending.delete(requestId); reject(Error('即用数据请求超时，请重新读取核对写入结果')); },30000);
    row.pending.set(requestId,{resolve,reject,timer});
    row.worker.postMessage({id:requestId,method,params});
  }).finally(() => {
    assetBytes -= budget;
    park(id,row);
  });
  assertCurrent(); if (store.scope(binding) !== scope) throw Error('即用账号已变化');
  return result;
}
function close() { for(const id of [...workers.keys()])release(id);return Promise.all([...closing.values()]); }
function diagnostics() { return {activeWorkers:workers.size,pendingRequests:[...workers.values()].reduce((n,row)=>n+row.pending.size,0),waitingRequests:waiting.size,assetBytes}; }
module.exports = {execute,close,diagnostics};
