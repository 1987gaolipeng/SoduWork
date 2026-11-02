'use strict';
// Real work-entry form, serialized receipts, workspace router and requirement detail.
// Hub and task persistence use controlled fixtures; all network is blocked.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 90000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-navigation-'));
  const output = path.resolve(process.argv[2] || path.join(client, '../outputs/receipt-navigation-20261022'));
  fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(temporary, 'profile'));
  const report = { ok: false, isolated: true, realModel: false, businessDatabase: false, cases: [], errors: [] };
  let win;
  const js = code => win.webContents.executeJavaScript(code, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code) {
    for (let i = 0; i < 200; i++) { if (await js(code)) return; await delay(25); }
    throw Error('Timed out: ' + code);
  }
  async function click(selector) {
    await until(`(() => {const n=document.querySelector(${JSON.stringify(selector)});if(!n)return false;
      n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return r.width>0&&r.height>0&&
      n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`);
    await delay(180);
    const point = await js(`(() => {const n=document.querySelector(${JSON.stringify(selector)}),r=n.getBoundingClientRect();
      const p={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
      if(!n.contains(document.elementFromPoint(p.x,p.y)))throw Error('Covered control');return p;})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
  }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1200, height: 1050,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: true, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_request, done) => done({ cancel: true }));
    win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
    await win.loadFile(path.join(__dirname, 'fixtures/requirement-sheet-receipt.html'));
    await js(`window.__deskPanel='workspace';window.__deskArgs={view:'create'};window.initData=async()=>{};
      document.getElementById('historyBoard').innerHTML='<h2>需求池</h2>';
      const chat=document.createElement('section');chat.id='composePanel';chat.innerHTML='<h2>对话</h2><div id="fixtureChat"></div>';document.body.append(chat);
      window.openComposePanel=()=>{const panel=document.getElementById('composePanel');panel.hidden=false;panel.style.display='block';document.getElementById('historyBoard').hidden=true;};
      window.closeComposePanel=()=>{const panel=document.getElementById('composePanel');panel.hidden=true;panel.style.display='none';};
      window.openTaskCenter=()=>{document.getElementById('historyBoard').hidden=false;};
      window.closeHistoryBoard=()=>{document.getElementById('historyBoard').hidden=true;};
      window.fixtureFailures=[];addEventListener('error',event=>fixtureFailures.push(event.message));
      addEventListener('unhandledrejection',event=>fixtureFailures.push(String(event.reason)));
      window.fixtureSetup=async (mode)=>{
        RequirementsDetail.close();WorkEntrySheet.close(false,true);WorkspaceHost.open('create',{});
        Object.keys(calls).forEach(k=>calls[k]=[]);calls.bound=[];tasks.length=0;serverTasks.clear();
        const inline=mode.startsWith('inline')||mode==='restored';
        const handedOff=mode==='inline-human';
        window.fixtureSeed={host:inline?document.getElementById('fixtureChat'):null,source:'对话',requirement:true,
          saveOnly:mode==='dialog-self'||inline,triageStage:'intake',cardId:'fixture-'+mode,
          bridge:{onOpen:id=>calls.bound.push(id)},onCreated:id=>calls.created.push(id),
          proposal:{title:'查看详情应定位这一条需求',note:'保留创建回执及原需求标识',checklist:['需求池打开原需求'],priority:'normal',kind:'requirement',
            ...(handedOff?{assigneeUserId:'colleague'}:{assignee:'me'})}};
        await WorkEntrySheet.openTask(fixtureSeed);
      };void 0;`);
    for (const file of ['core/win-bridge.js', 'desk-boot.js']) await js(fs.readFileSync(path.join(client, file), 'utf8') + '\nvoid 0;');
    await until("WorkspaceHost.view==='create'");
    for (const mode of ['inline-self', 'inline-human', 'restored', 'sheet-self', 'dialog-self']) {
      await js(`fixtureSetup(${JSON.stringify(mode)})`);
      await until("Boolean(document.querySelector('#cpCreate:not([disabled])'))");
      const inline = mode.startsWith('inline') || mode === 'restored';
      // Both surfaces now expose the same explicit cancellation contract.
      assert.equal(await js('document.querySelectorAll("[data-wes-close]").length'), 1);
      assert.equal(await js('document.querySelector("#cpCancel")?.textContent'), '取消', 'unsubmitted drafts retain an explicit cancel action');
      assert.equal(await js('document.querySelector("#workEntryLayer").classList.contains("is-inline")'), inline);
      if (inline) {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
        await delay(30);
        assert.equal(await js('Boolean(document.querySelector("#cpCreate"))'), true, 'Escape must retain inline cards');
      }
      await click('#cpCreate');
      const selector = mode === 'dialog-self' ? '.wes-result-secondary' : '#cpOpen';
      await until(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
      assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}).textContent.trim()`), '查看详情');
      const id = await js('calls.created[0]'); assert.ok(id);
      if (mode === 'restored') {
        await js(`localStorage.setItem('isolated-receipt',JSON.stringify(WorkEntrySheet.capture()));
          WorkEntrySheet.close(false,true);WorkspaceHost.open('history',{});WorkspaceHost.open('create',{});
          WorkEntrySheet.openTask({...fixtureSeed,cardState:JSON.parse(localStorage.getItem('isolated-receipt'))});void 0;`);
        await until("Boolean(document.querySelector('#cpOpen'))");
        assert.equal(await js('calls.created.length'), 1, 'restoring must not create another requirement');
      }
      if (mode !== 'dialog-self') {
        assert.equal(await js(`document.querySelector('.cp-receipt-kind').textContent`),'需求');
        assert.match(await js(`document.querySelector('.cp-receipt-meta').textContent`),/优先级.*创建时间/);
        if (mode === 'inline-human') assert.match(await js(`document.querySelector('.cp-receipt-meta').textContent`),/负责人/);
        else assert.doesNotMatch(await js(`document.querySelector('.cp-receipt-meta').textContent`),/负责人|未指定/);
        if(inline) assert.ok(await js(`(()=>{const card=document.querySelector('.cp-ok'),title=card.querySelector('.cp-done-title').getBoundingClientRect(),status=card.querySelector('.cp-okh').getBoundingClientRect(),action=card.querySelector('.cp-acts').getBoundingClientRect();return status.left>=title.right && action.top>=title.bottom})()`));
        for (const width of [1400, 480]) {
          win.setContentSize(width, 960);await delay(80);
          assert.equal(await js(`(()=>{const n=document.querySelector('.cp-receipt-meta');return n.scrollWidth<=n.clientWidth+1})()`),true,'receipt metadata fits '+width);
        }
        win.setContentSize(1400,960);await delay(80);
        const receipt = await js(`(() => {
          const layer=document.querySelector('#workEntryLayer'),card=layer.querySelector('.cp-ok');
          return {complete:layer.classList.contains('is-complete'),title:layer.querySelector('#wesTitle').textContent,
            hintHidden:getComputedStyle(layer.querySelector('.wes-head p')).display==='none',
            headHidden:getComputedStyle(layer.querySelector('.wes-head')).display==='none',
            height:card.getBoundingClientRect().height,loading:!!layer.querySelector('.cp-loading')};
        })()`);
        assert.equal(receipt.complete, true, mode);
        assert.equal(receipt.title, '需求已创建');
        assert.equal(receipt.hintHidden, true);
        assert.equal(receipt.headHidden, inline);
        assert.ok(receipt.height < 200, mode + ' receipt must not retain the empty form height');
        assert.equal(receipt.loading, false);
        if (mode === 'inline-self') fs.writeFileSync(path.join(output, 'compact-receipt.png'), (await win.webContents.capturePage()).toPNG());
      }
      await click(selector);
      await until("Boolean(document.querySelector('.rq-detail-content[data-task-id]'))");
      const result = await js(`(() => {const detail=document.querySelector('.rq-detail-content');
        const close=document.querySelector('[data-rq-dismiss]'),r=close.getBoundingClientRect();
        return {view:WorkspaceHost.view,requirementId:detail.dataset.taskId,title:document.getElementById('rqDetailTitle').textContent,
          poolVisible:!document.getElementById('historyBoard').hidden,
          chatHidden:document.getElementById('composePanel').hidden&&getComputedStyle(document.getElementById('composePanel')).display==='none',
          sheetGone:!document.getElementById('workEntryLayer'),modalGone:!document.querySelector('dialog:modal'),
          detailClickable:close.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),
          bound:calls.bound,created:calls.created.length,errors:fixtureFailures};})()`);
      assert.equal(result.view, 'history'); assert.equal(result.requirementId, id);
      assert.equal(result.title, '查看详情应定位这一条需求');
      for (const field of ['poolVisible', 'chatHidden', 'sheetGone', 'modalGone', 'detailClickable']) assert.equal(result[field], true, mode + ': ' + field);
      assert.deepEqual(result.bound, []); assert.equal(result.created, 1); assert.deepEqual(result.errors, []);
      const screenshot = path.join(output, mode + '.png');
      fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
      report.cases.push({ mode, ok: true, ...result, screenshot });
    }
    await js(`fixtureSetup('inline-self');window.parseCalls=0;window.parseRecover=false;
      SoduWorkAPI.parseTaskText=async()=>{parseCalls++;return parseRecover
        ? {title:'解析恢复',note:'人工修改后的完整说明',checklist:['可以验收']}
        : {_parseError:'需求解析失败（HTTP 504）；原文已保留，请稍后重试或手动填写'};};
      WorkEntrySheet.openTask({...fixtureSeed,proposal:null,text:'写一篇小作文'});void 0;`);
    await until('Boolean(document.querySelector(".cp-parse-warning"))');
    assert.equal(await js('Boolean(document.querySelector(".cp-parse-retry"))'), false);
    await js(`document.querySelector('#cpNote').value='人工修改后的完整说明';
      document.querySelector('#cpNote').dispatchEvent(new Event('input',{bubbles:true}));void 0;`);
    await js("ComposeDraft.refine('重试');void 0;");
    await until('parseCalls===2&&Boolean(document.querySelector(".cp-parse-warning"))');
    assert.equal(await js('document.querySelector("#cpNote").value'), '人工修改后的完整说明');
    assert.equal(await js('calls.created.length'), 0);
    await js('parseRecover=true');
    await js("ComposeDraft.refine('重试');void 0;");
    await until('document.querySelector("#cpTitle")?.value==="解析恢复"');
    assert.equal(await js('Boolean(document.querySelector(".cp-parse-retry"))'), false);
    assert.equal(await js('parseCalls'), 3);
    await click('#cpCreate'); await until('Boolean(document.querySelector("#cpOpen"))');
    assert.equal(await js('calls.created.length'), 1);
    assert.equal(await js('calls.persisted.length'), 1);
    fs.writeFileSync(path.join(output,'retry-recovered.png'),(await win.webContents.capturePage()).toPNG());
    report.cases.push({mode:'parse-retry-preserves-edits-and-creates-once',ok:true});
    assert.deepEqual(report.errors, []); report.ok = true;
  }).catch(async error => {
    report.error = String(error.stack || error);
    if (win) {
      report.failureDOM = await js(`({body:document.body.innerText,create:document.querySelector('#cpCreate')?.outerHTML,
        box:document.querySelector('#cpCreate')?.getBoundingClientRect().toJSON()})`).catch(() => null);
      fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG());
    }
  }).finally(() => {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); win?.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
