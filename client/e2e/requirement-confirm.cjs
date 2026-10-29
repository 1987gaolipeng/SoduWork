'use strict';
// Native input and the complete desktop CSS stack, isolated from user data.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env};
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename], {
    env, windowsHide: true, stdio: 'inherit', timeout: 120000,
  });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
const {app, BrowserWindow} = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {pathToFileURL} = require('node:url'), assert = require('node:assert/strict');
const client = path.resolve(__dirname, '..'), output = path.resolve(client, '../outputs/requirement-confirm-20261020');
fs.mkdirSync(output, {recursive: true});
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-confirm-')));
app.disableHardwareAcceleration();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = {ok: false, layouts: [], checks: [], errors: [],
  boundary: 'Hidden native Electron, complete desktop CSS and production confirmation, fixture APIs; no business data'};
const styles = [...fs.readFileSync(path.join(client, 'desk.html'), 'utf8')
  .matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)/g)]
  .map(match => pathToFileURL(path.join(client, match[1])).href);
let win;
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({show: false, width: 1440, height: 960,
      webPreferences: {offscreen: true, contextIsolation: true, sandbox: true, backgroundThrottling: false}});
    win.webContents.session.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*']}, (_r, done) => done({cancel: true}));
    win.webContents.on('console-message', event => {if (event.level === 'error') report.errors.push(event.message);});
    const js = source => win.webContents.executeJavaScript(source, true);
    const key = async (keyCode, modifiers = []) => {
      win.webContents.sendInputEvent({type: 'keyDown', keyCode, modifiers});
      if (keyCode === 'Return') win.webContents.sendInputEvent({type: 'char', keyCode: '\r', modifiers});
      win.webContents.sendInputEvent({type: 'keyUp', keyCode, modifiers}); await wait(70);
    };
    const click = async selector => {
      const point = await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),b=n.getBoundingClientRect();
        const x=b.x+b.width/2,y=b.y+b.height/2;if(!n.contains(document.elementFromPoint(x,y)))throw Error('Occluded target');
        return{x,y}})()`);
      const zoom = win.webContents.getZoomFactor();
      for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({type,
        x: Math.round(point.x * zoom), y: Math.round(point.y * zoom),
        ...(type === 'mouseMove' ? {} : {button: 'left', clickCount: 1})});
      await wait(90);
    };
    const shot = async name => fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
    await win.loadFile(path.join(__dirname, 'fixtures/requirements-board.html'));
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled: true});
    assert.equal(await js(`typeof RequirementConfirm`), 'object', 'Production themed confirmation is loaded');
    await js(`Promise.all(${JSON.stringify(styles)}.map(href=>new Promise((resolve,reject)=>{
      const n=document.createElement('link');n.rel='stylesheet';n.href=href;
      n.onload=resolve;n.onerror=()=>reject(Error(href));document.head.append(n)}))).then(()=>true)`);
    await js(`window.confirm=()=>{throw Error('Native confirmation must not be used')};
      window.confirmName='设计五子棋小游戏 <img src=x onerror=alert(1)>';
      window.openConfirmation=()=>{window.confirmResult='pending';document.querySelector('#rqArchiveEntry').focus();
        RequirementConfirm.open({title:'删除需求？',name:confirmName,
          description:'需求、相关材料和执行记录将永久删除，无法恢复。',confirmLabel:'删除需求'})
          .then(value=>{window.confirmResult=value});};void 0`);
    for (const theme of ['azure', 'ruby', 'steady', 'warm', 'minimal']) {
      for (const [width, height, zoom] of [[1440, 960, 1], [820, 720, 1.25], [480, 800, 1]]) {
        win.setContentSize(width, height); win.webContents.setZoomFactor(zoom); await wait(60);
        await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)};openConfirmation();void 0`);
        await wait(80);
        const geometry = await js(`(()=>{const d=document.querySelector('.rq-action-confirm'),b=d.getBoundingClientRect(),
          footer=d.querySelector('footer').getBoundingClientRect(),s=getComputedStyle(d),root=getComputedStyle(document.documentElement);
          return{open:d.matches(':modal'),left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:innerWidth,height:innerHeight,
            centered:Math.abs((b.left+b.right)/2-innerWidth/2)<2&&Math.abs((b.top+b.bottom)/2-innerHeight/2)<2,
            overflow:d.scrollWidth>d.clientWidth+1,footerVisible:footer.top>=b.top&&footer.bottom<=b.bottom,
            background:s.backgroundColor,themeBackground:root.getPropertyValue('--bg-0').trim(),
            radius:parseFloat(s.borderRadius),focused:document.activeElement.hasAttribute('data-rq-action-cancel'),
            name:d.querySelector('.rq-action-name').textContent,injected:d.querySelectorAll('img,script').length};})()`);
        assert.equal(geometry.open, true); assert.equal(geometry.centered, true);
        assert.ok(geometry.left >= 8 && geometry.right <= geometry.width - 8);
        assert.ok(geometry.top >= 8 && geometry.bottom <= geometry.height - 8);
        assert.equal(geometry.overflow, false); assert.equal(geometry.footerVisible, true);
        assert.equal(geometry.focused, true); assert.ok(geometry.radius >= 12);
        assert.equal(geometry.name, await js('confirmName')); assert.equal(geometry.injected, 0);
        report.layouts.push({theme, requestedWidth: width, requestedHeight: height, zoom, ...geometry});
        if ((theme === 'ruby' && width !== 820) || (theme === 'warm' && width === 820)) await shot(theme + '-' + width);
        await key('Escape');
        assert.equal(await js('confirmResult'), false);
        assert.equal(await js(`document.activeElement.id`), 'rqArchiveEntry');
        assert.equal(await js(`document.querySelectorAll('.rq-action-confirm').length`), 0);
      }
    }
    report.checks.push('15 theme/viewport/zoom layouts: centered top-layer dialog, visible actions, safe plain text, cancel focus and Escape restore');
    await js(`openConfirmation();void 0`); await wait(50);
    await key('Return');
    assert.equal(await js('confirmResult'), false, 'Enter defaults to cancelling deletion');
    await js(`openConfirmation();void 0`); await wait(50);
    await key('Tab'); assert.equal(await js(`document.activeElement.hasAttribute('data-rq-action-confirm')`), true);
    await key('Tab'); assert.equal(await js(`document.activeElement.hasAttribute('data-rq-action-close')`), true);
    await key('Tab', ['shift']); assert.equal(await js(`document.activeElement.hasAttribute('data-rq-action-confirm')`), true);
    await click('[data-rq-action-confirm]'); assert.equal(await js('confirmResult'), true);
    report.checks.push('Native keyboard default Enter cancels; Tab/Shift+Tab remain inside; explicit confirmation resolves true');
    await js(`openConfirmation();window.secondResult='pending';RequirementConfirm.open({title:'重复操作'}).then(v=>secondResult=v);void 0`);
    assert.equal(await js('secondResult'), false);
    assert.equal(await js(`document.querySelectorAll('.rq-action-confirm').length`), 1);
    await js(`dispatchEvent(new Event('soduwork-data-scope-changed'));void 0`);
    assert.equal(await js('confirmResult'), false);
    assert.equal(await js(`document.querySelectorAll('.rq-action-confirm').length`), 0);
    report.checks.push('Duplicate dialog rejects; account/service change cancels pending decision and removes modal');
    win.setContentSize(480, 400); win.webContents.setZoomFactor(1.25); await wait(80);
    await js(`confirmName='特别长的需求名称'.repeat(80);openConfirmation();void 0`); await wait(70);
    const small = await js(`(()=>{const d=document.querySelector('.rq-action-confirm'),f=d.querySelector('footer').getBoundingClientRect();
      return{overflow:d.scrollWidth>d.clientWidth+1,footerVisible:f.bottom<=innerHeight-8,
        scrollable:d.querySelector('.rq-action-body').scrollHeight>d.querySelector('.rq-action-body').clientHeight}})()`);
    assert.equal(small.overflow, false); assert.equal(small.footerVisible, true); assert.equal(small.scrollable, true);
    await click('[data-rq-action-close]'); assert.equal(await js('confirmResult'), false);
    report.checks.push('Long names and 125% zoom in a short window scroll only content; close and actions remain available');
    win.setContentSize(1440, 960); win.webContents.setZoomFactor(1); await wait(80);
    await js(`window.testFiles=[{id:'material-confirm',name:'需求参考材料.md',size:80}];
      SoduWorkAPI.listAttachments=async()=>structuredClone(testFiles);
      SoduWorkAPI.deleteAttachment=async id=>{fixtureCalls.push(['deleteAttachment',id]);testFiles=testFiles.filter(f=>f.id!==id)};
      void RequirementsDetail.open(tasks[0].id)`);
    await wait(100);
    // The fixture body can be long, so bring the material action into view.
    await js(`document.querySelector('[data-rq-remove-file]').scrollIntoView({block:'center'});void 0`); await wait(60);
    await click('[data-rq-remove-file]');
    assert.equal(await js(`document.querySelector('.rq-action-name').textContent`), '需求参考材料.md');
    await key('Escape');
    assert.equal(await js(`!!document.querySelector('.rq-detail')`), true, 'Cancel does not close the underlying drawer');
    assert.equal(await js(`fixtureCalls.filter(c=>c[0]==='deleteAttachment').length`), 0);
    await click('[data-rq-remove-file]'); await click('[data-rq-action-confirm]');
    assert.deepEqual(await js(`fixtureCalls.filter(c=>c[0]==='deleteAttachment')`), [['deleteAttachment', 'material-confirm']]);
    await js(`testFiles=[{id:'material-confirm-2',name:'尚未删除的材料.md'}];void RequirementsDetail.open(tasks[0].id)`);
    await wait(100);
    await js(`document.querySelector('[data-rq-remove-file]').scrollIntoView({block:'center'});void 0`); await wait(60);
    await click('[data-rq-remove-file]');
    await js(`RequirementsDetail.close(true);void 0`);
    assert.equal(await js(`document.querySelectorAll('.rq-action-confirm').length`), 0);
    assert.equal(await js(`fixtureCalls.filter(c=>c[0]==='deleteAttachment').length`), 1);
    report.checks.push('Material removal shares themed confirmation; Escape preserves drawer, confirm removes once, closing drawer cancels pending removal');
    await js(`const shortcutsRoot=document.createElement('section');shortcutsRoot.id='shortcutsPanel';shortcutsRoot.hidden=true;
      document.body.append(shortcutsRoot);
      window.confirmNavigation=[];window.WorkspaceHost={open:(...args)=>confirmNavigation.push(args)};
      window.soduWorkAPI={getWindowTitlebar:async()=>({mode:'native',nativeMenu:false}),
        setWindowShortcuts:async()=>({ok:true}),onWindowMenuCommand:fn=>{window.fixtureNativeCommand=fn}};
      confirmName='设计五子棋小游戏';void 0`);
    for (const file of ['core/shortcut-bindings.js', 'components/settings/shortcut-settings.js', 'components/workspace/window-menu.js']) {
      await js(fs.readFileSync(path.join(client, file), 'utf8') + '\nvoid 0');
    }
    await js(`openConfirmation();void 0`); await wait(60);
    for (const [code, modifiers] of [['N', ['control']], ['O', ['control']], ['F', ['alt']], ['F10', []]]) {
      await key(code, modifiers);
      assert.equal(await js('confirmNavigation.length'), 0);
      assert.equal(await js(`document.querySelector('.rq-action-confirm').contains(document.activeElement)`), true);
      assert.equal(await js(`document.querySelector('.wm-popup').hidden`), true);
    }
    await js(`fixtureNativeCommand('new');fixtureNativeCommand('about');void 0`);
    assert.equal(await js('confirmNavigation.length'), 0);
    assert.equal(await js(`document.querySelector('.wm-dialog').open`), false);
    await key('Escape'); await key('O', ['control']);
    assert.equal(await js(`confirmNavigation.at(-1)[0]`), 'settings');
    await js(`fixtureNativeCommand('new');void 0`);
    assert.equal(await js(`confirmNavigation.at(-1)[0]`), 'create');
    report.checks.push('Real shortcut/window-menu capture listeners and simulated native menu callback cannot navigate behind confirmation; actions resume after cancel');
    assert.deepEqual(report.errors, []); assert.deepEqual(await js('fixtureErrors'), []);
    report.ok = true;
  } catch (error) {
    report.error = String(error.stack || error);
    if (win) await win.webContents.capturePage().then(image => fs.writeFileSync(path.join(output, 'failure.png'), image.toPNG())).catch(() => {});
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
  }
});
