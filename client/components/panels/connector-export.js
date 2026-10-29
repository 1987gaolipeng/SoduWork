/* Export under the current account's permissions; Hub removes credentials. */
(function(global){
 'use strict';
 function open(ctx,options={}){
  const {api,h,openModal,errorText}=ctx;
  const rows=(ctx.mcp.personal||[]);
  const selected=new Set(options.ids||rows.map(x=>x.id));
  const owner=api.taskStorageKey?.('ops');
  const layer=openModal('导出连接配置','可在另一台电脑导入，使用前需要重新配置授权。',
   '<div class="cap-mcp-flow"><p>导出连接地址、鉴权字段名称和工具范围，不包含密钥或账号授权。原连接保持不变。</p><div data-export-choices>'+rows.map(x=>'<label class="cap-confirm"><input type="checkbox" data-export-id="'+h(x.id)+'"'+(selected.has(x.id)?' checked':'')+'><span>'+h(x.name)+'</span></label>').join('')+'</div><p data-export-status role="status"></p></div>',
   '<button type="button" class="btn-mini primary" data-export-save>导出 JSON</button>');
  const version=ctx.viewRevision?.(),save=layer.querySelector('[data-export-save]'),feedback=layer.querySelector('[data-export-status]');
  const active=()=>layer.isConnected&&!layer.hidden&&layer.querySelector('[data-export-save]')===save&&(!ctx.viewRevision||ctx.viewRevision()===version)&&(!api.taskStorageKey||api.taskStorageKey('ops')===owner);
  const choices=()=>Array.from(layer.querySelectorAll('[data-export-id]')).filter(x=>x.checked).map(x=>x.dataset.exportId);
  let busy=false;
  function update(){save.disabled=busy||!choices().length;}
  layer.querySelectorAll('[data-export-id]').forEach(x=>x.onchange=update);update();
  save.onclick=async()=>{
   if(!active()||busy||!choices().length)return;
   busy=true;update();feedback.textContent='正在生成导出文件…';
   try{
    const result=await api.exportMyMcp(choices());
    if(!active())return;
    if(typeof result.content!=='string'||!result.content.length||result.content.length>1024*1024)throw Error('导出文件无效，请重试');
    JSON.parse(result.content);
    const url=URL.createObjectURL(new Blob([result.content],{type:'application/json;charset=utf-8'}));
    try{const link=document.createElement('a');link.href=url;link.download=String(result.filename||'SoduWork-connectors.json').replace(/[\\/:*?"<>|]/g,'_');document.body.append(link);link.click();link.remove();}
    finally{setTimeout(()=>URL.revokeObjectURL(url),30000);}
    const notices=Array.isArray(result.warnings)?result.warnings.slice():[];
    for(const skipped of result.skipped||[]){const row=rows.find(x=>x.id===skipped.id);notices.push((row?.name||'连接')+'：'+skipped.reason);}
    feedback.textContent='已生成 '+Number(result.exported?.length||1)+' 个连接的导出文件。'+notices.join('；');
   }catch(error){if(active())feedback.textContent=errorText(error,'导出失败，请重试');}
   finally{busy=false;if(active())update();}
  };
 }
 global.SoduWorkConnectorExport={open};
})(window);
