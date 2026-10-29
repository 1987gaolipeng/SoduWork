'use strict';
// Real filesystem scan, production outputs IPC/preload and renderer. No model,
// existing profile, live task or business record is touched.
const {app,BrowserWindow,ipcMain,nativeImage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=process.argv[2];
if(!root||!path.isAbsolute(root))throw Error('Absolute evidence directory required');
fs.mkdirSync(root,{recursive:true});
app.setPath('userData',fs.mkdtempSync(path.join(require('node:os').tmpdir(),'soduwork-image-index-')));
const report={ok:false,cases:[],screenshots:[]};
let win;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const js=code=>win.webContents.executeJavaScript(code);
async function until(code){for(let i=0;i<100;i++){if(await js(code))return;await delay(50);}throw Error('Timed out: '+code);}
async function shot(name){const file=path.join(root,name+'.png');fs.writeFileSync(file,(await win.webContents.capturePage()).toPNG());report.screenshots.push(file);}
async function run(){
  const work=path.join(root,'work');fs.mkdirSync(work,{recursive:true});
  const names=['图标-透明底.png','图标-白底.png','验证-绿底合成.png'];
  const width=360,height=220;
  names.forEach((name,index)=>{
    const pixels=Buffer.alloc(width*height*4);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const p=(y*width+x)*4,mark=x>125&&x<235&&y>55&&y<165;
      const rgb=mark?[55,127,238]:index===2?[50,165,115]:[255,255,255];
      pixels[p]=rgb[2];pixels[p+1]=rgb[1];pixels[p+2]=rgb[0];pixels[p+3]=!mark&&index===0?0:255;
    }
    fs.writeFileSync(path.join(work,name),nativeImage.createFromBitmap(pixels,{width,height}).toPNG());
  });
  const outputs=require('../main/pi-session/outputs');
  let turnSince=Date.now()-5000;
  const session={cwd:work,outputSnapshot:()=>outputs.scan(work,0,turnSince)};
  assert.equal(session.outputSnapshot().delivery.items.length,0,'these ordinary image names are not inferred deliverables');
  require('../main/agent-runtime/pi-session-bridge').get=ref=>ref==='preview-fixture'?session:null;
  require('../main/pi-session/ipc').install({app,ipcMain,BrowserWindow,identityOf:()=>null,capabilityGrantsOf:()=>[]});
  const runtime=require('../main/conversation/artifact-runtime'),realAction=runtime.action;
  let blockImages=false,clipboardPng;
  runtime.action=async(...args)=>blockImages&&['image','image-full'].includes(args[3])
    ? {ok:false,reason:'fixture: temporarily unavailable'} : realAction(...args);
  // Exercise renderer + production IPC without replacing the user's OS clipboard.
  require('../main/conversation/image-clipboard').writePng=async bytes=>{clipboardPng=Buffer.from(bytes);};
  win=new BrowserWindow({show:false,width:1280,height:860,webPreferences:{preload:path.join(__dirname,'../preload.js'),contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
  await win.loadFile(path.join(__dirname,'fixtures/output-preview.html'));
  const markdown='已生成以下图片：\n\n'+names.map(name=>'!['+name+']('+encodeURIComponent(name)+')').join('\n\n');
  async function configure(){await js('window.previewMarkdown='+JSON.stringify(markdown)+';ChatOutputLinks.load(soduWorkAPI.conversationSession,"preview-fixture",[],[],null).then(configure)');}
  await configure();
  await until('document.querySelectorAll(".noutput-image").length===3');
  assert.equal(await js('document.querySelectorAll("#list .noutput-image img").length'),0);
  assert.ok(await js('[...document.querySelectorAll(".noutput-image")].every(node=>node.getBoundingClientRect().height<80)'));
  assert.ok(await js('files.every(file=>file.artifactId&&!file.path&&file.primary===false)'));
  await until('ChatWorkbench.state().open && document.querySelector(".ncw-image img")?.naturalWidth===360');
  report.cases.push('ordinary Chinese PNG names retain compact preview entries from a real filesystem scan without a delivery manifest');
  await shot('image-entries');
  await js('document.querySelectorAll(".noutput-image")[2].click()');
  await until('ChatWorkbench.state().open && document.querySelector(".ncw-image img")?.naturalWidth===360');
  assert.equal(await js('!!document.querySelector(".catt-preview")'),false);
  assert.equal(await js('document.querySelector(".ncw-dochead b").textContent'),names[2]);
  await js('document.querySelector("[data-wb-image-copy]").click()');
  await until('document.querySelector("[data-wb-image-copy]")?.getAttribute("aria-label")==="已复制"');
  assert.deepEqual(nativeImage.createFromBuffer(clipboardPng).getSize(),{width,height});
  assert.deepEqual(clipboardPng,fs.readFileSync(path.join(work,names[2])));
  report.cases.push('clicking the compact image entry opens the same full image in the right results panel, never a modal');
  report.cases.push('copy control reads authorized full image bytes through production IPC (OS clipboard stubbed)');
  await shot('right-image');
  // An unrelated primary document must not hide the image index.
  fs.writeFileSync(path.join(work,'report.md'),'# 已存在的主成果');
  await configure();
  await until('document.querySelectorAll(".noutput-image").length===3');
  assert.ok(await js('files.some(file=>file.name==="report.md")'));
  report.cases.push('image references still display alongside a classified primary document');
  // Resumed history has no active-turn marker, but explicit image references still render.
  turnSince=0;win.webContents.reload();await delay(150);await configure();
  await until('document.querySelectorAll(".noutput-image").length===3');
  assert.ok(await js('files.filter(file=>file.kind==="image").every(file=>!file.changedInTurn)'));
  report.cases.push('reopened history resolves explicit images without an active turn or persisted image bytes');
  await js('window.beforeImage=document.querySelector(".noutput-image");repaint()');
  assert.ok(await js('beforeImage===document.querySelector(".noutput-image")'));
  for(const dark of [false,true]){
    await js('document.body.classList.toggle("dark",'+dark+');document.querySelector(".noutput-image").click()');
    await until('document.querySelector(".ncw-image img")?.naturalWidth===360');
    for(const width of [1280,680,390]){
      win.setSize(width,860);await delay(100);
      assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'));
      assert.ok(await js('(()=>{const img=document.querySelector(".ncw-image img"),parent=img.parentElement;return img.getBoundingClientRect().width<=parent.clientWidth})()'));
    }
  }
  report.cases.push('light/dark themes and 1280/680/390px widths keep images visible without horizontal overflow');
  win.setSize(1280,860);blockImages=true;win.webContents.reload();await delay(150);await configure();
  await until('document.querySelectorAll(".noutput-image").length===3');
  assert.equal(await js('document.querySelectorAll(".noutput-image[data-image-state]").length'),0,
    'background chat rendering never reads images or shows a loading/error placeholder');
  await js('document.querySelector(".noutput-image").click()');
  await until('!!document.querySelector("[data-wb-image-retry]")');
  assert.ok(await js('document.querySelector("[data-wb-image-copy]").disabled'));
  blockImages=false;await js('document.querySelector("[data-wb-image-retry]").click()');
  await until('document.querySelector(".ncw-image img")?.naturalWidth===360');
  await js('document.querySelectorAll(".noutput-image").forEach(node=>node.click())');
  await until('document.querySelector(".ncw-image img")?.naturalWidth===360');
  assert.equal(await js('document.querySelectorAll("#list .noutput-image img").length'),0);
  report.cases.push('a transient read failure can be retried in place; failed previews never enable copy prematurely');
  assert.deepEqual(await js('errors'),[]);report.ok=true;
}
app.whenReady().then(run).catch(async error=>{report.error=error.stack;if(win){report.ui=await js('({files,images:[...document.querySelectorAll(".noutput-image")].map(el=>({state:el.dataset.imageState,text:el.textContent}))})');await shot('failure');}})
  .finally(()=>{fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(win)win.destroy();app.exit(report.ok?0:1);});
