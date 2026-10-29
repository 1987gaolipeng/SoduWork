'use strict';
// Native pointer input and production layout with an isolated, synthetic stream.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env};
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], {env, windowsHide: true, stdio: 'inherit'})
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const {app, BrowserWindow} = electron;
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const output = path.resolve(__dirname, '../../outputs/chat-blank-click-stability');
  fs.mkdirSync(output, {recursive: true});
  app.setPath('userData', fs.mkdtempSync(path.join(output, 'profile-')));
  const report = {ok: false, isolated: true, realModel: false, nativeInput: true, cases: []};
  let win;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code, true);
  async function mouse(point, type, extra = {}) {
    win.webContents.sendInputEvent({type, ...point, ...(type === 'mouseMove' ? {} : {button: 'left', clickCount: 1}), ...extra});
  }
  async function click(point, hold = 80) {
    await mouse(point, 'mouseMove'); await mouse(point, 'mouseDown');
    if (hold) await delay(hold); await mouse(point, 'mouseUp');
  }
  app.whenReady().then(async () => {
    win = new BrowserWindow({show: false, width: 1100, height: 820, webPreferences: {
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true,
    }});
    win.webContents.session.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*']}, (_request, callback) => callback({cancel: true}));
    await win.loadFile(path.join(__dirname, 'fixtures/long-conversation.html'));
    for (const file of ['workspace-experience.css', 'cursor.css']) {
      await win.webContents.insertCSS(fs.readFileSync(path.join(__dirname, '../theme', file), 'utf8'));
    }
    await js(`
      document.documentElement.dataset.deskPanel='workspace';
      const compose=document.createElement('div');compose.id='composePanel';document.body.appendChild(compose);compose.appendChild(document.querySelector('#root'));
      const area=document.createElement('div');area.className='nchat-content-area';area.style.position='relative';
      document.querySelector('#root').appendChild(area);area.appendChild(document.querySelector('#nchatScroll'));
      window.box=document.querySelector('#nchatScroll');box.classList.add('nchat-scroll');box.tabIndex=0;
      fill(80);ctx._snap.tools=[];ctx._snap.status='streaming';
      ctx._snap.messages=ctx._snap.messages.map((message,i)=>i%2?{role:'assistant',done:true,
        blocks:[{kind:'text',index:0,done:true,text:'Historical paragraph '+i+' short body.'}]}:message);
      ctx._snap.messages.push({role:'assistant',done:false,blocks:[{kind:'text',index:0,done:false,
        text:'## Live response\\n\\n'+('Text before the latest line.\\n\\n'.repeat(20))+'[Inspect reference](https://example.test/reference)\\n\\nSelectable streaming paragraph.'}]});
      window.tick=0;window.frames=[];window.events=[];window.capture=false;window.linkClicks=0;
      window.sample=()=>({top:box.scrollTop,height:box.scrollHeight,viewport:box.clientHeight,
        follow:box.__soduworkScrollFollow.follow,visibility:getComputedStyle(document.querySelector('[data-chat-node]')).contentVisibility,
        gap:box.scrollHeight-box.clientHeight-box.scrollTop,tick,selected:getSelection().toString()});
      for(const name of ['pointerdown','pointerup','click'])box.addEventListener(name,event=>{
        events.push({type:name,target:event.target.id||event.target.className,x:event.clientX,y:event.clientY});
      });
      box.addEventListener('click',event=>{if(event.target.closest('a')){event.preventDefault();linkClicks++;}});
      renderer._render();
      window.streamTimer=setInterval(()=>{ctx._snap.messages.at(-1).blocks[0].text+=' next';tick++;renderer._render();},25);
      function paint(){if(capture)frames.push(sample());requestAnimationFrame(paint)}requestAnimationFrame(paint);
    `);
    await delay(800);
    report.before = await js('sample()');
    const blank = await js('(()=>{const r=box.getBoundingClientRect();return{x:Math.round(r.left+15),y:Math.round(r.bottom-45)}})()');
    await js('capture=true;void 0');
    await click(blank); await delay(650);
    report.blank = await js('(()=>{capture=false;return{frames,events,after:sample()}})()');
    assert.equal(report.blank.events.find(event => event.type === 'pointerdown').target, 'nchatScroll');
    assert.ok(report.blank.frames.length > 10);
    assert.ok(report.blank.frames.every(frame => frame.follow && frame.visibility === 'auto'), 'blank clicks must not change offscreen layout or follow policy');
    assert.ok(report.blank.frames.every(frame => frame.top >= report.before.top - 2), 'a blank click must never pull output upward');
    assert.ok(report.blank.frames.every(frame => frame.gap < 30), 'only one normal text-line follow correction may be pending');
    assert.ok(Math.abs((report.blank.after.top - report.before.top) - (report.blank.after.height - report.before.height)) <= 2,
      'scroll movement must equal actual streaming growth');
    report.cases.push('blank click preserves each sampled frame and actual streaming growth');

    const link = await js(`(()=>{const r=Array.from(document.querySelectorAll('.nmsg.ai')).at(-1).querySelector('a').getBoundingClientRect();return{x:Math.round(r.left+20),y:Math.round(r.top+r.height/2)}})()`);
    report.link = {point: link, hit: await js(`document.elementFromPoint(${link.x},${link.y})?.outerHTML.slice(0,250)`)};
    await click(link, 0); await delay(200);
    assert.equal(await js('linkClicks'), 1);
    assert.equal((await js('sample()')).follow, true);
    report.cases.push('native link click stays interactive without pausing follow');

    win.webContents.sendInputEvent({type: 'mouseWheel', x: 550, y: 350, deltaY: 100, deltaX: 0});
    await delay(350);
    report.readStart = await js('sample()');
    assert.equal(report.readStart.follow, false, 'native upward wheel must pause following');
    await delay(400);
    report.readEnd = await js('sample()');
    assert.ok(report.readEnd.tick > report.readStart.tick);
    assert.ok(Math.abs(report.readEnd.top - report.readStart.top) <= 2, 'stream updates must preserve historical reading');
    report.cases.push('native wheel pauses following while stream keeps advancing');

    const text = await js(`(()=>{
      const viewport=box.getBoundingClientRect();const p=Array.from(document.querySelectorAll('.ntext p')).find(node=>{
        const rect=node.getBoundingClientRect();return rect.top>viewport.top+40&&rect.bottom<viewport.bottom-40&&node.firstChild?.nodeType===3;
      });if(!p)throw Error('No visible selection fixture');
      const range=document.createRange();range.setStart(p.firstChild,0);range.setEnd(p.firstChild,Math.min(12,p.firstChild.length));
      const r=range.getBoundingClientRect();return{start:{x:Math.ceil(r.left+1),y:Math.round(r.top+r.height/2)},end:{x:Math.floor(r.right),y:Math.round(r.top+r.height/2)}};
    })()`);
    await mouse(text.start, 'mouseMove'); await mouse(text.start, 'mouseDown');
    for (let step = 1; step <= 6; step++) {
      await mouse({x: Math.round(text.start.x + (text.end.x - text.start.x) * step / 6), y: text.start.y}, 'mouseMove', {button: 'left'});
      await delay(20);
    }
    await mouse(text.end, 'mouseUp');
    const selected = await js('getSelection().toString()');
    assert.ok(selected.length >= 5, 'native drag must select readable transcript text');
    await delay(300);
    assert.equal(await js('getSelection().toString()'), selected, 'token patches must retain the selection');
    report.cases.push('native text selection survives concurrent token updates');

    await js('getSelection().removeAllRanges();document.querySelector(".nchat-jump-latest").click();void 0');
    await delay(300);
    report.latest = await js('sample()');
    assert.equal(report.latest.follow, true);
    assert.ok(report.latest.gap < 3);
    report.cases.push('explicit latest resumes normal following');

    const scrollbar = await js(`(()=>{const r=box.getBoundingClientRect();return{x:Math.floor(r.right-3),y:Math.round(r.bottom-12),toY:Math.round(r.bottom-100),gutter:box.offsetWidth-box.clientWidth}})()`);
    assert.ok(scrollbar.gutter > 0, 'fixture must expose a measured native scrollbar gutter');
    await mouse({x: scrollbar.x, y: scrollbar.y}, 'mouseMove');
    await mouse({x: scrollbar.x, y: scrollbar.y}, 'mouseDown');
    await delay(60);
    await mouse({x: scrollbar.x, y: scrollbar.toY}, 'mouseMove', {button: 'left'});
    await delay(120);
    await mouse({x: scrollbar.x, y: scrollbar.toY}, 'mouseUp');
    await delay(180);
    report.scrollbar = await js('sample()');
    assert.equal(report.scrollbar.follow, false, 'native scrollbar drag must still pause following');
    assert.ok(report.scrollbar.top < report.latest.top - 50);
    report.cases.push('native scrollbar drag remains an intentional reading action');
    await js('clearInterval(streamTimer);void 0');
    report.ok = true;
  }).catch(error => {report.error = error.stack || String(error);}).finally(() => {
    win?.destroy();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ok: report.ok, cases: report.cases, link: report.link, error: report.error}));
    app.exit(report.ok ? 0 : 1);
  });
}
