(function(global){
  'use strict';
  const notify=topic=>{const bridge=global.soduWorkAPI?.workPreviewAppHost;if(bridge?.notifyDataChanged)void bridge.notifyDataChanged(topic).catch(()=>{});};
  let epoch=0;global.addEventListener('soduwork-data-scope-changed',()=>{epoch++;notify('identity');});
  global.addEventListener('soduwork-library-changed',()=>notify('library'));
  global.addEventListener('soduwork-host-data-changed',event=>{if(event?.detail?.topic==='notifications')notify('notifications');});
  const sessions=global.soduWorkAPI?.conversationSession||global.soduWorkAPI?.piSession;
  sessions?.onEvent?.(event=>{if(['settled','opened','closed','renamed','archived','restored','deleted','error'].includes(event.kind))notify('conversations');});
  const pick=(row,keys)=>Object.fromEntries(keys.filter(k=>['string','number','boolean'].includes(typeof row?.[k])).map(k=>[k,row[k]]));
  const metadata=row=>pick(row,['id','title','name','filename','kind','folderId','storage','backend','size','contentType','createdAt','updatedAt']);
  async function handle(method,p){
    const api=global.SoduWorkAPI,scope=api?.taskStorageKey?.('plugins'),capturedEpoch=epoch;
    if(!api?.taskStorageKey)throw Error('当前客户端未提供账号隔离能力');
    const guard=()=>{if(capturedEpoch!==epoch||scope!==api.taskStorageKey('plugins'))throw Error('SoduWork账号已变化，请重新读取');};
    const call=async(name,...args)=>{if(typeof api[name]!=='function')throw Error('当前客户端未提供 '+name);const r=await api[name](...args);guard();if(r?.ok===false)throw Error(r.reason||r.error||'数据读取失败');return r;};
    if(method==='user.getCurrent'){
      const r=await call('clientAuthMe');if(!r?.user?.id)throw Error('请先登录SoduWork');
      return {ok:true,user:pick(r.user,['id','username','name','displayName','orgId','orgName'])};
    }
    if(method==='notifications.list'){
      if(p.source==='center'){
        if(!global.MateNoticeSync?.rows)throw Error('通知中心读取接口未加载');
        const rows=global.MateNoticeSync.rows(p.folder||'received'),end=(p.offset||0)+(p.limit||50);guard();
        return {ok:true,source:'center',items:rows.slice(p.offset||0,end).map(x=>pick(x,['id','serverMessageId','kind','title','text','bodyText','taskId','at','read','senderId','senderName','recipientId','recipientName'])),nextOffset:end<rows.length?end:null};
      }
      const r=await call('mateMessages',p.folder||'received',p.limit||50,p.before||'');
      return {ok:true,items:(r.items||[]).map(x=>pick(x,['id','messageId','senderId','recipientId','senderName','recipientName','conversationId','text','kind','taskId','status','createdAt','readAt','deliveredAt'])),nextCursor:r.nextCursor||null};
    }
    if(method==='library.list'){
      const r=await call('listLibrary',{storage:p.storage||'local',folderId:p.folderId||'',query:p.query||''});
      const page=(rows)=>rows.slice(p.offset||0,(p.offset||0)+(p.limit||50)).map(metadata);
      const total=Math.max((r.items||[]).length,(r.folders||[]).length),end=(p.offset||0)+(p.limit||50);
      return {ok:true,storage:p.storage||'local',items:page(r.items||[]),folders:page(r.folders||[]),nextOffset:end<total?end:null};
    }
    if(method==='library.read'){
      const offset=p.offset||0,length=p.length||65536;
      if(p.format==='base64'){
        const r=await call('readLibraryBinary',p.id);const data=new Uint8Array(await r.blob.arrayBuffer());guard();
        const bytes=data.subarray(offset,offset+length);let text='';for(let i=0;i<bytes.length;i++)text+=String.fromCharCode(bytes[i]);
        return {ok:true,id:p.id,format:'base64',data:global.btoa(text),mimeType:r.blob.type,totalBytes:data.length,offset,nextOffset:offset+bytes.length<data.length?offset+bytes.length:null};
      }
      const r=await call('readLibraryContent',p.id);const text=String(r.content??'');
      if(r.preview?.truncated)throw Error('资料服务只返回预览内容；请改用base64读取原件');
      return {ok:true,id:p.id,format:'text',content:text.slice(offset,offset+length),totalLength:text.length,offset,nextOffset:offset+length<text.length?offset+length:null};
    }
    throw Error('宿主只读方法未开放');
  }
  global.SoduWorkAppHostData={handle};
})(window);
