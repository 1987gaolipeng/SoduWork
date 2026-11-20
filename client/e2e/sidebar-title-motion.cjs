'use strict';
// Real Chromium layout/animation with synthetic chats; no Hub or model calls.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = require('../scripts/start-client.cjs').cleanEnvironment(process.env);
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 90000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const root = path.resolve(__dirname, '..'), output = process.argv[2];
  assert.ok(output && path.isAbsolute(output), 'An absolute evidence directory is required');
  fs.mkdirSync(output, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-title-motion-'));
  app.setPath('userData', path.join(temp, 'profile'));
  const fixture = path.join(temp, 'fixture.html');
  const styles = [...fs.readFileSync(path.join(root, 'desk.html'), 'utf8')
    .matchAll(/<link\s+rel=["']stylesheet["']\s+href=["']([^"']+)["']/g)].map(match => match[1]);
  fs.writeFileSync(fixture, `<!doctype html><html data-theme="azure"><meta charset="utf-8">
    <base href="${pathToFileURL(root + path.sep).href}"><title>Sidebar title motion regression</title>
    ${styles.map(file => '<link rel="stylesheet" href="' + file + '">').join('\n')}
    <style>body{margin:0;font:14px var(--font-ui);background:var(--bg-0)}
    #sidebar{width:260px;height:500px;overflow:auto;padding:12px;background:var(--bg-1)}</style>
    <div class="workspace-shell"><aside class="ws-side" id="sidebar"><div id="wsSideScroll"><section id="wsChatsBox"><div id="chats"></div></section>
    <section id="wsPinnedBox"><div id="pinned"></div></section></div></aside></div>
    <script src="components/workspace/workspace-chat-history.js"></script>
    <script src="components/workspace/workspace-sidebar-state.js"></script>
    <script src="components/workspace/workspace-chat-list.js"></script>
    <script>
      window.errors=[];addEventListener('error',e=>errors.push(e.message));
      window.opened=[];window.WorkspaceHost={open:(_page,options)=>opened.push(options.chatId)};
      window.SoduWorkAPI={taskStorageKey:()=> 'title-motion-fixture'};
      window.renames=[];window.soduWorkAPI={conversationSession:{renameHistory:async(id,title)=>{
        renames.push({id,title});return {ok:true,id,title,titleUpdatedAt:Date.now()};}}};
      window.side={...WorkspaceChatHistory,root:document.querySelector('#sidebar'),active:'create',activeChatId:'',
        chatItems:[],chatNames:new Map(),wsT:(_key,text)=>text,icon:()=>'',mount:()=>{},_empty:()=>{},
        chats:document.querySelector('#chats'),pinnedChats:document.querySelector('#pinned')};
      window.list=WorkspaceChatList.create(side);Object.assign(side,list);
      window.find=id=>document.querySelector('[data-chat-id="'+id+'"]');
      window.text=id=>find(id).querySelector('.ws-chat-title-text');
      window.x=id=>{const t=getComputedStyle(text(id)).transform;return t==='none'?0:new DOMMatrixReadOnly(t).m41};
      window.hover=id=>find(id).parentElement.dispatchEvent(new MouseEvent('mouseenter'));
      window.leave=id=>find(id).parentElement.dispatchEvent(new MouseEvent('mouseleave'));
      window.set=(id,title)=>list.upsertChat({id,title,usedHarnesses:['pi'],state:'completed'});
      window.frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      window.wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    </script></html>`);
  let win;
  const report = { ok: false, cases: [], boundary: 'Production sidebar in isolated Electron, synthetic chats; not a real-model test.' };
  const js = code => win.webContents.executeJavaScript(`(async()=>{${code}})()`, true);
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 900, height: 650,
      webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, done) => done({ cancel: true }));
    await win.loadFile(fixture);
    const labels = ['整理出行计划，核对路线、交通和景点安排并保留已有记录',
      'Review the project requirements, implementation details and remaining verification steps',
      '旅行計画を整理して交通機関と観光地の詳細を確認してください',
      '여행 계획을 정리하고 교통편과 관광지의 세부 정보를 확인해 주세요'];
    await js(`set('long',${JSON.stringify(labels[0])});set('short','短标题');await frame();`);
    for (const width of [200, 280, 360]) for (const label of labels) {
      console.log('Checking width ' + width + ', language ' + labels.indexOf(label));
      const result = await js(`leave('long');find('long').blur();
        await Promise.all(text('long').getAnimations().map(a=>a.finished.catch(()=>{})));await frame();
        document.querySelector('#sidebar').style.width='${width}px';set('long',${JSON.stringify(label)});
        hover('long');await frame();await frame();const a=text('long').getAnimations()[0];
        const duration=a.effect.getTiming().duration;a.currentTime=500+duration/2;await frame();
        const half=x('long');a.currentTime=500+duration+5000;await frame();const end=x('long');
        const t=text('long').getBoundingClientRect(),v=find('long').querySelector('.ws-chat-title').getBoundingClientRect();
        const controls=find('long').parentElement.querySelector('.ws-chat-actions').getBoundingClientRect();
        return {half,end,tail:t.right,edge:Math.min(v.right,controls.left-8),scroll:find('long').querySelector('.ws-chat-title').scrollLeft};`);
      assert.ok(result.half < 0 && result.end < result.half, JSON.stringify(result));
      assert.ok(Math.abs(result.tail - result.edge) < 1.5, JSON.stringify(result));
      assert.equal(result.scroll, 0);
    }
    report.cases.push('Four languages at three sidebar widths: fractional transforms reveal the complete tail, clear controls and hold without looping');
    await js(`leave('long');await wait(260);hover('long');await wait(800);`);
    const stability = await js(`const a=text('long').getAnimations()[0],before=x('long');
      find('long').focus();set('long',find('long').textContent);await frame();
      const same=a===text('long').getAnimations()[0],after=x('long');
      document.querySelector('#sidebar').style.width='240px';await frame();await frame();
      return {same,before,after,resized:x('long')};`);
    assert.equal(stability.same, true, JSON.stringify(stability));
    assert.ok(stability.after <= stability.before && Math.abs(stability.after-stability.before)<8, JSON.stringify(stability));
    assert.ok(stability.resized <= stability.after + 1, JSON.stringify(stability));
    const samples = await js(`const values=[];for(let i=0;i<45;i++){await new Promise(requestAnimationFrame);values.push(x('long'));}return values;`);
    assert.ok(samples.some(x => Math.abs(x-Math.round(x)) > 0.05), 'Motion must retain subpixel positions');
    assert.ok(samples.every((x,i) => i===0 || x<=samples[i-1]+0.1), 'No restart during hover');
    report.motionSamples = samples;
    report.cases.push('Focus, live row repaint and sidebar resize preserve motion; measured positions are fractional and monotonic');
    await js(`find('long').blur();leave('long');await wait(280);`);
    assert.equal(await js(`return x('long');`), 0);
    assert.equal(await js(`return text('long').getAnimations().length;`), 0);
    await js(`hover('short');await frame();await frame();`);
    assert.equal(await js(`return text('short').getAnimations().length;`), 0);
    await js(`leave('short');hover('long');await wait(750);find('long').parentElement.dispatchEvent(new Event('dragstart'));`);
    assert.equal(await js(`return x('long');`), 0);
    assert.equal(await js(`return text('long').getAnimations().length;`), 0);
    report.cases.push('Pointer leave returns smoothly and releases animation; short titles stay still; drag start stops motion');
    await win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name:'prefers-reduced-motion',value:'reduce' }] });
    await js(`hover('long');await wait(650);`);
    assert.equal(await js(`return text('long').getAnimations().length;`), 0);
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    await js(`leave('long');hover('long');await wait(750);`);
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name:'prefers-reduced-motion',value:'reduce' }] });
    await js(`await frame();`);
    assert.equal(await js(`return x('long');`), 0);
    win.webContents.debugger.detach();
    await js(`find('long').click();`);
    assert.deepEqual(await js(`return opened;`), ['long']);
    assert.equal(await js(`return Array.from(find('long').querySelectorAll('[title]')).some(el=>el.title)||!!find('long').title;`), false);
    report.cases.push('Reduced motion at hover and during animation is respected; navigation and tooltip-free accessible title remain');
    const menu = await js(`const row=find('long').parentElement;row.querySelector('.ws-chat-more').click();await frame();
      const menu=row.querySelector('.ws-chat-menu');return {open:menu.matches(':popover-open'),
        hit:[...menu.querySelectorAll('button')].filter(e=>!e.hidden&&!e.disabled).every(e=>{
          const b=e.getBoundingClientRect();return e.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2));})};`);
    assert.deepEqual(menu,{open:true,hit:true});
    await js(`find('long').parentElement.querySelector('.ws-chat-rename').click();
      document.querySelector('.ws-chat-rename-input').value='改名后仍能完整读取的会话标题，用于确认标题内部的动画节点保留';
      document.querySelector('.ws-chat-rename-save').click();await wait(100);`);
    assert.equal(await js(`return renames.length;`),1);
    assert.equal(await js(`return text('long').textContent===renames[0].title;`),true);
    assert.equal(await js(`return !!document.querySelector('.ws-chat-rename-dialog');`),false);
    await js(`find('long').blur();`);
    assert.equal(await js(`return document.querySelectorAll('.ws-chat-more[aria-expanded="true"]').length;`),0);
    await win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
    await js(`leave('long');hover('long');await wait(750);window.removedText=text('long');list.removeChat('long');await frame();`);
    assert.equal(await js(`return removedText.getAnimations().length;`),0);
    win.webContents.debugger.detach();
    report.cases.push('Popover actions remain hit-testable; production rename dialog updates the animated title using a fixture IPC reply; row removal cancels animation');
    assert.deepEqual(await js(`return errors;`), []);
    fs.writeFileSync(path.join(output,'sidebar.png'),(await win.webContents.capturePage()).toPNG());
    report.ok = true;
  }).catch(error => { report.error = error.stack; })
    .finally(() => { fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
      console.log(JSON.stringify(report));win?.destroy();app.exit(report.ok?0:1); });
}
