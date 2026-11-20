'use strict';
// Opt-in observation only. Never persist prompts, filenames, URLs or credentials.
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
const projection=require('../core/requirement-diagnostics');
const hash=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
const ids=new Set(['taskId','conversationId','turnId','approvalId','artifactVersionId','hubKey','accountKey','errorKey',
  'runtimeKey','modelKey','workspaceKey','profileKey']);
const flags=new Set(['ok','hasContract','canSubmitReview','canReview','reviewed','rework','projectionPending',
  'pendingSubmission','deferred','pendingRework','already','hasTaskBinding','pending','obsolete']);
const counts=new Set(['httpStatus','fileCount','invalidCount','bytes']);
const enums=new Set(['status','requirementStage','selectedMode','effectiveMode','turnState','approvalState','action','operation','outcome','captureReason','origin']);
const values=new Set(('todo doing done cancel paused intake clarifying ready delivering reviewing delivered closed '+
  'manual auto default queued running waiting completed failed stopped pending approved rejected cancelled '+
  'prepare start started complete fail wait deliver tasks approvals conversation-turn conversation-delivery '+
  'dispatch ai-dispatch submit-review trace attachments acceptance-context ai-session approve reject native incomplete '+
  'no-handle summary no-primary unchanged no-entries captured review renderer').split(' '));
function create({directory,enabled=false,maxBytes=5*1024*1024}={}) {
  let file='', size=0, stopped=false;
  function record(event, data={}) {
    if(!enabled || stopped)return;
    try {
      if(!/^(native\.(send|prepared|capture|terminal|error)|receipt\.(send|result|error)|http\.result|renderer\.task|diagnostics\.startup)$/.test(event))return;
      const row={at:new Date().toISOString(),event,pid:process.pid};
      for(const [key,value] of Object.entries(data)) {
        if(value===undefined || value===null)continue;
        if(ids.has(key) && typeof value==='string' && value)row[key]=hash(value);
        else if(flags.has(key) && typeof value==='boolean')row[key]=value;
        else if(counts.has(key) && Number.isFinite(value))row[key]=Math.max(0,Math.trunc(value));
        else if(enums.has(key) && values.has(value))row[key]=value;
      }
      if(event==='diagnostics.startup') {
        for(const key of ['sourceFingerprint','revision'])if(/^[a-f0-9]{40,64}$/.test(data[key] || ''))row[key]=data[key];
        row.backendRevision='unknown';
      }
      const line=JSON.stringify(row)+'\n', bytes=Buffer.byteLength(line);
      if(size+bytes+160>maxBytes){
        if(file){const end=JSON.stringify({at:row.at,event:'diagnostics.limit',pid:process.pid})+'\n';
          if(size+Buffer.byteLength(end)<=maxBytes)fs.appendFileSync(file,end);}
        stopped=true;return;
      }
      if(!file){fs.mkdirSync(directory,{recursive:true});file=path.join(directory,`requirement-${Date.now()}-${process.pid}-${crypto.randomUUID()}.jsonl`);fs.writeFileSync(file,'',{flag:'wx',mode:0o600});}
      fs.appendFileSync(file,line);size+=bytes;
    } catch (_) { /* An unavailable diagnostics disk must not change task execution. */ }
  }
  return {record,get file(){return file;}};
}
let active=create();
function record(event,data){try{active.record(event,data);}catch(_) {}}
function http(identity,route,body,data,status){
  projection.http((event,row)=>record(event,{...row,origin:'native',hubKey:identity?.hub,
    accountKey:require('./device-auth-request').accountScopeKey(identity)}),route,body,data,status);
}
function install({app,ipcMain}) {
  const directory=process.env.SODUWORK_REQUIREMENT_DIAGNOSTICS_DIR;
  ipcMain.handle('requirement-diagnostics-enabled',event=>
    require('./access-control/preferences').isTrusted(event) && !!directory && path.isAbsolute(directory));
  if(!directory || !path.isAbsolute(directory))return;
  active=create({directory,enabled:true});
  let revision,sourceFingerprint;
  try {
    const root=path.resolve(__dirname,'../..');
    const files=['client/core/requirement-diagnostics.js','client/main/requirement-diagnostics.cjs',
      'client/main/pi-session/task-input.js','client/main/pi-session/start-receipts.cjs',
      'client/main/pi-session/task-delivery.cjs','client/main/pi-session/ipc.js','client/api.js'];
    sourceFingerprint=hash(Buffer.concat(files.map(name=>fs.readFileSync(path.join(root,name)))));
    revision=require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{cwd:root,windowsHide:true,timeout:2000,stdio:['ignore','pipe','ignore']}).toString().trim();
  } catch (_) { /* Installed builds may have no git checkout. */ }
  record('diagnostics.startup',{revision,sourceFingerprint,profileKey:app.getPath('userData')});
  ipcMain.on('requirement-diagnostics-record',(event,kind,data)=>{
    if(!require('./access-control/preferences').isTrusted(event) || !['http.result','renderer.task'].includes(kind))return;
    record(kind,{...data,origin:'renderer'});
  });
  console.info('[requirement-diagnostics] '+active.file);
}
module.exports={create,record,http,install};
