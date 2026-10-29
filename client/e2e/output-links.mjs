import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';
import {CdpPage,listPages,delay} from './lib/cdp.mjs';
const out=path.resolve(process.argv[2]||'output-links-evidence');fs.mkdirSync(out,{recursive:true});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-output-links-'));
const child=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,'--window-size=1440,1100','about:blank'],{windowsHide:true,stdio:'ignore'});
let page;
try{
 let port;for(let i=0;i<80;i++){try{port=Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);if(port)break}catch{}await delay(100)}
 page=await CdpPage.connect((await listPages(port))[0]);
 await page.call('Page.navigate',{url:new URL('../tests/output-links.html',import.meta.url).href});
 await page.waitFor(()=>window.fixtureReady,null,18000);
 const result=await page.run(()=>window.fixtureChecks);
 const point=await page.run(()=>{const b=document.querySelector('#nchatList .noutput-inline');const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}});
 for(const type of ['mouseMoved','mousePressed','mouseReleased'])await page.call('Input.dispatchMouseEvent',{type,...point,button:type==='mouseMoved'?'none':'left',clickCount:type==='mouseMoved'?0:1});
 await delay(60);
 const clicked=await page.run(()=>typeof opens.at(-1)==='string'&&opens.at(-1).includes('/attachments/task-file?'));
 result.lines.push((clicked?'PASS ':'FAIL ')+'真实鼠标点击打开对应任务成果');clicked?result.passed++:result.failed++;
 result.runtimeErrors=page.takeRuntimeErrors();
 const shot=await page.call('Page.captureScreenshot',{format:'png'});
 fs.writeFileSync(path.join(out,'task-output-links.png'),Buffer.from(shot.data,'base64'));
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify(result,null,2));if(result.failed||result.runtimeErrors.length)process.exitCode=1;
}finally{if(page){await page.call('Browser.close').catch(()=>{});page.close()}else child.kill();}
