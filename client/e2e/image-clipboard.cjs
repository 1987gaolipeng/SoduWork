'use strict';
// Production preview + preload + IPC + native system clipboard, without model,
// backend, live account, or changes to the running SoduWork process.
const {app,BrowserWindow,ipcMain,clipboard,ClipboardItem,nativeImage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const root=process.argv[2],mode=process.argv[3]||'verify';
if(!root||!path.isAbsolute(root))throw Error('An absolute evidence directory is required');
fs.mkdirSync(root,{recursive:true});
app.setPath('userData',path.join(root,mode+'-profile'));
app.setPath('documents',root);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const hash=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
const signature=buffer=>{
  const img=nativeImage.createFromBuffer(buffer);
  return {size:img.getSize(),pixels:hash(img.toBitmap())};
};
const report={mode,electron:process.versions.electron,platform:process.platform,cases:[],ok:false};
let win,original=[],lastWritten='',pasteSequence=0,fixtureServer,servedImage;
async function until(read,predicate,label){
  for(let i=0;i<100;i++){const value=await read();if(predicate(value))return value;await wait(50);}
  throw Error('Timed out: '+label);
}
async function readPng(){
  for(const item of await clipboard.read()){
    if(item.types.includes('image/png'))return Buffer.from(await (await item.getType('image/png')).arrayBuffer());
  }
  return null;
}
async function externalPaste(){
  return new Promise((resolve,reject)=>{
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    const child=spawn(process.execPath,[__filename,root,'receiver',String(++pasteSequence)],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let out='',err='';
    const timer=setTimeout(()=>{child.kill();reject(Error('External paste timed out'));},15000);
    child.stdout.on('data',chunk=>{out+=chunk;});
    child.stderr.on('data',chunk=>{err+=chunk;});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{
      clearTimeout(timer);
      const result=out.split('\n').find(line=>line.startsWith('SODUWORK_PASTE_RESULT '));
      if(code!==0||!result)return reject(Error('External paste process failed: '+err.slice(-400)));
      resolve(JSON.parse(result.slice('SODUWORK_PASTE_RESULT '.length)));
    });
  });
}
async function receiver(){
  // A second application process receives a genuine OS paste event. It has no
  // SoduWork preload, no IPC bridge, and no access to the sender's image paths.
  win=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,offscreen:true,backgroundThrottling:false}});
  await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<meta charset="utf-8"><style>body{font:16px sans-serif;background:#f8fafc;padding:24px;color:#172b4d}#paste{background:white;padding:16px;border:1px solid #cbd5e1;border-radius:12px}img{display:block;max-width:100%;max-height:450px;margin:12px auto}</style><h2>Independent clipboard paste receiver</h2><div id="paste" contenteditable="true">Paste image here</div>'));
  await win.webContents.executeJavaScript(`window.pasted=null;document.addEventListener('paste',async event=>{
    const file=Array.from(event.clipboardData.files)[0];if(!file){window.pasted={error:'no image file'};return;}
    event.preventDefault();
    const img=document.createElement('img');img.src=URL.createObjectURL(file);img.alt='Image received from system clipboard';
    document.querySelector('#paste').textContent='Image pasted successfully';document.querySelector('#paste').appendChild(img);
    await img.decode();
    const data=await file.arrayBuffer();const bitmap=await createImageBitmap(file);
    window.pasted={type:file.type,width:bitmap.width,height:bitmap.height,bytes:Array.from(new Uint8Array(data))};bitmap.close();
  });document.querySelector('#paste').focus();`);
  win.webContents.paste();
  const result=await until(()=>win.webContents.executeJavaScript('window.pasted'),Boolean,'external paste event');
  if(result.error)throw Error(result.error);
  const sig=signature(Buffer.from(result.bytes));
  const screenshot=path.join(root,'external-paste-'+String(process.argv[4]||'0').replace(/[^0-9]/g,'')+'.png');
  fs.writeFileSync(screenshot,(await win.webContents.capturePage()).toPNG());
  console.log('SODUWORK_PASTE_RESULT '+JSON.stringify({type:result.type,size:sig.size,pixels:sig.pixels,pastedBytes:result.bytes.length,screenshot}));
}
async function run(){
  const work=path.join(root,'work');fs.mkdirSync(work,{recursive:true});
  const bridge=require('../main/agent-runtime/pi-session-bridge');
  bridge.get=ref=>ref==='clipboard-e2e'?{cwd:work}:null;
  require('../main/pi-session/ipc').install({app,ipcMain,BrowserWindow,identityOf:()=>null,capabilityGrantsOf:()=>[]});
  fixtureServer=require('node:http').createServer((request,response)=>{
    const url=new URL(request.url,'http://localhost');
    const status=url.pathname.endsWith('expired0')?403:url.pathname.endsWith('missing0')?404:url.pathname.endsWith('redirect')?302:200;
    if(status!==200){response.writeHead(status,{location:'https://example.invalid/'});response.end();return;}
    if(!servedImage||url.pathname!=='/api/v1/attachments/12345678'||
      url.searchParams.get('ticket')!=='abcdefghijklmnop.qrstuvwxyz012345.abcdefghi'){response.writeHead(403);response.end();return;}
    response.writeHead(200,{'content-type':servedImage.type,'content-length':servedImage.buffer.length});
    response.end(servedImage.buffer);
  });
  await new Promise(resolve=>fixtureServer.listen(0,'127.0.0.1',resolve));
  const fixtureHub='http://127.0.0.1:'+fixtureServer.address().port;
  require('../main/attachment-files').install({app,ipcMain,BrowserWindow,net:require('electron').net,
    identityOf:()=>({hub:fixtureHub}),dialog:{showErrorBox:(title,message)=>{throw Error(message)}},
    shell:{openPath:async()=>{throw Error('Unexpected external document open')}}});
  win=new BrowserWindow({width:1100,height:820,show:false,webPreferences:{
    preload:path.resolve(__dirname,'../preload.js'),nodeIntegration:false,contextIsolation:true,
    sandbox:false,offscreen:true,backgroundThrottling:false}});
  const errors=[];win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
  await win.loadFile(path.join(__dirname,'fixtures/clipboard-preview.html'));
  const evaluate=code=>win.webContents.executeJavaScript(code,true);
  const existing=await clipboard.read();
  for(const item of existing){
    const values={};for(const type of item.types)values[type]=await item.getType(type);
    original.push(new ClipboardItem(values)); // memory only; never log/persist clipboard contents
  }
  const formats=mode==='reproduce'?['image/png']:['image/png','image/jpeg','image/webp'];
  const fixtures=[];
  for(const mime of formats){
    const encoded=await evaluate('fixtureImage('+JSON.stringify(mime)+')');
    const buffer=Buffer.from(encoded,'base64'),ext=mime.split('/')[1];
    const file=path.join(work,'clipboard-fixture.'+ext);fs.writeFileSync(file,buffer);
    fixtures.push({name:path.basename(file),type:mime,size:buffer.length,buffer,file});
  }
  if(mode!=='reproduce'){
    const buffer=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
    const file=path.join(work,'clipboard-fixture.gif');fs.writeFileSync(file,buffer);
    fixtures.push({name:path.basename(file),type:'image/gif',size:buffer.length,buffer,file});
  }
  const provided=process.env.SODUWORK_E2E_IMAGE;
  if(mode!=='reproduce'&&provided){
    const buffer=fs.readFileSync(provided),file=path.join(work,'provided-screenshot.png');
    fs.writeFileSync(file,buffer);fixtures.push({name:'provided-screenshot.png',type:'image/png',size:buffer.length,buffer,file});
  }
  const contract=require('../main/pi-session/attachment-contract');
  for(const fixture of fixtures){
    const publicFile={name:fixture.name,type:fixture.type,size:fixture.size,previewRef:contract.previewRef(fixture.file)};
    await evaluate('renderAttachment('+JSON.stringify(publicFile)+');document.querySelector("[data-catt-message-image]").click()');
    await until(()=>evaluate('!!document.querySelector(".catt-preview-body img")?.naturalWidth'),Boolean,'full image loaded');
    await evaluate('document.querySelector("[data-catt-preview-copy]").click()');
    const outcome=await until(()=>evaluate('document.querySelector("[data-catt-preview-copy] span").textContent'),text=>text==='已复制'||text==='复制失败','copy outcome');
    const reason=await evaluate('document.querySelector("#status").textContent');
    const shot=path.join(root,mode+'-'+fixture.name+'.png');fs.writeFileSync(shot,(await win.webContents.capturePage()).toPNG());
    if(mode==='reproduce'){
      if(outcome!=='复制失败'||!reason.includes('clipboard.writeImage is not a function'))throw Error('Expected old API error, got '+outcome+': '+reason);
      report.cases.push({image:fixture.name,outcome,reason,screenshot:shot});report.ok=true;return;
    }
    if(outcome!=='已复制')throw Error(fixture.name+': '+reason);
    const actual=await readPng();if(!actual)throw Error('System clipboard contains no PNG');
    const normalized=/image\/(webp|gif)/.test(fixture.type) ? Buffer.from(await evaluate(
      '(()=>{const img=document.querySelector(".catt-preview-body img");const c=document.createElement("canvas");c.width=img.naturalWidth;c.height=img.naturalHeight;c.getContext("2d").drawImage(img,0,0);return c.toDataURL("image/png").split(",")[1];})()'), 'base64') : fixture.buffer;
    const expected=signature(normalized),got=signature(actual);lastWritten=got.pixels;
    if(JSON.stringify(expected)!==JSON.stringify(got))throw Error('Clipboard pixels differ from source');
    const pasted=await externalPaste();
    if(pasted.pixels!==expected.pixels||JSON.stringify(pasted.size)!==JSON.stringify(expected.size))throw Error('External paste differs from source');
    report.cases.push({image:fixture.name,type:fixture.type,outcome,clipboard:got,pasted,screenshot:shot});
    await evaluate('document.querySelector("[data-catt-preview-close]").click()');
  }
  // Unsaved composer previews use the same bounded native writer, even when
  // this isolated offscreen document cannot acquire browser clipboard focus.
  report.drafts=[];
  for(const draft of fixtures.slice(0,4)){
    await evaluate('loadDraft('+JSON.stringify(draft.buffer.toString('base64'))+','+JSON.stringify(draft.type)+','+JSON.stringify(draft.name)+');document.querySelector("[data-catt-open]").click()');
    await until(()=>evaluate('!!document.querySelector(".catt-preview-body img")?.naturalWidth'),Boolean,'draft loaded');
    const focused=await evaluate('document.hasFocus()');
    await evaluate('document.querySelector("[data-catt-preview-copy]").click()');
    const outcome=await until(()=>evaluate('document.querySelector("[data-catt-preview-copy] span").textContent'),text=>text==='已复制'||text==='复制失败','draft copy outcome');
    if(outcome!=='已复制')throw Error('Draft copy failed: '+await evaluate('document.querySelector("#status").textContent'));
    lastWritten=signature(await readPng()).pixels;
    const expected=report.cases.find(row=>row.image===draft.name).clipboard;
    const pasted=await externalPaste();
    if(lastWritten!==expected.pixels||pasted.pixels!==expected.pixels)throw Error('Draft paste pixels differ');
    report.drafts.push({type:draft.type,outcome,focused,pasted});
    await evaluate('document.querySelector("[data-catt-preview-close]").click()');
  }
  // Task-details UI -> actual preload -> validated Hub fetch -> shared preview
  // -> system clipboard -> a separate application's native paste event.
  report.taskDetails=[];
  for(const fixture of fixtures){
    servedImage=fixture;
    await evaluate('loadTaskDetail('+JSON.stringify({
      id:'12345678',filename:fixture.name,contentType:fixture.type,size:fixture.size,
      isImage:true,canDelete:false,url:fixtureHub+'/api/v1/attachments/12345678?ticket=abcdefghijklmnop.qrstuvwxyz012345.abcdefghi'
    })+')');
    await evaluate('document.querySelector("[data-rq-file]").click()');
    await until(()=>evaluate('!!document.querySelector(".catt-preview-body img")?.naturalWidth'),Boolean,'task detail preview loaded');
    await evaluate('document.querySelector("[data-catt-preview-copy]").click()');
    const outcome=await until(()=>evaluate('document.querySelector("[data-catt-preview-copy] span").textContent'),
      text=>text==='已复制'||text==='复制失败','task image copy outcome');
    if(outcome!=='已复制')throw Error('Task detail copy failed: '+await evaluate('document.querySelector("#status").textContent'));
    lastWritten=signature(await readPng()).pixels;
    const expected=report.cases.find(row=>row.image===fixture.name).clipboard;
    const pasted=await externalPaste();
    if(lastWritten!==expected.pixels||pasted.pixels!==expected.pixels)throw Error('Task detail paste differs from original');
    const screenshot=path.join(root,'task-detail-'+fixture.name+'.png');
    fs.writeFileSync(screenshot,(await win.webContents.capturePage()).toPNG());
    report.taskDetails.push({type:fixture.type,outcome,pasted,screenshot});
    await evaluate('document.querySelector("[data-catt-preview-close]").click()');
  }
  const quotedName = "l'image <test>.png";
  await evaluate('loadTaskDetail('+JSON.stringify({id:'12345678',filename:quotedName,contentType:servedImage.type,size:servedImage.size,isImage:true,url:fixtureHub+'/api/v1/attachments/12345678?ticket=abcdefghijklmnop.qrstuvwxyz012345.abcdefghi'})+')');
  await evaluate('document.querySelector("[data-rq-file]").click()');
  await until(()=>evaluate('!!document.querySelector(".catt-preview-body img")?.naturalWidth'),Boolean,'quoted filename preview');
  if(await evaluate('document.querySelector(".catt-preview-body img").getAttribute("alt")')!==quotedName)throw Error('Quoted filename corrupted image markup');
  await evaluate('document.querySelector("[data-catt-preview-close]").click()');
  report.quotedFilename=true;
  report.taskBoundaries=[];
  for(const [name,url] of [
    ['other-origin','https://example.invalid/api/v1/attachments/12345678?ticket=abcdefghijklmnop.qrstuvwxyz012345.abcdefghi'],
    ['missing-ticket',fixtureHub+'/api/v1/attachments/12345678'],
    ['expired',fixtureHub+'/api/v1/attachments/expired0?ticket=abcdefghijklmnop.qrstuvwxyz012345.abcdefghi'],
    ['missing',fixtureHub+'/api/v1/attachments/missing0?ticket=abcdefghijklmnop.qrstuvwxyz012345.abcdefghi'],
    ['redirect',fixtureHub+'/api/v1/attachments/redirect?ticket=abcdefghijklmnop.qrstuvwxyz012345.abcdefghi']
  ]){
    const rejected=await evaluate('window.soduWorkAPI.previewAttachment('+JSON.stringify({url,inlineImage:true})+').then(()=>false,()=>true)');
    if(!rejected)throw Error('Unsafe attachment accepted: '+name);
    if(signature(await readPng()).pixels!==lastWritten)throw Error('Denied attachment changed clipboard');
    report.taskBoundaries.push({name,rejected});
  }
  const invalid=await evaluate('window.soduWorkAPI.conversationSession.copyAttachmentImage("missing","att1.invalid")');
  const denied=await evaluate('window.soduWorkAPI.conversationSession.copyAttachmentImage("clipboard-e2e",'+JSON.stringify(contract.previewRef(path.join(root,'outside.png')))+')');
  if(invalid.ok||denied.ok)throw Error('Session boundary was bypassed');
  if(signature(await readPng()).pixels!==lastWritten)throw Error('Denied request changed clipboard');
  const malformed=await evaluate('window.soduWorkAPI.conversationSession.copyImage(new Uint8Array([1,2,3]))');
  const pathRejected=await evaluate('window.soduWorkAPI.conversationSession.copyImage("C:/not-an-image.png")');
  const webp=fixtures.find(file=>file.type==='image/webp');
  const badConversion=await evaluate('window.soduWorkAPI.conversationSession.copyAttachmentImage("clipboard-e2e",'+JSON.stringify(contract.previewRef(webp.file))+',new Uint8Array([1,2,3]))');
  if(malformed.ok||pathRejected.ok||badConversion.ok)throw Error('Invalid image data accepted');
  if(signature(await readPng()).pixels!==lastWritten)throw Error('Invalid PNG changed clipboard');
  report.boundaries={missingSession:invalid,otherDirectory:denied,malformed,pathRejected,badConversion};
  report.rendererErrors=errors;report.ok=true;
}
app.whenReady().then(async()=>{
  try{
    if(mode==='receiver'){await receiver();return;}
    await run();
  }catch(error){report.error=String(error.stack||error);console.error(report.error);}
  finally{
    if(mode!=='receiver'){
      if(lastWritten){
        const current=await readPng().catch(()=>null);
        if(current&&signature(current).pixels===lastWritten){
          if(original.length)await clipboard.write(original);else clipboard.clear();
          report.clipboardRestored=true;
        }
      }
      fs.writeFileSync(path.join(root,mode+'-report.json'),JSON.stringify(report,null,2));
      console.log(JSON.stringify({mode,ok:report.ok,cases:report.cases.length,error:report.error||null}));
    }
    if(fixtureServer)fixtureServer.close();
    app.exit(mode==='receiver'?(report.error?1:0):(report.ok?0:1));
  }
});
