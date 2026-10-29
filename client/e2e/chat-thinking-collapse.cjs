'use strict';
// Real Chromium layout/animation with a deterministic stream; no account/model calls.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  app.disableHardwareAcceleration();
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict');
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-thinking-fold-')));
  let win;
  const report = { ok: false, scope: 'Real Chromium animation, deterministic local and cloud transcript updates' };
  const output = path.resolve(__dirname, '../../outputs/ui-polish-20261015');
  const js = code => win.webContents.executeJavaScript(code);
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1100, height: 820,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    await win.loadFile(path.join(__dirname, 'fixtures/long-conversation.html'));
    await js(`
      window.sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
      window.scrollBox=document.querySelector('#nchatScroll');
      window.list=document.querySelector('#nchatList');
      window.start=async (scope,long=true)=>{
        renderer.reset();ctx._ref=scope;fill(8);ctx._snap.tools=[];ctx._snap.status='streaming';
        window.thought={kind:'thinking',index:0,done:false,text:long?'Check constraints\\n'.repeat(30):'Planning'};
        window.message={role:'assistant',done:false,blocks:[thought]};ctx._snap.messages.push(message);
        renderer._render();await sleep(200);
      };
      window.state=()=>({body:document.querySelector('.nthink-body').getBoundingClientRect().height,
        list:list.getBoundingClientRect().height,top:scrollBox.scrollTop,
        floor:list.style.minHeight,follow:scrollBox.__soduworkScrollFollow?.follow,
        textBottom:[...list.querySelectorAll('.ntext')].at(-1)?.getBoundingClientRect().bottom-scrollBox.getBoundingClientRect().top,
        blank:list.getBoundingClientRect().bottom-[...list.children].filter(e=>e.getBoundingClientRect().height>0).at(-1).getBoundingClientRect().bottom,
        bottomGap:scrollBox.scrollHeight-scrollBox.clientHeight-scrollBox.scrollTop});
      window.complete=()=>{thought.done=true;message.blocks.push({kind:'text',index:1,done:false,text:'Done.'});renderer._render()};
      void 0;
    `);
    report.fold = await js(`(async()=>{
      await start('fold');const before=state();complete();const frames=[state()];
      for(let i=0;i<18;i++){await new Promise(requestAnimationFrame);frames.push(state());}
      return {before,frames};
    })()`);
    assert.equal(report.fold.before.body, 144);
    assert.ok(report.fold.frames.some(x => x.body > 2 && x.body < 142), 'upward fold has intermediate frames');
    assert.equal(report.fold.frames.at(-1).body, 0, 'completed reasoning collapses');
    for (let i = 1; i < report.fold.frames.length; i++) {
      assert.ok(report.fold.frames[i].body <= report.fold.frames[i - 1].body + 1, 'fold shrinks upward monotonically');
      assert.ok(Math.abs(report.fold.frames[i].textBottom-report.fold.frames[1].textBottom)<=2,
        'latest answer stays at the same screen position while reasoning folds');
      assert.equal(report.fold.frames[i].floor, '', 'fold never locks the virtualized list height');
      assert.ok(report.fold.frames[i].blank<=10, 'no artificial blank area below the last visible message');
    }
    report.fill = await js(`(async()=>{
      const before=state();message.blocks[1].text+=' Streaming answer.'.repeat(10);renderer._render();await sleep(350);
      const short=state();message.blocks[1].text+='\\n\\nMore output.'.repeat(60);renderer._render();await sleep(350);
      return {before,short,long:state()};
    })()`);
    assert.ok(report.fill.short.blank<=10, 'short output does not leave reserved space');
    assert.ok(report.fill.long.list>report.fill.short.list, 'long output grows naturally');
    assert.ok(report.fill.long.bottomGap<3, 'normal streaming bottom following still works');
    assert.equal(report.fill.long.floor,'','streaming never retains a height constraint');
    report.short = await js(`(async()=>{await start('short',false);const before=state();complete();await sleep(250);return {before,after:state()}})()`);
    assert.ok(report.short.before.body<70, 'short reasoning uses natural height');
    assert.equal(report.short.after.body,0);
    report.reopen = await js(`(async()=>{
      await start('reopen');complete();await sleep(40);
      const head=document.querySelector('.nthink-head');head.click();
      head.closest('.nthink').classList.add('open');await sleep(250);
      return {open:document.querySelector('.nthink').classList.contains('open'),height:state().body,animations:document.getAnimations().length};
    })()`);
    assert.equal(report.reopen.open,true, 'manual reopen wins over an in-flight fold');
    assert.equal(report.reopen.height,144);
    assert.equal(report.reopen.animations,0);
    report.paused = await js(`(async()=>{
      await start('paused');scrollBox.__soduworkScrollFollow.follow=false;scrollBox.dataset.scrollFollow='paused';
      scrollBox.scrollTop=80;await sleep(200);const before=state();complete();await sleep(250);return {before,after:state()};
    })()`);
    assert.ok(Math.abs(report.paused.before.top-report.paused.after.top)<=2,'paused historical reading stays anchored');
    assert.equal(report.paused.after.floor,'','paused reading does not reserve tail space');
    report.pauseDuringFold = await js(`(async()=>{
      await start('pause-during-fold');complete();await sleep(35);
      const wasFolding=document.getAnimations().some(a=>a.effect?.target?.matches('.nthink-body'));
      scrollBox.dispatchEvent(new WheelEvent('wheel',{deltaY:-250,bubbles:true}));
      scrollBox.scrollTop-=250;await new Promise(requestAnimationFrame);
      const anchor=[...list.children].find(e=>e.getBoundingClientRect().height>0&&e.getBoundingClientRect().bottom>scrollBox.getBoundingClientRect().top);
      const before=anchor.getBoundingClientRect().top;await sleep(250);
      return {wasFolding,before,after:anchor.getBoundingClientRect().top,...state()};
    })()`);
    assert.equal(report.pauseDuringFold.wasFolding,true);
    assert.equal(report.pauseDuringFold.follow,false,'scrolling up during folding pauses automatic following');
    assert.ok(Math.abs(report.pauseDuringFold.before-report.pauseDuringFold.after)<=2,'remaining animation does not move historical reading');
    report.reset = await js(`(async()=>{
      await start('reset');complete();const folding=document.getAnimations().length;renderer.reset();
      await sleep(250);return {folding,after:list.style.minHeight,animations:document.getAnimations().length};
    })()`);
    assert.ok(report.reset.folding>0);
    assert.equal(report.reset.after,'','reset leaves no session-specific reservation');
    assert.equal(report.reset.animations,0);
    report.cloud = await js(`(async()=>{
      renderer.reset();list.innerHTML='<div data-task-stream="cloud-one"><div class="nthink is-live open" data-dks-node="thinking:1"><div class="nthink-head">Thinking</div><div class="nthink-body">'+('Reasoning<br>'.repeat(20))+'</div></div></div>';
      scrollBox.dataset.scrollFollow='following';delete scrollBox.__soduworkScrollFollow;
      const card=list.querySelector('.nthink'),body=card.querySelector('.nthink-body');
      const commit=ChatThinkingCollapse.capture(list,scrollBox,'cloud');card.classList.remove('open','is-live');commit();
      await sleep(60);const mid=body.getBoundingClientRect().height;await sleep(200);
      const done={height:body.getBoundingClientRect().height,floor:list.style.minHeight};
      const noOp=ChatThinkingCollapse.capture(list,scrollBox,'other-session');noOp();
      return {mid,done,nextFloor:list.style.minHeight};
    })()`);
    assert.ok(report.cloud.mid>0&&report.cloud.mid<144,'cloud timeline uses the same upward animation');
    assert.equal(report.cloud.done.height,0);
    assert.equal(report.cloud.nextFloor,'','switching sessions cannot carry a stale floor');
    report.resize = await js(`(async()=>{
      await start('resize');complete();await sleep(250);const reserved=list.style.minHeight;
      list.style.width='480px';await sleep(200);
      const after=list.style.minHeight;list.style.width='';return {reserved,after};
    })()`);
    assert.equal(report.resize.reserved,'');
    assert.equal(report.resize.after,'','opening a side pane cannot retain a height measured at the old width');
    report.repeated = await js(`(async()=>{
      await start('repeated');complete();await sleep(35);
      thought.done=false;message.blocks.pop();renderer._render();
      await sleep(20);complete();await sleep(300);
      return {height:state().body,display:document.querySelector('.nthink-body').style.display};
    })()`);
    assert.equal(report.repeated.height,0,'overlapping completion snapshots cannot leave reasoning visible');
    assert.equal(report.repeated.display,'','fold cleanup restores the original display rule');
    await win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    report.reduced = await js(`(async()=>{await start('reduced');complete();return {animations:document.getAnimations().length,...state()}})()`);
    assert.equal(report.reduced.animations,0,'respects reduced-motion preference');
    assert.equal(report.reduced.body,0);
    assert.equal(report.reduced.floor,'','reduced motion cannot leave a blank tail');
    report.ok=true;
  }).catch(error=>{report.error=error.stack||String(error)}).finally(()=>{
    if(win&&!win.isDestroyed())win.destroy();fs.mkdirSync(output,{recursive:true});
    fs.writeFileSync(path.join(output,'thinking-collapse.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));app.exit(report.ok?0:1);
  });
}
