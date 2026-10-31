'use strict';
const topics=new Set(['identity','notifications','conversations','library']);
function publish(owners,event,topic){
 if(!topics.has(topic)||!owners.has(event?.sender?.id))return {ok:false};
 let delivered=0;
 for(const owner of owners.values())for(const root of owner.views?.values()||[])for(const item of root.appTabs?.pages.values()||[root]){
  const wc=item.view?.webContents,bridge=item.appBridge;if(!bridge||!wc||wc.isDestroyed())continue;
  const caps=bridge.capabilities||[],needed=topic==='library'?'library.read':topic==='identity'?'context.read':'messages.read';
  if(!caps.includes(needed))continue;
  try{if(new URL(wc.getURL()).origin!==bridge.origin)continue;wc.send('app-data-changed',{topic});delivered++;}catch(_){}
 }
 return {ok:true,delivered};
}
module.exports={publish};
