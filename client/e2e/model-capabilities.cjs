'use strict';
const { app, BrowserWindow }=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const output=process.argv[2];if(!output||!path.isAbsolute(output))throw Error('Absolute evidence directory required');
fs.mkdirSync(output,{recursive:true});app.setPath('userData',fs.mkdtempSync(path.join(require('node:os').tmpdir(),'soduwork-capabilities-')));
let win;const report={ok:false,cases:[],screenshots:[]};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));const js=code=>win.webContents.executeJavaScript(code);
async function until(code){for(let i=0;i<100;i++){if(await js(code))return;await wait(40)}throw Error('Timeout: '+code)}
async function shot(name){await wait(150);const file=path.join(output,name+'.png');fs.writeFileSync(file,(await win.webContents.capturePage()).toPNG());report.screenshots.push(file)}
async function scroll(){await js('document.querySelector(".cfg-detail-scroll").scrollTop=100000');await wait(100)}
async function run(){
 win=new BrowserWindow({show:false,width:1500,height:1000,webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
 await win.loadFile(path.join(__dirname,'fixtures/model-settings.html'));await until('document.querySelectorAll(".md-nav-item").length===6');
 await js('selectService("company")');
 assert.equal(await js('document.querySelectorAll("[data-mdedit]").length'),0);
 assert.ok(await js('document.querySelector(".md-cap-badge").textContent.includes("支持")'));
 assert.equal(await js('document.querySelector(".md-cap-badge").title'),'已有配置');
 await js('selectService("personal");document.querySelector("[data-mdedit]").click()');
 assert.equal(await js('document.querySelector("[data-mdfield=maxOutputTokens]").value'),'8192');
 await js('fill("[data-mdfield=imageInput]","unsupported");fill("[data-mdfield=imageRouting]","native");document.querySelector("[data-madd]").click()');
 assert.ok(await js('notice.includes("冲突")'));
 await js('fill("[data-mdfield=imageInput]","supported");fill("[data-mdfield=maxOutputTokens]","256001");document.querySelector("[data-madd]").click()');
 assert.ok(await js('notice.includes("不能超过")'));
 await js('fill("[data-mdfield=maxOutputTokens]","32768");fill("[data-mdfield=toolCalling]","supported");document.querySelector(".md-cap-advanced").open=true');await wait(60);
 await js('selectService("company");selectService("personal")');
 assert.equal(await js('document.querySelector("[data-mdfield=maxOutputTokens]").value'),'32768');
 await scroll();await shot('client-edit-zh');
 await js('document.querySelector("[data-madd]").click()');
 assert.equal(await js('_mdMyModels[0].config.thinkingFormat'),'zai');
 assert.equal(await js('_mdMyModels[0].config.thinkingMode'),'always');
 assert.equal(await js('_mdMyModels[0].config.maxOutputTokens'),32768);
 assert.equal(await js('_mdMyModels[0].ctxWindow'),128000);
 report.cases.push('organization models read-only; own capability editing validates conflicts and limits, retains advanced thinking and drafts across provider switches');
 await js('document.querySelector("[data-mdcheck]").click()');
 await until('capabilityCalls.length===1');
 assert.equal(await js('document.querySelector("[data-mdcheck]").disabled'),true);
 await js('document.querySelector("[data-mdcheck]").click()');
 await until('document.querySelector(".md-cap-report")');
 assert.equal(await js('capabilityCalls.length'),1);
 assert.equal(await js('saved.at(-1).models[0].config.maxOutputTokens'),32768);
 await js('document.querySelector(".md-cap-report").open=true');await scroll();await shot('client-results-zh');
 report.cases.push('capability checks save applied changes first, prevent duplicate submissions and display per-capability evidence');
 await js('capabilityFailure=true;document.querySelector("[data-mdcheck]").click()');await until('document.querySelector(".md-cap-error")');
 await js('capabilityFailure=false;document.querySelector("[data-mdcheck]").click()');await until('document.querySelector(".md-cap-report")');
 await js('document.querySelector("[data-mdcheck]").click();fill("[data-purl]","https://changed.example.test/v1")');await wait(350);
 assert.equal(await js('document.querySelectorAll(".md-cap-report").length'),0);
 report.cases.push('failed capability checks can be retried; a late result never overwrites a changed service configuration');
 await js('document.querySelector("[data-mdedit]").click();document.querySelector(".md-cap-advanced").open=true;SoduWorkI18n.setLocale("en-US")');
 await wait(200);await scroll();await shot('client-edit-en');
 const untranslated=await js('[...document.querySelectorAll(".md-model-editor *, .md-model-list *, .md-model-help")].filter(el=>(el.getClientRects().length||el.matches("option"))&&!el.closest("[data-user-content]")&&[...el.childNodes].some(n=>n.nodeType===3&&/[\\u4e00-\\u9fff]/.test(n.textContent))).map(el=>el.textContent)');
 assert.deepEqual(untranslated,[]);
 await js('SoduWorkI18n.setLocale("zh-CN")');await wait(120);
 assert.equal(await js('document.querySelector("[data-mdfield=maxOutputTokens]").value'),'32768');
 report.cases.push('Chinese/English switch translates editor and capability results without losing values');
 win.setSize(820,700);await wait(150);await js('document.querySelector("#mdBody").scrollTop=100000');
 assert.ok(await js('document.querySelector("#mdBody").scrollWidth<=document.querySelector("#mdBody").clientWidth+1'));
 const small=await js('[...document.querySelectorAll(".md-model-editor *, .md-model-list *")].filter(el=>el.getClientRects().length&&[...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())&&parseFloat(getComputedStyle(el).fontSize)<12).map(el=>el.className)');
 assert.deepEqual(small,[]);await shot('client-edit-narrow');
 report.cases.push('narrow editor has no horizontal overflow and visible text stays at least 12px');
 assert.deepEqual(await js('errors'),[]);report.ok=true;
}
app.whenReady().then(run).catch(async error=>{report.error=error.stack;if(win){report.diagnostics=await js('({errors,notice,body:document.querySelector(".md-model-editor")?.innerText})');await shot('failure')}})
 .finally(()=>{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));win?.destroy();app.exit(report.ok?0:1)});
