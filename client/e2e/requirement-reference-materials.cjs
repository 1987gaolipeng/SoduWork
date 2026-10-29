'use strict';
// Verify reference-material persistence, completion cards, and view/download actions with real forms and isolated APIs.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 60000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'requirement-materials-'));
  const out = path.resolve(process.argv[2] || path.join(client, '../outputs/requirement-materials-20261016'));
  fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(tmp, 'profile'));
  const report = { ok: false, cases: [], errors: [], realModel: false, businessDatabase: false };
  let win;
  const js = code => win.webContents.executeJavaScript(code, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code) { for (let i = 0; i < 150; i++) { if (await js(code)) return; await delay(20); } throw Error('等待超时：' + code); }
  async function click(selector) {
    await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`); await delay(80);
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();const p={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};if(!e.contains(document.elementFromPoint(p.x,p.y)))throw Error('按钮被遮挡');return p})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
  }
  async function open(reference) {
    await js(`WorkEntrySheet.close();window.tasks=[];window.calls=[];window.rows=[];window.toasts=[];window.uploadFail=false;window.authScope='alice';
      window.selected=PluginUIHost.actions().find(a=>a.id==='work.requirement.create');void 0;`);
    const text = reference ? '把这个缺陷文档转给高示例成员修复' : '修复导出按钮';
    await js(`ChatWorkActions.route({text:${JSON.stringify(text)},mention:{action:()=>selected}}, {conversationContext:workIntent._workConversationContext,
      open:(command,options)=>ChatWorkActions.open(command,options,{mount:()=>document.body,dismissProposal(){},bridge:()=>({})})});void 0;`);
    await until('Boolean(document.querySelector("#cpCreate"))');
  }
  app.whenReady().then(async () => {
    const html = fs.readFileSync(path.join(client, 'desk.html'), 'utf8');
    const styles = [...html.matchAll(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/g)].map(m => fs.readFileSync(path.join(client, m[1]), 'utf8')).join('\n');
    const file = path.join(tmp, 'fixture.html');
    fs.writeFileSync(file, '<!doctype html><meta charset="utf-8"><style>' + styles + '</style><main class="nchat-draft"></main><textarea id="nchatInput"></textarea>');
    win = new BrowserWindow({ show: false, width: 1100, height: 1100, webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_request, cb) => cb({ cancel: true }));
    win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
    await win.loadFile(file);
    await js(`window.calls=[];window.toasts=[];window.tasks=[];window.rows=[];window.authScope='alice';window.uid=()=> 'isolated-task';window.save=()=>{};window.petSay=text=>toasts.push(text);
      window.Store={persistTask:async()=>true};window.Requirements={dateTimestamp:()=>null};
      window.SoduWorkAPI={taskStorageKey:()=>authScope,parseTaskText:async(text,model,attachments)=>{calls.push({kind:'parse',attachments});return{title:'修复工作目标分析导出缺陷',note:'修复报告中的导出错误',kind:'bug',checklist:['导出成功并通过回归']};},
        listTeammates:async()=>({mates:[{id:'fixture-member',name:'示例成员',hasBox:true}]}),createAssignedTask:async body=>{tasks.push({...body,id:body.taskId});return{task:tasks.at(-1),targetName:'示例成员'};},
        uploadAttachment:async(id,file)=>{calls.push({kind:'upload',name:file.name,text:await file.text()});if(uploadFail)throw Error('隔离上传失败');const row={id:'attachment-'+rows.length,filename:file.name,size:file.size,url:'/attachments/fixture?ticket=isolated'};rows.push(row);return row;},
        listAttachments:async()=>{calls.push({kind:'list'});if(window.delayList)await new Promise(r=>window.releaseList=r);return rows;},attachmentUrl:row=>'http://isolated.invalid'+row.url};
      window.soduWorkAPI={previewAttachment:async row=>{calls.push({kind:'preview',id:row.id});return{ok:true};},downloadAttachment:async row=>{calls.push({kind:'download',id:row.id});return{ok:true};}};
      window.sourceCtx={_ref:'conversation-a',_viewEpoch:1,_snap:{messages:[{role:'assistant',blocks:[{kind:'text',text:'已生成 工作目标分析-缺陷报告.md，请核对。'}]}]},
        _api:()=>({outputs:async()=>({ok:true,artifacts:[{artifactId:'report',name:'工作目标分析-缺陷报告.md',at:7}]}),artifactAction:async()=>({ok:true,name:'工作目标分析-缺陷报告.md',at:7,data:btoa(unescape(encodeURIComponent('# 缺陷报告\\n尾项：导出时清楚提示错误')))})})};void 0;`);
    for (const name of ['task-priority', 'task-execution-client', 'plugin-ui-host', 'requirement-routing', 'panels-compose-submit', 'panels-compose-draft', 'conversation-attachments', 'work-entry-sheet', 'panels-chat-work-actions', 'chat-work-intent'])
      await js(fs.readFileSync(path.join(client, 'components/panels', name + '.js'), 'utf8') + '\nvoid 0;');
    await js(fs.readFileSync(path.join(client, 'components/requirements/requirement-fields.js'), 'utf8') + '\nwindow.workIntent=ChatWorkIntent.create(sourceCtx);void 0;');
    await open(false); await click('#cpCreate'); await until('Boolean(document.querySelector(".cp-ok"))');
    assert.equal(await js(`document.querySelector('.wes-attach-zone').hidden`), true);
    report.cases.push('完成卡无附件时隐藏相关材料');
    await open(true);
    assert.equal(await js(`document.querySelectorAll('.wes-attach-tray .catt-item').length`), 1);
    assert.match(await js(`calls.find(c=>c.kind==='parse').attachments[0].text`), /尾项：导出时清楚提示错误/);
    assert.equal(await js(`document.querySelector('#cpNote').value`), '修复报告中的导出错误');
    assert.match(await js(`document.querySelector('#cpSourceNote').value`), /工作目标分析-缺陷报告/);
    report.cases.push('明确引用成果带入原件与解析文本，摘要不被聊天记录覆盖');
    await js('window.uploadFail=true;void 0;'); await click('#cpCreate');
    await until(`document.querySelector('#cpCreate')?.textContent==='重试上传并继续'`);
    assert.equal(await js(`Boolean(document.querySelector('.cp-ok'))`), false);
    assert.match(await js('toasts.at(-1)'), /附件未上传/); report.cases.push('上传失败保留材料并提示重试');
    await js('window.uploadFail=false;void 0;'); await click('#cpCreate'); await until('Boolean(document.querySelector(".cp-ok"))');
    assert.equal(await js(`document.querySelectorAll('[data-wes-material]').length`), 2);
    assert.equal(await js(`document.querySelectorAll('#wesAttachPick,[data-catt-remove]').length`), 0);
    assert.equal(await js('tasks.length'), 1); assert.match(await js('calls.find(c=>c.kind===\'upload\').text'), /尾项：导出时清楚提示错误/);
    report.cases.push('重试复用原任务，完成卡显示已保存附件且没有添加移除入口');
    await click('[data-wes-material="view"]'); await until(`calls.some(c=>c.kind==='preview')`);
    await click('[data-wes-material="download"]'); await until(`calls.some(c=>c.kind==='download')`);
    assert.equal(await js(`calls.filter(c=>c.kind==='list').length`), 2); report.cases.push('查看与下载重新取得鉴权附件列表');
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(out, 'saved-materials.png'), (await win.webContents.capturePage()).toPNG());
    await js(`window.delayList=true;void 0;`); await click('[data-wes-material="download"]');
    await until(`Boolean(window.releaseList)`);
    await js(`window.authScope='bob';releaseList();void 0;`); await delay(60);
    assert.equal(await js(`calls.filter(c=>c.kind==='download').length`), 1); report.cases.push('账号切换后迟到的附件票据不会打开或下载');
    assert.deepEqual(report.errors, []); report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); }).finally(() => {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
    win?.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
