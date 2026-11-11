(function(global){
  'use strict';
  const call=global.MobileAutomationBridge.call;
  const form=document.querySelector('#composer'),input=document.querySelector('#instruction');
  const send=document.querySelector('#send'),model=document.querySelector('#model');
  const notice=document.querySelector('#notice'),host=document.querySelector('#conversation');
  let owner='',storageKey='',prompt='',saved=null,busy=false,ready=false;
  const say=value=>{notice.textContent=String(value||'');};
  function persist(snapshot) {
    if(!storageKey)throw Error('身份尚未就绪');
    saved=snapshot;
    if(snapshot?.phase==='succeeded'){sessionStorage.removeItem(storageKey);return;}
    sessionStorage.setItem(storageKey,JSON.stringify({prompt,snapshot,input:input.value,model:model.value}));
  }
  global.petSay=()=>say('计划已保存为暂停状态，可在自动化列表检查后启用。');
  global.openSchedulesEntry=()=>void call('close').catch(error=>say(error.message));
  global.openAgentsPanel=()=>say('请刷新执行底座；执行电脑必须在线。手机无需安装底座。');
  global._schmLoad=async()=>[];
  global.SoduWorkAPI={
    taskStorageKey:name=>owner+':automation:'+name,
    taskExecutionOptions:args=>call('executionOptions',args),
    parseTaskText:async(text,selectedModel,_attachments,options={})=>{
      try{return await call('parse',{text,model:selectedModel,instruction:options.instruction||text,candidates:options.candidates||{}});}
      catch(error){return {_parseError:error.message};}
    },
    preflightSchedule:body=>call('preflight',{...body,enabled:false}),
    createSchedule:async body=>{
      const result=await call('create',{...body,enabled:false});
      if(!result?.id)throw Error('保存回执缺少编号，请在列表核对，勿重复创建');
      return result;
    },
  };
  global.soduWorkAPI=global.SoduWorkAPI;
  function open(snapshot) {
    return global.WorkAutomationSheet.open({text:prompt,parseText:'/自动化 '+prompt,instruction:prompt,
      model:()=>model.value,host,proposal:{enabled:false},cardState:snapshot||undefined,
      onCardState:persist,onBeforeSubmit:async state=>persist(state),
      onCreated:()=>{input.value='';input.disabled=true;send.disabled=true;send.textContent='已保存';say('已保存为暂停计划。点击“查看自动化”检查后启用。');},
      onClose:()=>say('草稿已保留；可补充要求继续整理。'),
    });
  }
  // These are presentation changes on the mobile mount, not edits to copied PC code.
  new MutationObserver(()=>{
    for(const toggle of host.querySelectorAll('input[name="enabled"]')){toggle.checked=false;toggle.disabled=true;}
    for(const heading of host.querySelectorAll('.waz-head p')){
      if(heading.textContent!=='整理要求、确认计划，再交给执行电脑完成。')heading.textContent='整理要求、确认计划，再交给执行电脑完成。';
    }
    for(const hint of host.querySelectorAll('small')){
      if(hint.textContent==='运行时会在当前设备选择具备所需能力的可用席位')hint.textContent='任务交给所选执行电脑，手机无需安装底座。';
    }
    for(const action of host.querySelectorAll('[data-waz-save]')){
      if(action.textContent==='创建自动化')action.textContent='保存为暂停计划';
    }
  }).observe(host,{childList:true,subtree:true});
  form.addEventListener('submit',async event=>{
    event.preventDefault();const text=input.value.trim();if(!ready||busy||!text)return;
    busy=true;send.disabled=true;say('');
    try{
      if(global.WorkAutomationSheet.active()){
        const accepted=await global.WorkAutomationSheet.refine(text,{model:model.value,instruction:text});
        if(accepted)input.value='';
      }else{
        if(saved?.uncertain || saved?.phase==='submitting')throw Error('上次创建结果尚未确认，请返回自动化列表核对。');
        if(saved?.phase==='succeeded')throw Error('该计划已保存，请从自动化列表新建或编辑。');
        prompt=text;input.value='';await open();
      }
      document.querySelector('#intro').hidden=true;
      send.textContent='补充要求';
      persist(global.WorkAutomationSheet.capture()||saved);
    }catch(error){say(error.message);if(!input.value)input.value=text;}
    finally{busy=false;if(saved?.phase!=='succeeded')send.disabled=false;}
  });
  input.addEventListener('input',()=>{if(ready)try{persist(global.WorkAutomationSheet.capture()||saved);}catch(error){say(error.message);}});
  (async()=>{
    const info=await call('ready');owner=info.identity;storageKey='soduwork-mobile-automation:'+owner;
    document.documentElement.classList.toggle('dark',info.dark===true);
    let previous;try{previous=JSON.parse(sessionStorage.getItem(storageKey)||'null');}catch{say('上次草稿无法读取，请重新描述。');}
    const catalog=await call('models');
    for(const row of catalog.usable||[]){if(!row.name)continue;const option=document.createElement('option');option.value=row.name;option.textContent=row.label||row.name;model.append(option);}
    if(previous){prompt=String(previous.prompt||'');saved=previous.snapshot||null;input.value=String(previous.input||'');
      if([...model.options].some(o=>o.value===previous.model))model.value=previous.model;
      if(prompt&&saved){document.querySelector('#intro').hidden=true;await open(saved);send.textContent='补充要求';}
    }
    ready=true;send.disabled=saved?.phase==='succeeded';if(send.disabled){input.disabled=true;send.textContent='已保存';}
  })().catch(error=>{say(error.message);send.disabled=true;});
})(window);
