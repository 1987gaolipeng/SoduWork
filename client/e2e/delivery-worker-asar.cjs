'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env={...process.env};for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ELECTRON_NO_ATTACH_CONSOLE','CHROME_CRASHPAD_PIPE_NAME','CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron,[__filename],{env,windowsHide:true,stdio:'inherit'}).on('exit',code=>process.exitCode=code??1);
} else {
  const { app }=electron,fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
  const report={ok:false},output=path.resolve(__dirname,'../../outputs/local-execution-20261004/asar.json');
  let root;
  app.whenReady().then(async()=>{
    root=await fs.mkdtemp(path.join(os.tmpdir(),'soduwork-delivery-asar-'));
    const source=path.join(root,'source'),cwd=path.join(root,'workspace');
    await fs.mkdir(cwd);await fs.mkdir(source);
    await fs.cp(path.resolve(__dirname,'../main'),path.join(source,'main'),{recursive:true});
    const archive=path.join(root,'app.asar');await require('@electron/asar').createPackage(source,archive);
    await fs.writeFile(path.join(cwd,'index.html'),'<link href="style.css"><h1>Original website</h1>');
    await fs.writeFile(path.join(cwd,'style.css'),'body{color:green}');
    const packaged=path.join(archive,'main'),outputs=require(path.join(packaged,'pi-session/outputs.js'));
    const session={cwd,sessionId:'packaged',snapshot:()=>({status:'idle'}),outputSnapshot:()=>outputs.scan(cwd,0,1)};
    const files=require(path.join(packaged,'conversation/artifact-runtime.js')).snapshot(session).items;
    const job=await require(path.join(packaged,'conversation/delivery-package-worker.js')).capture(session,files.filter(f=>f.primary!==false).map(f=>f.artifactId),{completedTurn:true});
    await fs.writeFile(path.join(cwd,'style.css'),'body{color:blue}');
    const payload=await job.payload;
    assert(Buffer.isBuffer(payload.bytes));assert.equal(payload.bytes.readUInt32LE(0),0x04034b50);assert.equal(payload.manifest.files.length,2);
    assert.equal(payload.manifest.files.find(f=>f.path==='style.css').sha256,require('node:crypto').createHash('sha256').update('body{color:green}').digest('hex'));
    Object.assign(report,{ok:true,files:2,bytes:payload.bytes.length,boundary:'Real Electron worker executed from ASAR; source mutation after capture preserves original collection'});
  }).catch(error=>report.error=String(error.stack)).finally(async()=>{
    await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
    // Electron holds the ASAR descriptor until process exit on Windows.
    if(root)await fs.rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:30}).catch(()=>{});
    app.exit(report.ok?0:1);
  });
}
