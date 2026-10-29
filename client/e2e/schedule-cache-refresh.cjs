'use strict';
// Use real renderers and controllers with isolated API doubles, without business Hub, model, or production data access.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron, assert = require('node:assert/strict');
  const output = process.argv[2];
  if (!output || !path.isAbsolute(output)) throw Error('Absolute evidence directory required');
  fs.mkdirSync(output, { recursive: true });
  const profile = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'soduwork-schedule-refresh-'));
  app.setPath('userData', profile);
  const report = { ok: false, proof: 'Production schedule UI in offscreen Chromium; isolated API responses',
    checks: [], scenarios: [], screenshots: [], failures: [], requests: [] };
  let win;
  const js = source => win.webContents.executeJavaScript(source, true);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(source) {
    for (let i = 0; i < 120; i++) { if (await js(source)) return; await wait(25); }
    throw Error('Timeout: ' + source);
  }
  function fixture() {
    const file = path.join(__dirname, 'fixtures/schedule-once-editor.html'), root = path.dirname(file);
    const css = (name, seen = new Set()) => {
      if (seen.has(name)) return ''; seen.add(name);
      return fs.readFileSync(name, 'utf8').replace(/@import\s+["']([^"']+)["'];/g,
        (_, child) => css(path.resolve(path.dirname(name), child), seen));
    };
    return fs.readFileSync(file, 'utf8')
      .replace(/<link rel="stylesheet" href="([^"]+)">/g,
        (_, name) => '<style>' + css(path.resolve(root, name)) + '</style>')
      .replace(/<script src="([^"]+)"><\/script>/g, (_, name) => '<script>' +
        fs.readFileSync(path.resolve(root, name), 'utf8').replace(/<\/script/gi, '<\\/script') + '</script>')
      .replace('<script>openSchedulePanel();</script>', `<script>
        window.mode='ok'; window.pending=[]; window.listCalls=0; window.notices=[];
        petSay = text => notices.push(text);
        SoduWorkAPI.listSchedules=async()=>{
          listCalls++;
          if(mode==='defer') return new Promise((resolve,reject)=>pending.push({resolve,reject}));
          if(mode==='fail') throw Object.assign(Error('HTTP 503 服务暂时不可用 <b data-error-markup>详情</b>'),{status:503});
          return rows.map(row=>({...row}));
        };
        SoduWorkAPI.deleteSchedule=async()=>{throw Object.assign(Error('HTTP 403 无权删除'),{status:403});};
        SoduWorkAPI.updateSchedule=async()=>{throw Object.assign(Error('HTTP 403 无权保存'),{status:403});};
        window.pageReady=openSchedulePanel();
      </script>`);
  }
  async function load() {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(fixture()));
    await js('pageReady');
  }
  async function click(selector) {
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});
      if(!e)throw Error('Missing click target: '+${JSON.stringify(selector)});
      e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();
      const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);
      if(!e.contains(document.elementFromPoint(x,y)))throw Error('Click obscured');return{x,y};})()`);
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp'])
      win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await wait(50);
  }
  async function state(name, shot = false) {
    const result = await js(`({text:document.querySelector('#schBody').innerText,
      titles:[...document.querySelectorAll('.sch-i-title')].map(e=>e.textContent),
      warning:document.querySelector('.sch-stale-notice')?.innerText||'',
      warningRole:document.querySelector('.sch-stale-notice')?.getAttribute('role'),
      retry:!!document.querySelector('.sch-stale-notice button'),
      error:!!document.querySelector('.sch-load-fail'),
      disabledActions:[...document.querySelectorAll('.sch-item [data-act]')].filter(e=>e.disabled).length,
      notice:notices.at(-1)||'',loadError:_schLoadError,
      shown:document.querySelector('#schPanel').classList.contains('show')})`);
    report.scenarios.push({ name, ...result });
    if (shot) {
      await wait(100);
      const file = path.join(output, name + '.png');
      fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); report.screenshots.push(file);
    }
    return result;
  }
  async function check(name, run) {
    try { await load(); await run(); assert.deepEqual(await js('errors'), []); report.checks.push(name); }
    catch (error) { report.failures.push({ name, error: String(error.stack || error) }); }
  }
  async function failCached() {
    await js("mode='fail'; closeSchedulePanel(); openSchedulePanel()");
  }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1280, height: 950,
      webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (request, callback) => { report.requests.push(request.url); callback({ cancel: true }); });
    await check('cached 503 keeps readable cards and explicitly marks stale data with retry', async () => {
      const healthy = await state('healthy'); assert.equal(healthy.warning, ''); assert.equal(healthy.titles.length, 2);
      await failCached(); const failed = await state('cached-failure-wide', true);
      assert.deepEqual(failed.titles, healthy.titles);
      assert.match(failed.warning, /刷新失败/); assert.match(failed.warning, /上次|旧|缓存/);
      assert.match(failed.warning, /可能|最新/); assert.match(failed.warning, /503/);
      assert.equal(failed.warningRole, 'status'); assert.equal(failed.retry, true);
      assert.equal(failed.disabledActions, 0);
      assert.equal(await js("!!document.querySelector('.sch-stale-notice [data-error-markup]')"), false);
      assert.match(failed.warning, /<b data-error-markup>详情<\/b>/);
      win.setSize(390, 900); await wait(80); await state('cached-failure-narrow', true);
      const geometry = await js(`(()=>{const n=document.querySelector('.sch-stale-notice'),b=n.querySelector('button'),
        r=n.getBoundingClientRect(),q=b.getBoundingClientRect();return{overflow:n.scrollWidth-n.clientWidth,
        inside:q.left>=r.left&&q.right<=r.right&&q.top>=r.top&&q.bottom<=r.bottom};})()`);
      assert.ok(geometry.overflow <= 1); assert.equal(geometry.inside, true); win.setSize(1280, 950);
    });
    await check('retry preserves warning and cards until success then shows fresh server state', async () => {
      await failCached(); await js("mode='defer'"); await click('.sch-stale-notice button');
      assert.equal(await js('pending.length'), 1);
      assert.equal(await js("document.querySelector('.sch-stale-notice button').disabled"), true);
      await js("document.querySelector('.sch-stale-notice button').click()");
      assert.equal(await js('pending.length'), 1);
      const waiting = await state('retry-pending'); assert.equal(waiting.titles.length, 2);
      assert.match(waiting.warning, /刷新失败/);
      await js("pending[0].resolve([{...rows[0],title:'服务端已更新的计划',enabled:false}]); void 0");
      await until("!_schLoading"); const recovered = await state('recovered', true);
      assert.deepEqual(recovered.titles, ['服务端已更新的计划']); assert.equal(recovered.warning, '');
      assert.equal(recovered.retry, false); assert.equal(recovered.loadError, '');
      assert.match(recovered.text, /已停用/);
    });
    await check('failed retry retains cache and exposes another actionable retry', async () => {
      await failCached(); await click('.sch-stale-notice button'); await until('!_schLoading');
      const failed = await state('retry-failed'); assert.equal(failed.titles.length, 2);
      assert.match(failed.warning, /503/); assert.equal(failed.retry, true);
      assert.equal(await js("document.querySelector('.sch-stale-notice button').disabled"), false);
    });
    await check('successful retry refreshes cards while preserving an editor opened during the request', async () => {
      await failCached(); await js("mode='defer'"); await click('.sch-stale-notice button');
      await click('.sch-item[data-sid="pending"] [data-act="edit"]');
      await until("!!document.querySelector('#schEditorLayer.show')");
      await js("document.querySelector('#schTitle').value='正在填写的新草稿';pending[0].resolve([{...rows[0],title:'刷新后的服务端计划'}]);void 0");
      await until('!_schLoading');
      assert.equal(await js("document.querySelector('#schTitle').value"), '正在填写的新草稿');
      assert.equal(await js("!!document.querySelector('#schEditorLayer.show')"), true);
      const fresh = await state('recovered-during-edit'); assert.equal(fresh.warning, '');
      assert.deepEqual(fresh.titles, ['刷新后的服务端计划']);
      await click('#schCancel'); assert.equal((await state('recovered-after-edit')).warning, '');
    });
    await check('empty-cache 503 keeps the existing failure and retry recovers', async () => {
      await js("dispatchEvent(new Event('soduwork-data-scope-changed'));mode='fail';openSchedulePanel()");
      const failed = await state('empty-failure', true); assert.equal(failed.titles.length, 0);
      assert.equal(failed.error, true); assert.match(failed.text, /503/); assert.equal(failed.warning, '');
      await js("mode='ok'"); await click('.sch-load-fail button'); await until('!_schLoading');
      const recovered = await state('empty-recovered'); assert.equal(recovered.titles.length, 2);
      assert.equal(recovered.error, false); assert.equal(recovered.loadError, '');
    });
    await check('stale cards remain editable and server rejection never becomes success', async () => {
      await failCached(); await click('.sch-item[data-sid="pending"] [data-act="del"]');
      await click('.sch-item[data-sid="pending"] [data-c="yes"]');
      assert.match(await js('notices.at(-1)'), /没删掉|删除失败/);
      assert.equal(await js("document.querySelectorAll('.sch-item').length"), 2);
      await click('.sch-item[data-sid="pending"] [data-act="edit"]');
      await until("document.querySelector('#schEditorLayer.show') && document.querySelector('#schReady.ready')");
      assert.equal(await js("document.querySelectorAll('#schRetry').length"), 1);
      await click('#schSave'); await until("!document.querySelector('#schSave').disabled");
      assert.match(await js('notices.at(-1)'), /没保存上|保存失败/);
      assert.equal(await js("!!document.querySelector('#schEditorLayer.show')"), true);
      assert.equal(await js("document.querySelector('#schTitle').value"), '固定日期完成一次工作');
      assert.equal(await js("notices.some(s=>/已保存|删掉了定时任务/.test(s))"), false);
      await click('#schCancel'); assert.match((await state('rejected-operation')).warning, /刷新失败/);
    });
    await check('identity change clears stale warning and ignores a late failed previous-account retry', async () => {
      await failCached(); await js("mode='defer';window.oldLoad=_loadSch();void 0");
      await js("dispatchEvent(new Event('soduwork-data-scope-changed'));rows=[{...rows[0],id:'new',title:'新账号计划'}];mode='ok';openSchedulePanel()");
      await js("pending[0].reject(Error('旧账号 HTTP 503'));oldLoad");
      const fresh = await state('identity-changed'); assert.deepEqual(fresh.titles, ['新账号计划']);
      assert.equal(fresh.warning, ''); assert.equal(fresh.loadError, '');
    });
    await check('closed request cannot replace reopened schedule data or warning', async () => {
      await js("mode='defer';window.oldLoad=_loadSch();void 0");
      await js("closeSchedulePanel();rows=[{...rows[0],title:'重新打开后的最新计划'}];mode='ok';window.newLoad=openSchedulePanel();void 0");
      // Resolve the old request before awaiting a new one so incorrect Promise reuse fails instead of hanging.
      await js("pending[0].reject(Error('关闭前 HTTP 503'));Promise.all([oldLoad,newLoad])");
      const fresh = await state('closed-and-reopened');
      assert.deepEqual(fresh.titles, ['重新打开后的最新计划']); assert.equal(fresh.warning, '');
      assert.equal(fresh.loadError, ''); assert.equal(fresh.shown, true);
    });
    await check('same-plan navigation after reopen waits for its own response before opening the editor', async () => {
      await js("mode='defer';window.oldLoad=openSchedulePanel({scheduleId:'pending'});closeSchedulePanel();window.newLoad=openSchedulePanel({scheduleId:'pending'});void 0");
      assert.equal(await js('pending.length'), 2);
      await js("pending[0].resolve([{...rows[0],title:'关闭前请求的旧计划'}]);oldLoad");
      const beforeCurrent = await js(`({editor:!!document.querySelector('#schEditorLayer.show'),
        target:document.querySelector('#schPanel').dataset.scheduleFocus,loading:!!_schLoading})`);
      // Await response B even if A consumes its target incorrectly, preventing a false pass that misses the newer response.
      await js("pending[1].resolve([{...rows[0],title:'本次导航的最新计划'}]);newLoad");
      assert.deepEqual(beforeCurrent, { editor: false, target: 'pending', loading: true });
      assert.equal(await js("!!document.querySelector('#schEditorLayer.show')"), true);
      assert.equal(await js("document.querySelector('#schTitle').value"), '本次导航的最新计划');
      assert.deepEqual((await state('same-plan-reopened')).titles, ['本次导航的最新计划']);
    });
    await check('late completion after close never reopens the panel or editor', async () => {
      await js("mode='defer';window.oldLoad=openSchedulePanel({scheduleId:'pending'});closeSchedulePanel();void 0");
      await js("pending[0].resolve(rows);oldLoad");
      assert.equal((await state('closed')).shown, false);
      assert.equal(await js("!!document.querySelector('#schEditorLayer.show')"), false);
    });
    assert.deepEqual(report.requests, []); report.ok = report.failures.length === 0;
  }).catch(error => report.failures.push({ name: 'harness', error: String(error.stack || error) })).finally(() => {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(report.ok ? 0 : 1);
  });
}
