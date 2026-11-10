(function(global){
  'use strict';
  const channel=new URLSearchParams(location.hash.slice(1)).get('channel');
  let serial=0,closed=false;
  const pending=new Map();
  function call(method,args={}) {
    if(closed || !channel || global.parent===global) return Promise.reject(Error('请从移动端自动化页面打开'));
    const id=String(++serial);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(Error('服务响应超时，原内容已保留，请先核对结果'));},100000);
      pending.set(id,{resolve,reject,timer});
      global.parent.postMessage({type:'soduwork-automation',channel,id,method,args},location.origin);
    });
  }
  global.addEventListener('message',event=>{
    const data=event.data;
    if(event.origin!==location.origin || event.source!==global.parent || data?.channel!==channel || data.type!=='soduwork-automation-host') return;
    const row=pending.get(data.id);if(!row)return;
    clearTimeout(row.timer);pending.delete(data.id);
    data.error?row.reject(Error(data.error)):row.resolve(data.result);
  });
  global.addEventListener('pagehide',()=>{closed=true;for(const row of pending.values()){clearTimeout(row.timer);row.reject(Error('页面已关闭'));}pending.clear();});
  global.MobileAutomationBridge={call};
})(window);
