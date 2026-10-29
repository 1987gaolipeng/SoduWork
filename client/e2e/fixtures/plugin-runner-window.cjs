// Isolated real IPC/Runner/CLI/model test. Reuses existing device identity
// read-only for short-lived model access. Never enrolls a second device/Runner.
const {app,BrowserWindow,ipcMain,safeStorage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const [root,profile]=process.argv.slice(2);
if(!root||!profile||!fs.existsSync(path.join(profile,'device-auth.json')))throw Error('Explicit test root and existing profile required');
const testProfile=path.join(root,'profile');fs.mkdirSync(testProfile,{recursive:true});
// Electron safeStorage needs the existing encrypted OSCrypt key; copy only
// that encrypted key, never browser history/cookies or plaintext credentials.
const localState=JSON.parse(fs.readFileSync(path.join(profile,'Local State'),'utf8'));
fs.writeFileSync(path.join(testProfile,'Local State'),JSON.stringify({os_crypt:localState.os_crypt}),{mode:0o600});
app.setPath('userData',testProfile);
app.setPath('documents',root);
const client=path.resolve(__dirname,'../..'),backend=path.join(client,'../hub-backend');
let child,window,identity;
const pending=new Map(),calls=[];let seq=0,buffer='';
const prefix='@@SODUWORK_LOCAL_RPC@@';
function rpc(op,payload={},timeout=60000){
  return new Promise((resolve,reject)=>{
    const id=String(++seq),timer=setTimeout(()=>{pending.delete(id);reject(Error('Runner RPC timeout '+op))},timeout);
    pending.set(id,{resolve,reject,timer});
    // Audit presence/metadata only. No prompts, paths, model keys or tickets.
    calls.push({op,plugins:(payload.ctx?.conversationPlugins||payload.plugins||[]).map(p=>p.pluginId),
      hasPluginContext:String(payload.task?.note||payload.promptText||'').includes('<soduwork-conversation-plugins>'),
      ref:payload.ref||'',dispatchId:payload.dispatchId||''});
    child.stdin.write(prefix+JSON.stringify({id,message:{op,...payload}})+'\n');
  });
}
require('../../main/runner-runtime').rpc=rpc;
const auth=require('../../main/device-auth');
auth.install({app:{getPath:()=>profile},ipcMain:{handle(){}},safeStorage});
const personal=require('../../main/personal-plugins');
if(process.env.SODUWORK_E2E_INCUBATOR==='1')personal.install({app,ipcMain,safeStorage});
const marker='PLUGIN-'+crypto.randomBytes(6).toString('hex').toUpperCase();
const work=path.join(root,'work');fs.mkdirSync(work,{recursive:true});
const values={first:marker+'-FIRST',second:marker+'-SECOND',followup:marker+'-FOLLOWUP'};
// Incubator runs need no synthetic resource plugins. This also lets their
// isolated profile be reopened without replacing a same-version test resource.
if(process.env.SODUWORK_E2E_INCUBATOR!=='1'){
personal.create(app,{template:'method',key:'runner-e2e-resource',name:'Runner 资源验证',version:'1.0.0',
  description:'读取随包材料，验证真实 Agent 插件执行链路。',
  instructions:'每一轮必须用工具读取本插件随包的 references/receipt.json 文件，找到用户指定的 first、second 或 followup 属性，只回复该属性的值。不要猜测，不要改文件，不要访问网络。',
  resources:[{path:'references/receipt.json',kind:'reference',encoding:'utf8',content:JSON.stringify(values)}]});
personal.create(app,{template:'method',key:'runner-e2e-denied',name:'Runner 授权拦截验证',version:'1.0.0',
  description:'本测试会话没有操作电脑的授权，应停止发送。',
  instructions:'需要操作电脑，不得跳过授权。',runtimeCapabilities:['computer']});
}
const ipc=require('../../main/pi-session/ipc').install({app,ipcMain,BrowserWindow,
  identityOf:()=>identity,capabilityGrantsOf:()=>[]});
ipcMain.handle('plugin-test-catalog',()=>({items:personal.catalog(app,true).filter(p=>
  process.env.SODUWORK_E2E_INCUBATOR === '1' ? p.key === 'product-incubator' : /^runner-e2e-/.test(p.key))}));
ipcMain.handle('plugin-test-audit',()=>({calls,
  versions:{client:require('../../package.json').version},
  values,work, grants:fs.existsSync(path.join(app.getPath('userData'),'pi-agent/mcp/grants'))
    ?fs.readdirSync(path.join(app.getPath('userData'),'pi-agent/mcp/grants')).length:0}));
ipcMain.handle('plugin-test-shutdown',async()=>{
  require('../../main/agent-runtime/pi-session-bridge').closeAll();
  await new Promise(r=>setTimeout(r,500));child?.stdin.end();return true;
});
app.whenReady().then(async()=>{
  identity=auth.identity({getPath:()=>profile});
  if(!identity)throw Error('Existing model identity is unavailable');
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
  child=spawn(process.env.SODUWORK_E2E_PYTHON||path.join(backend,'.venv/Scripts/python.exe'),
    [path.join(__dirname,'plugin-runner-local.py'),backend,root],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  child.stdout.setEncoding('utf8');child.stdout.on('data',data=>{
    buffer+=data;let at;
    while((at=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,at).trim();buffer=buffer.slice(at+1);
      if(!line.startsWith(prefix))continue;
      const row=JSON.parse(line.slice(prefix.length)),item=pending.get(row.id);if(!item)continue;
      pending.delete(row.id);clearTimeout(item.timer);
      if(process.env.SODUWORK_E2E_INCUBATOR==='1' && (row.result?.ok===false || row.result?.data?.ok===false)) {
        let reason=String(row.result.error?.message||row.result.error||row.result.reason||row.result.data?.error||'unknown');
        for(const value of Object.values(identity||{}))if(typeof value==='string'&&value.length>5)reason=reason.split(value).join('[redacted]');
        reason=reason.replace(/(?:sk|pk|pat|ghp|glpat)-[A-Za-z0-9_-]+/g,'[redacted]');
        console.error('Isolated Runner diagnostic:',reason.slice(0,600));
      }
      row.ok?item.resolve(row.result):item.reject(Error(row.error));
    }
  });
  child.stderr.on('data',()=>{}); // Native logs remain in this isolated Runner's private store.
  child.on('exit',code=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error('Isolated Runner exited '+code));}pending.clear();});
  await rpc('runtime.ping');
  window=new BrowserWindow({width:1280,height:900,show:false,
    webPreferences:{preload:path.join(__dirname,'plugin-runner-preload.cjs'),nodeIntegration:false,
      contextIsolation:true,sandbox:false,offscreen:true,backgroundThrottling:false}});
  await window.loadFile(path.join(__dirname,'plugin-runner.html'));
}).catch(error=>{console.error(String(error.message||error));app.exit(1)});
app.on('before-quit',()=>{child?.stdin.end();child?.kill();});
