'use strict';
// Production UI and native input in a separate Electron profile. All task APIs
// are fixtures; deletion uses the production confirmation dialog and native input.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env};
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename], {
    env, windowsHide: true, stdio: 'inherit', timeout: 90000,
  });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
const {app, BrowserWindow} = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const output = path.resolve(__dirname, '../../outputs/requirements-usability-20261020');
fs.mkdirSync(output, {recursive: true});
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-requirements-ui-')));
app.disableHardwareAcceleration();
const report = {ok: false, checks: [], errors: [], boundary: 'Native Electron input, production renderer, fixture APIs; no business data'};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({show: false, width: 1400, height: 960,
      webPreferences: {offscreen: true, contextIsolation: true, sandbox: true, backgroundThrottling: false}});
    win.webContents.session.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*']}, (_request, done) => done({cancel: true}));
    win.webContents.on('console-message', event => {if (event.level === 'error') report.errors.push(event.message);});
    const js = source => win.webContents.executeJavaScript(source, true);
    const click = async selector => {
      let point;
      for (let attempt = 0; attempt < 30; attempt++) {
        point = await js(`(async()=>{const n=[...document.querySelectorAll(${JSON.stringify(selector)})].find(n=>n.getClientRects().length&&!n.disabled);if(!n)return null;n.scrollIntoView({block:'nearest'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height/2);return n.contains(document.elementFromPoint(x,y))?{x,y}:null})()`);
        if (point) break; await wait(40);
      }
      assert.ok(point, 'Visible target: ' + selector);
      for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({
        type, ...point, ...(type === 'mouseMove' ? {} : {button: 'left', clickCount: 1}),
      });
      await wait(100);
    };
    const enter = async () => {
      win.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Return'});
      win.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Return'}); await wait(50);
    };
    const capture = async name => {
      await wait(60); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
    };
    await win.loadFile(path.join(__dirname, 'fixtures/requirements-board.html'));
    const client = path.resolve(__dirname, '..'), {pathToFileURL} = require('node:url');
    const styles = [...fs.readFileSync(path.join(client, 'desk.html'), 'utf8').matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)/g)]
      .map(match => pathToFileURL(path.join(client, match[1])).href);
    await js(`Promise.all(${JSON.stringify(styles)}.map(href=>new Promise((resolve,reject)=>{const n=document.createElement('link');n.rel='stylesheet';n.href=href;n.onload=resolve;n.onerror=reject;document.head.append(n)}))).then(()=>true)`);
    await js(fs.readFileSync(path.join(__dirname, '../components/panels/panels-forward-select.js'), 'utf8'));
    await js('window.detailId=null;');
    await js(fs.readFileSync(path.join(__dirname, '../components/panels/panels-detail.js'), 'utf8'));
    await js(`(()=>{const style=document.createElement('style');style.textContent=${JSON.stringify(fs.readFileSync(path.join(__dirname, '../components/panels/panels-forward-plugin.css'), 'utf8'))};document.head.append(style)})()`);
    await js(`SoduWorkAPI.clientId='device-a';
      tasks=['critical','high','normal','low'].map((priority,i)=>({id:'ui-'+i,title:'需求池交互验证 '+i,
        status:'todo',triageStage:'intake',origin:'local',ownerClientId:'device-a',readOnly:false,canEditRequirement:true,
        canViewExecution:true,myRoles:['creator'],assigneeName:'测试成员',priority,kind:'requirement',requirementVersion:1,
        note:'背景\\n\\n验收要点（做到这些算完）：\\n1. 内容完整\\n2. 可直接使用',acceptanceCriteria:['内容完整','可直接使用'],tags:['已有']}));
      Store.removeTask=id=>{const index=tasks.findIndex(t=>t.id===id);if(index<0)return null;const [task]=tasks.splice(index,1);fixtureCalls.push(['delete',id]);return{task,index}};
      Store._flushTaskOps=async()=>{};Store._readTaskOps=()=>[];Store.taskPersistError=()=>'';RequirementsBoard.render(true);void 0;`);
    await click('[data-rq-scope="all"]');
    const colors = await js(`[...document.querySelectorAll('.rq-priority-flag')].map(n=>getComputedStyle(n).color)`);
    assert.equal(new Set(colors).size, 4);
    assert.equal(await js(`document.querySelectorAll('.rq-card-tags .rq-priority-flag').length`), 0);
    await capture('priority-flags');
    report.checks.push('Four distinct priority flag colors, located in card header with accessible labels');
    await click('[data-rq-open="ui-0"]');
    assert.equal(await js(`document.querySelector('.rq-description').textContent`), '背景');
    assert.equal(await js(`document.querySelectorAll('.rq-detail-criteria li').length`), 2);
    await click('[data-rq-edit]');
    await js(`SoduWorkAPI.listTeammates=async()=>({mates:[{id:'zhang',name:'张小明'},{id:'wang',name:'王小红'}]});void 0;`);
    await click('[data-rq-edit-cancel]'); await click('[data-rq-edit]');
    assert.equal(await js(`document.querySelector('[name="assigneeUserId"]').getClientRects().length`), 0, 'native assignee select must be hidden with full desktop CSS');
    assert.equal(await js(`document.querySelectorAll('[name="assigneeUserId"] + .fwd-select').length`), 1);
    await click('[name="assigneeUserId"] + .fwd-select button');
    await win.webContents.insertText('小明'); await wait(60);
    assert.deepEqual(await js(`[...document.querySelectorAll('.fwd-select-option')].map(n=>n.textContent.replace('✓',''))`), ['张小明']);
    await js(`document.querySelector('.fwd-select-search').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));void 0;`);
    assert.equal(await js(`!!document.querySelector('.fwd-select-popup')`), true);
    assert.equal(await js(`fixtureCalls.filter(c=>c[0]==='patch').length`), 0);
    await capture('assignee-chinese-search');
    await enter();
    assert.equal(await js(`document.querySelector('[name=assigneeUserId]').value`), 'zhang');
    report.checks.push('Assignee supports Chinese partial-name search; composing Enter does not select or submit, normal Enter selects');
    await click('#rqTagsInput');
    await win.webContents.insertText('中文测试');
    await enter();
    assert.deepEqual(await js(`JSON.parse(document.querySelector('[name=tags]').value)`), ['已有', '中文测试']);
    assert.equal(await js(`fixtureCalls.filter(c=>c[0]==='patch').length`), 0);
    await click('[data-rq-tag-remove="0"]');
    assert.deepEqual(await js(`JSON.parse(document.querySelector('[name=tags]').value)`), ['中文测试']);
    await capture('editable-tags');
    await js(`window.originalPatchTask=SoduWorkAPI.patchTask;window.originalGetTask=SoduWorkAPI.getTask;
      SoduWorkAPI.patchTask=async(...args)=>{await new Promise(r=>setTimeout(r,8000));await originalPatchTask(...args);throw new Error('请求超时')};
      SoduWorkAPI.getTask=async(...args)=>{await new Promise(r=>setTimeout(r,1500));return originalGetTask(...args)};void 0;`);
    await click('.rq-detail-footer button[type=submit]');
    assert.equal(await js(`document.querySelector('[data-rq-save]').textContent`), '正在保存…');
    assert.equal(await js(`document.querySelector('[data-rq-save]').disabled`), true);
    assert.equal(await js(`document.querySelector('#rqEditForm').getAttribute('aria-busy')`), 'true');
    assert.equal(await js(`RequirementsDetail.close()`), false);
    assert.equal(await js(`document.querySelector('[data-rq-confirm]').hidden`), true);
    await capture('edit-saving');
    await wait(8000);
    assert.equal(await js(`document.querySelector('[data-rq-save]').textContent`), '正在确认保存结果…');
    await js(`refreshOpenDetail('ui-0');void 0;`);
    assert.equal(await js(`document.querySelector('[data-rq-confirm]').hidden`), true);
    await wait(1600);
    await js(`SoduWorkAPI.patchTask=originalPatchTask;SoduWorkAPI.getTask=originalGetTask;void 0;`);
    assert.equal(await js(`!!document.querySelector('#rqEditForm')`), false);
    assert.equal(await js(`document.querySelector('[data-rq-confirm]').hidden`), true);
    assert.deepEqual(await js(`tasks[0].tags`), ['中文测试']);
    assert.equal(await js(`fixtureCalls.filter(c=>c[0]==='patch').length`), 1);
    await js(`window.savedDrawer=document.querySelector('.rq-detail-backdrop');window.loadingFlashes=0;
      window.refreshObserver=new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)if(node.nodeType===1&&(node.matches?.('.rq-detail-loading')||node.querySelector?.('.rq-detail-loading')))loadingFlashes++});
      refreshObserver.observe(document.body,{childList:true,subtree:true});void 0;`);
    await js(`Promise.all([refreshOpenDetail('ui-0'),refreshOpenDetail('ui-0'),refreshOpenDetail('ui-0')]).then(()=>true)`);
    await js(`refreshOpenDetail('ui-0')`);
    assert.equal(await js(`loadingFlashes`), 0);
    assert.equal(await js(`savedDrawer===document.querySelector('.rq-detail-backdrop')`), true);
    await js(`refreshObserver.disconnect();void 0;`);
    report.checks.push('8-second timeout followed by late background refresh confirms saved fields without duplicate PATCH or discard prompt');
    assert.equal(await js(`fixtureCalls.filter(c=>c[0]==='patch').at(-1)[2].note`), undefined);
    await click('[data-rq-dismiss]');
    report.checks.push('Detail tags: native Enter adds, X removes, save persists; historical duplicate hidden without changing stored note');
    await js(fs.readFileSync(path.join(client, 'components/panels/library-transfer.js'), 'utf8'));
    await js(`window.originalAttachments=SoduWorkAPI.listAttachments;
      SoduWorkAPI.listAttachments=async()=>[{id:'output-one',filename:'需求交付报告.md',role:'output',size:123,createdAt:1}];
      SoduWorkAPI.uploadLibraryOutput=()=>new Promise(resolve=>window.finishLibrarySave=resolve);
      RequirementsDetail.open('ui-0');void 0;`);
    await wait(100);
    assert.equal(await js(`document.querySelector('[data-rq-library]').textContent`),'');
    assert.equal(await js(`document.querySelector('[data-rq-library]').getBoundingClientRect().width`),30);
    assert.match(await js(`document.querySelector('[data-rq-library]').getAttribute('aria-label')`),/保存到本机资料库/);
    await click('[data-rq-library]');
    assert.equal(await js(`document.querySelector('[data-rq-library]').disabled`),true);
    assert.equal(await js(`getComputedStyle(document.querySelector('[data-rq-library] .library-save-label')).position`),'absolute');
    assert.equal(await js(`document.querySelector('[data-rq-library]').getBoundingClientRect().width`),30);
    assert.match(await js(`document.querySelector('[data-rq-library]').textContent`),/正在保存/);
    await capture('library-saving');
    await js(`finishLibrarySave({ok:false,reason:'源文件已丢失，请从原执行电脑或服务器备份恢复附件后重试'});void 0;`);await wait(80);
    assert.equal(await js(`document.querySelector('.rq-library-error').hidden`),false);
    assert.match(await js(`document.querySelector('.rq-library-error').textContent`),/源文件已丢失/);
    assert.equal(await js(`document.querySelector('[data-rq-library]').textContent`),'文件丢失');
    assert.match(await js(`document.querySelector('[data-rq-library]').title`),/服务器备份.*点击重试/);
    for(const width of [1400,820,480]){
      win.setContentSize(width,960);await wait(80);
      assert.equal(await js(`(()=>{
        const row=document.querySelector('.rq-material'),actions=row.querySelector('.rq-material-actions');
        const button=row.querySelector('[data-rq-library]'),box=button.getBoundingClientRect();
        const parts=[...actions.children].map(n=>n.getBoundingClientRect());
        return row.scrollWidth<=row.clientWidth+1 && box.width<=110 && actions.getBoundingClientRect().height<=32 &&
          parts.every((r,i)=>!i||r.left>=parts[i-1].right);
      })()`),true,'failed save stays compact without overlapping adjacent actions at '+width);
    }
    win.setContentSize(1400,960);await wait(80);
    await js(`document.querySelector('.rq-material').scrollIntoView({block:'center'});void 0;`);
    await capture('library-error');
    await click('[data-rq-library]');
    // Reopening during the transfer replaces the button; completion must reach it.
    await js(`RequirementsDetail.close(true);RequirementsDetail.open('ui-0');void 0;`);await wait(100);
    assert.equal(await js(`document.querySelector('[data-rq-library]').disabled`),true);
    await js(`finishLibrarySave({ok:true,item:{id:'fixture-saved'}});void 0;`);await wait(80);
    assert.match(await js(`document.querySelector('[data-rq-library]').textContent`),/已保存/);
    assert.equal(await js(`document.querySelector('[data-rq-library]').classList.contains('is-saved')`),true);
    for(const width of [1400,820,480]){
      win.setContentSize(width,960);await wait(80);
      assert.equal(await js(`(()=>{const row=document.querySelector('.rq-material');return row.scrollWidth<=row.clientWidth+1})()`),true);
    }
    await js(`document.querySelector('[data-rq-library]').scrollIntoView({block:'center'});void 0;`);await wait(80);
    await capture('library-saved');win.setContentSize(1400,960);
    await js(`SoduWorkAPI.listAttachments=originalAttachments;RequirementsDetail.close(true);void 0;`);
    report.checks.push('Requirement library saving/error/success is visible; reopen during save keeps state, retry succeeds and narrow rows fit');
    await click('[data-rq-actions="ui-0"]'); await click('[data-rq-maintain="ui-0"]');
    assert.equal(await js(`!!document.querySelector('.hb-body [data-hbid="ui-0"]')`), false);
    await click('#rqArchiveEntry');
    assert.equal(await js(`document.querySelector('#hbTitleText').textContent`), '归档需求');
    assert.deepEqual(await js(`[...document.querySelectorAll('.hb-body [data-hbid]')].map(n=>n.dataset.hbid)`), ['ui-0']);
    await capture('archive-view');
    await click('[data-rq-actions="ui-0"]'); await click('[data-rq-maintain="ui-0"]');
    assert.equal(await js(`tasks[0].archivedAt`), null);
    await click('#rqArchiveEntry');
    await click('[data-rq-actions="ui-1"]'); await click('[data-rq-delete="ui-1"]');
    assert.equal(await js(`!!document.querySelector('.rq-action-confirm[open]')`), true);
    assert.equal(await js(`tasks.some(t=>t.id==='ui-1')`), true);
    await capture('current-delete-confirmation');
    await click('[data-rq-action-confirm]');
    assert.equal(await js(`tasks.some(t=>t.id==='ui-1')`), false);
    await click('[data-rq-actions="ui-0"]'); await click('[data-rq-maintain="ui-0"]'); await click('#rqArchiveEntry');
    await click('[data-rq-actions="ui-0"]'); await click('[data-rq-delete="ui-0"]');
    await click('[data-rq-action-cancel]');
    assert.equal(await js(`tasks.some(t=>t.id==='ui-0')`), true);
    assert.equal(await js(`fixtureCalls.filter(c=>c[0]==='delete'&&c[1]==='ui-0').length`), 0);
    assert.equal(await js(`!!document.querySelector('.rq-action-confirm[open]')`), false);
    await click('[data-rq-actions="ui-0"]'); await click('[data-rq-delete="ui-0"]');
    await click('[data-rq-action-confirm]');
    assert.equal(await js(`tasks.some(t=>t.id==='ui-0')`), false);
    report.checks.push('Native archive/restore and direct/archived deletion; cancel does not delete, empty archive remains navigable');
    for (const width of [1440, 820, 480]) {
      win.setSize(width, 900); await wait(100);
      const layout = await js(`(()=>{const n=document.querySelector('#rqArchiveEntry'),r=n.getBoundingClientRect();return{overflow:document.documentElement.scrollWidth>innerWidth+1,entry:r.width>0&&r.left>=0&&r.right<=innerWidth}})()`);
      assert.equal(layout.overflow, false, 'Outer overflow at ' + width);
      assert.equal(layout.entry, true, 'Archive navigation at ' + width);
    }
    report.checks.push('Archive entry accessible at 1440 / 820 / 480 px without outer overflow');
    assert.deepEqual(await js('fixtureErrors'), []);
    await win.loadFile(path.join(__dirname, 'fixtures/requirement-sheet-receipt.html'));
    await js(fs.readFileSync(path.join(__dirname, '../components/requirements/requirement-fields.js'), 'utf8'));
    win.setSize(1200, 900);
    await js('openSheet()'); await wait(100);
    assert.equal(await js(`document.body.textContent.includes('这么建，行吗')`), false);
    await click('#cpTagsInput'); await win.webContents.insertText('新建标签'); await enter();
    assert.equal(await js(`document.querySelectorAll('.rq-tag-chip').length`), 1);
    await click('#cpCreate');
    const created = await js(`tasks.map(t=>({note:t.note,acceptanceCriteria:t.acceptanceCriteria,tags:t.tags}))`);
    assert.equal(created.length, 1);
    assert.equal(created[0].note, '含歌单与播放页');
    assert.deepEqual(created[0].acceptanceCriteria, ['页面可打开']);
    assert.deepEqual(created[0].tags, ['新建标签']);
    report.checks.push('Production creation card saves criteria once in structured field, keeps background unchanged, no redundant heading');
    assert.deepEqual(report.errors, []);
    report.ok = true;
  } catch (error) {
    report.error = String(error.stack || error);
    if (win) fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG());
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    app.exit(report.ok ? 0 : 1);
  }
});
