// Real task attachment cards -> production preload/IPC -> loopback download -> viewer/save.
// Only OS application handoff and save-dialog choices are captured; no business Hub is used.
const {app,BrowserWindow,ipcMain,net}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const assert=require('node:assert/strict');
const client=path.resolve(__dirname,'..'),out=process.argv[2];
if(!out||!path.isAbsolute(out))throw Error('Absolute evidence directory required');
fs.mkdirSync(out,{recursive:true});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-attachment-test-'));
app.setPath('userData',profile);
const report={ok:false,mode:'requirements-drawer',checks:[],requests:[]};
const files=[
  {id:'html0001',filename:'05_指标模块验证报告.html',contentType:'text/html',body:Buffer.from('<!doctype html><meta charset="utf-8"><h1>HTML 附件验收</h1>')},
  {id:'mark0001',filename:'测试执行报告.md',contentType:'text/markdown',body:Buffer.from('# Markdown 附件验收\n\n修复后可以查看。')},
  {id:'text0001',filename:'说明.txt',contentType:'text/plain',body:Buffer.from('Text 附件验收')},
  {id:'csv00001',filename:'数据.csv',contentType:'text/csv',body:Buffer.from('name,value\nexample,1')},
  {id:'json0001',filename:'资料.json',contentType:'application/json',body:Buffer.from('{"example":true}')},
  {id:'pdf00001',filename:'验收.pdf',contentType:'application/pdf',body:Buffer.from('%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF')},
  {id:'word0001',filename:'资料.docx',contentType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',body:Buffer.from('isolated document bytes: test OS handoff only')},
  {id:'png00001',filename:'图片.png',contentType:'image/png',isImage:true,body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6+0sAAAAASUVORK5CYII=','base64')},
];
const ticket='attachment-fixture-ticket-1234567890';
let server,win,base,saveCanceled=false,openError='',status=200;
const opened=[],saves=[],viewers=[],errors=[];
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const js=code=>win.webContents.executeJavaScript(code,true);
async function until(fn,label){for(let i=0;i<120;i++){if(await fn())return;await delay(50)}throw Error('Timed out: '+label)}
async function click(selector){const point=await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button:'left',clickCount:1,...point});await delay(120)}
function fixtureHtml(){
  const list=files.map(({body,...f})=>({...f,size:body.length,url:'/api/v1/attachments/'+f.id+'?ticket='+ticket,canDelete:false}));
  // Use the production generic error mapper, which originally hid the type failure.
  const human=fs.readFileSync(path.join(client,'components/pet/pet-ui.js'),'utf8').split('let bubbleTimer =')[0];
  return `<!doctype html><meta charset="utf-8"><title>Task attachments fixture</title>
  <link rel="stylesheet" href="/components/panels/conversation-attachments.css">
  <style>body{font:14px sans-serif;padding:24px}.rq-material{display:flex;gap:12px;padding:8px}.rq-material-actions{display:flex;gap:8px}button{min-height:28px}</style>
  <div id="toast"></div>
  <script>${human}
  window.fixtureErrors=[];window.toasts=[];addEventListener('error',e=>fixtureErrors.push(e.message));addEventListener('unhandledrejection',e=>fixtureErrors.push(String(e.reason)));
  window.petSay=m=>{toasts.push(m);document.querySelector('#toast').textContent=m};
  window.esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));window._fmtSize=n=>n+' B';window._fileIcon=()=>'';
  window.SoduWorkAPI={getTask:async id=>({id,title:'Attachment acceptance',status:'done',canEditRequirement:false,canViewExecution:true}),listAttachments:async()=>${JSON.stringify(list)},attachmentUrl:a=>location.origin+a.url};
  </script><script src="/core/requirements.js"></script><script src="/components/panels/conversation-attachments.js"></script><script src="/components/requirements/requirements-detail.js"></script><script>RequirementsDetail.open('fixture-task')</script>`;
}
app.whenReady().then(async()=>{
  server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    if(url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fixtureHtml());return}
    const file=files.find(f=>url.pathname==='/api/v1/attachments/'+f.id);
    if(file){const code=url.searchParams.get('ticket')===ticket?status:401;report.requests.push({id:file.id,mode:url.searchParams.get('mode')||'download',status:code});res.writeHead(code,{'Content-Type':file.contentType,'X-Content-Type-Options':'nosniff'});res.end(file.body);return}
    const allowed=['/components/panels/conversation-attachments.js','/components/panels/conversation-attachments.css','/core/requirements.js','/components/requirements/requirements-detail.js'];
    if(allowed.includes(url.pathname)){res.setHeader('Content-Type',url.pathname.endsWith('.js')?'text/javascript':'text/css');res.end(fs.readFileSync(path.join(client,url.pathname)));return}res.writeHead(404);res.end();
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
  function PreviewWindow(options){const w=new BrowserWindow({...options,show:false,webPreferences:{...options.webPreferences,offscreen:true}});w.show=()=>{};const record={win:w,title:options.title,loaded:false,failed:null};viewers.push(record);w.webContents.once('did-finish-load',()=>record.loaded=true);w.webContents.on('did-fail-load',(_e,code,reason)=>record.failed={code,reason});return w}
  PreviewWindow.fromWebContents=BrowserWindow.fromWebContents;
  require('../main/attachment-files').install({app,net,ipcMain,BrowserWindow:PreviewWindow,identityOf:()=>({hub:base}),shell:{openPath:async target=>{opened.push(target);return openError}},dialog:{showSaveDialog:async(_parent,options)=>{if(saveCanceled)return{canceled:true};const target=path.join(profile,path.basename(options.defaultPath));saves.push(target);return{filePath:target}},showErrorBox:(title,reason)=>errors.push({title,reason})}});
  win=new BrowserWindow({show:false,width:1280,height:800,webPreferences:{preload:path.join(client,'preload.js'),offscreen:true,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  await win.loadURL(base);await until(()=>js("document.querySelectorAll('[data-rq-file]').length===8"),'cards rendered');
  files.find(f=>f.id==='pdf00001').body=await win.webContents.printToPDF({pageSize:'A4'});
  for(const f of files){
    await js('toasts.length=0');const o=opened.length,v=viewers.length;
    await click(`[data-rq-file="${f.id}"]`);
    if(/\.(html|docx)$/.test(f.filename)){await until(()=>opened.length>o,'system handoff');assert.deepEqual(fs.readFileSync(opened.at(-1)),f.body);assert.equal(path.basename(opened.at(-1)),f.filename);report.checks.push({filename:f.filename,systemHandoff:true,downloadedBytesMatch:true})}
    else if(f.isImage){await until(()=>js("!!document.querySelector('.catt-preview-body img')?.naturalWidth"),'image decoded');report.checks.push({filename:f.filename,imageDecoded:true});await click('[data-catt-preview-close]')}
    else{await until(()=>viewers.length>v,'native viewer created');const viewer=viewers.at(-1);await until(()=>viewer.loaded||viewer.failed,'native viewer load');assert.equal(viewer.failed,null);assert.ok(viewer.loaded);if(f.contentType!=='application/pdf'){const dbg=viewer.win.webContents.debugger;dbg.attach('1.3');const tree=await dbg.sendCommand('DOM.getDocument');const body=(await dbg.sendCommand('DOM.getOuterHTML',{nodeId:tree.root.nodeId})).outerHTML;dbg.detach();assert.ok(body.includes(f.body.toString('utf8').split('\n')[0]),f.filename+' body readable')};report.checks.push({filename:f.filename,nativeLoaded:true});viewer.win.destroy()}
    assert.deepEqual(await js('toasts'),[]);
  }
  {
    for(const f of files){const n=saves.length;await js('toasts.length=0');await click(`[data-rq-download="${f.id}"]`);await until(()=>saves.length===n+1&&fs.existsSync(saves.at(-1))&&fs.readFileSync(saves.at(-1)).equals(f.body),'save success');assert.equal(saves.length,n+1);assert.deepEqual(fs.readFileSync(saves.at(-1)),f.body);report.checks.push({filename:f.filename,downloadSaved:true})}
    status=500;await js('toasts.length=0');await click('[data-rq-download="html0001"]');await until(()=>js("document.querySelector('[data-rq-error]').textContent.includes('HTTP 500')"),'failed download feedback');assert.deepEqual(await js('toasts'),[]);status=200;report.checks.push('Failed download reports HTTP status without a success toast');
    saveCanceled=true;await js('toasts.length=0');await click('[data-rq-download="html0001"]');assert.deepEqual(await js('toasts'),[]);saveCanceled=false;report.checks.push('Cancel save is silent');
    for(const code of [401,403,404,500]){status=code;await js("toasts.length=0;document.querySelector('[data-rq-error]').textContent=''");await click('[data-rq-file="html0001"]');await until(()=>js("document.querySelector('[data-rq-error]').textContent.length>0"),'HTTP failure feedback');const toast=await js("document.querySelector('[data-rq-error]').textContent");assert.match(toast,code===401||code===403?/凭证.*失效/:code===404?/不存在|权限/:/HTTP 500/);report.checks.push({http:code,toast})}status=200;
    openError='No application is associated';await js("toasts.length=0;document.querySelector('[data-rq-error]').textContent=''");await click('[data-rq-file="html0001"]');await until(()=>js("document.querySelector('[data-rq-error]').textContent.length>0"),'system association failure');assert.match(await js("document.querySelector('[data-rq-error]').textContent"),/没有可打开.*应用/);openError='';report.checks.push('Missing system app produces a specific error');
    await js('toasts.length=0');await click('[data-rq-download="html0001"]');await until(()=>fs.readFileSync(saves.at(-1)).equals(files[0].body),'download after open failure');report.checks.push('Download still works after system app failure');
    assert.deepEqual(await js('fixtureErrors'),[]);assert.deepEqual(errors,[]);
  }
  report.ok=true;
}).catch(e=>{report.error=e.stack;report.nativeErrors=errors;report.viewers=viewers.map(({win,...v})=>v)})
.finally(()=>{fs.writeFileSync(path.join(out,'after-ui.json'),JSON.stringify(report,null,2));for(const v of viewers)if(!v.win.isDestroyed())v.win.destroy();win?.destroy();server?.close();app.emit('before-quit');app.exit(report.ok?0:1)});
