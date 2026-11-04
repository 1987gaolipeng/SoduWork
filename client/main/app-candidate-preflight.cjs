'use strict';
// Candidate-only native startup check. A separate Electron process owns its
// throwaway account/database; it never reads the user's installed-app storage.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), {spawn} = require('node:child_process');
const pending = new Map(), passed = new Map();
let queue=Promise.resolve(); // At most one temporary Electron check at a time.
function eligibility(body) {
  if (body?.template !== 'app') return 'not_app';
  const pages = body.ui?.contributions?.filter(row=>row.slot==='workspace.navigation') || [];
  if (pages.length !== 1 || pages[0].source?.type !== 'package') return 'external';
  return 'package';
}
function run(app,body) {
  const kind=eligibility(body);
  if(kind!=='package')return Promise.resolve({ok:true,executed:false,checks:[],reason:kind});
  const checksum=crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const key=app.getPath('userData')+'\0'+checksum;
  const cached=passed.get(key);
  if(cached&&Date.now()-cached.at<120000)return Promise.resolve(cached.result);
  if(pending.has(key))return pending.get(key);
  const execution=queue.catch(()=>{}).then(()=>execute(app,body,checksum));
  queue=execution.then(()=>{},()=>{});
  const promise=execution.then(result=>{
    if(result.ok){if(passed.size>=8)passed.delete(passed.keys().next().value);passed.set(key,{at:Date.now(),result});}
    return result;
  }).finally(()=>pending.delete(key));
  pending.set(key,promise);return promise;
}
async function execute(app,body,checksum) {
  const base=path.resolve(os.tmpdir()),folder=fs.mkdtempSync(path.join(base,'soduwork-app-preflight-'));
  const input=path.join(folder,'candidate.json'),output=path.join(folder,'result.json');
  fs.writeFileSync(input,JSON.stringify(body),{mode:0o600});
  let result;
  try {
    const binary=process.versions.electron ? process.execPath : require('electron');
    const env={...process.env};
    // The native child is an Electron app, not a Node test-runner child.
    for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ELECTRON_NO_ATTACH_CONSOLE','CHROME_CRASHPAD_PIPE_NAME','CHROME_CRASHPAD_PIPE_HANDLE','NODE_TEST_CONTEXT'])delete env[key];
    // Containerized preflight runs as root without the SUID sandbox; chromium
    // refuses to start there unless sandboxing is explicitly disabled. Chromium
    // does not consume every switch from process.argv, so the folder travels in
    // the environment instead of trusting argv positions.
    const args=require('./app-preflight-entry.cjs').launchArgs(app.isPackaged, path.resolve(__dirname,'..'));
    if(typeof process.getuid==='function'&&process.getuid()===0)args.unshift('--no-sandbox');
    env.APP_CANDIDATE_PREFLIGHT_FOLDER=folder;
    result=await new Promise(resolve=>{
      let done=false,diagnostic='';
      const child=spawn(binary,args,{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
      const capture=chunk=>{diagnostic=(diagnostic+chunk.toString('utf8')).slice(-3000);};
      child.stdout.on('data',capture);child.stderr.on('data',capture);
      const finish=error=>{
        if(done)return;done=true;clearTimeout(timer);
        try{if(fs.existsSync(output))return resolve(JSON.parse(fs.readFileSync(output,'utf8')));}catch(_){}
        let phase='';try{phase=JSON.parse(fs.readFileSync(path.join(folder,'progress.json'),'utf8')).stage;}catch(_){}
        if(phase)error=String(error||'检查进程未返回结果')+'；阶段='+phase;
        resolve({ok:false,executed:true,checks:[{key:'app-startup',ok:false,label:'原生启动检查未完成：'+String(error || '检查进程未返回结果')+(diagnostic?'；'+diagnostic:'')}]});
      };
      const timer=setTimeout(()=>{child.kill();finish('启动检查超时');},40000);
      child.once('error',error=>finish(error.message));child.once('close',(code,signal)=>finish('检查进程退出（'+String(code ?? signal)+'）'));
    });
    result.candidate={key:body.key,version:body.version,checksum};
    const evidence=path.join(app.getPath('userData'),'diagnostics','app-preflight',checksum);
    fs.mkdirSync(evidence,{recursive:true});
    fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify(result,null,2),{mode:0o600});
    const screenshot=path.join(folder,'first-screen.png');
    if(fs.existsSync(screenshot))fs.copyFileSync(screenshot,path.join(evidence,'first-screen.png'));
    return result;
  } finally {
    // Only remove our own freshly created, resolved temp directory.
    if(path.dirname(path.resolve(folder))!==base || !path.basename(folder).startsWith('soduwork-app-preflight-'))throw Error('预检临时目录不在指定范围');
    fs.rmSync(folder,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
}
module.exports={run,eligibility};
