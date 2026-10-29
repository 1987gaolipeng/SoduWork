/* Browser authorization belongs to the current account and editor only. Tokens never enter the renderer. */
(function(global) {
  'use strict';
  function create({api,layer,value,template,current,show,onChange,save,compose}) {
    const schemes=Object.values(value.apiDefinition?.securitySchemes||{}).filter(s=>s.flow==='authorizationCode');
    const generic=schemes.length===1;
    const providerId=generic?'api':String(template?.key||value.templateKey||'').replace(/^connector-/,'');
    const supported=generic||['google-drive','onedrive','outlook','sharepoint','microsoft-teams'].includes(providerId);
    let provider=generic?{available:true,label:value.apiDefinition.name,tokenField:schemes[0].tokenKey}:null,loading=supported && !!api.connectorOAuthProviders,attempt='',pending=false,manual=false;
    let binding=value.oauth||null,completedAttempt='';
    function releaseCompleted(){const id=completedAttempt;completedAttempt='';if(id)api.cancelConnectorOAuth(id).catch(()=>{});}
    function watchCompleted(){if(!completedAttempt)return;if(!current()){releaseCompleted();return;}setTimeout(watchCompleted,1000);}
    if(!generic&&!binding&&value.env?.[providerId==='google-drive'?'GOOGLE_ACCESS_TOKEN':'MSFT_ACCESS_TOKEN'])manual=true;
    const host=layer.querySelector('[data-connector-oauth]');
    const field=key=>layer.querySelector('[data-connector-field="'+key+'"]');
    const tokenKey=()=>provider?.tokenField || (providerId==='google-drive'?'GOOGLE_ACCESS_TOKEN':'MSFT_ACCESS_TOKEN');
    const enabled=()=>supported && !manual && !!provider?.available;
    function render() {
      if(!current()||!host||!supported)return;
      const token=field(tokenKey()),writes=field('ALLOW_WRITES');
      if(token?.closest('label'))token.closest('label').hidden=enabled()||!!binding;
      if(writes?.closest('label'))writes.closest('label').hidden=!generic&&(enabled()||!!binding);
      if(writes&&!generic&&(enabled()||binding))writes.checked=false;
      const doc=host.ownerDocument;
      const node=(tag,cls,text)=>{const n=doc.createElement(tag);n.className=cls;n.textContent=text;return n;};
      host.replaceChildren();
      if(loading)host.append(node('p','connector-inline-note','正在准备授权方式…'));
      else {
        if(generic&&provider?.redirectUri){const callback=node('p','connector-inline-note','平台应用的回调地址：'+provider.redirectUri);host.append(callback);}
        const row=node('div','connector-auth-state','');
        row.append(node('span','',binding?'账号已授权':enabled()?'使用 '+(provider.label||template.name)+(generic?' 账号登录 · 按接口范围授权':' 账号登录 · 只读访问'):provider?.connectionState==='error'?'暂时无法获取登录方式，可稍后重试':(provider?.message||'账号登录尚未开通，请联系管理员')));
        if(binding){const button=node('button','connector-link','更换账号');button.type='button';button.dataset.reauthorize='';row.append(button);}
        host.append(row);
        if(provider?.available){const button=node('button','connector-link',manual?'使用账号登录':'使用已有访问令牌');button.type='button';button.dataset.authMode='';host.append(button);}
      }
      host.querySelector('[data-auth-mode]')?.addEventListener('click',()=>{if(pending)return;releaseCompleted();manual=!manual;binding=null;render();onChange();});
      host.querySelector('[data-reauthorize]')?.addEventListener('click',()=>{if(pending)return;releaseCompleted();binding=null;render();onChange();});
      if(!pending)save.textContent=enabled()&&!binding?'登录并连接':value.id&&value.oauth?'保存并连接':'连接';
    }
    const ready=loading?api.connectorOAuthProviders().then(result=>{
      if(!current())return;const meta=(result.providers||[]).find(p=>p.id===providerId)||null;provider=generic?{...meta,available:!!meta?.available,label:value.apiDefinition.name,tokenField:schemes[0].tokenKey}:meta;
    }).catch(()=>{provider={available:false,connectionState:'error',message:'暂时无法获取登录方式，请稍后重试或使用已有访问令牌'};})
      .finally(()=>{loading=false;render();}):Promise.resolve();
    if(loading||generic)render();
    async function cancel(){const id=attempt;attempt='';if(id)try{await api.cancelConnectorOAuth(id);}catch(_){} }
    async function authorize(){
      await ready;if(!current())return false;
      if(!enabled()||binding)return true;
      if(pending)return false;pending=true;save.disabled=true;save.textContent='等待授权…';
      try{
        show('loading','请在浏览器完成授权','授权后会自动回到连接流程');
        const started=await api.startConnectorOAuth(providerId,value.id,generic?compose():undefined);
        attempt=started.attemptId;
        if(!current()){await cancel();return false;}
        const url=new URL(started.authorizationUrl);
        if(url.protocol!=='https:'&&!(generic&&url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw Error('授权地址无效，请联系管理员');
        const open=global.soduWorkAPI?.openExternal;
        if(!open)throw Error('当前客户端无法打开授权页面，请更新客户端');
        await open(url.href);
        const deadline=Date.now()+10*60*1000;
        while(current()&&Date.now()<deadline){
          const result=await api.connectorOAuthStatus(attempt);
          if(!current()){await cancel();return false;}
          if(result.state==='connected'){
            if(!result.oauth?.connectionId||result.oauth.provider!==providerId)throw Error('授权信息不完整，请重新连接');
            binding=result.oauth;completedAttempt=attempt;attempt='';watchCompleted();if(field(tokenKey()))field(tokenKey()).value='';
            render();onChange();return true;
          }
          if(result.state!=='pending')throw Error(result.message||'授权未完成，请重试');
          await new Promise(resolve=>setTimeout(resolve,1500));
        }
        if(current())throw Error('授权等待已超时，请重新连接');
        return false;
      }finally{pending=false;await cancel();if(current())save.disabled=false;render();}
    }
    return {ready,authorize,binding:()=>binding,usesLogin:enabled,skipField:key=>(enabled()||!!binding)&&key===tokenKey()};
  }
  global.SoduWorkConnectorAuth={create};
})(window);
