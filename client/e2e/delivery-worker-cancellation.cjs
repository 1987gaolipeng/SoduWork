'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const name of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ELECTRON_NO_ATTACH_CONSOLE','CHROME_CRASHPAD_PIPE_NAME','CHROME_CRASHPAD_PIPE_HANDLE']) delete env[name];
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer=setTimeout(()=>child.kill(),45000);
  child.on('exit', code=>{clearTimeout(timer);process.exitCode=code??1;});
} else {
  const {app}=electron, fs=require('node:fs/promises'), path=require('node:path'), os=require('node:os');
  const assert=require('node:assert/strict'), crypto=require('node:crypto');
  const worker=require('../main/conversation/delivery-package-worker');
  const artifacts=require('../main/conversation/artifact-runtime'), outputs=require('../main/pi-session/outputs');
  let root;
  const tick=()=>new Promise(resolve=>setTimeout(resolve,15));
  app.whenReady().then(async()=>{
    root=await fs.mkdtemp(path.join(os.tmpdir(),'soduwork-cancel-compression-'));
    await fs.mkdir(path.join(root,'.soduwork'));
    await fs.writeFile(path.join(root,'index.html'),'<h1>Captured result</h1>');
    await fs.writeFile(path.join(root,'asset.bin'),crypto.randomBytes(2*1024*1024));
    await fs.writeFile(path.join(root,'.soduwork/delivery.json'),JSON.stringify({schemaVersion:1,deliverables:[{path:'index.html',files:['asset.bin']}]}));
    const session={cwd:root,sessionId:'cancel-native',snapshot:()=>({status:'idle'}),outputSnapshot:()=>outputs.scan(root,0,1)};
    const ids=artifacts.snapshot(session).items.filter(f=>f.primary!==false).map(f=>f.artifactId);
    async function capture(){
      for(let retry=0;retry<200;retry++){
        try{return await worker.capture(session,ids)}catch(error){if(!/其他成果/.test(error.message))throw error;await tick()}
      } throw Error('Cancelled worker failed to release its slot');
    }
    for(let round=0;round<30;round++){
      const job=await capture();job.cancel();await assert.rejects(job.payload,/取消/);
    }
    const result=await (await capture()).payload;
    assert.equal(result.manifest.files.length,2);assert.equal(result.bytes.readUInt32LE(0),0x04034b50);
    console.log(JSON.stringify({ok:true,cancellations:30,finalArchiveFiles:2,nativeRuntime:process.versions.electron}));
  }).catch(error=>{console.error(error.stack||error);process.exitCode=1;}).finally(async()=>{
    if(root)await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:30});
    app.exit(process.exitCode||0);
  });
}
