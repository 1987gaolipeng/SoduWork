import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';
import {CdpPage,listPages,delay} from './lib/cdp.mjs';
const out=path.resolve(process.argv[2]||'task-picker-evidence');fs.mkdirSync(out,{recursive:true});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-task-picker-'));
let chrome,page;const checks=[];
const check=(name,ok)=>{checks.push({name,ok:Boolean(ok)});if(!ok)throw Error(name)};
async function click(selector){const point=await page.run(s=>{const n=document.querySelector(s);if(!n||n.disabled||n.hidden)throw Error('unavailable '+s);n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}},selector);for(const type of ['mouseMoved','mousePressed','mouseReleased'])await page.call('Input.dispatchMouseEvent',{type,...point,button:type==='mouseMoved'?'none':'left',clickCount:type==='mouseMoved'?0:1})}
async function open(){await click('#add');await page.waitFor(()=>document.querySelector('.ncollab-picker')&&!ctx._collabPicker.loading)}
async function type(text){await click('[data-collab-search]');await page.call('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2,commands:['selectAll']});await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:2});await page.call('Input.insertText',{text})}
async function shot(name){await delay(180);const r=await page.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'))}
try{
 chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,'--window-size=1200,920','about:blank'],{windowsHide:true,stdio:'ignore'});
 let port;for(let i=0;i<100;i++){try{port=Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);if(port)break}catch{}await delay(100)}
 page=await CdpPage.connect((await listPages(port))[0]);await page.call('Page.navigate',{url:new URL('../tests/task-picker.html',import.meta.url).href});await page.waitFor(()=>window.ready);
 const before=await page.run(()=>{const r=document.querySelector('#nchatInput').getBoundingClientRect();return{x:r.x,width:r.width}});
 await open();
 check('仅显示待办，排除执行中、完成、已排队',await page.run(()=>document.querySelectorAll('.ncollab-picker-row').length===5&&!document.querySelector('[data-collab-task-select="running"]')));
 check('打开时搜索自动获得焦点，未选择不能提交',await page.run(()=>document.activeElement.matches('[data-collab-search]')&&document.querySelector('[data-collab-picker-submit]').disabled));
 check('非模态选择面板不改变对话宽度',await page.run(b=>{const r=document.querySelector('#nchatInput').getBoundingClientRect();return r.x===b.x&&r.width===b.width&&document.querySelector('.ncollab-picker').getAttribute('aria-modal')==='false'},before));
 await click('[data-collab-task-select="design"]');check('选择只预览确认，不直接派活',await page.run(()=>sent.length===0&&!document.querySelector('[data-collab-picker-submit]').disabled&&document.querySelector('[data-collab-task-select="design"]').getAttribute('aria-checked')==='true'));
 await shot('pending-selected');

 async function themeMatches(){
  return page.run(()=>{
   const style=(selector)=>getComputedStyle(document.querySelector(selector));
   const probe=document.createElement('span');document.body.appendChild(probe);
   const token=(name,property='color')=>{probe.style[property]='var('+name+')';return getComputedStyle(probe)[property]};
   const result={
    accent:style('.ncollab-picker-mark').color===token('--accent'),
    button:style('.ncollab-picker-submit').backgroundColor===token('--accent'),
    checked:style('[aria-checked="true"] .ncollab-picker-radio').backgroundColor===token('--accent'),
    soft:style('[aria-checked="true"]').backgroundColor===token('--accent-soft','backgroundColor'),
    paper:style('.ncollab-picker').backgroundColor===token('--bg-0'),
    ink:style('.ncollab-picker-head h2').color===token('--ink'),
    muted:style('.ncollab-picker-copy small').color===token('--ink-3'),
    fonts:style('.ncollab-picker-copy b').fontFamily===token('--font-ui','fontFamily')&&style('.ncollab-picker-head h2').fontFamily===token('--font-display','fontFamily'),
   };
   probe.remove();return result;
  });
 }
 for(const theme of ['ruby','azure','minimal','steady','warm']){
  await page.run(theme=>document.documentElement.dataset.theme=theme,theme);await delay(160);
  const match=await themeMatches();
  check(theme+' 主题同步文字、图标、选中、按钮和背景'+(Object.values(match).every(Boolean)?'':' '+JSON.stringify(match)),Object.values(match).every(Boolean));
  await shot('theme-'+theme);
 }
 await page.run(()=>document.documentElement.dataset.theme='ruby');await click('[data-collab-search]');await delay(150);
 check('搜索焦点跟随主题而非固定蓝框',await page.run(()=>{const n=document.createElement('i');n.style.color='var(--accent)';document.body.appendChild(n);const expected=getComputedStyle(n).color;n.remove();return getComputedStyle(document.querySelector('.ncollab-picker-search')).borderTopColor===expected}));
 await click('[data-collab-task-select="design"]');
 const hover=await page.run(()=>{const r=document.querySelector('[data-collab-picker-submit]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}});
 await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',...hover,button:'none'});await delay(160);
 check('主按钮悬停色随主题变化',await page.run(()=>{const n=document.createElement('i');n.style.color='var(--accent-hover)';document.body.appendChild(n);const expected=getComputedStyle(n).color;n.remove();return getComputedStyle(document.querySelector('[data-collab-picker-submit]')).backgroundColor===expected}));
 const compact=[18,14,14,13];
 await page.run(()=>{window.retainedRow=document.querySelector('[aria-checked="true"]')});
 for(const [name,scale] of [['small',.88],['large',1.15]]){
  await page.run(scale=>document.documentElement.style.setProperty('--font-scale',scale),scale);
  const sizes=await page.run(()=>['.ncollab-picker-head h2','.ncollab-picker-copy b','[data-collab-search]','[data-collab-picker-submit]'].map(s=>parseFloat(getComputedStyle(document.querySelector(s)).fontSize)));
  check(name+' picker 保持紧凑字号且不随全局缩放放大 '+JSON.stringify({compact,sizes}),sizes.every((n,i)=>Math.abs(n-compact[i])<.03));
  check(name+' 字号没有低于12px的文字或横向溢出',await page.run(()=>{const p=document.querySelector('.ncollab-picker');return p.scrollWidth<=p.clientWidth&&[...p.querySelectorAll('*')].filter(n=>n.textContent.trim()&&n.getClientRects().length).every(n=>parseFloat(getComputedStyle(n).fontSize)>=12)}));
  await shot('font-'+name);
 }
 await page.run(()=>{
  document.documentElement.style.setProperty('--font-ui','Arial, sans-serif');
  document.documentElement.style.setProperty('--font-display','Georgia, serif');
 });
 check('修改全局字体后标题与正文分别跟随对应字体',await page.run(()=>getComputedStyle(document.querySelector('.ncollab-picker-head h2')).fontFamily.includes('Georgia')&&['.ncollab-picker-copy b','[data-collab-search]','[data-collab-picker-submit]'].every(s=>getComputedStyle(document.querySelector(s)).fontFamily.includes('Arial'))));
 await page.run(()=>{document.documentElement.style.removeProperty('--font-ui');document.documentElement.style.removeProperty('--font-display');document.documentElement.style.removeProperty('--font-scale')});
 check('切换主题和字号不重建选择、不丢失任务',await page.run(()=>retainedRow===document.querySelector('[aria-checked="true"]')&&document.querySelector('[aria-checked="true"]').getAttribute('data-collab-task-select')==='design'&&sent.length===0));

 check('全部可见文字至少12px',await page.run(()=>Array.from(document.querySelectorAll('.ncollab-picker *')).filter(n=>n.textContent.trim()&&n.getClientRects().length).every(n=>parseFloat(getComputedStyle(n).fontSize)>=12)));
 const pickerRect=await page.run(()=>document.querySelector('.ncollab-picker').getBoundingClientRect().top);
 await type('经营');check('搜索按任务名称筛选，隐藏选择不再可提交',await page.run(()=>document.querySelectorAll('.ncollab-picker-row:not([hidden])').length===1&&document.querySelector('[data-collab-picker-submit]').disabled));
 await type('示例社区');check('支持工程名称搜索',await page.run(()=>document.querySelectorAll('.ncollab-picker-row:not([hidden])').length===2));
 check('搜索时面板与搜索框位置不跳动',await page.run(top=>document.querySelector('.ncollab-picker').getBoundingClientRect().top===top,pickerRect));
 await type('完全不存在');check('搜索无结果提示',await page.run(()=>!document.querySelector('[data-collab-no-match]').hidden));await shot('search-empty');
 await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});
 check('Escape关闭并将焦点归还添加任务',await page.run(()=>!document.querySelector('.ncollab-picker')&&document.activeElement.id==='add'));
 await open();await click('[data-collab-task-select="design"]');
 await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown'});
 check('键盘方向键选择下一项',await page.run(()=>document.activeElement.getAttribute('data-collab-task-select')==='interview'&&document.activeElement.getAttribute('aria-checked')==='true'));
 await click('[data-collab-picker-close]');check('关闭按钮正常',await page.run(()=>!document.querySelector('.ncollab-picker')));
 await open();await click('[data-collab-task-select="design"]');
 await page.run(()=>tasks.find(t=>t.id==='design').status='doing');
 await click('[data-collab-picker-submit]');await page.waitFor(()=>document.querySelector('.ncollab-picker-error'));
 check('打开后任务变执行中，确认时拦截且不发送',await page.run(()=>sent.length===0&&bindings.length===0&&!document.querySelector('[data-collab-task-select="design"]')));
 await shot('status-changed');
 await page.run(()=>resetFixture());await open();await click('[data-collab-task-select="design"]');
 await page.run(()=>{delayDetail=350;tasks.find(t=>t.id==='design').note='最新完整说明与截图'});
 await click('[data-collab-picker-submit]');check('提交中禁用按钮避免重复发送',await page.run(()=>document.querySelector('[data-collab-picker-submit]').disabled));
 await page.waitFor(()=>sent.length===1);check('当前会话加入一次，保留最新正文与附件引用',await page.run(()=>ctx._sessionId==='chat-a'&&sent[0].text==='最新完整说明与截图'&&ctx._collabTasks.get('design').task.attachments[0].id==='screenshot'));
 await open();check('已经加入的任务不会再次列出',await page.run(()=>!document.querySelector('[data-collab-task-select="design"]')));
 await click('[data-collab-task-select="interview"]');await click('[data-collab-picker-submit]');await page.waitFor(()=>sent.length===2);
 check('第二项沿用同一会话和原任务发送入口',await page.run(()=>sent[1].options.taskId==='interview'&&ctx._collabTasks.get('interview').queueState==='queued'&&ctx._sessionId==='chat-a'));
 await page.run(()=>{resetFixture();offline=true});await open();check('断网显示重试，不伪装空列表',await page.run(()=>Boolean(document.querySelector('[data-collab-picker-retry]'))));await shot('offline');
 await page.run(()=>offline=false);await click('[data-collab-picker-retry]');await page.waitFor(()=>document.querySelectorAll('.ncollab-picker-row').length===5);check('重试恢复待办列表',true);
 await page.run(()=>{resetFixture();tasks=tasks.filter(t=>t.status!=='todo')});await open();check('无待办明确空态',await page.run(()=>document.querySelector('.ncollab-picker').textContent.includes('暂无可添加的待办')));check('无待办空态隐藏无用筛选',await page.run(()=>!document.querySelector('[data-collab-project-scope]')));await shot('no-pending');
 await page.run(()=>{resetFixture();tasks=Array.from({length:45},(_,i)=>({id:'many-'+i,title:'后续待办 '+i,status:'todo'}))});await open();await type('后续待办 44');
 check('超过20条的任务也能搜索到',await page.run(()=>document.querySelectorAll('.ncollab-picker-row:not([hidden])').length===1&&document.querySelector('.ncollab-picker-row:not([hidden])').textContent.includes('44')));
 await page.run(()=>resetFixture());await open();await click('[data-collab-task-select="design"]');await page.run(()=>failDetail=true);await click('[data-collab-picker-submit]');await page.waitFor(()=>document.querySelector('.ncollab-picker-error'));
 check('复核失败保留选择，允许重试',await page.run(()=>!document.querySelector('[data-collab-picker-submit]').disabled&&document.querySelector('[aria-checked="true"]').getAttribute('data-collab-task-select')==='design'));
 await page.run(()=>resetFixture());await open();await click('[data-collab-task-select="design"]');await page.run(()=>delayDetail=400);await click('[data-collab-picker-submit]');await click('[data-collab-picker-close]');await delay(550);
 check('复核时关闭不会晚到派活',await page.run(()=>sent.length===0&&ctx._collabTasks.size===0));
 await page.run(()=>resetFixture());await page.call('Emulation.setDeviceMetricsOverride',{width:600,height:700,deviceScaleFactor:1,mobile:false});await open();await click('[data-collab-task-select="long"]');
 check('窄窗口和长标题没有横向溢出',await page.run(()=>{const n=document.querySelector('.ncollab-picker'),r=n.getBoundingClientRect();return n.scrollWidth<=n.clientWidth&&r.left>=0&&r.right<=innerWidth&&r.top>=0}));
 await shot('narrow-long-title');
 await page.run(()=>document.documentElement.style.setProperty('--font-scale',1.15));
 check('窄窗口大字号仍可看到关闭和确认按钮',await page.run(()=>['[data-collab-picker-close]','[data-collab-picker-submit]'].every(s=>{const r=document.querySelector(s).getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth})));
 await shot('narrow-large-font');await page.run(()=>document.documentElement.style.removeProperty('--font-scale'));

 await click('#nchatInput');check('点击面板外可以继续对话',await page.run(()=>!document.querySelector('.ncollab-picker')&&document.activeElement.id==='nchatInput'));await page.call('Input.insertText',{text:'普通对话草稿保持可编辑'});check('普通对话输入不受影响',await page.run(()=>document.querySelector('#nchatInput').value==='普通对话草稿保持可编辑'));
 check('页面无脚本异常',page.takeRuntimeErrors().length===0);
}catch(error){checks.push({name:String(error.stack||error),ok:false});process.exitCode=1;if(page)await shot('failure').catch(()=>{})}
finally{fs.writeFileSync(path.join(out,'page-results.json'),JSON.stringify(checks,null,2));console.log(JSON.stringify(checks,null,2));if(page){await page.call('Browser.close').catch(()=>{});page.close()}else chrome?.kill()}
