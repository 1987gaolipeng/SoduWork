'use strict';

const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict');
  const out = path.resolve(__dirname, '../../work/ui-polish/presentation');
  fs.mkdirSync(out, { recursive: true });
  app.disableHardwareAcceleration();
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-picker-presentation-')));
  const report = { ok: false, checks: [], geometry: [],
    boundary: 'Production homepage and picker resources in isolated Electron; synthetic catalogs; HTTP(S) blocked; no model calls.' };
  let win;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code, true).catch(error => {
    throw Error(error.message + '\nCode: ' + code.slice(0, 900));
  });
  async function until(code) {
    for (let i = 0; i < 100; i++) { if (await js(code)) return; await delay(30); }
    throw Error('Timeout: ' + code);
  }
  async function click(selector, horizontal = 0.5) {
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width*${horizontal}),y=Math.round(r.y+r.height/2);if(!e.contains(document.elementFromPoint(x,y)))throw Error('Occluded: '+${JSON.stringify(selector)});return{x,y}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(70);
  }
  async function key(keyCode) {
    win.webContents.focus();
    const accelerator = { ArrowDown: 'Down', ArrowUp: 'Up', ArrowRight: 'Right', ArrowLeft: 'Left' }[keyCode] || keyCode;
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: accelerator });
    if (keyCode === 'ENTER') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: accelerator });
    await delay(60);
  }
  async function search(text) {
    await js(`(()=>{const e=document.querySelector('.cp-model-search input');e.focus();e.value=${JSON.stringify(text)};e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  }
  async function openNativeModels() {
    await click('[data-native-list]');
    assert.equal(await js('Boolean(document.querySelector("[data-effort-slider]"))'), false, 'model list and slider never coexist');
  }
  async function dragEffort() {
    const rect = await js(`(()=>{const e=document.querySelector('[data-effort-slider]');window.presentationSlider=e;e.focus();const r=e.getBoundingClientRect();return{x:r.x,y:r.y+r.height/2,width:r.width,value:Number(e.value),max:Number(e.max)}})()`);
    const point = index => ({x:Math.round(rect.x+14+(rect.width-28)*index/rect.max),y:Math.round(rect.y)});
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mousePressed',...point(rect.value),button:'left',buttons:1,clickCount:1});
    for (let index = rect.value + 1; index <= rect.max; index++) {
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseMoved',...point(index),button:'left',buttons:1});
      await delay(50);
      assert.equal(await js('Number(document.querySelector("[data-effort-slider]").value)'), index);
      assert.equal(await js('window.presentationSlider===document.querySelector("[data-effort-slider]")'), true, 'drag must retain the native range node');
      assert.ok(await js(`(()=>{const p=document.querySelector('#cpModelPop').getBoundingClientRect(),b=document.querySelector('#cpModelBtn').getBoundingClientRect(),left=Math.max(12,Math.min((b.left+b.right-p.width)/2,innerWidth-12-p.width));return Math.abs(p.left-left)<1})()`),'alignment follows model-trigger width changes when the effort label changes');
    }
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseReleased',...point(rect.max),button:'left',buttons:0,clickCount:1});
    await delay(60);
  }
  async function verifyMotion() {
    const rect = await js(`(()=>{const r=document.querySelector('[data-effort-slider]').getBoundingClientRect();return{x:r.x,y:r.y+r.height/2,width:r.width}})()`);
    const point = ratio => ({x:Math.round(rect.x+14+(rect.width-28)*ratio),y:Math.round(rect.y)});
    const mouse = (type, ratio, buttons=0) => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type, ...point(ratio), button: buttons || type === 'mouseReleased' ? 'left' : 'none', buttons,
      ...(type === 'mousePressed' || type === 'mouseReleased' ? {clickCount:1} : {}),
    });
    const cursor = () => js('getComputedStyle(document.querySelector("[data-effort-slider]")).cursor');
    assert.equal(await js('Boolean(document.querySelector("link[href=\\"theme/cursor.css\\"]"))'), true, 'load production cursor rules');
    assert.equal(await js('Boolean(document.querySelector(".cp-effort-bolt"))'), false, 'no decorative fast-mode control');
    await mouse('mouseMoved', .6); await delay(220);
    assert.equal(await cursor(), 'pointer');
    assert.equal(await js('ComposeModelPicker.value().reasoningEffort'), 'medium', 'hover previews do not commit');
    assert.equal(await js('document.querySelector(".cp-effort-preview")'), null, 'hovering a stop never shows explanatory text');
    assert.equal(await js('getComputedStyle(document.querySelector(".cp-effort-sparks span")).animationPlayState'), 'running');
    assert.ok(await js('getComputedStyle(document.querySelector(".cp-effort-stops .is-preview")).transform.startsWith("matrix(1.8")'));
    assert.equal(await js('getComputedStyle(document.querySelector(".cp-effort-endpoints")).opacity'), '1');
    await shot('codex-slider-hover');
    await mouse('mouseMoved', .2); await delay(200);
    assert.equal(await cursor(), 'grab');
    assert.ok(await js('getComputedStyle(document.querySelector(".cp-effort-thumb")).transform.startsWith("matrix(1.08")'));
    await mouse('mousePressed', .2, 1);
    assert.equal(await cursor(), 'grabbing');
    const thumbX = () => js(`(()=>{const r=document.querySelector('.cp-effort-thumb').getBoundingClientRect();return r.left+r.width/2})()`);
    for (const ratio of [.24,.28]) {
      await mouse('mouseMoved', ratio, 1); await delay(140);
      assert.equal(await js('ComposeModelPicker.value().reasoningEffort'), 'medium');
      assert.ok(Math.abs(await thumbX()-point(.2).x)<2, 'movement inside a level range stays on that detent');
    }
    await js(`window.motionSamples=[];window.motionStart=performance.now();requestAnimationFrame(function sample(t){const r=document.querySelector('.cp-effort-thumb').getBoundingClientRect();motionSamples.push({t:t-motionStart,x:r.left+r.width/2});if(t-motionStart<280)requestAnimationFrame(sample)})`);
    await mouse('mouseMoved', .34, 1); await delay(320);
    const samples = await js('motionSamples');
    const last = samples.at(-1).x;
    assert.ok(Math.abs(last-point(.4).x)<2, 'crossing the threshold snaps to high before release');
    assert.ok(samples.some(s=>s.x>point(.2).x+1 && s.x<last-1), 'each detent has a short visible transition');
    await mouse('mouseMoved', .46, 1); await delay(150);
    assert.ok(Math.abs(await thumbX()-point(.4).x)<2, 'near high stays on high, not under the pointer');
    await mouse('mouseReleased', .46); await delay(200);
    assert.equal(await js('ComposeModelPicker.value().reasoningEffort'), 'high');
    assert.ok(Math.abs(await thumbX()-point(.4).x)<2, 'release near high retains the actual high stop');
    // Drag back through the same boundary: the descending direction also has detents.
    await mouse('mousePressed', .4, 1); await mouse('mouseMoved', .26, 1); await delay(160);
    assert.equal(await js('ComposeModelPicker.value().reasoningEffort'), 'medium');
    assert.ok(Math.abs(await thumbX()-point(.2).x)<2);
    await mouse('mouseReleased', .26);
    report.motion = { hoverCursor:'pointer', thumbCursor:'grab', draggingCursor:'grabbing', detentSamples:samples, releaseNearHigh:'high' };
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseMoved',x:rect.x-40,y:rect.y,buttons:0});
    await delay(200);
    assert.equal(await js('getComputedStyle(document.querySelector(".cp-effort-sparks span")).animationPlayState'), 'running');
    const idleParticle = await js('getComputedStyle(document.querySelector(".cp-effort-sparks span")).transform');
    await delay(180);
    assert.notEqual(await js('getComputedStyle(document.querySelector(".cp-effort-sparks span")).transform'), idleParticle, 'particles animate without hover');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await mouse('mouseMoved', .2); await delay(50);
    assert.equal(await js('getComputedStyle(document.querySelector(".cp-effort-thumb")).transitionDuration'), '0s');
    assert.equal(await js('getComputedStyle(document.querySelector(".cp-effort-sparks")).display'), 'none');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features:[]});
    await click('[data-effort-reset]');
    assert.equal(await js('ComposeModelPicker.value().reasoningEffort'), 'medium');
    await mouse('mousePressed', .2, 1);
    await mouse('mouseMoved', .37, 1);
    await key('ESC');
    assert.equal(await js('document.querySelector("#cpModelPop").classList.contains("show")'), false);
    assert.equal(await js('document.querySelector(".cp-effort-card").matches(".is-dragging,.is-pressed,.is-hovering")'), false, 'closing mid-drag clears pointer and animation state');
    assert.equal(await js('Boolean(document.querySelector(".cp-effort-card").dataset.pointerId)'), false);
    assert.equal(await js('getComputedStyle(document.querySelector(".cp-effort-sparks span")).animationPlayState'), 'paused', 'hidden menu stops its animation');
    await mouse('mouseReleased', .37);
    await click('#cpModelBtn');
    await click('[data-effort-reset]');
    report.checks.push('Production cursor.css; hover previews; particles run without hover and pause on close; plateau within level ranges, animated forward/backward detents and release near high; reduced motion');
  }
  async function recordMotion() {
    if (process.env.SODUWORK_RECORD_PICKER !== '1') return;
    const directory = path.join(out, 'motion');
    fs.mkdirSync(directory, { recursive: true });
    const area = await js(`(()=>{const card=document.querySelector('.cp-effort-card').getBoundingClientRect(),slider=document.querySelector('[data-effort-slider]').getBoundingClientRect();return{clip:{x:Math.floor(card.x),y:Math.floor(card.y),width:Math.ceil(card.width),height:Math.ceil(card.height)},x:slider.x,y:slider.y+slider.height/2,width:slider.width}})()`);
    const mouse = (type, ratio, buttons=0) => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type,x:Math.round(area.x+14+(area.width-28)*ratio),y:Math.round(area.y),
      button: buttons || type === 'mouseReleased' ? 'left' : 'none',buttons,
      ...(type === 'mousePressed' || type === 'mouseReleased' ? {clickCount:1} : {}),
    });
    const frames = [];
    async function frame() {
      await delay(50);
      const file = 'frame-' + String(frames.length).padStart(3, '0') + '.png';
      fs.writeFileSync(path.join(directory,file), (await win.webContents.capturePage(area.clip)).toPNG());
      frames.push({file,time:Date.now()});
    }
    await mouse('mouseMoved', .8);
    for(let i=0;i<12;i++) await frame();
    await mouse('mouseMoved', .2);
    for(let i=0;i<8;i++) await frame();
    await mouse('mousePressed', .2, 1);
    for(let i=1;i<=20;i++) { await mouse('mouseMoved', .2+i*.0325, 1); await frame(); }
    await mouse('mouseReleased', .85);
    for(let i=0;i<12;i++) await frame();
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseMoved',x:area.x-30,y:area.y,buttons:0});
    for(let i=0;i<8;i++) await frame();
    fs.writeFileSync(path.join(directory,'frames.json'),JSON.stringify(frames));
    report.recording = {frames:frames.length,directory,boundary:'Actual isolated Electron control, recorded with pointer events; synthetic model names, no model request'};
    await click('[data-effort-reset]');
  }
  async function shot(name) {
    await delay(100);
    fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
    if (name === 'codex-two-stage-initial-default') {
      const area = await js(`(()=>{const p=document.querySelector('#cpModelPop').getBoundingClientRect(),b=document.querySelector('#cpModelBtn').getBoundingClientRect(),x=Math.floor(Math.min(p.left,b.left)-8),y=Math.floor(p.top-8);return{x,y,width:Math.ceil(Math.max(p.right,b.right)-x+8),height:Math.ceil(b.bottom-y+8)}})()`);
      fs.writeFileSync(path.join(out,name+'-anchor.png'),(await win.webContents.capturePage(area)).toPNG());
    }
    if (name.startsWith('codex-slider-') || name.startsWith('codex-two-stage-') || name.startsWith('codex-model-list-') || name === 'managed-menu-1440') {
      const clip = await js(`(()=>{const r=document.querySelector('#cpModelPop').getBoundingClientRect();return{x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width)+1,height:Math.ceil(r.height)+1}})()`);
      fs.writeFileSync(path.join(out, name + '-detail.png'), (await win.webContents.capturePage(clip)).toPNG());
    }
  }
  async function geometry(width, height, native) {
    const value = await js(`(()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};const list=document.querySelector('.cp-model-scroll'),models=document.querySelector('#cpModelPop').dataset.modelView==='models';return{viewport:{width:innerWidth,height:innerHeight},models,pop:rect('#cpModelPop'),close:rect('[data-model-close], [data-effort-reset]'),footer:rect(${JSON.stringify(native ? '[data-effort-slider], [data-native-back]' : '.cp-model-summary, .cp-thinking')}),list:list?{...rect('.cp-model-scroll'),scroll:list.scrollHeight,client:list.clientHeight}:null,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
    report.geometry.push({ width, height, native, ...value });
    assert.ok(value.pop.left >= 0 && value.pop.right <= value.viewport.width && value.pop.top >= 0 && value.pop.bottom <= value.viewport.height,
      'Picker exceeds viewport: ' + JSON.stringify(value));
    assert.ok(value.close.top >= value.pop.top && value.close.bottom <= value.pop.bottom, 'Close button must remain visible');
    assert.ok(value.footer.top >= value.pop.top && value.footer.bottom <= value.pop.bottom, 'Footer must remain visible');
    if (value.list) assert.ok(value.list.client > 0, 'Model list must remain usable');
    if (native && value.models) assert.ok(value.list.scroll > value.list.client, 'Long native catalog must scroll');
    assert.equal(value.overflow, false, 'Page must not overflow horizontally');
    const expectedLeft = await js(`(()=>{const a=document.querySelector('#cpModelBtn').getBoundingClientRect(),p=document.querySelector('#cpModelPop').getBoundingClientRect();return Math.max(12,Math.min((a.left+a.right-p.width)/2,innerWidth-12-p.width))})()`);
    assert.ok(Math.abs(value.pop.left-expectedLeft)<1,'popup centers over the model trigger, with viewport edge avoidance');
    const selectors = native && !value.models ? ['[data-native-list]','[data-effort-reset]','[data-effort-slider]'] : ['.cp-model-search input','[data-model-close]',native?'[data-native-back]':'.cp-model-summary, .cp-thinking'];
    const controlsVisible = await js(`${JSON.stringify(selectors)}.map(selector=>{const e=document.querySelector(selector),r=e.getBoundingClientRect();return{selector,visible:e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))}})`);
    assert.ok(controlsVisible.every(item => item.visible), 'Controls clipped or covered: ' + JSON.stringify(controlsVisible));
  }
  async function run() {
    win = new BrowserWindow({ show: false, width: 1440, height: 1000, useContentSize: true,
      webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, done) => done({ cancel: true }));
    await win.loadFile(path.join(__dirname, '../tests/composer-menu.html'));
    await until("window.ComposeModelPicker && document.querySelector('#cpModelBtn') && document.querySelector('.cp-hero')");
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await js(`
      window.presentationRuntime='pi';
      window.presentationModels=[{name:'office-fast',label:'办公快速模型',providerName:'公司网关',thinkingMode:'none'},
        {name:'office-reasoning',label:'办公推理模型',providerName:'公司网关',thinkingMode:'controllable'}];
      window.presentationNative=[{id:'fixture-sol',label:'GPT-6.1-Sol',reasoningLevels:['low','medium','high','xhigh','max','ultra'],defaultReasoning:'low'},
        {id:'fixture-luna',label:'Codex 示例 · 精简档位',reasoningLevels:['low','medium'],defaultReasoning:'medium'},
        ...Array.from({length:12},(_,i)=>({id:'fixture-archive-'+i,label:'历史模型示例 '+(i+1),reasoningLevels:['low','medium','high'],defaultReasoning:'medium'}))];
      ComposeRuntime.value=()=>presentationRuntime;
      ComposeRuntime.catalog=()=>[{id:'pi',modelMode:'managed'},{id:'codex',modelMode:'account'}];
      SoduWorkAPI.myModels=async()=>({usable:presentationModels,defaultModels:{pi:'office-fast'}});
      soduWorkAPI.conversationSession.runtimeModels=async()=>({ok:true,models:presentationNative});
      void 0;
    `);
    await js('ComposeModelPicker.refresh(true)');
    assert.equal(await js('document.querySelector(".cp-hero").textContent'), '想让 SoduWork 做什么？');
    assert.equal(await js('document.querySelector(".cp-hero-note").textContent'), '直接对话；需要持续推进时设为目标，需要协作时创建需求。');
    report.homepageTypography = await js(`(()=>{const title=getComputedStyle(document.querySelector('.cp-hero')),note=getComputedStyle(document.querySelector('.cp-hero-note'));return{title:{size:parseFloat(title.fontSize),weight:title.fontWeight,color:title.color,lineHeight:parseFloat(title.lineHeight)},note:{size:parseFloat(note.fontSize),weight:note.fontWeight,color:note.color,lineHeight:parseFloat(note.lineHeight),marginBottom:parseFloat(note.marginBottom)}}})()`);
    assert.equal(report.homepageTypography.title.weight, '500');
    assert.ok(report.homepageTypography.title.size >= 24 && report.homepageTypography.title.size <= 30);
    assert.ok(report.homepageTypography.note.size >= 14);
    assert.ok(report.homepageTypography.note.lineHeight >= report.homepageTypography.note.size * 1.7);
    assert.notEqual(report.homepageTypography.title.color, report.homepageTypography.note.color);
    assert.equal(report.homepageTypography.note.marginBottom, 16);
    await shot('homepage-1440');
    await click('#cpModelBtn');
    await until('document.querySelectorAll("[data-model]").length===2');
    assert.equal(await js('document.querySelector("[data-thinking-toggle]")'), null);
    assert.match(await js('document.querySelector(".cp-model-summary").textContent'), /不支持/);
    await geometry(1440, 1000, false);
    await shot('managed-menu-1440');
    await click('[data-model-close]');
    assert.equal(await js('document.activeElement.id'), 'cpModelBtn');
    await click('#cpModelBtn');
    await click('.cp-hero', 0.05);
    assert.equal(await js('document.querySelector("#cpModelPop").classList.contains("show")'), false);
    assert.equal(await js('document.querySelector("#cpModelPop").matches(":popover-open")'), false);
    await click('#cpModelBtn');
    assert.equal(await js('document.querySelector("#cpModelPop").matches(":popover-open")'), true);
    await click('[data-model-close]');
    await click('#cpModelBtn');
    await click('[data-model="office-reasoning"]');
    await click('#cpModelBtn');
    assert.equal(await js('document.querySelector("[data-thinking-toggle]").disabled'), false);
    await click('[data-thinking-toggle]');
    assert.equal(await js('ComposeModelPicker.value().thinkingLevel'), 'medium');
    await click('[data-thinking-toggle]');
    assert.equal(await js('ComposeModelPicker.value().thinkingLevel'), 'off');
    await click('[data-model="office-fast"]');
    assert.equal(await js('ComposeModelPicker.value().thinkingLevel'), '');
    report.checks.push('Production homepage copy; compact unsupported-thinking status; supported thinking on/off; close restores focus');

    await js("presentationRuntime='codex';ComposeModelPicker.refresh(true)");
    await click('#cpModelBtn');
    assert.equal(await js('document.querySelectorAll("[data-native-model]").length'), 0);
    assert.equal(await js('ComposeModelPicker.value().modelName'), 'fixture-sol');
    assert.equal(await js('ComposeModelPicker.value().reasoningEffort'), 'medium');
    assert.equal(await js('document.querySelector("[data-effort-slider]").disabled'), false);
    const compact = await js(`(()=>{const pop=document.querySelector('#cpModelPop').getBoundingClientRect(),model=document.querySelector('[data-native-list]'),r=model.getBoundingClientRect(),s=getComputedStyle(model);return{width:pop.width,centerOffset:Math.abs(r.x+r.width/2-pop.x-pop.width/2),border:s.borderTopWidth,caption:Boolean(document.querySelector('.cp-effort-caption'))}})()`);
    assert.ok(compact.width<=280); assert.ok(compact.centerOffset<1);
    assert.equal(compact.border,'0px'); assert.equal(compact.caption,false);
    await shot('codex-two-stage-initial-default');
    await openNativeModels();
    await until('document.querySelectorAll("[data-native-model]").length===14');
    assert.equal(await js('document.querySelector(".cp-native-models").textContent.includes("默认推理")'), false);
    await click('[data-native-model="fixture-sol"]');
    assert.equal(await js('ComposeModelPicker.value().reasoningEffort'), 'medium');
    assert.equal(await js('document.querySelectorAll("[data-native-model]").length'), 0);
    await verifyMotion();
    await recordMotion();
    await geometry(1440, 1000, true);
    await shot('codex-menu-1440');
    await openNativeModels();
    await geometry(1440, 1000, true);
    await shot('codex-model-list-1440');
    await search('精简');
    assert.equal(await js('document.querySelectorAll(".cp-mrow:not([hidden])").length'), 1);
    await key('ENTER');
    assert.equal(await js('ComposeModelPicker.value().modelName'), 'fixture-luna');
    assert.equal(await js('document.querySelector("#cpModelPop").classList.contains("show")'), true);
    await openNativeModels();
    await search('不存在的模型');
    assert.equal(await js('document.querySelectorAll(".cp-mrow:not([hidden])").length'), 0);
    assert.equal(await js('document.querySelector(".cp-model-empty").hidden'), false);
    const untrustedSearch = '\"><img src=x onerror="window.presentationInjected=true">';
    await search(untrustedSearch);
    await js('ComposeModelPicker.refresh(true)');
    assert.equal(await js('document.querySelector(".cp-model-search input").value'), untrustedSearch);
    assert.equal(await js('document.querySelectorAll("#cpModelPop img").length'), 0);
    assert.equal(await js('Boolean(window.presentationInjected)'), false);
    await search('');
    await key('ArrowDown');
    assert.equal(await js('document.activeElement.dataset.nativeModel'), 'fixture-sol');
    await key('ArrowDown');
    assert.equal(await js('document.activeElement.dataset.nativeModel'), 'fixture-luna');
    await key('ArrowUp');
    assert.equal(await js('document.activeElement.dataset.nativeModel'), 'fixture-sol');
    await key('ENTER');
    assert.equal(await js('ComposeModelPicker.value().modelName'), 'fixture-sol');
    await dragEffort();
    assert.equal(await js('ComposeModelPicker.value().reasoningEffort'), 'ultra');
    assert.equal(await js('document.querySelector("[data-effort-slider]").getAttribute("aria-valuetext")'), '超高');
    await shot('codex-slider-ultra');
    await key('Home');
    assert.equal(await js('ComposeModelPicker.value().reasoningEffort'), 'low');
    await key('ArrowRight');
    assert.equal(await js('ComposeModelPicker.value().reasoningEffort'), 'medium');
    await key('End');
    assert.equal(await js('ComposeModelPicker.value().reasoningEffort'), 'ultra');
    await click('[data-effort-reset]');
    assert.equal(await js('ComposeModelPicker.value().reasoningEffort'), 'medium');
    await dragEffort();
    await openNativeModels();
    await click('[data-native-model="fixture-luna"]');
    assert.equal(await js('ComposeModelPicker.value().reasoningEffort'), 'medium');
    assert.equal(await js('document.querySelector("[data-effort-slider]").value'), '1');
    assert.match(await js('document.querySelector("[data-native-list]").textContent'), /精简档位/);
    const selectedModelFocus = await js('document.activeElement.matches("[data-native-list]")');
    await openNativeModels();
    await key('ESC');
    assert.equal(await js('document.querySelector("#cpModelPop").dataset.modelView'), 'effort');
    assert.equal(await js('document.activeElement.matches("[data-native-list]")'), true, JSON.stringify(await js('[document.activeElement.outerHTML,document.querySelector("#cpModelPop").className]')));
    await key('ESC');
    assert.equal(await js('document.querySelector("#cpModelPop").classList.contains("show")'), false);
    assert.equal(await js('document.activeElement.id'), 'cpModelBtn');
    report.checks.push('Codex long catalog; search and empty state; arrows/Enter; native choice stays open; effort and incompatible-model fallback; Escape/focus');
    report.checks.push('Continuous pointer drag retains the range element; Home/End/arrows; reset to medium; visible level matches submitted effort');

    for (const [width, height] of [[390, 720], [390, 480]]) {
      await js("document.documentElement.setAttribute('data-window-sidebar-hidden','')");
      win.setContentSize(width, height); await delay(140);
      await click('#cpModelBtn');
      await geometry(width, height, true);
      await shot('codex-menu-' + width + '-' + height);
      await openNativeModels();
      await geometry(width, height, true);
      await shot('codex-model-list-' + width + '-' + height);
      await click('[data-model-close]');
      await js("presentationRuntime='pi';ComposeModelPicker.refresh(true)");
      await click('#cpModelBtn');
      await geometry(width, height, false);
      await shot('managed-menu-' + width + '-' + height);
      await click('[data-model-close]');
      await js("presentationRuntime='codex';ComposeModelPicker.refresh(true)");
    }
    report.checks.push('1440x1000, 390x720 and 390x480 requested Windows sizes: actual viewport bounds recorded; scrollable catalog, visible close and fixed footer');
    report.checks.push('Search text with quotes and HTML remains literal across refresh; no injected element or handler');
    assert.equal(selectedModelFocus, true, 'Codex model choice returns focus to the model trigger');
    report.modelLabels = [];
    for (const width of [1440,390]) {
      await js(`document.documentElement.toggleAttribute('data-window-sidebar-hidden',${width<620})`);
      win.setContentSize(width,720); await delay(140);
      for (const label of ['GPT-6.1-Sol','企业-Codex-GPT-6.1-Sol-超长模型名称完整显示验证']) {
        await js(`presentationNative[0].label=${JSON.stringify(label)};ComposeModelPicker.refresh(true)`);
        await click('#cpModelBtn'); await openNativeModels();
        const listText = await js(`(()=>{const e=document.querySelector('[data-native-model="fixture-sol"] b');return{text:e.textContent,clipped:e.scrollWidth>e.clientWidth||e.scrollHeight>e.clientHeight}})()`);
        assert.equal(listText.text,label); assert.equal(listText.clipped,false,'model names in the list also wrap without ellipsis');
        await click('[data-native-model="fixture-sol"]');
        const modelText = await js(`(()=>{const e=document.querySelector('[data-native-list] small');return{text:e.textContent,clipped:e.scrollWidth>e.clientWidth||e.scrollHeight>e.clientHeight}})()`);
        assert.ok(modelText.text.includes(label)); assert.equal(modelText.clipped,false);
        await click('[data-effort-slider]',.99);
        assert.equal(await js('ComposeModelPicker.value().reasoningEffort'),'ultra');
        await shot('codex-two-stage-'+width+(label==='GPT-6.1-Sol'?'-standard':'-long'));
        await click('#cpModelBtn');
        const trigger = await js(`(()=>{const e=document.querySelector('#cpModelName'),send=document.querySelector('#cpGo'),r=send.getBoundingClientRect();return{text:e.textContent,clipped:e.scrollWidth>e.clientWidth||e.scrollHeight>e.clientHeight,overflow:document.documentElement.scrollWidth>innerWidth,sendVisible:send.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`);
        assert.ok(trigger.text.includes(label)); assert.ok(trigger.text.includes('超高'));
        assert.equal(trigger.clipped,false,'model and effort must be readable');
        assert.equal(trigger.overflow,false); assert.equal(trigger.sendVisible,true);
        report.modelLabels.push({width,label,...trigger});
      }
    }
    report.checks.push('Compact Codex first; model list is a separate view; selection/back/Escape return to effort; full names and effort remain readable at 1440px/390px without covering send');
    assert.deepEqual(await js('fixtureErrors'), []);
    assert.equal(await js("fixtureCalls.filter(row=>row[0]==='send').length"), 0);
    report.ok = true;
  }
  app.whenReady().then(run).catch(error => { report.error = error.stack; }).finally(async () => {
    if (win && !win.isDestroyed()) {
      if (!report.ok) { try { await shot('failure'); } catch (error) { report.captureError = error.message; } }
      win.destroy();
    }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    app.exit(report.ok ? 0 : 1);
  });
}
