'use strict';
// Real desk DOM/scripts and native input, isolated synthetic bridge and no network.
const electron = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
if (typeof electron === 'string') {
  const env = {...process.env};
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE', 'CHROME_DEVEL_SANDBOX']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    {env, windowsHide: true, stdio: 'inherit'});
  const timer = setTimeout(() => child.kill(), 100000);
  child.on('exit', code => {clearTimeout(timer); process.exitCode = code ?? 1;});
} else {
  const {app, BrowserWindow, session, net} = electron;
  const assert = require('node:assert/strict'), {fileURLToPath} = require('node:url');
  const client = path.resolve(__dirname, '..'), baseline = process.argv.includes('--baseline');
  const outputArg = process.argv.slice(2).find(value => !value.startsWith('--'));
  const out = path.resolve(outputArg || path.join(client, '../outputs/chat-more-menu', baseline ? 'before' : 'after'));
  fs.mkdirSync(out, {recursive: true});
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-chat-more-'));
  app.setPath('userData', profile); app.disableHardwareAcceleration();
  const report = {ok: false, baseline, profile, cases: [], errors: [],
    boundary: 'Complete production desk loading graph; native mouse/keyboard; synthetic API/session; all network blocked.'};
  let win;
  const oldScripts = new Map();
  if (baseline) {
    for (const filename of ['work-composer.js','compose-surface.js','chat-composer-bindings.js']) {
      const source = require('node:child_process').execFileSync('git', ['show', 'HEAD:client/components/panels/' + filename],
        {cwd: path.join(client, '..'), encoding: 'utf8'});
      oldScripts.set(filename, source);
      fs.writeFileSync(path.join(out, 'baseline-' + filename), source);
    }
  }
  const fixture = `
    fixtureData.myModels={usable:[{name:'fixture-model',label:'Isolated model',providerName:'Synthetic'}],defaultModel:'fixture-model'};
    window.moreFixture={opens:[],sends:[],releases:[],events:new Set(),catalogCalls:0,catalogFailure:false,pending:[],defer:false};
    window.moreItems=Array.from({length:25},(_,i)=>({pluginId:'more-'+String(i).padStart(2,'0'),
      key:'more-'+i,name:'Fixture plugin '+String(i).padStart(2,'0'),description:'Complete plugin '+i,
      personal:true,enabled:i!==4,version:'1.0.0'}));
    moreItems.push({pluginId:'not-installed',name:'Not installed',installed:false,organizationWide:true});
    fixtureOverrides.pluginCatalog=()=>{
      moreFixture.catalogCalls++;
      if(moreFixture.catalogFailure)throw Error('Synthetic catalog failure');
      if(moreFixture.defer)return new Promise(resolve=>moreFixture.pending.push(resolve));
      return {items:structuredClone(moreItems)};
    };
    const moreApi=soduWorkAPI.conversationSession;
    moreApi.runtimes=async()=>({ok:true,items:[{id:'pi',displayName:'Pi',modelMode:'managed',goalMode:'native'}]});
    moreApi.probe=async()=>({ok:true,accessControl:{version:1,supported:true,modes:['standard','readonly','full']}});
    moreApi.capabilities=async()=>({ok:true,items:[{id:'fixture-files',label:'Fixture files',selected:true}],skills:[]});
    moreApi.workdir=async()=>({ok:true,dir:'D:/isolated/chat-more',name:'Isolated menu'});
    moreApi.setMode=async()=>({ok:true,mode:'full'});
    moreApi.skills=async()=>({ok:true,items:[]});
    moreApi.onEvent=fn=>{moreFixture.events.add(fn);return()=>moreFixture.events.delete(fn);};
    moreApi.open=async options=>{
      const id=options.chatId||'more-session-1',ref='ref-'+id;
      moreFixture.opens.push({options:structuredClone(options),ref,id});
      return {ok:true,ref,sessionId:id,adapterId:'pi',displayName:'Pi',cwd:'D:/isolated/chat-more',workspaceName:'Isolated menu',
        mode:'full',model:{name:'fixture-model'},capabilities:['fixture-files'],
        snapshot:{status:'idle',statusText:'就绪',messages:[],tools:[],pendingUi:null,
          adapterId:'pi',accessControl:{version:1,supported:true},accessPolicy:{mode:'standard'},
          execution:{location:'local'},capabilities:['fixture-files']}};
    };
    moreApi.send=async(ref,text,attachments,options)=>{
      moreFixture.sends.push(structuredClone({ref,text,attachments,options}));
      const snapshot={status:'idle',statusText:'就绪',messages:[{role:'user',text,sentAt:options.sentAt},
        {role:'assistant',blocks:[{kind:'text',text:'Synthetic response'}],done:true,completedAt:Date.now()}],tools:[],pendingUi:null,
        adapterId:'pi',accessPolicy:{mode:'standard'},execution:{location:'local'}};
      setTimeout(()=>moreFixture.events.forEach(fn=>fn({ref,kind:'settled',submissionId:options.submissionId,snapshot})),0);
      return {ok:true,snapshot};
    };
    moreApi.release=async ref=>{moreFixture.releases.push(ref);return {ok:true};};
    moreApi.addAttachments=async files=>({ok:true,items:files.map((f,i)=>({...f,ref:'fixture-attachment-'+i}))});
    moreApi.attachments=async()=>({ok:true,items:[]});
  `;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code, true);
  async function until(code, timeout = 4000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {if (await js('Boolean(' + code + ')')) return; await delay(25);}
    throw Error('Timeout: ' + code);
  }
  async function click(selector, {disabled = false} = {}) {
    const point = await js(`(async()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||(!${disabled}&&e.disabled))throw Error('Unavailable '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});await new Promise(r=>requestAnimationFrame(r));const b=e.getBoundingClientRect(),x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height/2);if(!e.contains(document.elementFromPoint(x,y)))throw Error('Occluded '+${JSON.stringify(selector)});return{x,y};})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({type, ...point, button: 'left', clickCount: 1});
    await delay(75);
  }
  async function key(keyCode) {
    win.webContents.sendInputEvent({type:'keyDown', keyCode});
    if(keyCode==='Return')win.webContents.sendInputEvent({type:'char',keyCode:'\r'});
    win.webContents.sendInputEvent({type:'keyUp', keyCode});
    await delay(45);
  }
  async function type(selector, value) {
    await click(selector);
    await js(`{const e=document.querySelector(${JSON.stringify(selector)});e.value='';e.dispatchEvent(new Event('input',{bubbles:true}));}void 0;`);
    await win.webContents.insertText(value); await delay(30);
  }
  async function shot(name) {
    await delay(180); // Capture the settled menu, after its 120 ms entry animation.
    fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  async function check(name, run) {
    console.log('CHECK ' + name);
    try {await run(); report.cases.push({name, ok: true});}
    catch (error) {
      report.cases.push({name, ok: false, error: error.stack || String(error)}); await shot('failed-' + report.cases.length);
      await js('moreFixture.defer=false;moreFixture.catalogFailure=false;moreFixture.pending.splice(0).forEach(resolve=>resolve({items:structuredClone(moreItems)}));void 0;').catch(()=>{});
    }
  }
  const ids = selector => js(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(e=>e.dataset.morePlugin)`);
  async function openMore() {
    if (await js('document.querySelector("#nchatMorePop")?.hidden')) await click('#nchatMore');
    await until('document.querySelector("#nchatMorePop")?.hidden===false');
  }
  async function closeMore() {if (await js('document.querySelector("#nchatMorePop")?.hidden===false')) await click('#nchatMore');}
  app.whenReady().then(async () => {
    session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']}, (_r, cb) => cb({cancel:true}));
    session.defaultSession.protocol.handle('file', request => {
      const filename = path.basename(fileURLToPath(request.url.split('?')[0]));
      if (oldScripts.has(filename)) return new Response(oldScripts.get(filename), {headers:{'content-type':'text/javascript'}});
      if (filename !== 'desk.html') return net.fetch(request.url, {bypassCustomProtocolHandlers:true});
      const early = '<script>' + fs.readFileSync(path.join(__dirname, 'fixtures/page-audit-api.js'), 'utf8') + '</script>';
      const html = fs.readFileSync(path.join(client, 'desk.html'), 'utf8').replace('<head>', '<head>' + early)
        .replace('<script src="desk-boot.js"></script>', '<script>fixtureInstallApi();' + fixture + '</script><script src="desk-boot.js"></script>');
      return new Response(html, {headers:{'content-type':'text/html;charset=utf-8'}});
    });
    win = new BrowserWindow({show:true, skipTaskbar:true, width:1440, height:1000, title:'Isolated chat more menu regression',
      webPreferences:{contextIsolation:true, nodeIntegration:false, backgroundThrottling:false}});
    win.webContents.on('console-message', event => {if(event.level==='error')report.errors.push(event.message);});
    await win.loadFile(path.join(client, 'desk.html'), {query:{panel:'workspace'}});
    await until('fixtureReady && document.querySelector("#cpMore")');
    if (!baseline) await check('Cold menu reserves its final plugin area and warm reopen renders rows synchronously', async () => {
      await js('moreFixture.defer=true;dispatchEvent(new CustomEvent("soduwork:plugins-changed"));void 0;');
      await click('#cpMore'); await until('moreFixture.pending.length>0');
      const bounds = () => js('(()=>{const r=document.querySelector("#cpMorePop").getBoundingClientRect();return {top:r.top,height:r.height};})()');
      const before = await bounds();
      await js('moreFixture.defer=false;moreFixture.pending.splice(0).forEach(resolve=>resolve({items:structuredClone(moreItems)}));void 0;');
      await until('document.querySelectorAll("#cpMorePop [data-more-plugin]").length===25');
      const after = await bounds();
      assert(Math.abs(before.top-after.top)<=1 && Math.abs(before.height-after.height)<=1, JSON.stringify({before,after}));
      await click('#cpMore');
      const warm = await js('(()=>{const calls=moreFixture.catalogCalls;document.querySelector("#cpMore").click();return {calls:moreFixture.catalogCalls-calls,rows:document.querySelectorAll("#cpMorePop [data-more-plugin]").length};})()');
      assert.equal(warm.rows,25); assert.equal(warm.calls,0);
      await click('#cpMore');
      report.menuLayout={before,after,warm};
    });
    await check('Homepage shows every installed plugin, including unavailable rows', async () => {
      await click('#cpMore'); await until('document.querySelectorAll("#cpMorePop [data-more-plugin]").length===25');
      report.homeIds = await ids('#cpMorePop [data-more-plugin]');
      assert.equal(await js('document.querySelector("#cpMorePop [data-more-plugin=more-04]").disabled'), true);
      await shot('homepage-menu'); await click('#cpMore');
    });
    if (!baseline) for (const boundary of ['new-chat', 'account', 'policy']) {
      await check('Homepage pending plugin choice cannot cross ' + boundary, async () => {
        await click('#cpMore'); await until('document.querySelectorAll("#cpMorePop [data-more-plugin]").length===25');
        await js('moreFixture.defer=true;void 0;');
        await click('#cpMorePop [data-more-plugin=more-12]');
        await until('moreFixture.pending.length>0');
        await js(boundary === 'new-chat'
          ? 'WorkspaceHost.open("create",{newSession:true});void 0;'
          : boundary === 'account' ? 'fixtureOwner="menu-owner-next";dispatchEvent(new CustomEvent("soduwork-data-scope-changed"));void 0;'
            : 'dispatchEvent(new CustomEvent("soduwork-plugin-policy"));void 0;');
        await js('moreFixture.defer=false;moreFixture.pending.splice(0).forEach(resolve=>resolve({items:structuredClone(moreItems)}));void 0;');
        await delay(100);
        assert.equal(await js('document.querySelectorAll(".cp-box .nplugin-chip").length'),0);
        if (await js('!document.querySelector("#cpMorePop").hidden')) await click('#cpMore');
      });
    }
    await check('Sending from homepage opens one synthetic native session', async () => {
      await type('#cpInput', '首次发送，进入会话');
      if (!baseline) {
        await click('#cpMore'); await until('document.querySelectorAll("#cpMorePop [data-more-plugin]").length===25');
        await js('moreFixture.defer=true;void 0;'); await click('#cpMorePop [data-more-plugin=more-11]');
        await until('moreFixture.pending.length>0'); await click('#cpMore');
      }
      await click('#cpGo');
      await until('moreFixture.sends.length===1 && document.querySelector("#nchatMore")');
      if (!baseline) {
        await js('moreFixture.defer=false;moreFixture.pending.splice(0).forEach(resolve=>resolve({items:structuredClone(moreItems)}));void 0;');
        await delay(100);
        assert.equal(await js('document.querySelectorAll(".cp-box .nplugin-chip").length'),0);
        assert.equal(await js('moreFixture.sends[0].options.plugins.length'),0);
      }
      await until('!NativeChat.isBusy()');
      assert.equal(await js('moreFixture.opens.length'),1); await shot('native-chat');
    });
    await check('Native chat more menu retains the complete homepage plugin catalog', async () => {
      await openMore(); await delay(150);
      report.chatIds = await ids('#nchatMorePop [data-more-plugin]');
      report.chatMenu = await js('document.querySelector("#nchatMorePop").innerText');
      assert.deepEqual(report.chatIds, report.homeIds);
      assert.equal(await js('!!document.querySelector("#nchatPlugins")'),true);
      await shot('chat-menu');
    });
    if (!baseline) await interactionCases();
    report.uiErrors = await js('fixtureErrors');
    assert.deepEqual(report.uiErrors, []);
    report.ok = report.cases.every(row => row.ok);
  }).catch(error => {report.error = error.stack || String(error);}).finally(async () => {
    if(win&&!win.isDestroyed())report.state=await js('({text:document.body.innerText.slice(-5000),opens:moreFixture.opens,sends:moreFixture.sends,catalogCalls:moreFixture.catalogCalls,errors:fixtureErrors})').catch(()=>null);
    win?.destroy(); fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({ok:report.ok,cases:report.cases,error:report.error,report:path.join(out,'report.json')},null,2));
    app.exit(report.ok?0:1);
  });
  async function interactionCases() {
    const plugin = id => '#nchatMorePop [data-more-plugin="more-' + id + '"]';
    const chips = () => js('Array.from(document.querySelectorAll("#cpChat .nplugin-chip>span")).map(e=>e.textContent)');
    const clearChips = async () => {
      await closeMore();
      while(await js('!!document.querySelector("#cpChat .nplugin-chip>button")')) await click('#cpChat .nplugin-chip>button');
    };
    const noExtraSend = async () => {
      assert.equal(await js('moreFixture.sends.length'),1,'Selection must not send');
    };
    await check('Goal and fixed capabilities have truthful disabled states; execution remains in its toolbar', async () => {
      await openMore();
      const rows = await js('Array.from(document.querySelectorAll("#nchatMoreGoal,#nchatAbility")).map(e=>({id:e.id,disabled:e.disabled,text:e.innerText,title:e.title}))');
      assert.equal(rows.length,2); assert(rows.every(row=>row.disabled));
      assert.equal(await js('!!document.querySelector("[data-chat-execution]")'),true);
      assert(rows.find(row=>row.id==='nchatMoreGoal').text.includes('新对话'));
      assert(rows.find(row=>row.id==='nchatAbility').title.includes('会话开始'));
    });
    await check('Unavailable plugin cannot be selected by native click', async () => {
      await openMore(); assert.equal(await js('document.querySelector('+JSON.stringify(plugin('04'))+').disabled'),true);
      await click(plugin('04'),{disabled:true}); assert.deepEqual(await chips(),[]); await noExtraSend();
    });
    const draft = '保留正文 /literal 和 #literal\n附件与本轮插件由用户继续发送。';
    await check('Bottom plugin selection preserves body, attachment, ref and does not send', async () => {
      await closeMore(); await type('#nchatInput',draft);
      await js(`{const transfer=new DataTransfer();transfer.items.add(new File(['isolated attachment'],'menu-note.txt',{type:'text/plain'}));const e=document.querySelector('#nchatFile');e.files=transfer.files;e.dispatchEvent(new Event('change',{bubbles:true}));}void 0;`);
      await until('document.querySelector("#nchatAtts")?.textContent.includes("menu-note.txt")');
      const before = await js('NativeChat.sessionInfo()');
      await openMore(); await until('document.querySelectorAll("#nchatMorePop [data-more-plugin]").length===25');
      await click(plugin('24')); await until('document.querySelector("#nchatMorePop").hidden');
      assert.deepEqual(await chips(),['Fixture plugin 24']);
      assert.equal(await js('document.querySelector("#nchatInput").value'),draft);
      assert(await js('document.querySelector("#nchatAtts").textContent.includes("menu-note.txt")'));
      assert.equal((await js('NativeChat.sessionInfo()')).ref,before.ref);
      assert.equal(await js('moreFixture.opens.length'),1); await noExtraSend();
      await openMore(); await until('document.querySelectorAll("#nchatMorePop [data-more-plugin]").length===25');
      assert.equal(await js('document.querySelector('+JSON.stringify(plugin('24'))+').getAttribute("aria-pressed")'),'true');
      await shot('selected-plugin-draft');
    });
    await check('Native keyboard visits complete menu, skips disabled rows and selects focused plugin', async () => {
      await clearChips(); await click('#nchatMore');
      await until('document.querySelectorAll("#nchatMorePop [data-more-plugin]").length===25');
      await key('Down'); assert.equal(await js('document.activeElement.id'),'nchatFilePick');
      await key('Up'); assert.equal(await js('document.activeElement.dataset.morePlugin'),'more-24');
      const visible = await js('(()=>{const a=document.activeElement.getBoundingClientRect(),p=document.querySelector("#nchatMorePop").getBoundingClientRect();return a.top>=p.top&&a.bottom<=p.bottom;})()');
      assert.equal(visible,true,'Keyboard focused bottom row must be visible');
      await key('Down'); assert.equal(await js('document.activeElement.id'),'nchatFilePick');
      // Include toolbar actions such as screenshot without assuming a fixed row count.
      for(let i=0;i<12;i++) {
        await key('Down');
        const focused = await js('document.activeElement.dataset.morePlugin');
        assert.notEqual(focused,'more-04','Disabled rows must not receive keyboard focus');
        if(focused==='more-05')break;
      }
      assert.equal(await js('document.activeElement.dataset.morePlugin'),'more-05');
      await key('Return'); await until('document.querySelector("#nchatMorePop").hidden');
      assert.deepEqual(await chips(),['Fixture plugin 05']);
      assert.equal(await js('document.querySelector("#nchatInput").value'),draft); await noExtraSend();
    });
    await check('Escape closes menu and returns focus to its trigger', async () => {
      await openMore(); await key('Down'); await key('Escape');
      assert.equal(await js('document.querySelector("#nchatMorePop").hidden'),true);
      assert.equal(await js('document.activeElement.id'),'nchatMore');
    });
    await check('Catalog error exposes native retry and recovers full list', async () => {
      await closeMore(); await js('moreFixture.catalogFailure=true;dispatchEvent(new CustomEvent("soduwork:plugins-changed"));void 0;'); await openMore();
      await until('document.querySelector("#nchatMorePop [data-more-retry]")');
      assert.equal(await ids('#nchatMorePop [data-more-plugin]').then(rows=>rows.length),0);
      await js('moreFixture.catalogFailure=false;void 0;'); await click('#nchatMorePop [data-more-retry]');
      await until('document.querySelectorAll("#nchatMorePop [data-more-plugin]").length===25');
      assert.deepEqual(await ids('#nchatMorePop [data-more-plugin]'),report.homeIds); await noExtraSend();
    });
    await check('A pending selection cannot survive plugin permission invalidation', async () => {
      await clearChips(); await openMore();
      await until('document.querySelectorAll("#nchatMorePop [data-more-plugin]").length===25');
      await js('moreFixture.defer=true;void 0;'); await click(plugin('14'));
      await until('moreFixture.pending.length>0');
      await js('dispatchEvent(new CustomEvent("soduwork-plugin-policy"));moreFixture.defer=false;moreFixture.pending.splice(0).forEach(resolve=>resolve({items:structuredClone(moreItems)}));void 0;');
      await delay(100); assert.deepEqual(await chips(),[]);
      assert.equal(await js('document.querySelectorAll("#nchatMorePop [data-more-plugin]").length'),0);
      await noExtraSend();
    });
    await check('Typing a slash during asynchronous menu selection remains literal draft text', async () => {
      await clearChips(); await openMore(); await until('document.querySelectorAll("#nchatMorePop [data-more-plugin]").length===25');
      await js('moreFixture.defer=true;void 0;'); await click(plugin('10'));
      await until('moreFixture.pending.length>0');
      await closeMore();
      await type('#nchatInput','继续编辑 /literal');
      await js('moreFixture.defer=false;moreFixture.pending.splice(0).forEach(resolve=>resolve({items:structuredClone(moreItems)}));void 0;');
      await until('document.querySelector("#cpChat .nplugin-strip")?.textContent.includes("Fixture plugin 10")');
      assert.equal(await js('document.querySelector("#nchatInput").value'),'继续编辑 /literal');
      await noExtraSend();
    });
    await check('Late selection cannot alter the next conversation draft or plugin metadata', async () => {
      await clearChips(); await openMore(); await until('document.querySelectorAll("#nchatMorePop [data-more-plugin]").length===25');
      await js('moreFixture.defer=true;void 0;'); await click(plugin('12'));
      await until('moreFixture.pending.length>0');
      await js('moreFixture.defer=false;NativeChat.enter("","more-session-2",{adapterId:"pi"})'); await delay(100);
      await until('NativeChat.sessionInfo().sessionId==="more-session-2"');
      await type('#nchatInput','第二个会话自己的草稿');
      await js('moreFixture.pending.splice(0).forEach(resolve=>resolve({items:structuredClone(moreItems)}));void 0;'); await delay(130);
      assert.deepEqual(await chips(),[]);
      assert.equal(await js('document.querySelector("#nchatInput").value'),'第二个会话自己的草稿'); await noExtraSend();
    });
    await check('Late catalog cannot repaint a different conversation menu', async () => {
      await closeMore(); await js('moreFixture.defer=true;dispatchEvent(new CustomEvent("soduwork:plugins-changed"));void 0;'); await openMore();
      await until('moreFixture.pending.length>0');
      await js('moreFixture.defer=false;dispatchEvent(new CustomEvent("soduwork:plugins-changed"));NativeChat.enter("","more-session-3",{adapterId:"pi"})'); await delay(100);
      await until('NativeChat.sessionInfo().sessionId==="more-session-3"');
      await openMore(); await until('document.querySelectorAll("#nchatMorePop [data-more-plugin]").length===25');
      await js('moreFixture.pending.splice(0).forEach(resolve=>resolve({items:[{pluginId:"late-leak",name:"Old conversation only",personal:true}]}));void 0;'); await delay(130);
      assert.deepEqual(await ids('#nchatMorePop [data-more-plugin]'),report.homeIds); await noExtraSend();
    });
    await check('Late selection cannot cross an account owner change', async () => {
      await js('moreFixture.defer=true;void 0;'); await click(plugin('13'));
      await until('moreFixture.pending.length>0');
      await js('fixtureOwner="chat-more-other-owner";dispatchEvent(new CustomEvent("soduwork-data-scope-changed"));moreFixture.defer=false;void 0;');
      await js('WorkspaceHost.open("create",{chatId:"more-session-3"})'); await delay(100);
      await closeMore(); await type('#nchatInput','新帐号自己的草稿');
      await js('moreFixture.pending.splice(0).forEach(resolve=>resolve({items:structuredClone(moreItems)}));void 0;'); await delay(130);
      assert.deepEqual(await chips(),[]);
      assert.equal(await js('document.querySelector("#nchatInput").value'),'新帐号自己的草稿'); await noExtraSend();
    });
    for(const width of [1440,760])await check('Native popup stays in viewport and bottom row is selectable at width '+width, async () => {
      await closeMore(); win.setSize(width,width===760?850:1000); await delay(110);
      await openMore(); await until('document.querySelectorAll("#nchatMorePop [data-more-plugin]").length===25');
      const bounds = await js('(()=>{const b=document.querySelector("#nchatMorePop").getBoundingClientRect();return{x:b.x,y:b.y,right:b.right,bottom:b.bottom,w:innerWidth,h:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth+1};})()');
      assert(bounds.x>=-1&&bounds.y>=-1&&bounds.right<=bounds.w+1&&bounds.bottom<=bounds.h+1,JSON.stringify(bounds));
      assert.equal(bounds.overflow,false,JSON.stringify(bounds));
      await shot('viewport-'+width); await click(plugin('24')); await until('document.querySelector("#nchatMorePop").hidden');
      assert((await chips()).includes('Fixture plugin 24')); await noExtraSend();
      await clearChips();
    });
    await check('Only explicit Send submits the chosen metadata and intact literal body and attachment bytes', async () => {
      const body = '请回复菜单回归确认，正文中的 /literal 与 #literal 原样保留。';
      await type('#nchatInput',body);
      await js(`{const transfer=new DataTransfer();transfer.items.add(new File(['preserved bytes'],'explicit-send.txt',{type:'text/plain'}));const e=document.querySelector('#nchatFile');e.files=transfer.files;e.dispatchEvent(new Event('change',{bubbles:true}));}void 0;`);
      await until('document.querySelector("#nchatAtts")?.textContent.includes("explicit-send.txt")');
      const ref = await js('NativeChat.sessionInfo().ref');
      await openMore(); await until('document.querySelectorAll("#nchatMorePop [data-more-plugin]").length===25');
      await click(plugin('03')); await until('document.querySelector("#nchatMorePop").hidden');
      await noExtraSend(); await click('#nchatSend'); await until('moreFixture.sends.length===2');
      const sent = await js('moreFixture.sends.at(-1)');
      assert.equal(sent.ref,ref); assert.equal(sent.text,body);
      assert.deepEqual(sent.options.plugins.map(row=>row.pluginId),['more-03']);
      assert.deepEqual(sent.options.skills,[]);
      assert.deepEqual(sent.attachments.map(row=>row.name),['explicit-send.txt']);
      assert.equal(await js('new TextDecoder().decode(moreFixture.sends.at(-1).attachments[0].data)'),'preserved bytes');
      await until('document.querySelector("#nchatInput").value===""');
      assert.deepEqual(await chips(),[]);
    });
    await check('Selection completing after Send cannot repopulate the following turn chip', async () => {
      await until('!NativeChat.isBusy()');
      const body = '目录还没返回，先发送这一轮已有正文。';
      await type('#nchatInput',body); await openMore();
      await until('document.querySelectorAll("#nchatMorePop [data-more-plugin]").length===25');
      await js('moreFixture.defer=true;void 0;'); await click(plugin('11'));
      await until('moreFixture.pending.length>0'); await closeMore();
      await click('#nchatSend'); await until('moreFixture.sends.length===3');
      const sent = await js('moreFixture.sends.at(-1)');
      assert.equal(sent.text,body); assert.deepEqual(sent.options.plugins,[]);
      await js('moreFixture.defer=false;moreFixture.pending.splice(0).forEach(resolve=>resolve({items:structuredClone(moreItems)}));void 0;');
      await delay(130);
      assert.deepEqual(await chips(),[]);
      assert.equal(await js('document.querySelector("#nchatInput").value'),'');
      assert.equal(await js('moreFixture.sends.length'),3);
    });
    await check('View all keeps its production library navigation', async () => {
      await openMore(); await click('#nchatPlugins');
      await until('WorkspaceHost.view==="skills" && document.querySelector("#capPanel")');
      assert.equal(await js('moreFixture.sends.length'),3);
    });
  }
}
