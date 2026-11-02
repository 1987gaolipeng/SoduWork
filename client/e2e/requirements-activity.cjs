'use strict';
// Exercise the production drawer and timeline with isolated APIs and desktop styles.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env};
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename], {env, windowsHide: true, stdio: 'inherit', timeout: 180000});
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
}
const {app, BrowserWindow} = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const client = path.resolve(__dirname, '..'), output = path.resolve(client, '../outputs/requirements-activity');
fs.mkdirSync(output, {recursive: true});
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-activity-')));
app.disableHardwareAcceleration();
const report = {ok: false, checks: [], layouts: [], errors: [], boundary: 'Isolated Electron; production CSS and renderer; fixture APIs; no account or business data'};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({show: false, width: 1440, height: 960, webPreferences: {offscreen: true, contextIsolation: true, sandbox: true, backgroundThrottling: false}});
    win.webContents.session.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*']}, (_request, done) => done({cancel: true}));
    win.webContents.on('console-message', event => {if (event.level === 'error') report.errors.push(event.message);});
    const js = source => win.webContents.executeJavaScript(source, true);
    const read = name => fs.readFileSync(path.join(client, name), 'utf8');
    const click = async selector => {
      const point = await js(`(async()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing '+${JSON.stringify(selector)});
        n.scrollIntoView({block:'nearest',behavior:'instant'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        const b=n.getBoundingClientRect(),x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height/2);
        if(!n.contains(document.elementFromPoint(x,y)))throw Error('Occluded '+${JSON.stringify(selector)});return{x,y}})()`);
      const zoom = win.webContents.getZoomFactor();
      for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({type, x: Math.round(point.x * zoom), y: Math.round(point.y * zoom), ...(type === 'mouseMove' ? {} : {button: 'left', clickCount: 1})});
      await wait(65);
    };
    const open = async selector => {await click('.rq-detail-more>summary'); await click(selector);};
    await win.loadFile(path.join(__dirname, 'fixtures/requirements-board.html'));
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled: true});
    const styles = [...read('desk.html').matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)/g)].map(match => pathToFileURL(path.join(client, match[1])).href);
    await js(`Promise.all(${JSON.stringify(styles)}.map(href=>new Promise((resolve,reject)=>{const n=document.createElement('link');n.rel='stylesheet';n.href=href;n.onload=resolve;n.onerror=reject;document.head.append(n)}))).then(()=>true)`);
    for (const file of JSON.parse(read('core/locales/manifest.json'))) await js(read('core/locales/' + file));
    await js(read('core/i18n-dom.js')); await js(read('core/i18n.js'));
    await js(read('components/panels/task-trace-view.js')); await js(read('components/panels/task-trace-runtime.js'));
    await js(`window.activityMode='normal';window.pluginOpened=[];window.activityReads=[];
      window.activityEvents=[
        {id:'started',kind:'task.execution_started',actor:'system',at:1700000000000,detail:{from:'todo',to:'doing'}},
        {id:'files',kind:'ai.artifacts',actor:'agent:conversation',at:1700000001000,detail:{files:['index.html','style.css']}},
        {id:'candidate',kind:'release.candidate',actor:'agent:conversation',at:1700000002000},
        {id:'requested',kind:'release.approval_requested',actor:'SoduWork',at:1700000003000},
        {id:'approval',kind:'release.approved',actor:'Alice',at:1700000004000,detail:{action:'review',requestId:'r',versionId:'v',note:'Original review 原始意见 '.repeat(25)+'END-EVIDENCE'}},
        {id:'report',kind:'artifact.auto_reviewed',actor:'Alice',at:1700000005000,detail:{requestId:'r',versionId:'v',verdict:'approved'}}];
      SoduWorkAPI.getTaskComments=async id=>{activityReads.push(['comments',id]);if(activityMode==='failure')throw Error('Offline');return activityMode==='empty'?[]:[{body:'原始讨论 doing <script>unchanged</script>',authorName:'Alice',createdAt:1700000006000}]};
      SoduWorkAPI.getTaskEvents=async id=>{activityReads.push(['events',id]);return activityMode==='history-failure'?null:activityMode==='empty'?[]:structuredClone(activityEvents)};
      SoduWorkAPI.taskTrace=async id=>{activityReads.push(['trace',id]);return {card:{taskId:id},timeline:activityMode==='empty'?[]:structuredClone(activityEvents)}};
      window.PluginUIHost={contributions:async()=>[],openContribution:async(row,context)=>{pluginOpened.push([row.id,context.task.id])}};
      SoduWorkI18n.setLocale('zh-CN');RequirementsDetail.open('delivered-0')`);
    await open('[data-rq-comments-open]');
    const text = await js('document.querySelector("[data-rq-comment-list]").textContent');
    for (const value of ['自动验收通过', '交付版本已生成', '待开始 → 进行中', 'AI 助手', '原始讨论 doing <script>unchanged</script>']) assert.ok(text.includes(value), value);
    assert.doesNotMatch(text, /agent:conversation|人工通过|release[. ·]+candidate/);
    assert.equal(await js('document.querySelectorAll("[data-rq-comment-list] script").length'), 0);
    assert.equal(await js('document.querySelector(".tfd-event-note").open'), false);
    await click('.tfd-event-note>summary');
    assert.equal(await js('document.querySelector(".tfd-event-note").open'), true);
    assert.match(await js('document.querySelector(".tfd-event-note>p").textContent'), /END-EVIDENCE$/);
    await js(`SoduWorkI18n.setLocale('en-US');void 0;`); await wait(100);
    assert.equal(await js('document.querySelector(".tfd-event-note").open'), true);
    assert.equal(await js('document.activeElement.matches(".tfd-event-note>summary")'), true);
    await js(`SoduWorkI18n.setLocale('zh-CN');void 0;`); await wait(100);
    await click('.tfd-event-note>summary');
    report.checks.push('Human event labels, localized states, safe user content, automatic review provenance and expandable full notes');
    for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']) {
      await js(`SoduWorkI18n.setLocale(${JSON.stringify(locale)});void 0;`); await wait(100);
      const expected = await js(`SoduWorkI18n.t('自动验收通过')`);
      assert.ok((await js('document.querySelector("[data-rq-comment-list]").textContent')).includes(expected));
      if (locale !== 'zh-CN') assert.notEqual(expected, '自动验收通过');
      if (locale !== 'zh-CN') {
        const missing = await js(`['AI 助手','系统','成员','待开始','进行中','已完成','讨论留言','审批通过','验收通过','查看完整说明'].filter(key=>SoduWorkI18n.t(key)===key)`);
        assert.deepEqual(missing, [], 'Activity translations in ' + locale);
      }
      assert.match(await js('document.querySelector("[data-rq-comment-list]").textContent'), /原始讨论 doing/);
      for (const [width, zoom] of [[1440, 1], [820, 1.25], [480, 1]]) {
        win.setSize(width, 960); win.webContents.setZoomFactor(zoom); await wait(70);
        const layout = await js(`(()=>{const card=document.querySelector('.rq-evidence-modal .rq-detail-modal-card'),body=card.querySelector('.rq-detail-modal-body'),r=card.getBoundingClientRect();return {cardFits:r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1,noOverflow:body.scrollWidth<=body.clientWidth+1,rows:body.querySelectorAll('.tfd-timeline li').length}})()`);
        assert.equal(layout.cardFits, true, JSON.stringify({locale, width, zoom, layout}));
        assert.equal(layout.noOverflow, true, JSON.stringify({locale, width, zoom, layout})); assert.equal(layout.rows, 7);
        report.layouts.push({locale, width, zoom, ...layout});
        if (width === 1440) fs.writeFileSync(path.join(output, locale + '.png'), (await win.webContents.capturePage()).toPNG());
      }
    }
    win.setSize(1440, 960); win.webContents.setZoomFactor(1);
    await js(`SoduWorkI18n.setLocale('zh-CN');void 0;`); await wait(70);
    win.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Escape'}); win.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Escape'}); await wait(70);
    assert.equal(await js('document.querySelector("[data-rq-evidence-modal]").hidden'), true);
    assert.equal(await js('document.activeElement.matches(".rq-detail-more>summary")'), true);
    await js(`activityMode='failure';void 0;`); await open('[data-rq-comments-open]');
    assert.match(await js('document.querySelector("[data-rq-comment-list]").textContent'), /部分记录未能加载.*交付版本已生成/s);
    await js(`activityMode='history-failure';void 0;`); await click('[data-rq-activity-retry]');
    assert.match(await js('document.querySelector("[data-rq-comment-list]").textContent'), /部分记录未能加载.*原始讨论/s);
    await js(`activityMode='empty';void 0;`); await click('[data-rq-activity-retry]');
    assert.match(await js('document.querySelector("[data-rq-comment-list]").textContent'), /暂无活动记录/);
    await click('[data-rq-evidence-close]'); await open('[data-rq-extensions-open]');
    assert.match(await js('document.querySelector("[data-rq-extension-list]").textContent'), /不影响执行与验收/);
    assert.match(await js('document.querySelector("[data-rq-evidence-subtitle]").textContent'), /已安装插件/);
    await click('[data-rq-evidence-close]');
    await js(`PluginUIHost.contributions=async()=>[{id:'task-panel',title:'Design review'}];void 0;`);
    await open('[data-rq-extensions-open]'); await click('[data-rq-extension-list]>button');
    assert.deepEqual(await js('pluginOpened'), [['task-panel', 'delivered-0']]);
    report.checks.push('Four locales, three viewport/zoom combinations, keyboard close/focus, partial load and retry, explicit empty state, working plugin context');
    await click('[data-rq-evidence-close]'); await js(`activityMode='normal';void 0;`);
    await click('[data-rq-execution]>summary'); await wait(200);
    assert.equal(await js('document.querySelectorAll("[data-rq-trace] .tfd-timeline").length'), 0);
    assert.ok(await js('document.querySelector("[data-rq-trace]").textContent.length>20'));
    await js(`RequirementsDetail.open('shared-only')`); await wait(60);
    assert.equal(await js('document.querySelectorAll("[data-rq-comments-open],[data-rq-extensions-open]").length'), 0);
    assert.deepEqual(await js('fixtureErrors'), []); assert.deepEqual(report.errors, []);
    report.checks.push('Execution evidence retained without duplicate history; restricted viewer gets no activity or plugin entry');
    report.ok = true;
  } catch (error) {
    report.error = String(error.stack || error);
    if (win) fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG());
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
  }
});
