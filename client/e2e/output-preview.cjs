'use strict';
// Real renderer modules, production preload/IPC, safe artifact reader and native
// image decoder. Isolated profile, synthetic files, no model or live user data.
const {app,BrowserWindow,ipcMain,nativeImage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=process.argv[2];
if(!root||!path.isAbsolute(root))throw Error('Absolute evidence directory required');
fs.mkdirSync(root,{recursive:true});
app.setPath('userData',path.join(root,'profile'));
let win,server;
const report={ok:false,cases:[],screenshots:[]};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(code){for(let i=0;i<100;i++){if(await win.webContents.executeJavaScript(code))return;await delay(50);}throw Error('Timed out: '+code);}
async function run(){
  const work=path.join(root,'work');fs.mkdirSync(work,{recursive:true});
  const width=1440,height=900,pixels=Buffer.alloc(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=(y*width+x)*4,band=x<width/3?0:x<width*2/3?1:2;
    const rgb=[[234,161,109],[105,162,157],[106,139,186]][band];
    pixels[i]=rgb[2];pixels[i+1]=rgb[1];pixels[i+2]=rgb[0];pixels[i+3]=255;
  }
  fs.writeFileSync(path.join(work,'preview.png'),nativeImage.createFromBitmap(pixels,{width,height}).toPNG());
  fs.writeFileSync(path.join(work,'report.md'),'# Delivery check\n\nScreenshot is ready for review.\n\n| Check | Result |\n| --- | --- |\n| Image | Pass |\n| Markdown | Pass |\n\n## Usage\n\n- Click the image to zoom\n- Close the panel to return\n\n<script>window.injected=true</script>\n');
  fs.writeFileSync(path.join(work,'second.md'),'# Second document\n\nThis content proves that rapid tab switches remain safe.');
  fs.writeFileSync(path.join(work,'source.js'),'const answer = 1;\nconsole.log(answer);\n');
  const artifacts=[['image','preview.png','image'],['markdown','report.md','document'],['second','second.md','document'],['source','source.js','file']]
    .map(([artifactId,name,kind])=>({artifactId,name,relative:name,kind,path:path.join(work,name),at:1,primary:true,changedInTurn:artifactId==='image',size:fs.statSync(path.join(work,name)).size}));
  const fixture={cwd:work,outputSnapshot:()=>({delivery:{items:artifacts}})};
  require('../main/agent-runtime/pi-session-bridge').get=ref=>ref==='preview-fixture'?fixture:null;
  require('../main/pi-session/ipc').install({app,ipcMain,BrowserWindow,identityOf:()=>null,capabilityGrantsOf:()=>[]});
  server=require('node:http').createServer((req,res)=>{
    const url=new URL(req.url,'http://fixture');
    const image=url.pathname.endsWith('image1234'),name=image?'preview.png':'report.md';
    res.writeHead(200,{'content-type':image?'image/png':'text/markdown'});
    res.end(fs.readFileSync(path.join(work,name)));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const hub='http://127.0.0.1:'+server.address().port;
  require('../main/attachment-files').install({app,ipcMain,BrowserWindow,net:require('electron').net,
    identityOf:()=>({hub}),dialog:{},shell:{}});
  const runtime=require('../main/conversation/artifact-runtime');
  const realAction=runtime.action;
  let slow=false;
  runtime.action=async(...args)=>{if(slow&&args[2]==='markdown'&&args[3]==='read')await delay(250);return realAction(...args);};
  win=new BrowserWindow({show:false,width:1280,height:860,webPreferences:{
    preload:path.join(__dirname,'../preload.js'),contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
  win.webContents.on('console-message',(_e,level,message)=>{if(level>=3)report.console=(report.console||[]).concat(message);});
  await win.loadFile(path.join(__dirname,'fixtures/output-preview.html'));
  await win.webContents.executeJavaScript('configure('+JSON.stringify(runtime.decorate('preview-fixture',{items:artifacts}))+')');
  await until('document.querySelector("#list .noutput-image img")?.naturalWidth===1440');
  assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll("#list .noutput-image-caption").length'),0,
    'the conversation displays the authorized image without a filename caption');
  await until('document.querySelector(".ncw-image img")?.naturalWidth===1440');
  report.cases.push('generated image automatically opens authorized full-resolution bytes in the right panel');
  assert.equal(await win.webContents.executeJavaScript('ChatWorkbench.state().open'),true);
  assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".noutput-image").length'),1);
  assert.ok(await win.webContents.executeJavaScript('document.querySelector(".noutput-image img").getBoundingClientRect().height <= 360'));
  const stable=await win.webContents.executeJavaScript('window.priorImage=document.querySelector(".noutput-image");repaint();priorImage===document.querySelector(".noutput-image")');
  assert.equal(stable,true);report.cases.push('stream updates retain the decoded inline image without a filename caption');
  await delay(250); // Capture after the workbench opening transition has settled.
  const imageShot=path.join(root,'preview-image-right.png');
  fs.writeFileSync(imageShot,(await win.webContents.capturePage()).toPNG());report.screenshots.push(imageShot);
  await win.webContents.executeJavaScript('document.querySelector("[data-open-app=markdown]").click()');
  await until('document.querySelector(".ncw-markdown h1")?.textContent==="Delivery check"');
  assert.equal(await win.webContents.executeJavaScript('Boolean(window.injected)'),false);
  report.cases.push('Markdown link opens in right panel; tables render and scripts do not execute');
  slow=true;
  await win.webContents.executeJavaScript('ChatWorkbench.openOutput("second");ChatWorkbench.openOutput("markdown");ChatWorkbench.openOutput("second")');
  await until('document.querySelector(".ncw-markdown h1")?.textContent==="Second document"');
  await delay(350);
  assert.equal(await win.webContents.executeJavaScript('document.querySelector(".ncw-markdown h1").textContent'),'Second document');
  report.cases.push('rapid tab switches cannot leave loading stuck or overwrite the active file');
  slow=false;
  await win.webContents.executeJavaScript('ChatWorkbench.openOutput("markdown")');
  await until('document.querySelector(".ncw-markdown h1")?.textContent==="Delivery check"');
  await win.webContents.executeJavaScript(`ChatWorkbench.render(document.querySelector('#chat'),{messages:[],fileChanges:{capturedAt:2,files:[{path:'source.js',action:'modified',before:{path:'source.js',text:'const answer = 0;\\nconsole.log(answer);\\n',hash:'before'},after:{path:'source.js',text:'const answer = 1;\\nconsole.log(answer);\\n',hash:'after'}}]}},files);ChatWorkbench.openOutput('source');`);
  await until('document.querySelector(".ncw-diff-body") && document.querySelector(".ncw-diff-body").textContent.includes("answer")');
  assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".ncw-diff-body .d2h-ins").length>0 || document.querySelectorAll(".ncw-diff-body .nd-l.add").length>0'),true);
  report.cases.push('local file changes open in a compact file-level Diff view');
  await win.webContents.executeJavaScript(`ChatWorkbench.render(document.querySelector('#chat'),{messages:[],fileChanges:{cwd:${JSON.stringify(work)},capturedAt:3,files:[{path:'created.js',action:'created',after:{path:'created.js',size:25,mtimeMs:2,text:'const created = true;\\n'}}]}},files.filter(file=>file.artifactId!=='created'));ChatWorkbench.openLink('created.js');`);
  await until('document.querySelector(".CodeMirror")?.textContent.includes("created")');
  assert.equal(await win.webContents.executeJavaScript('document.querySelector("[data-wb-tab][aria-selected=true] [data-wb-tab-label]")?.textContent==="created.js"'),true);
  report.cases.push('newly created code files open from filename links without falling back to a browser URL');
  await win.webContents.executeJavaScript(`ChatTools.openSide({name:'write_file',state:'done',args:{path:'tool.md',content:'# Tool change\\n\\nconst ready = true;'}})`);
  await until('document.querySelector(".CodeMirror")?.textContent.includes("Tool change")');
  assert.equal(await win.webContents.executeJavaScript('Boolean(document.querySelector(".ntool-drawer"))'),false);
  assert.equal(await win.webContents.executeJavaScript('Boolean(document.querySelector(".ncw-diff-body"))'),false);
  report.cases.push('write tool cards with a delayed output index open the same right-side CodeMirror workbench');
  await win.webContents.executeJavaScript(`ChatTools.openSide({name:'edit_file',state:'done',args:{path:'tool.md',old_string:'# Tool change',new_string:'# Tool changed'}})`);
  await until('document.querySelector(".ncw-diff-body")?.textContent.includes("Tool changed")');
  assert.equal(await win.webContents.executeJavaScript('Boolean(document.querySelector(".ntool-drawer"))'),false);
  report.cases.push('edit tool cards open the file-level Diff view beside the conversation');
  await win.webContents.executeJavaScript('ChatWorkbench.openOutput("source")');
  await until('document.querySelector(".CodeMirror-code")?.textContent.includes("const answer")');
  const diffShot=path.join(root,'preview-diff.png');fs.writeFileSync(diffShot,(await win.webContents.capturePage()).toPNG());report.screenshots.push(diffShot);
  await win.webContents.executeJavaScript('document.querySelector("[data-wb-code-view=code]").click()');
  await until('document.querySelector(".CodeMirror")');
  assert.equal(await win.webContents.executeJavaScript('document.querySelector(".CodeMirror-code")?.textContent.includes("const answer")'),true);
  report.cases.push('code artifacts open in the native CodeMirror editor with syntax mode');
  assert.equal(await win.webContents.executeJavaScript('!document.querySelector("[data-wb-code-save]")?.hidden'),true);
  await win.webContents.executeJavaScript('ChatWorkbench.state().open && document.querySelector("[data-wb-code-view=code]").click();');
  await until('document.querySelector(".CodeMirror")');
  await win.webContents.executeJavaScript('(()=>{const cm=document.querySelector(".CodeMirror").CodeMirror;cm.setValue("const answer = 2;\\nconsole.log(answer);\\n");document.querySelector("[data-wb-code-save]").click();})()');
  await delay(120);
  assert.equal(fs.readFileSync(path.join(work,'source.js'),'utf8').includes('answer = 2'),true);
  report.cases.push('local code edits save back through the bounded conversation workspace IPC');
  assert.equal(await win.webContents.executeJavaScript('(()=>{const host=document.querySelector(".CodeMirror")?.getBoundingClientRect(),code=document.querySelector(".CodeMirror-code")?.getBoundingClientRect();return Boolean(host&&code&&code.left>=host.left&&code.right<=host.right+1&&code.top>=host.top&&code.bottom<=host.bottom+1);})()'),true);
  for(const dark of [false,true]){
    await win.webContents.executeJavaScript('document.body.classList.toggle("dark",'+dark+')');
    const shot=path.join(root,dark?'preview-dark.png':'preview-light.png');
    fs.writeFileSync(shot,(await win.webContents.capturePage()).toPNG());report.screenshots.push(shot);
  }
  await win.webContents.executeJavaScript('document.querySelector("[data-wb-close]").click();document.querySelector(".noutput-image").click()');
  await until('document.querySelector(".ncw-image img")?.naturalWidth===1440');
  assert.ok(await win.webContents.executeJavaScript('Boolean(document.querySelector("[data-wb-image-copy]"))'));
  assert.equal(await win.webContents.executeJavaScript('Boolean(document.querySelector(".catt-preview"))'),false);
  await win.webContents.executeJavaScript('document.querySelector("[data-wb-close]").click()');
  assert.equal(await win.webContents.executeJavaScript('ChatWorkbench.state().open'),false);
  report.cases.push('image opens full resolution in the right panel, exposes copy and closes without a modal');
  const safe=await win.webContents.executeJavaScript('ChatOutputLinks.decorate("<div class=\\"nmsg ai\\"><div class=\\"ntext nmd\\">"+ChatOutputLinks.sanitize(marked.parse("![private](C:/Windows/private.png) ![tracking](https://example.invalid/pixel.png)"),DOMPurify)+"</div></div>",[])');
  assert.doesNotMatch(safe,/<img\b/);report.cases.push('untrusted image paths and tracking URLs remain inert');
  win.setSize(680,860);
  await win.webContents.executeJavaScript('document.body.classList.remove("dark");ChatWorkbench.openOutput("markdown")');
  await until('document.querySelector(".ncw-markdown h1")?.textContent==="Delivery check"');
  await delay(250);
  const measure=await win.webContents.executeJavaScript('({overflow:document.documentElement.scrollWidth>innerWidth,fonts:[...document.querySelectorAll(".ncw-dochead button,.ncw-markdown,.noutput-image-caption small")].map(n=>parseFloat(getComputedStyle(n).fontSize))})');
  assert.equal(measure.overflow,false);assert.ok(measure.fonts.every(n=>n>=12));
  report.cases.push('680px viewport has no horizontal overflow; preview type is at least 12px');
  const narrow=path.join(root,'preview-narrow.png');fs.writeFileSync(narrow,(await win.webContents.capturePage()).toPNG());report.screenshots.push(narrow);
  assert.deepEqual(await win.webContents.executeJavaScript('errors'),[]);
  await win.webContents.executeJavaScript('window.SoduWorkAPI={listAttachments:async()=>['+
    JSON.stringify({id:'markdown1234',filename:'cloud.md',role:'output',url:'/api/v1/attachments/markdown1234?ticket=fixture-ticket-0123456789'})+','+
    JSON.stringify({id:'image1234',filename:'cloud.png',role:'output',url:'/api/v1/attachments/image1234?ticket=fixture-ticket-0123456789'})+
    '],attachmentUrl:row=>'+JSON.stringify(hub)+'+row.url};'+
    'files.push({artifactId:"cloud-md",taskId:"fixture-task",attachmentId:"markdown1234",name:"cloud.md",kind:"task-file",at:1},'+
    '{artifactId:"cloud-image",taskId:"fixture-task",attachmentId:"image1234",name:"cloud.png",kind:"task-file",at:1});'+
    'ChatWorkbench.render(document.querySelector("#chat"),{messages:[]},files);ChatWorkbench.openOutput("cloud-md");');
  await until('document.querySelector(".ncw-markdown h1")?.textContent==="Delivery check" && document.querySelector(".ncw-dochead b")?.textContent==="cloud.md"');
  await win.webContents.executeJavaScript('ChatWorkbench.openOutput("cloud-image")');
  await until('document.querySelector(".ncw-image img")?.naturalWidth===1440');
  report.cases.push('remote task Markdown and images use fresh attachment authorization and render inside the client');
  const revoked=await win.webContents.executeJavaScript('(async()=>{SoduWorkAPI.listAttachments=async()=>[];try{await ChatOutputLinks.readPreview(files.find(f=>f.artifactId==="cloud-image"),soduWorkAPI.conversationSession,ref,"image-full");return false;}catch(_){return true;}})()');
  assert.equal(revoked,true);report.cases.push('revoked task attachment cannot be reopened from a stale output index');
  assert.equal((await runtime.action(fixture,'preview-fixture','missing','image',{})).ok,false);
  fs.unlinkSync(path.join(work,'preview.png'));
  assert.equal((await runtime.action(fixture,'preview-fixture','image','image',{})).ok,false);
  report.cases.push('deleted and unknown output images fail safely instead of reading arbitrary paths');
  report.ok=true;
}
app.whenReady().then(run).catch(error=>{report.error=error.stack;process.exitCode=1;})
  .finally(()=>{fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(server)server.close();if(win)win.destroy();app.exit(report.ok?0:1);});
