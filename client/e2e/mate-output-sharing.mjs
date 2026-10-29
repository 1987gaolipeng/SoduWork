import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import net from 'node:net';import {spawn} from 'node:child_process';
import {CdpPage,listPages,delay} from './lib/cdp.mjs';
const out=path.resolve(process.argv[2]||'mate-output-evidence');fs.mkdirSync(out,{recursive:true});
const root=path.resolve(decodeURIComponent(new URL('../../',import.meta.url).pathname).replace(/^\/([A-Za-z]:)/,'$1'));
const serverPort=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});
const backend=spawn(path.join(root,'hub-backend/.venv/Scripts/python.exe'),['e2e_mate_messages.py',String(serverPort)],{cwd:path.join(root,'hub-backend'),windowsHide:true,stdio:['ignore','pipe','pipe']});
let log='';backend.stdout.on('data',x=>log+=x);backend.stderr.on('data',x=>log+=x);
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-mate-output-'));
let chrome,page;const checks=[];
const check=(name,ok)=>{checks.push({name,ok:Boolean(ok)});if(!ok)throw Error(name)};
async function click(selector){const p=await page.run(s=>{const n=document.querySelector(s);if(!n||n.disabled||n.hidden)throw Error('unavailable '+s);const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}},selector);for(const type of ['mouseMoved','mousePressed','mouseReleased'])await page.call('Input.dispatchMouseEvent',{type,...p,button:type==='mouseMoved'?'none':'left',clickCount:type==='mouseMoved'?0:1})}
async function choose(){await page.run(()=>{input.value='@林';input.selectionStart=input.selectionEnd=input.value.length;input.dispatchEvent(new Event('input',{bubbles:true}))});await page.waitFor(()=>document.querySelector('.nmate-menu .nplugin-option'),null,5000);await click('.nmate-menu .nplugin-option');await page.waitFor(()=>!document.querySelector('.nmate-card-send').disabled,null,5000)}
try{
 for(let i=0;i<150;i++){try{if((await fetch('http://127.0.0.1:'+serverPort+'/test/health')).ok)break}catch{}if(backend.exitCode!==null)throw Error(log);await delay(100)}
 chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--disable-extensions','--no-sandbox','--no-first-run','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,'--window-size=1360,900','about:blank'],{windowsHide:true,stdio:'ignore'});
 let port;for(let i=0;i<80;i++){try{port=Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);if(port)break}catch{}await delay(100)}
 page=await CdpPage.connect((await listPages(port))[0]);
 const url='file:///'+path.join(root,'client/tests/mate-messages.html').replaceAll('\\','/')+'?backend='+encodeURIComponent('http://127.0.0.1:'+serverPort);
 await page.call('Page.navigate',{url});await page.waitFor(()=>window.ready,null,12000);
 await choose();check('默认带上本地成果和当前任务成果',await page.run(()=>document.querySelectorAll('.nmate-results input:checked').length===3));
 await click('.nmate-results label:nth-of-type(2) input');check('可以移除不想发送的成果',await page.run(()=>document.querySelectorAll('.nmate-results input:checked').length===2));
 await click('.nmate-card-send');await page.waitFor(()=>document.querySelector('.nmate-card').hidden,null,12000);
 await page.run(()=>refreshNotices());check('真实后台通知携带两份文件',await page.run(()=>document.querySelectorAll('.np-file').length===2));
 await click('.np-file');await page.waitFor(()=>opened.length===1);
 check('通知中可直接打开附件并获得真实文件字节',await page.run(()=>JSON.stringify(opened[0].bytes)==='[0,1,255,128,13,10]'));
 check('通知正文保留小结开头和段落',await page.run(()=>document.querySelector('.np-txt').textContent.includes('您好，以下是我当前的工作进展：')));
 await click('.np-file-download');await page.waitFor(()=>downloaded.length===1);
 check('接收端点击下载，二进制完整一致',await page.run(()=>JSON.stringify(downloaded[0].bytes)==='[0,1,255,128,13,10]'));
 await click('.np-attachment:nth-child(2) .np-file-download');await page.waitFor(()=>downloaded.length===2);
 check('任务成果经权限校验复制后可下载',await page.run(()=>new TextDecoder().decode(new Uint8Array(downloaded[1].bytes))==='# verified task result'));
 check('原始本机路径和文件内容不进入通知',await page.run(()=>notices.every(n=>n.attachments.every(f=>!f.data&&!f.path&&!f.url))));
 const event=await page.run(()=>notices[0]);
 const forbidden=await fetch('http://127.0.0.1:'+serverPort+'/api/v1/team/message-files/'+event.attachments[0].id,{headers:{'X-Test-User':'other'}});
 check('其他同事不能读取分享文件',forbidden.status===404);
 await choose();await page.run(()=>currentRef='chat-b');await click('.nmate-card-send');
 check('切换会话后阻止错发',await page.run(()=>document.querySelector('#status').textContent.includes('会话已切换')&&capture.length===1));
 await click('.nmate-card-close');await page.run(()=>{currentRef='chat-a';failSend=true});await choose();await click('.nmate-card-send');await page.waitFor(()=>!document.querySelector('.nmate-card-send').disabled);
 check('发送失败保留草稿和成果选择',await page.run(()=>!document.querySelector('.nmate-card').hidden&&document.querySelector('.nmate-card-text').value.includes('发布材料')&&document.querySelectorAll('.nmate-results input:checked').length===3));
 await page.run(()=>failSend=false);await click('.nmate-card-send');await page.waitFor(()=>document.querySelector('.nmate-card').hidden);
 await page.run(()=>outputMode='truncated');await choose();
 check('truncated results show selectable warning',await page.run(()=>document.querySelector('.nmate-results-warning')?.textContent.includes('60')));
 check('truncated results default to twenty selections',await page.run(()=>document.querySelectorAll('.nmate-results input').length===65&&document.querySelectorAll('.nmate-results input:checked').length===20));
 await page.run(()=>document.querySelectorAll('.nmate-results input')[0].click());
 await page.waitFor(()=>document.querySelectorAll('.nmate-results input:checked').length===19,null,3000);
 await page.run(()=>document.querySelectorAll('.nmate-results input')[24].click());
 check('long result selection stays at twenty',await page.run(()=>document.querySelectorAll('.nmate-results input:checked').length===20));
 await click('.nmate-card-send');await page.waitFor(()=>document.querySelector('.nmate-card').hidden,null,12000);
 check('long result sends selected output count',await page.run(()=>capture[capture.length-1]?.outputs?.files?.length===20));
 await page.run(()=>outputMode='none');await choose();check('无成果保留纯文字发送',await page.run(()=>document.querySelector('.nmate-results').textContent.includes('仅发送留言')));await click('.nmate-card-send');await page.waitFor(()=>document.querySelector('.nmate-card').hidden);
 await page.run(()=>{outputMode='normal';failIndex=true;input.value='@林';input.selectionStart=input.selectionEnd=input.value.length;input.dispatchEvent(new Event('input',{bubbles:true}))});await page.waitFor(()=>document.querySelector('.nmate-menu .nplugin-option'));await click('.nmate-menu .nplugin-option');await page.waitFor(()=>document.querySelector('.nmate-results button'));
 check('成果读取失败时禁止漏文件发送',await page.run(()=>document.querySelector('.nmate-card-send').disabled));
 await page.run(()=>failIndex=false);await click('.nmate-results button');await page.waitFor(()=>!document.querySelector('.nmate-card-send').disabled);
 check('成果读取可重试恢复',await page.run(()=>document.querySelectorAll('.nmate-results input:checked').length===3));
 await click('.nmate-card-close');

 await choose();check('默认小结使用礼貌开头并保留未验证状态',await page.run(()=>document.querySelector('.nmate-card-text').value.startsWith('您好，以下是我当前的工作进展：')&&document.querySelector('.nmate-card-text').value.includes('尚未验证')));
 await click('.nmate-card-close');
 await page.run(()=>delayDraft=450);
 await page.run(()=>{input.value='@林';input.selectionStart=input.selectionEnd=input.value.length;input.dispatchEvent(new Event('input',{bubbles:true}))});await page.waitFor(()=>document.querySelector('.nmate-menu .nplugin-option'));await click('.nmate-menu .nplugin-option');
 await page.waitFor(()=>document.querySelector('.nmate-summary-status').textContent.includes('正在整理'));
 await click('.nmate-card-tools button:last-child');
 await page.run(()=>{const n=document.querySelector('.nmate-card-text');n.value='您好，这是我手动确认的工作进展。';n.dispatchEvent(new Event('input',{bubbles:true}))});
 await delay(650);
 check('晚到的摘要不会覆盖手动内容',await page.run(()=>document.querySelector('.nmate-card-text').value==='您好，这是我手动确认的工作进展。'));
 await click('.nmate-card-close');await page.run(()=>{delayDraft=0;failDraft=true});
 await page.run(()=>{input.value='@林';input.selectionStart=input.selectionEnd=input.value.length;input.dispatchEvent(new Event('input',{bubbles:true}))});await page.waitFor(()=>document.querySelector('.nmate-menu .nplugin-option'));await click('.nmate-menu .nplugin-option');await page.waitFor(()=>document.querySelector('.nmate-summary-status').textContent.includes('暂时无法总结'));
 check('摘要失败明确提示而不是转发技术原文',await page.run(()=>!document.querySelector('.nmate-card-text').value&&document.querySelector('.nmate-card-tools button:first-child').textContent==='重新总结'));
 await page.run(()=>failDraft=false);await click('.nmate-card-tools button:first-child');await page.waitFor(()=>document.querySelector('.nmate-card-text').value.startsWith('您好'));
 check('摘要失败后可以重新总结',true);

 check('成果文字字号不低于12px',await page.run(()=>Array.from(document.querySelectorAll('.nmate-results b,.nmate-results label span,.nmate-results small,.np-file span,.np-file small')).every(n=>parseFloat(getComputedStyle(n).fontSize)>=12)));
 check('小结正文14px样式实际生效',await page.run(()=>parseFloat(getComputedStyle(document.querySelector('.nmate-card-text')).fontSize)===14));
 check('发送卡完整位于视口内',await page.run(()=>{const r=document.querySelector('.nmate-card').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight}));
 check('发送卡没有水平溢出',await page.run(()=>{const c=document.querySelector('.nmate-card');return c.scrollWidth<=c.clientWidth}));
 const shot=await page.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'mate-send-receive.png'),Buffer.from(shot.data,'base64'));
 await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
 check('Escape关闭发送卡并恢复输入框焦点',await page.run(()=>document.querySelector('.nmate-card').hidden&&document.activeElement===input));
 check('页面无运行错误',page.takeRuntimeErrors().length===0);
}catch(error){checks.push({name:String(error.stack||error),ok:false});process.exitCode=1}
finally{
 fs.writeFileSync(path.join(out,'page-results.json'),JSON.stringify(checks,null,2));fs.writeFileSync(path.join(out,'backend.log'),log);
 console.log(JSON.stringify(checks,null,2));
 if(page){await page.call('Browser.close').catch(()=>{});page.close()}else chrome?.kill();backend.kill();
}
