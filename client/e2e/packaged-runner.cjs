'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
function runtimeArguments(script,payload,root,mode) {
  assert.ok(['lifecycle','task'].includes(mode));
  const args=['-X','utf8',script,path.join(payload,'resources/runner/soduwork-runner.exe')];
  if(mode==='task') {
    const profile=require('../main/distribution.cjs').current();
    args.push(payload,root,path.join(payload,profile.windowsExecutableName+'.exe'));
  } else args.push(root);
  return args;
}
async function main() {
const candidateFile=path.resolve(process.argv[2]),mode=process.argv[3];
assert.ok(['lifecycle','task'].includes(mode));
const candidate=JSON.parse(fs.readFileSync(candidateFile));assert.equal(candidate.payloadVerified,true);
const payload=JSON.parse(fs.readFileSync(path.join(path.dirname(candidateFile),'payload-result.json'))).extracted;
const backend=path.resolve(candidate.source,'../hub-backend');
const python=process.env.SODUWORK_TEST_PYTHON || path.join(backend,'.venv/Scripts/python.exe');
const script=path.join(backend,mode==='task'?'scripts/check_packaged_runner_task.py':'scripts/check_packaged_runner.py');
// Queue journals need room for their digest and temporary suffix on Windows
// hosts without long paths. Keep runtime data out of the CI checkout depth.
assert.ok(path.resolve(os.tmpdir()).length < 100, 'Runner checks require a short TEMP directory');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-runner-check-'));
const evidence=path.join(path.dirname(candidateFile),'runner-'+mode);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
try {
  const args=runtimeArguments(script,payload,root,mode);
  const status=await new Promise((resolve,reject)=>{
    const child=spawn(python,args,{env,windowsHide:true,stdio:'inherit'});
    const timer=setTimeout(()=>{
      if(child.pid) spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});
      reject(Error('Delivered Runner '+mode+' timed out'));
    },150000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',code=>{clearTimeout(timer);resolve(code);});
  });
  assert.equal(status,0,'Delivered Runner '+mode+' failed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'report.json'))).ok,true);
} finally {
  // Preserve diagnostic receipts, not temporary user profiles or task stores.
  fs.mkdirSync(evidence,{recursive:true});
  for(const name of fs.readdirSync(root)) {
    if(/\.(json|log)$/.test(name) && fs.statSync(path.join(root,name)).isFile())
      fs.copyFileSync(path.join(root,name),path.join(evidence,name));
  }
  fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
}
module.exports={runtimeArguments};
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
