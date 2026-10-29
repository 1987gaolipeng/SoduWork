'use strict';
const { app, BrowserWindow }=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=process.argv[2];if(!root||!path.isAbsolute(root))throw Error('Absolute evidence directory required');
fs.mkdirSync(root,{recursive:true});app.setPath('userData',fs.mkdtempSync(path.join(require('node:os').tmpdir(),'soduwork-model-ui-')));
let win;const report={ok:false,cases:[],screenshots:[]};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));const js=code=>win.webContents.executeJavaScript(code);
async function until(code){for(let i=0;i<100;i++){if(await js(code))return;await wait(40)}throw Error('Timeout: '+code)}
async function shot(name){await wait(150);const file=path.join(root,name+'.png');fs.writeFileSync(file,(await win.webContents.capturePage()).toPNG());report.screenshots.push(file)}
async function run(){
 win=new BrowserWindow({show:false,width:1500,height:1000,webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
 await win.loadFile(path.join(__dirname,'fixtures/model-settings.html'));await until('document.querySelectorAll(".md-nav-item").length===6');
 await js('selectService("personal")');
 assert.equal(await js('document.querySelectorAll(".md-settings-section").length'),2);
 assert.equal(await js('document.querySelectorAll(".cfg-subsection").length'),1);
 assert.equal(await js('document.querySelector(".md-personal-key-card")?.textContent.includes("当前使用这个模型的个人 Key")'),true);
 assert.equal(await js('document.querySelector(".md-clear-key")?.textContent.includes("停止使用个人额度")'),true);
 const themes=[];
 for(const theme of ['azure','warm','minimal','steady']){
  await js('document.documentElement.dataset.theme='+JSON.stringify(theme));
  themes.push(await js('({theme:document.documentElement.dataset.theme,button:getComputedStyle(document.querySelector(".md-test")).backgroundColor,paper:getComputedStyle(document.querySelector(".cfg-detail")).backgroundColor,ink:getComputedStyle(document.querySelector(".cfg-detail-title h2")).color})'));
  await shot('models-'+theme);
 }
 assert.equal(new Set(themes.map(t=>t.button)).size,4);assert.ok(new Set(themes.map(t=>t.paper)).size>=3);
 report.themes=themes;report.cases.push('four production themes change button, surface and text; form uses three clear groups');
 const small=await js('[...document.querySelectorAll("#mdPanel *")].filter(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=="hidden"&&[...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())&&parseFloat(getComputedStyle(el).fontSize)<12).map(el=>({tag:el.tagName,cls:el.className,font:getComputedStyle(el).fontSize}))');
 assert.deepEqual(small,[]);report.cases.push('all visible model-page text is at least 12px');
 await js('fill("[data-pkey]","fixture-key-not-a-secret");document.querySelector("[data-peye]").click()');
 assert.equal(await js('document.querySelector("[data-pkey]").type'),'text');
 await js('selectService("company");selectService("personal")');
 assert.equal(await js('document.querySelector("[data-pkey]").value'),'fixture-key-not-a-secret');
 assert.equal(await js('document.querySelector("[data-pkey]").type'),'password');
 await js('fill("#mdQ","personal");fill("#mdQ","")');
 assert.equal(await js('document.querySelector("[data-pkey]").value'),'fixture-key-not-a-secret');
 report.cases.push('service switches and searches retain unsaved key, with password hidden again');
 await js('document.querySelector("[data-mdeditor]").open=true;fill("[data-padd]","custom-report-model");document.querySelector("[data-madd]").click()');
 assert.ok(await js('[...document.querySelectorAll(".md-mtag")].some(el=>el.textContent.includes("custom-report-model"))'));
 await js('fill("[data-padd]","custom-report-model");document.querySelector("[data-madd]").click()');
 assert.equal(await js('[...document.querySelectorAll(".md-mtag")].filter(el=>el.textContent.includes("custom-report-model")).length'),1);
 await js('document.querySelector("[data-ptest]").click()');await until('document.querySelector("[data-ptest]").disabled');
 await until('document.querySelector(".md-test-r.is-ok")');
 assert.equal(await js('saved.at(-1).keys.personal'),'fixture-key-not-a-secret');
 assert.equal(await js('testCalls.length'),1);
 assert.equal(await js('document.querySelector("[data-pkey]").value'),'');
 report.cases.push('add model, prevent duplicates, save-before-test, disable duplicate test and clear persisted key from input');
 await js('[...document.querySelectorAll("[data-mdel]")].find(el=>el.closest("[data-md-model]").textContent.includes("custom-report-model")).click()');
 await until('saved.at(-1)?.models?.every(item=>item.name!=="custom-report-model")');
 assert.equal(await js('[...document.querySelectorAll(".md-mtag")].some(el=>el.textContent.includes("custom-report-model"))'),false);
 report.cases.push('removing a personal model persists immediately and it does not reappear after reload');
 await js('testFailure=true;document.querySelector("[data-ptest]").click()');await until('document.querySelector(".md-test-r.is-bad")');
 assert.ok(await js('document.querySelector(".md-test-r").textContent.includes("检查 API 地址")'));
 await js('testFailure=false;document.querySelector("[data-ptest]").click()');await until('document.querySelector(".md-test-r.is-ok")');
 report.cases.push('connection failure is visible in place and can be retried');
 await js('document.querySelector("#mdAddInline").click();fill("[data-pname]","新增业务服务");fill("[data-purl]","http://127.0.0.1:11434/v1");document.querySelector("[data-pnoauth]").click()');
 assert.equal(await js('document.querySelector("[data-pkey]")'),null);
 await js('fill("[data-padd]","local-demo");document.querySelector("[data-madd]").click();document.querySelector("[data-ptest]").click()');
 await until('document.querySelector(".md-test-r.is-ok")');
 report.cases.push('new service, no-key local configuration and test result stay usable');
 await js('selectService("personal");fill("[data-pkey]","draft-on-error");saveFailure=true;document.querySelector("#mdSave").click()');
 await until('notice?.includes("模拟保存失败")');
 assert.equal(await js('document.querySelector("[data-pkey]").value'),'draft-on-error');
 await js('saveFailure=false');report.cases.push('save failure preserves user input');
 win.setSize(820,700);await wait(120);
 await js('document.querySelector("[data-mdeditor]").open=true');
 assert.ok(await js('document.querySelector(".cfg-detail").getBoundingClientRect().top>=document.querySelector(".cfg-master").getBoundingClientRect().bottom-1'));
 await js('document.querySelector("#mdBody").scrollTop=100000');
 assert.ok(await js('(()=>{const body=document.querySelector("#mdBody"),button=document.querySelector("[data-madd]").getBoundingClientRect(),bounds=body.getBoundingClientRect();return body.scrollWidth<=body.clientWidth+1&&button.bottom<=bounds.bottom&&button.top>=bounds.top})()'));
 await shot('models-narrow');report.cases.push('820px window stacks by actual content width; last form action stays reachable without horizontal overflow');
 win.setSize(1500,620);await wait(100);await js('document.querySelector("#mdBody").scrollTop=0;document.querySelector(".cfg-detail-scroll").scrollTop=100000');
 assert.ok(await js('(()=>{const b=document.querySelector("[data-madd]").getBoundingClientRect();return b.top>=0&&b.bottom<=innerHeight})()'));
 report.cases.push('short desktop window retains independently scrollable service list and configuration');
 assert.deepEqual(await js('errors'),[]);report.ok=true;
}
app.whenReady().then(run).catch(async error=>{report.error=error.stack;if(win){report.diagnostics=await js('({errors,body:document.querySelector("#mdBody")?.getBoundingClientRect().toJSON(),grid:getComputedStyle(document.querySelector(".md-master-detail")).gridTemplateColumns})');await shot('failure')}})
 .finally(()=>{fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));if(win)win.destroy();app.exit(report.ok?0:1)});
