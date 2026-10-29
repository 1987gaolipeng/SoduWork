'use strict';
// Isolated Electron interaction tests. No real directory or notification sends.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 90000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..'), output = path.resolve(client, '../outputs/library-share');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-library-share-'));
  fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(temporary, 'profile'));
  const report = { ok: false, boundary: 'Real production panel, dialog and CSS in isolated Electron; synthetic member/API responses, no real notifications.', cases: [], screenshots: [] };
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  let win;
  const js = code => win.webContents.executeJavaScript(code, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code) { for (let i = 0; i < 120; i++) { if (await js(code)) return; await delay(40); } throw Error('Timed out: ' + code); }
  async function click(selector) {
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||!e.checkVisibility())throw Error('Unavailable '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
    await delay(80);
  }
  async function open() { await click('[data-library-menu-toggle="item-share-fixture"]'); await click('[data-library-share="share-fixture"]'); await until('document.querySelector(".library-share-dialog")?.open'); }
  async function centered() {
    const r = await js(`(()=>{const r=document.querySelector('.library-share-dialog').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,vw:innerWidth,vh:innerHeight}})()`);
    assert.ok(Math.abs(r.x + r.width / 2 - r.vw / 2) < 2, 'Share dialog must be centered horizontally: ' + JSON.stringify(r));
    assert.ok(Math.abs(r.y + r.height / 2 - r.vh / 2) < 2, 'Share dialog must be centered vertically: ' + JSON.stringify(r));
    assert.ok(r.x >= 10 && r.y >= 10 && r.x + r.width <= r.vw - 10 && r.y + r.height <= r.vh - 10, 'Dialog must remain within viewport');
  }
  async function shot(name) {
    await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); await delay(120);
    const file = path.join(output, name + '.png'); fs.writeFileSync(file, (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); report.screenshots.push(file);
  }
  async function verifySubmitHover(storage) {
    for (const skin of ['box', 'default']) {
      await js(`document.documentElement.dataset.skin=${JSON.stringify(skin)};void 0;`);
      await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      const point = await js(`(()=>{const r=document.querySelector('.library-share-submit').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });
      win.webContents.sendInputEvent({ type: 'mouseMove', ...point }); await delay(160);
      const style = await js(`(()=>{const b=document.querySelector('.library-share-submit'),s=getComputedStyle(b),c=document.createElement('canvas').getContext('2d');function rgb(v){c.fillStyle=v;c.fillRect(0,0,1,1);return [...c.getImageData(0,0,1,1).data].slice(0,3)}return{hover:b.matches(':hover'),disabled:b.disabled,fg:rgb(s.color),bg:rgb(s.backgroundColor),opacity:s.opacity}})()`);
      const luminance = rgb => rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
      const levels = [luminance(style.fg), luminance(style.bg)].sort((a, b) => b - a);
      const contrast = (levels[0] + .05) / (levels[1] + .05);
      assert.equal(style.hover, true); assert.equal(style.disabled, false);
      assert.ok(contrast >= 4.5, `${storage}/${skin} hover text contrast: ${contrast.toFixed(2)}`);
      await shot(`${storage}-share-hover-${skin}`);
      report.cases.push(`${storage}/${skin}: native pointer hover keeps primary submit readable (${contrast.toFixed(2)}:1)`);
    }
    await js("delete document.documentElement.dataset.skin;void 0;");
  }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1360, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, done) => done({ cancel: true }));
    await win.loadFile(path.join(__dirname, 'fixtures/library.html'));
    const sheets = [...read('desk.html').matchAll(/<link\s+rel=["']stylesheet["']\s+href=["']([^"']+)["']/g)].map(m => m[1]);
    // Include the new scoped sheet when testing before the shell integration lands.
    if (fs.existsSync(path.join(client, 'components/panels/library-share-dialog.css')) && !sheets.includes('components/panels/library-share-dialog.css')) sheets.splice(sheets.indexOf('components/panels/panels-library.css') + 1, 0, 'components/panels/library-share-dialog.css');
    const urls = sheets.map(file => require('node:url').pathToFileURL(path.join(client, file)).href);
    await js(`(async()=>{document.querySelectorAll('link[rel=stylesheet]').forEach(e=>e.remove());await Promise.all(${JSON.stringify(urls)}.map(href=>new Promise((resolve,reject)=>{const e=document.createElement('link');e.rel='stylesheet';e.href=href;e.onload=resolve;e.onerror=reject;document.head.append(e)})));})()`);
    await js(`window.calls=[];window.notices=[];window.petSay=m=>notices.push(m);window.failShare=false;window.waitShare=false;window.releaseShare=null;window.SoduWorkAPI={taskStorageKey:()=>"share-user",getLibraryStorageStatus:async()=>({local:{available:true}}),listLibrary:async()=>({items:[{id:'share-fixture',filename:'资料分享.txt',title:'资料分享',size:1024,kind:'document',updatedAt:'2026-10-13T08:00:00Z'}],folders:[]}),listLibraryShareMembers:async()=>({meId:'self',members:[{id:'self',name:'本人',isMe:true},{id:'alice',name:'张一',username:'alice'},{id:'bob',name:'李二',username:'bob'},{id:'charlie',name:'王三',username:'charlie'}]}),shareLibraryItem:async(id,ids,note)=>{calls.push({id,ids,note});if(failShare)throw Error('分享失败：隔离测试');if(waitShare)await new Promise(r=>releaseShare=r);return{ok:true,shared:ids.length};}};void 0;`);
    for (const file of ['components/panels/library-file-icons.js', 'components/panels/panels-library-dialogs.js', 'components/panels/panels-library.js']) await js(read(file) + '\nvoid 0;');
    await js('openLibraryPanel();void 0;'); await until('document.querySelector("[data-library-share]")');
    await open(); await centered();
    assert.equal(await js('document.querySelector(".library-share-submit").disabled'), true);
    await js('document.querySelector(".library-share-card").requestSubmit();void 0;');
    assert.equal(await js('calls.length'), 0, 'Empty selection must not send even on form submission');
    assert.equal(await js('document.querySelectorAll(".library-share-member input").length'), 3);
    await click('.library-share-member:has(input[value="alice"])'); await click('.library-share-member:has(input[value="bob"])');
    assert.equal(await js('document.querySelectorAll(".library-share-member input:checked").length'), 2);
    assert.match(await js('document.querySelector("[data-library-share-status]").textContent'), /2/);
    await verifySubmitHover('remote');
    await shot('share-wide-two-members'); report.cases.push('Wide dialog centered, sender excluded, whole member rows select two recipients and count updates');
    await js(`document.querySelector('[data-library-share-search]').value='张';document.querySelector('[data-library-share-search]').dispatchEvent(new Event('input',{bubbles:true}));void 0;`);
    assert.equal(await js('[...document.querySelectorAll(".library-share-member")].filter(e=>e.checkVisibility()).length'), 1);
    assert.equal(await js('document.querySelectorAll(".library-share-member input:checked").length'), 2);
    await js(`document.querySelector('[data-library-share-note]').value='请查阅这份文件';void 0;`);
    await click('.library-share-submit'); await until('!document.querySelector(".library-share-dialog")');
    assert.deepEqual(await js('calls[0]'), { id: 'share-fixture', ids: ['alice', 'bob'], note: '请查阅这份文件' });
    report.cases.push('Search preserves multiple selection; submit sends both IDs and note once');
    await open(); await click('[data-library-share-cancel]'); assert.equal(await js('calls.length'), 1);
    await open(); await click('.library-share-member:has(input[value="alice"])'); await js('failShare=true;document.querySelector("[data-library-share-note]").value="保留这段附言";void 0;');
    await click('.library-share-submit'); await until('document.querySelector("[data-library-share-error]")?.textContent.includes("隔离测试")');
    assert.equal(await js('document.querySelector(".library-share-dialog").open'), true);
    assert.equal(await js('document.querySelector("input[value=alice]").checked'), true);
    assert.equal(await js('document.querySelector("[data-library-share-note]").value'), '保留这段附言');
    assert.equal(await js('document.querySelector(".library-share-submit").disabled'), false);
    await js('failShare=false;waitShare=true;void 0;'); await click('.library-share-submit');
    assert.equal(await js('document.querySelector(".library-share-submit").disabled'), true);
    await js('document.querySelector(".library-share-card").requestSubmit();void 0;'); assert.equal(await js('calls.length'), 3);
    await js('releaseShare();void 0;'); await until('!document.querySelector(".library-share-dialog")');
    report.cases.push('Cancel makes no request; failed share retains members and note; retry blocks duplicate submission');
    await js('waitShare=false;void 0;'); win.setSize(420, 580); await delay(180); await open(); await centered();
    await shot('share-narrow'); await click('[data-library-share-cancel]');
    report.cases.push('Narrow dialog centered and contained; member list scrolls without hiding submit/cancel');
    win.setSize(1200, 800); await delay(100); await open();
    await js('dispatchEvent(new Event("soduwork-data-scope-changed"));void 0;'); await until('!document.querySelector(".library-share-dialog")');
    assert.equal(await js('calls.length'), 3); report.cases.push('Account switch closes picker without sending');
    await js(`window.localCopies=[];window.localRequests=[];window.failShare=false;window.SoduWorkAPI.getLibraryStorageStatus=async()=>({local:{available:true},remote:{available:false,backend:''}});window.SoduWorkAPI.listLibrary=async()=>({items:[{id:'local-share',filename:'renamed.txt',title:'renamed',size:12,kind:'document',backend:'local'}],folders:[]});window.SoduWorkAPI.copyLocalLibraryItemToRemote=async(id,target)=>{localCopies.push({id,target});throw Error('Must not create a remote copy')};window.SoduWorkAPI.shareLibraryItem=async(id,ids,note,options)=>{localRequests.push({id,ids,note,options});if(failShare)throw Error('分享失败：隔离测试');return{ok:true}};openLibraryPanel();void 0;`);
    await until('document.querySelector("[data-library-share=local-share]")');
    const openLocal = async () => { await click('[data-library-menu-toggle="item-local-share"]'); await click('[data-library-share="local-share"]'); await until('document.querySelector(".library-share-dialog")?.open'); };
    await openLocal();
    assert.match(await js('document.querySelector(".library-share-dialog").textContent'), /是否存入资料库由对方决定/);
    await click('[data-library-share-cancel]'); assert.equal(await js('localCopies.length'), 0);
    await openLocal(); await click('.library-share-member:has(input[value="alice"])');
    await verifySubmitHover('local');
    await js('failShare=true;void 0;'); await click('.library-share-submit');
    await until('document.querySelector("[data-library-share-error]")?.textContent.includes("隔离测试")');
    assert.deepEqual(await js('localCopies'), []);
    assert.equal(await js('localRequests.at(-1).id'), 'local-share');
    await js('failShare=false;void 0;'); await click('.library-share-submit'); await until('!document.querySelector(".library-share-dialog")');
    assert.equal(await js('localCopies.length'), 0, 'Sharing must never create a remote library copy');
    assert.equal(await js('localRequests[0].options.requestId === localRequests[1].options.requestId'), true);
    report.cases.push('Local sharing works without remote storage; cancel reads no bytes; notification retries preserve the request ID without a library copy');

    await js(`SoduWorkAPI.shareLibraryItem=async()=>{throw Error('这次分享已发送，内容或成员已变化，请重新打开分享窗口');};void 0;`);
    await openLocal(); await click('.library-share-member:has(input[value="alice"])'); await click('.library-share-submit');
    await until('document.querySelector("[data-library-share-error]")?.textContent.includes("重新打开分享窗口")');
    await shot('local-share-request-conflict');
    assert.equal(await js('document.querySelector("input[value=alice]").checked'), true);
    await click('[data-library-share-cancel]');
    report.cases.push('A changed retry request remains in the dialog with its selected recipients and clear recovery text');
    report.ok = true;
  }).catch(error => { report.error = error.stack || String(error); process.exitCode = 1; }).finally(() => {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); if (win && !win.isDestroyed()) win.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
