const {app,BrowserWindow}=require('electron'),fs=require('fs'),path=require('path'),assert=require('assert/strict');
const out=path.resolve(__dirname,'../../outputs/connector-foundation-20261017/admin-browser');fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();
let win;const sleep=ms=>new Promise(r=>setTimeout(r,ms)),results=[];const js=s=>win.webContents.executeJavaScript(s,true);
async function wait(s){for(let i=0;i<150;i++){if(await js(s))return;await sleep(30)}throw Error('Timeout: '+s)}
const click=text=>js('(()=>{const n=[...document.querySelectorAll("button")].find(n=>n.textContent.trim()==='+JSON.stringify(text)+');if(!n)throw Error("Missing button");n.click()})()');
const fill=value=>js('(()=>{const n=document.querySelector("input[type=password]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(n,'+JSON.stringify(value)+');n.dispatchEvent(new Event("input",{bubbles:true}))})()');
async function shot(name){fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG())}
app.whenReady().then(async()=>{try{win=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false}});win.webContents.on('console-message',(_event,level,message)=>console.log(level,message));await win.loadFile(path.join(out,'dist/tests/connector-form-browser.html'));await wait('!!document.querySelector(".connector-form")');assert.equal(await js('document.querySelector("details").open'),false);await shot('admin-compact');await click('保存并连接');await wait('document.querySelector(".connector-status")?.textContent.includes("请填写")');assert.equal(await js('probes.length'),0);results.push('missing credentials stays local');await fill('fixture-token');await js('failProbe=true');await click('保存并连接');await wait('document.querySelector(".connector-status")?.textContent.includes("授权已失效")');assert.equal(await js('saves.length'),0);assert.equal(await js('document.querySelector("input[type=password]").value'),'fixture-token');results.push('rejected authorization preserves draft');await js('failProbe=false');await click('保存并连接');await wait('saves.length===1');assert.equal(await js('saves[0].enabled'),true);results.push('connect checks and enables');
 await js('openForm()');await wait('!!document.querySelector(".connector-form")');await fill('draft');await js('document.querySelector("details").open=true;hold=true');await click('仅检查连接');await wait('typeof finish==="function"');await fill('changed');await js('hold=false;finish()');await sleep(80);assert.equal(await js('document.querySelector(".connector-status")'),null);results.push('stale check never shown');
 for(const[w,h]of [[390,740],[900,640]]){win.setContentSize(w,h);await sleep(80);const g=await js('(()=>{const r=document.querySelector(".modal").getBoundingClientRect();return{left:r.left,right:r.right,w:innerWidth,scroll:document.documentElement.scrollWidth}})()');assert.ok(g.left>=0&&g.right<=g.w+1&&g.scroll<=g.w+1,JSON.stringify(g));await shot('admin-'+w);results.push('layout '+w)}
 for(const[locale,label]of [['zh-CN','设备上的工具'],['en-US','Tools on a device'],['ja-JP','デバイス上のツール'],['ko-KR','기기의 도구']]) {
  await js('changeLocale('+JSON.stringify(locale)+');openDeviceForm()');await wait('!!document.querySelector(".connector-arguments textarea")');
  for(const[w,zoom]of [[1100,1],[480,1.25]]) {
   win.setContentSize(w,900);win.webContents.setZoomFactor(zoom);await sleep(100);
   const g=await js(`(()=>{const button=document.querySelector('.connector-transport .select-menu-trigger'),span=button.querySelector('span'),r=button.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(span);const text=range.getBoundingClientRect(),args=document.querySelector('.connector-arguments textarea'),a=args.getBoundingClientRect(),form=document.querySelector('.connector-form').getBoundingClientRect();return{label:span.textContent.trim(),clipped:text.top<r.top||text.bottom>r.bottom||text.right>r.right-20,argsHeight:a.height,argsWidth:a.width,formWidth:form.width,overflow:document.documentElement.scrollWidth>innerWidth+1}})()`);
   assert.equal(g.label,label);assert.equal(g.clipped,false,JSON.stringify(g));assert.ok(g.argsHeight>=132,JSON.stringify(g));assert.ok(Math.abs(g.argsWidth-g.formWidth)<2,JSON.stringify(g));assert.equal(g.overflow,false,JSON.stringify(g));
   await js(`document.querySelector('.connector-transport .select-menu-trigger').click()`);await wait('!!document.querySelector(".select-menu-option")');
   assert.equal(await js(`document.querySelectorAll('.select-menu-option').length`),2);
   await js(`document.querySelectorAll('.select-menu-option')[1].click()`);await shot('device-'+locale+'-'+w);
  }
 }
 results.push('device transport label and full-width arguments: four locales, narrow layout and 125% zoom');
 win.webContents.setZoomFactor(1);win.setContentSize(1100,900);await js(`changeLocale('en-US');openDeviceForm()`);await wait('!!document.querySelector(".connector-arguments textarea")');
 const argsText='-y, package, "a,b", C:\\Team Work, --flag, --flag';
 const fillArgs=value=>js(`(()=>{const n=document.querySelector('.connector-arguments textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}))})()`);
 await fillArgs(argsText);const prior=await js('saves.length');await click('Connect');await wait('saves.length==='+String(prior+1));
 assert.deepEqual(await js('saves.at(-1).args'),['-y','package','a,b','C:\\Team Work','--flag','--flag']);
 assert.deepEqual(await js('probes.at(-1).args'),await js('saves.at(-1).args'));
 await js(`openDeviceForm({...saves.at(-1),id:'edit-fixture'})`);await wait('!!document.querySelector(".connector-arguments textarea")');
 assert.equal(await js(`document.querySelector('.connector-arguments textarea').value`),argsText);
 await fillArgs('"unfinished');await wait('!!document.querySelector(".connector-argument-error")');const probesBefore=await js('probes.length');
 await click('Save and connect');assert.equal(await js('probes.length'),probesBefore);assert.equal(await js('saves.length'),prior+1);
 results.push('comma arguments probe/save/edit round-trip and invalid input blocks execution');
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({ok:true,results},null,2));console.log(JSON.stringify({ok:true,results}));app.exit(0)}catch(e){console.error(e.stack);if(win)await shot('failure');app.exit(1)}})
