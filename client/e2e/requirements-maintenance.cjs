'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env};
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)], {env, windowsHide: true, stdio: 'inherit', timeout: 90000});
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
const {app, BrowserWindow} = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const output = path.resolve(process.argv.slice(2).find(value => !value.startsWith('--')) ||
  path.join(__dirname, '../../outputs/requirements-maintenance-visibility'));
const sourceOverride = process.argv.find(value => value.startsWith('--requirements-source='))?.slice('--requirements-source='.length) || '';
fs.mkdirSync(output, {recursive: true});
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-maintenance-'));
app.setPath('userData', path.join(temporary, 'profile'));
app.disableHardwareAcceleration();
const report = {ok: false, checks: [], errors: [], sourceOverride,
  boundary: 'Native Electron input, production components, explicit Hub-shaped fixtures; no business data'};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({show: false, width: 1440, height: 1000,
      webPreferences: {offscreen: true, contextIsolation: true, sandbox: true, backgroundThrottling: false}});
    win.webContents.session.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*']}, (_request, done) => done({cancel: true}));
    win.webContents.on('console-message', event => {if (event.level === 'error') report.errors.push(event.message);});
    const js = value => win.webContents.executeJavaScript(value, true);
    const key = async keyCode => {
      win.webContents.sendInputEvent({type: 'keyDown', keyCode});
      if (keyCode === 'Return') win.webContents.sendInputEvent({type: 'char', keyCode: '\r'});
      win.webContents.sendInputEvent({type: 'keyUp', keyCode}); await wait(70);
    };
    const click = async (selector, times = 1) => {
      const point = await js(`(async()=>{const n=[...document.querySelectorAll(${JSON.stringify(selector)})].find(n=>n.getClientRects().length);if(!n)return null;n.scrollIntoView({block:'nearest',inline:'nearest'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height/2);return n.contains(document.elementFromPoint(x,y))?{x,y}:null})()`);
      assert.ok(point, 'Visible target: ' + selector);
      for (let n = 0; n < times; n++) {
        for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({
          type, ...point, ...(type === 'mouseMove' ? {} : {button: 'left', clickCount: n + 1}),
        });
      }
      await wait(100);
    };
    const dialogOpen = () => js(`!!document.querySelector('.rq-action-confirm[open]')`);
    const deleteCount = id => js(`fixtureCalls.filter(c=>c[0]==='delete'&&c[1]===${JSON.stringify(id)}).length`);
    const requestDelete = async id => {
      await click(`[data-rq-actions="${id}"]`); await click(`[data-rq-delete="${id}"]`);
      assert.equal(await dialogOpen(), true, 'Delete waits for the application confirmation');
      assert.equal(await js(`tasks.some(t=>t.id===${JSON.stringify(id)})`), true);
    };
    const capture = async name => fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
    const actionPresent = async (selector, allowed) => {
      assert.equal(await js(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), allowed, selector + ' visibility');
      if (allowed) assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}).disabled`), false, selector + ' is usable');
    };
    const assertScopes = async archive => {
      const expected = archive ? ['related', 'all'] : ['related', 'actionable', 'created', 'all'];
      assert.deepEqual(await js(`[...document.querySelectorAll('.rq-scopes [data-rq-scope]')].map(n=>n.dataset.rqScope)`), expected);
      assert.deepEqual(await js(`[...document.querySelector('#rqScope').options].map(n=>n.value)`), expected);
    };
    let page = path.join(__dirname, 'fixtures/requirements-board.html');
    if (sourceOverride) {
      assert.ok(fs.existsSync(path.resolve(sourceOverride)), 'The baseline production source exists');
      const html = fs.readFileSync(page, 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.dirname(page) + path.sep).href + '">')
        .replace('src="../../core/requirements.js"', 'src="' + pathToFileURL(path.resolve(sourceOverride)).href + '"');
      page = path.join(temporary, 'fixture.html'); fs.writeFileSync(page, html);
    }
    await win.loadFile(page);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled: true});
    await js(`SoduWorkAPI.clientId='my-device';
      const seed={origin:'dispatch',ownerClientId:'coworker-device',readOnly:true,canEditRequirement:true,canDeleteRequirement:true,canArchiveRequirement:true,
        maintenanceBlocked:false,status:'todo',triageStage:'ready',myRoles:['creator'],assigneeName:'杨善明',kind:'requirement',priority:'normal',requirementVersion:3};
      tasks=[{...seed,id:'delegated',title:'委托同事整理客户周报'},{...seed,id:'archived',title:'已归档的客户资料整理',archivedAt:123},
        {...seed,id:'cancelled-unarchived',title:'仅取消但尚未归档的需求',status:'cancel'},
        {...seed,id:'approval',title:'等待审批中的协作流程',status:'done',maintenanceBlocked:true,maintenanceBlockReason:'关联流程尚未结束，请先结束流程再操作'},
        {...seed,id:'stopped',title:'停止后的返修需求',status:'doing'},
        {...seed,id:'paused',title:'暂停中的需求',status:'paused'},
        {...seed,id:'submitted',title:'已提交但未验收',status:'done'},
        {...seed,id:'review-stage',title:'已有待验收交付',requirementStage:'reviewing'},
        {...seed,id:'fresh-stage',title:'菜单打开后进入执行的需求'},
        {...seed,id:'cancel-dialog',title:'取消删除后保留的业务需求'},
        {...seed,id:'detail-delete',title:'从详情删除的已完成需求',status:'done',triageStage:'delivered',reviewedAt:Date.now()},
        {...seed,id:'workflow-race',title:'确认期间启动的协作流程'},
        {...seed,id:'identity-race',title:'原账号的需求不得跨账号删除'},
        {...seed,id:'repeat-confirm',title:'双击确认只删除一次'},
        {...seed,id:'observer',title:'团队可见但无维护权限',canEditRequirement:false,canDeleteRequirement:false,canArchiveRequirement:false}];
      const stages={intake:{triageStage:'intake'},clarifying:{triageStage:'clarifying'},ready:{},
        doing:{status:'doing'},paused:{status:'paused'},reviewing:{status:'done'},
        delivered:{status:'done',reviewedAt:Date.now()},closed:{archivedAt:456}};
      window.maintenanceMatrix=[];
      for(const [stage,fields] of Object.entries(stages))for(const actor of ['creator','noncreator']){
        const early=['intake','clarifying','ready'].includes(stage),id='matrix-'+stage+'-'+actor;
        const actorPermission=!early||actor==='creator';
        tasks.push({...seed,...fields,id,title:stage+' · '+actor,myRoles:[actor==='creator'?'creator':'assignee'],
          canArchiveRequirement:actorPermission,canDeleteRequirement:actorPermission});
        maintenanceMatrix.push({id,stage,actor,allowed:actorPermission&&!['doing','paused','reviewing'].includes(stage)});
      }
      fixtureApprovals=[];
      const originalGetTask=SoduWorkAPI.getTask;SoduWorkAPI.getTask=async id=>{fixtureCalls.push(['get',id]);return originalGetTask(id)};
      Store.removeTask=(id,delay,latest)=>{fixtureCalls.push(['delete',id,latest?.canDeleteRequirement]);const index=tasks.findIndex(t=>t.id===id);if(index<0)return null;return{task:tasks.splice(index,1)[0],index}};
      Store._flushTaskOps=async()=>{};Store._readTaskOps=()=>[];Store.taskPersistError=()=>'';RequirementsBoard.render(true);void 0`);
    await assertScopes(false);
    await click('[data-rq-actions="approval"]');
    for (const selector of ['[data-rq-delete="approval"]', '[data-rq-maintain="approval"]']) {
      await actionPresent(selector, false);
    }
    assert.equal(await js(`fixtureCalls.some(c=>['patch','delete'].includes(c[0]))`), false);
    assert.equal(await dialogOpen(), false);
    await capture('waiting-workflow-hidden');
    await key('Escape');
    await click('[data-rq-open="approval"]'); await click('.rq-detail-more > summary');
    await actionPresent('.rq-detail [data-rq-delete]', false); await actionPresent('.rq-detail [data-rq-archive]', false);
    await click('[data-rq-dismiss]');
    await click('[data-rq-actions="observer"]');
    assert.equal(await js(`!!document.querySelector('[data-rq-delete="observer"]')`), false);
    await key('Escape');
    report.checks.push('An unfinished workflow hides archive/delete in board and detail; an unauthorized observer sees neither action');
    for (const archived of [false, true]) {
      if (archived) await click('#rqArchiveEntry');
      for (const row of await js(`maintenanceMatrix.filter(row=>(row.stage==='closed')===${archived})`)) {
        await click(`[data-rq-actions="${row.id}"]`);
        await actionPresent(`[data-rq-maintain="${row.id}"]`, row.allowed);
        await actionPresent(`[data-rq-delete="${row.id}"]`, row.allowed);
        await key('Escape');
        await click(`[data-rq-open="${row.id}"]`); await click('.rq-detail-more > summary');
        await actionPresent('.rq-detail [data-rq-archive]', row.allowed);
        await actionPresent('.rq-detail [data-rq-delete]', row.allowed);
        await click('[data-rq-dismiss]');
      }
      if (archived) await click('#rqArchiveEntry');
    }
    report.checks.push('Board and detail cover creator/noncreator across intake, clarifying, ready, doing, paused, reviewing, accepted completion and archive; blocked actions are absent');
    await click('[data-rq-actions="delegated"]');
    assert.equal(await js(`document.querySelector('[data-rq-delete="delegated"]').disabled`), false);
    await capture('current-delete-available');
    await click('[data-rq-maintain="delegated"]');
    await click('[data-rq-scope="created"]');
    await click('#rqArchiveEntry'); await assertScopes(true);
    assert.equal(await js(`document.querySelector('#rqScope').value`), 'related');
    assert.ok(await js(`!!document.querySelector('[data-rq-actions="delegated"]')`));
    await click('[data-rq-actions="delegated"]');
    assert.equal(await js(`document.querySelector('[data-rq-maintain="delegated"]').textContent`), '恢复需求');
    assert.equal(await js(`document.querySelector('[data-rq-delete="delegated"]').disabled`), false);
    assert.equal(await js(`document.querySelector('[data-rq-maintain="delegated"]').disabled`), false);
    await capture('archive-delete-available');
    const restoresBeforeDelete = await js(`fixtureCalls.filter(c=>c[0]==='patch'&&c[1]==='delegated'&&c[2].archivedAt===null).length`);
    await click('[data-rq-delete="delegated"]');
    assert.equal(await dialogOpen(), true);
    assert.equal(await deleteCount('delegated'), 0);
    await capture('archive-direct-delete-confirmation');
    await click('[data-rq-action-confirm]');
    assert.equal(await js(`tasks.some(t=>t.id==='delegated')`), false);
    assert.equal(await js(`fixtureCalls.filter(c=>c[0]==='patch'&&c[1]==='delegated'&&c[2].archivedAt===null).length`), restoresBeforeDelete);
    report.checks.push('Creator archives a coworker-owned dispatch/readOnly demand; archived delete opens confirmation and deletes directly without a restore request');
    await click('[data-rq-open="archived"]'); await click('.rq-detail-more > summary');
    await actionPresent('.rq-detail [data-rq-delete]', true); await click('.rq-detail [data-rq-delete]');
    assert.equal(await dialogOpen(), true); assert.equal(await deleteCount('archived'), 0);
    await click('[data-rq-action-confirm]'); assert.equal(await deleteCount('archived'), 1);
    assert.equal(await js(`fixtureCalls.some(c=>c[0]==='patch'&&c[1]==='archived'&&c[2].archivedAt===null)`), false);
    report.checks.push('Archived detail also confirms and deletes directly without restoring');
    await click('[data-rq-actions="cancelled-unarchived"]');
    await actionPresent('[data-rq-delete="cancelled-unarchived"]', true);
    await actionPresent('[data-rq-maintain="cancelled-unarchived"]', true);
    await click('[data-rq-delete="cancelled-unarchived"]'); assert.equal(await dialogOpen(), true);
    await click('[data-rq-action-cancel]'); assert.equal(await deleteCount('cancelled-unarchived'), 0);
    await click('[data-rq-open="cancelled-unarchived"]'); await click('.rq-detail-more > summary');
    await actionPresent('.rq-detail [data-rq-delete]', true); await actionPresent('.rq-detail [data-rq-archive]', true);
    await click('.rq-detail [data-rq-delete]'); assert.equal(await dialogOpen(), true);
    await click('[data-rq-action-confirm]'); assert.equal(await deleteCount('cancelled-unarchived'), 1);
    assert.equal(await js(`fixtureCalls.some(c=>c[0]==='patch'&&c[1]==='cancelled-unarchived')`), false);
    report.checks.push('A cancelled record displayed as archived also confirms direct deletion without an intermediate restore');
    win.setContentSize(480, 900); await wait(120); await assertScopes(true);
    await click('#rqScope'); await key('Escape'); await key('Down'); await key('Return');
    assert.equal(await js(`document.querySelector('#rqScope').value`), 'all');
    assert.equal(await js(`document.documentElement.scrollWidth>innerWidth+1`), false);
    await capture('archive-mobile-two-scopes');
    await click('#rqArchiveEntry'); await assertScopes(false);
    win.setContentSize(1440, 1000); await wait(100);
    for (const id of ['stopped', 'paused', 'submitted', 'review-stage']) {
      await click(`[data-rq-actions="${id}"]`);
      for (const selector of [`[data-rq-maintain="${id}"]`, `[data-rq-delete="${id}"]`]) {
        await actionPresent(selector, false);
      }
      await key('Escape');
    }
    await click('[data-rq-actions="fresh-stage"]');
    assert.equal(await js(`document.querySelector('[data-rq-maintain="fresh-stage"]').disabled`), false);
    await js(`tasks.find(t=>t.id==='fresh-stage').status='doing';void 0`);
    await click('[data-rq-delete="fresh-stage"]');
    assert.ok(await js(`tasks.some(t=>t.id==='fresh-stage')`));
    assert.match(await js(`fixtureCalls.filter(c=>c[0]==='notice').at(-1)[1]`), /收集箱.*待开始.*已完成/);
    assert.equal(await deleteCount('fresh-stage'), 0);
    report.checks.push('Doing, paused, unreviewed done and projected review hide maintenance despite no live execution; a fresh stage change prevents stale menu deletion');
    for (const dismiss of ['[data-rq-action-cancel]', '[data-rq-action-close]', 'Escape']) {
      await requestDelete('cancel-dialog');
      if (dismiss === 'Escape') await key('Escape'); else await click(dismiss);
      assert.equal(await dialogOpen(), false);
      assert.equal(await deleteCount('cancel-dialog'), 0);
      assert.equal(await js(`tasks.some(t=>t.id==='cancel-dialog')`), true);
    }
    report.checks.push('Current card uses the application confirmation; Cancel, close and Escape all preserve the requirement');

    await click('[data-rq-open="detail-delete"]');
    await click('.rq-detail-more > summary'); await click('.rq-detail [data-rq-delete]');
    assert.equal(await dialogOpen(), true);
    await capture('detail-delete-confirmation');
    await click('[data-rq-action-cancel]');
    assert.equal(await deleteCount('detail-delete'), 0);
    assert.equal(await js(`!!document.querySelector('.rq-detail')?.getClientRects().length`), true);
    await click('.rq-detail-more > summary'); await click('.rq-detail [data-rq-delete]');
    await click('[data-rq-action-confirm]');
    assert.equal(await deleteCount('detail-delete'), 1);
    assert.equal(await js(`tasks.some(t=>t.id==='detail-delete')`), false);
    assert.equal(await js(`!!document.querySelector('.rq-detail')?.getClientRects().length`), false);
    report.checks.push('Completed coworker-owned detail uses the same confirmation; cancel keeps detail open and confirmed deletion closes it');

    await requestDelete('workflow-race');
    const readsBeforeConfirm = await js(`fixtureCalls.filter(c=>c[0]==='get'&&c[1]==='workflow-race').length`);
    await js(`Object.assign(tasks.find(t=>t.id==='workflow-race'),{maintenanceBlocked:true,maintenanceBlockReason:'确认期间流程已启动，请先结束流程'});void 0`);
    await click('[data-rq-action-confirm]');
    assert.equal(await deleteCount('workflow-race'), 0);
    assert.equal(await js(`tasks.some(t=>t.id==='workflow-race')`), true);
    assert.ok(await js(`fixtureCalls.filter(c=>c[0]==='get'&&c[1]==='workflow-race').length`) > readsBeforeConfirm);
    assert.match(await js(`fixtureCalls.filter(c=>c[0]==='notice').at(-1)[1]`), /确认期间流程已启动/);
    assert.equal(await dialogOpen(), false);
    report.checks.push('A workflow starting while confirmation is open is rechecked against Hub and cannot be deleted');

    await requestDelete('identity-race');
    await js(`fixtureIdentity='fixture:bob:tasks';window.dispatchEvent(new Event('soduwork-data-scope-changed'));void 0`);
    await wait(100);
    assert.equal(await dialogOpen(), false, 'Changing accounts dismisses the previous account confirmation');
    assert.equal(await deleteCount('identity-race'), 0);
    assert.equal(await js(`tasks.some(t=>t.id==='identity-race')`), true);
    await key('Return');
    assert.equal(await deleteCount('identity-race'), 0, 'A late Enter cannot confirm the previous account operation');
    await js(`fixtureIdentity='fixture:alice:tasks';window.dispatchEvent(new Event('soduwork-data-scope-changed'));void 0`);
    await wait(100);
    report.checks.push('Account switch cancels an open confirmation; stale keyboard confirmation never deletes the previous account requirement');

    await js(`window.finishDeleteFlush=null;Store._flushTaskOps=()=>new Promise(resolve=>{window.finishDeleteFlush=resolve});void 0`);
    await requestDelete('repeat-confirm');
    await click('[data-rq-action-confirm]', 2);
    assert.equal(await deleteCount('repeat-confirm'), 1);
    assert.equal(await dialogOpen(), false);
    assert.equal(await js(`typeof window.finishDeleteFlush`), 'function');
    await key('Return');
    assert.equal(await deleteCount('repeat-confirm'), 1);
    await js(`window.finishDeleteFlush();Store._flushTaskOps=async()=>{};void 0`);
    await wait(100);
    assert.equal(await deleteCount('repeat-confirm'), 1);
    assert.equal(await js(`tasks.some(t=>t.id==='repeat-confirm')`), false);
    report.checks.push('Native double-click and late Enter while deletion is syncing issue one delete and do not reopen confirmation');
    assert.deepEqual(await js('fixtureErrors'), []);
    assert.deepEqual(report.errors, []);
    report.ok = true;
  } catch (error) {
    report.error = String(error.stack || error);
    if (win) await win.webContents.capturePage().then(image => fs.writeFileSync(path.join(output, 'failure.png'), image.toPNG())).catch(() => {});
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
  }
});
