// Live local desktop: preserve the connected WeCom account and disconnect only an unauthenticated DingTalk entry.
import {listPages,CdpPage} from './lib/cdp.mjs';
import fs from 'node:fs';
if(process.env.SODUWORK_CONNECTOR_LIVE!=='1')throw Error('Set SODUWORK_CONNECTOR_LIVE=1 for local logged-in desktop verification');
const page=await CdpPage.connect((await listPages(Number(process.env.SODUWORK_CDP_PORT||63816))).find(p=>/desk\.html/.test(p.url)));
const report={ok:false,cases:[],businessCalls:false};
async function click(selector){
 const point=await page.run(selector=>{const node=document.querySelector(selector);if(!node||node.hidden||node.disabled)throw Error('Unavailable target: '+selector);node.scrollIntoView({block:'center'});const b=node.getBoundingClientRect();const x=b.x+b.width/2,y=b.y+b.height/2;if(!node.contains(document.elementFromPoint(x,y)))throw Error('Covered target: '+selector);return{x,y};},selector);
 for(const type of ['mousePressed','mouseReleased'])await page.call('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});
}
try{
 if(await page.evaluate('new URL(SoduWorkAPI.hubBase()).origin')!=='http://127.0.0.1:9080')throw Error('Local Hub required');
 const account=await page.run(()=>soduWorkAPI.platformConnections.refresh('wecom'));
 if(!account.connected)throw Error('Expected the existing connected WeCom account');
 await click('button[title="主页"]');await click('button[title="插件"]');
 await page.waitFor(()=>!!document.querySelector('[data-cap-tab="connections"]'));await click('[data-cap-tab="connections"]');
 await page.waitFor(()=>!!document.querySelector('[data-platform-manage="wecom"]'));page.takeRuntimeErrors();
 await click('[data-platform-manage="wecom"]');await page.waitFor(()=>document.querySelector('#capPlatformState')?.dataset.state==='connected');
 await click('#capPlatformDisconnect');
 if(!await page.evaluate("!document.querySelector('#capPlatformDisconnectConfirm').hidden && document.querySelector('#capPlatformStart').disabled"))throw Error('Confirmation missing');
 fs.mkdirSync('../outputs/connector-lifecycle-20261016',{recursive:true});
 const shot=await page.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync('../outputs/connector-lifecycle-20261016/confirm.png',Buffer.from(shot.data,'base64'));
 await click('#capPlatformKeep');await click('#capPlatformClose');
 if(!(await page.run(()=>soduWorkAPI.platformConnections.refresh('wecom'))).connected)throw Error('Cancellation changed the existing account');
 report.cases.push('真实鼠标确认后取消，企业微信原有授权保留');
 const before=await page.run(()=>soduWorkAPI.platformConnections.refresh('dingtalk'));
 if(before.connected||!before.installed||!['needs_auth','disconnected'].includes(before.state))throw Error('DingTalk must be installed and unauthenticated; no connected account may be removed by this smoke');
 await click('[data-platform-manage="dingtalk"]');await page.waitFor(()=>!document.querySelector('#capPlatformCheck')?.disabled);
 if(before.state!=='disconnected'){
  await click('#capPlatformDisconnect');await click('#capPlatformDisconnectApply');
  await page.waitFor(()=>document.querySelector('#capPlatformState')?.dataset.state==='disconnected');
  report.cases.push('未授权钉钉通过真实确认按钮调用主进程完成本机断开');
 }
 const after=await page.run(()=>soduWorkAPI.platformConnections.refresh('dingtalk'));
 if(!after.disconnected||after.connected||after.state!=='disconnected')throw Error('Refresh revived a disconnected account');
 if(await page.evaluate("document.querySelector('#capPlatformStart').textContent")!=='重新连接')throw Error('Reconnect action missing');
 await click('#capPlatformClose');await click('[data-platform-manage="dingtalk"]');
 await page.waitFor(()=>document.querySelector('#capPlatformState')?.dataset.state==='disconnected');
 report.cases.push('重新检查与打开弹框保持已断开，并提供重新连接入口');
 report.errors=page.takeRuntimeErrors();if(report.errors.length)throw Error('Renderer errors');report.ok=true;
}finally{
 fs.mkdirSync('../outputs/connector-lifecycle-20261016',{recursive:true});fs.writeFileSync('../outputs/connector-lifecycle-20261016/live-desktop.json',JSON.stringify(report,null,2));
 try{if(await page.evaluate("!!document.querySelector('#capPlatformClose')"))await click('#capPlatformClose');}catch(_){}
 page.close();console.log(JSON.stringify(report));
}
