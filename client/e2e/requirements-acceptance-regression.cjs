'use strict';
// Real Chromium interactions with production components and styles, using isolated API fixtures.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env};
  for (const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ELECTRON_NO_ATTACH_CONSOLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron,[__filename,'--force-device-scale-factor=1'],
    {env,windowsHide:true,stdio:'inherit',timeout:150000});
  process.exit(result.status ?? 1);
}
const {app,BrowserWindow} = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), {pathToFileURL} = require('node:url');
const client = path.resolve(__dirname,'..'), output = path.resolve(client,'../outputs/acceptance-20261031/ui');
fs.mkdirSync(output,{recursive:true});
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-acceptance-e2e-')));
app.disableHardwareAcceleration();
const report = {ok:false,checks:[],errors:[],boundary:'Production Electron components and CSS; isolated API fixtures, no installed-client configuration or model calls'};
const wait = ms=>new Promise(resolve=>setTimeout(resolve,ms));
let win;
app.whenReady().then(async()=>{
  try {
    win = new BrowserWindow({show:false,width:1280,height:1000,webPreferences:{contextIsolation:true,sandbox:true,offscreen:true}});
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_r,done)=>done({cancel:true}));
    const js = async source=>{
      const value = await win.webContents.executeJavaScript(`(async()=>{try{return await(0,eval)(${JSON.stringify(source)})}catch(e){return{fixtureError:e.stack}}})()`,true);
      if(value?.fixtureError)throw Error(value.fixtureError);return value;
    };
    const click = async selector=>{
      const point = await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)throw Error('Unavailable control');
        n.scrollIntoView({block:'center',behavior:'instant'});const b=n.getBoundingClientRect();return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`);
      for (const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({type,...point,button:'left',clickCount:1});
      await wait(100);
    };
    const shot = async name=>{
      await wait(100);
      fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());
    };
    await win.loadFile(path.join(__dirname,'fixtures/requirements-board.html'));
    const styles = [...fs.readFileSync(path.join(client,'desk.html'),'utf8').matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)/g)]
      .map(match=>pathToFileURL(path.join(client,match[1])).href);
    await js(`Promise.all(${JSON.stringify(styles)}.map(href=>new Promise((resolve,reject)=>{const n=document.createElement('link');n.rel='stylesheet';n.href=href;n.onload=resolve;n.onerror=reject;document.head.append(n)}))).then(()=>true)`);
    await js(`tasks=[{id:'acceptance',title:'写一篇关于秋天的散文',status:'doing',requirementStage:'reviewing',createdBy:'me',
      canViewExecution:true,canReview:true,canSubmitReview:false,maintenanceBlocked:false,acceptanceCriteria:['格式为 HTML','保留原文并美化样式']}];
      fixtureApprovals=[{id:'review-html',taskId:'acceptance',action:'review',status:'pending',artifactVersionId:'v2'}];
      SoduWorkAPI.listAttachments=async()=>[{id:'old-md',filename:'秋天的散文.md',role:'output',sourceRef:'conversation:original',evidenceMeta:{round:1}},
        {id:'final-html',filename:'秋天的散文.html',role:'output',sourceRef:'conversation:original',evidenceMeta:{round:2}}];
      RequirementsBoard.render(true);RequirementsDetail.open('acceptance')`);
    await wait(150);
    assert.equal(await js(`document.querySelectorAll('[data-tfd-acceptance-mode]').length`),2);
    assert.equal(await js(`!!document.querySelector('[data-tfd-approval-action="approve"]')`),true);
    assert.equal(await js(`document.querySelector('[data-tfd-acceptance-session="auto"]').hidden`),true);
    await js(`document.querySelector('.rq-delivery').scrollIntoView({block:'start',behavior:'instant'});void 0;`);
    await shot('manual-acceptance');
    await click('[data-tfd-acceptance-mode][value="auto"]');
    assert.equal(await js(`document.querySelector('[data-tfd-acceptance-session="auto"]').hidden`),false);
    assert.equal(await js(`document.querySelector('[data-tfd-approval-action="approve"]').hidden`),true);
    await js(`document.querySelector('.rq-delivery').scrollIntoView({block:'start',behavior:'instant'});void 0;`);
    await shot('automatic-acceptance');
    await click('[data-tfd-acceptance-mode][value="manual"]');
    assert.equal(await js(`document.querySelector('[data-tfd-approval-action="approve"]').hidden`),false);
    const files = await js(`(()=>{const n=document.querySelector('[data-rq-material-group="output"]');return n.textContent})()`);
    assert.ok(files.includes('秋天的散文.html')); assert.ok(!files.includes('秋天的散文.md'));
    report.checks.push('Pending review on a doing task exposes manual/automatic modes and correct actions; only revised HTML is current');
    await js(`RequirementsDetail.close();fixtureApprovals=[];Object.assign(tasks[0],{requirementStage:'delivering',canReview:false,canSubmitReview:true});
      RequirementsBoard.render(true);RequirementsDetail.open('acceptance')`);
    await click('.rq-detail-more>summary');
    assert.equal(await js(`document.querySelectorAll('[data-rq-submit-review]').length`),1);
    await click('[data-rq-submit-review]');
    assert.equal(await js(`tasks[0].requirementStage`),'reviewing');
    assert.equal(await js(`fixtureCalls.filter(row=>row[0]==='submit-review').length`),1);
    await js(`RequirementsDetail.close();Object.assign(tasks[0],{status:'todo',requirementStage:'ready',canEditRequirement:true});RequirementsDetail.open('acceptance')`);
    assert.equal(await js(`document.querySelector('.rq-detail-footer').textContent.includes('我来处理')`),false);
    report.checks.push('More menu submits exactly once and moves the task to review; ready details have no incomplete take-over shortcut');
    await js(`RequirementsDetail.close();document.body.innerHTML='<main id="analysis"></main><textarea id="nchatInput"></textarea>';`);
    await js(fs.readFileSync(path.join(client,'components/panels/chat-acceptance-results.js'),'utf8'));
    await js(`window.testContext={esc:String,_sessionOptions:{taskRef:'acceptance'},_snap:{messages:[{role:'user',sentAt:20},{role:'assistant',sentAt:30}]},
      _collaborationTask:{id:'acceptance',status:'doing',canReview:true},_collaborationTrace:{approvals:[{id:'review-html',action:'review',status:'pending',createdAt:10}]},
      _mount:()=>document.body};
      window.paintAnalysis=()=>{document.querySelector('#analysis').innerHTML=acceptanceRenderer.html('【验收分析结果】\\n最终 HTML 已逐项核验。',String(testContext._snap.messages.length-1)+':0')};
      window.acceptanceRenderer=ChatAcceptanceResults.create(testContext,{rich:String,render:paintAnalysis,invalidate:paintAnalysis});
      paintAnalysis();acceptanceRenderer.bind(document.querySelector('#analysis'));`);
    await js(`document.querySelector('[data-acceptance-result-analysis]').value='补充检查排版';void 0;`);
    await click('[data-acceptance-result-action="analyze"]');
    assert.equal(await js(`document.querySelector('.nacceptance-result').tagName`),'SECTION');
    assert.equal(await js(`document.querySelectorAll('details.nacceptance-result').length`),0);
    assert.equal(await js(`document.querySelectorAll('[data-acceptance-result-action]').length`),0);
    assert.ok((await js(`document.querySelector('#nchatInput').value`)).includes('补充检查排版'));
    report.checks.push('Analysis action leaves an expanded read-only result while preserving a follow-up draft');
    await js(`testContext._snap.messages.push({role:'user',sentAt:50},{role:'assistant',sentAt:60});
      window.decisions=[];SoduWorkAPI.decideApproval=async(...args)=>{decisions.push(args);return{ok:true}};
      testContext._loadCollabTask=async()=>{testContext._collaborationTrace.approvals[0].status='rejected'};
      paintAnalysis();document.querySelector('[data-acceptance-result-note]').value='请保留原文并调整排版';void 0;`);
    await click('[data-acceptance-result-action="reject"]');
    assert.deepEqual(await js(`decisions.map(row=>row.slice(0,3))`),[['review-html','reject','请保留原文并调整排版']]);
    assert.equal(await js(`document.querySelector('.nacceptance-result').tagName`),'SECTION');
    assert.equal(await js(`document.querySelectorAll('details.nacceptance-result').length`),0);
    assert.equal(await js(`document.querySelectorAll('[data-acceptance-result-action]').length`),0);
    report.checks.push('Rejecting the current analysis submits the correct approval and replaces obsolete controls with its result');
    await js(`document.body.innerHTML='<div class="nchat"><div class="nmd"><div class="noutput-library"><div class="noutput-library-row"><span class="noutput-library-file-icon"><span class="library-native-file-icon"><img alt="HTML" src="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2718%27 height=%2718%27%3E%3Crect width=%2718%27 height=%2718%27 fill=%27purple%27/%3E%3C/svg%3E"></span></span><button class="noutput-library-name">秋天的散文.html</button></div></div></div></div>';`);
    const align = await js(`(()=>{const r=s=>document.querySelector(s).getBoundingClientRect(),i=r('.noutput-library-file-icon img'),n=r('.noutput-library-name');return Math.abs((i.top+i.height/2)-(n.top+n.height/2))})()`);
    assert.ok(align<=1,'File icon and name must share their vertical center: '+align);
    report.checks.push('Native file icon and title align under the complete desktop stylesheet stack');
    assert.deepEqual(await js('fixtureErrors'),[]);
    report.ok=true;
  } catch(error) {
    report.error=String(error.stack||error);
    if(win)fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());
  } finally {
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));app.exit(report.ok?0:1);
  }
});
