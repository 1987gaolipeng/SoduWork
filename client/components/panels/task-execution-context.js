(function(global){
  'use strict';
  var clean=function(v){return String(v==null?'':v).trim();};
  var key=function(v){return clean(v).toLowerCase();};
  var list=function(v){return Array.isArray(v)?v:[];};
  function locationMode(v){
    var x=v||{};
    if(clean(x.locationMode)==='mixed') return 'mixed';
    if(clean(x.locationMode)==='local') return 'local';
    if(clean(x.locationMode)==='remote'||x.remote===true||clean(x.runnerId)||clean(x.clientId)) return 'remote';
    return 'local';
  }
  function locationLabel(v){
    var x=v||{}, mode=locationMode(x);
    if(clean(x.locationLabel)) return clean(x.locationLabel);
    return mode==='remote'?'\u8fdc\u7a0b Runner':mode==='mixed'?'\u672c\u673a + \u8fdc\u7a0b Runner':'\u672c\u673a';
  }
  function agentRows(options){return list((options||{}).substrates);}
  function findAgent(options,selection){
    var s=selection||{}, wanted=key(s.agentId||s.substrateKey||s.agentKey);
    if(!wanted) return null;
    var direct=agentRows(options).find(function(a){return a&&(
      key(a.key)===wanted||key(a.id)===wanted||key(a.cli)===wanted);})||null;
    if(direct) return direct;
    for(var i=0;i<agentRows(options).length;i++){
      var group=agentRows(options)[i], locations=list(group&&group.locations);
      for(var j=0;j<locations.length;j++){
        var location=locations[j]||{}, id=key(location.assigneeId||location.id);
        if(id===wanted) return Object.assign({},group,location,{key:location.assigneeId||location.id,id:location.assigneeId||location.id,
          locationMode:location.mode||group.locationMode,locationLabel:location.label||group.locationLabel});
      }
    }
    return null;
  }
  function repoOf(options,selection){
    var s=selection||{}, wanted=key(s.repoId), rows=list((options||{}).repos);
    return rows.find(function(r){return r&&key(r.id)===wanted;})||s.repo||null;
  }
  function normalize(options,selection){
    var o=options||{}, s=selection||{}, a=findAgent(o,s), r=repoOf(o,s);
    var strategy=clean(s.strategy)||'direct';
    // Switching to direct execution must not retain a previous plugin binding.
    var wf=strategy==='workflow'?(list(o.workflows).find(function(x){return x&&key(x.bindingId)===key(s.workflowId);})||s.workflow||null):null;
    var mode=locationMode(a||s), context={
      schemaVersion:1,
      strategy:strategy,
      agent:a?{id:clean(a.id||a.key),key:clean(a.key),cli:clean(a.cli),name:clean(a.name||a.cli)}:null,
      // Empty means follow this Agent's effective default. The global company
      // default is neither an explicit choice nor a native-account model.
      model:a&&a.modelPick===false?'':clean(s.model),
      location:{mode:mode,label:locationLabel(a||s)},
      runner:a?{mode:mode,id:clean(a.runnerId),runnerId:clean(a.runnerId),clientId:clean(a.clientId),machineKey:clean(a.machineKey),host:clean(a.host),version:clean(a.runnerVersion||a.version)}:{mode:mode},
      repo:r?{id:clean(r.id),projectId:clean(r.projectId||s.projectId),name:clean(r.name),branch:clean(r.branch),path:clean(r.path)}:null,
      plugin:wf?{bindingId:clean(wf.bindingId),name:clean(wf.name),version:clean(wf.version)}:null
    };
    return context;
  }
  function execution(context){
    var c=context||{}, out={}, a=c.agent||{};
    if(clean(a.id||a.key||a.cli)) out.agentKind=clean(a.id||a.key||a.cli).indexOf('local:')===0?clean(a.id||a.key||a.cli):'local:'+clean(a.cli||a.key||a.id);
    if(clean(c.model)) out.model=clean(c.model);
    return out;
  }
  function payload(context,extra){
    var c=context||{}, out={execution:execution(c),executionContext:c};
    if(c.repo&&c.repo.id) out.repoId=c.repo.id;
    if(c.plugin&&c.plugin.bindingId) out.bindingId=c.plugin.bindingId;
    return Object.assign(out,extra||{});
  }
  function summary(context){
    var c=context||{}, a=c.agent||{}, p=c.plugin||{}, r=c.repo||{};
    return [p.name||'',a.name||a.cli||'',c.model||'',(c.location||{}).label||'',r.name||''].filter(Boolean).join(' · ');
  }
  global.TaskExecutionContext={version:1,locationMode:locationMode,locationLabel:locationLabel,normalize:normalize,execution:execution,payload:payload,summary:summary};
})(window);
