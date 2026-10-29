'use strict';
// Deterministic production renderer/CSS in Chromium; no production account or model calls.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const args = [__filename, ...(process.argv.includes('--baseline') ? ['--baseline'] : [])];
  require('node:child_process').spawn(electron, args, { env, windowsHide: true, stdio: 'inherit' })
    .on('error', error => { console.error(error); process.exitCode = 1; })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict');
  app.disableHardwareAcceleration();
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-thinking-long-')));
  const baseline = process.argv.includes('--baseline');
  const report = { ok: false, baseline, scope: 'Deterministic long-conversation production renderer/CSS in Chromium; no production account/model calls', scenarios: [] };
  const output = path.resolve(__dirname, '../../outputs/ui-polish-20261015');
  let win;
  const js = code => win.webContents.executeJavaScript(code);
  const compact = (sample, label) => {
    assert.equal(sample.floor, '', label + ': no transcript-wide min-height reservation');
    assert.ok(sample.tailGap < 3, label + ': no empty space below the last rendered content: ' + sample.tailGap);
  };
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1100, height: 820,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    await win.loadFile(path.join(__dirname, 'fixtures/long-conversation.html'));
    if (baseline) {
      // Load only the committed old helper in this isolated renderer. Never
      // overwrite the checked-out helper while another agent is editing it.
      const oldHelper = require('node:child_process').execFileSync('git',
        ['show', 'HEAD:client/components/panels/chat-thinking-collapse.js'],
        { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', windowsHide: true, timeout: 10000 });
      await js(oldHelper);
    }
    await js(`
      window.sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      window.scrollBox=document.querySelector('#nchatScroll');window.list=document.querySelector('#nchatList');
      window.sample=()=>{
        const rows=[...list.children].filter(node=>node.getBoundingClientRect().height>.5);
        const tail=rows.at(-1),box=list.getBoundingClientRect(),body=list.querySelector('.nthink.is-live .nthink-body');
        return {floor:list.style.minHeight,top:scrollBox.scrollTop,listHeight:box.height,
          tailGap:tail?box.bottom-tail.getBoundingClientRect().bottom-parseFloat(getComputedStyle(list).paddingBottom):0,
          first:list.querySelector('[data-chat-node^="message:"]')?.dataset.chatNode,
          count:list.querySelectorAll('[data-chat-node^="message:"]').length,
          follow:scrollBox.__soduworkScrollFollow?.follow,body:body?.getBoundingClientRect().height||0};
      };
      window.start=async scope=>{
        renderer.reset();ctx._ref=scope;ctx._messageWindowSize=80;fill(120);
        ctx._snap.status='idle';ctx._snap.execution={};ctx._snap.tools=[];
        renderer._render();await sleep(220);
      };
      window.begin=async serial=>{
        ctx._snap.execution={};ctx._snap.status='streaming';ctx._snap.statusText='';
        ctx._snap.messages.push({role:'user',text:'Continue '+serial});
        window.thought={kind:'thinking',index:0,done:false,text:'Review constraints\\n'.repeat(30)};
        window.message={role:'assistant',done:false,blocks:[thought]};ctx._snap.messages.push(message);
        renderer._render();await sleep(45);
      };
      window.finish=async (serial,outcome='idle')=>{
        thought.done=true;message.blocks.push({kind:'text',index:1,done:false,text:'Short reply '+serial+'.'});
        ctx._snap.tools.push({id:'alternating-tool-'+serial,after:ctx._snap.messages.length,name:serial%2?'read':'bash',
          args:serial%2?{path:'report-'+serial+'.md'}:{command:'echo checked'},state:'done',result:'Checked'});
        renderer._render();await sleep(220);message.done=true;
        ctx._snap.status=outcome==='error'?'unreachable':'idle';
        ctx._snap.statusText=outcome==='error'?'Fixture execution error':'';
        ctx._snap.execution=outcome==='stop'?{stopped:true,reason:'Stopped by user'}:{};
        renderer._render();await sleep(80);return sample();
      };
      window.visibleAnchor=()=>{
        const top=scrollBox.getBoundingClientRect().top;
        const node=[...list.children].find(item=>item.getBoundingClientRect().height>0&&item.getBoundingClientRect().bottom>top);
        return node?{key:node.dataset.chatNode,offset:node.getBoundingClientRect().top-top}:null;
      };
      window.anchorOffset=anchor=>{
        const node=[...list.children].find(item=>item.dataset.chatNode===anchor.key);
        return node?node.getBoundingClientRect().top-scrollBox.getBoundingClientRect().top:null;
      };
      void 0;
    `);
    report.long = await js(`(async()=>{await start('long-window');const before=sample(),rounds=[];
      for(let i=0;i<12;i++){await begin(i);rounds.push(await finish(i));}
      return {before,rounds,total:ctx._snap.messages.length};})()`);
    assert.ok(report.long.total > 140, 'more than 80 messages exercise rolling history');
    assert.notEqual(report.long.before.first, report.long.rounds.at(-1).first, 'old rows are removed as the window advances');
    for (const [index, sample] of report.long.rounds.entries()) compact(sample, 'long fold ' + index);
    report.scenarios.push('long history: 12 folds, short replies, alternating tools and rolling window');
    report.outcomes = {};
    for (const outcome of ['idle', 'stop', 'error']) {
      report.outcomes[outcome] = await js(`(async()=>{await begin(100);return await finish(100,${JSON.stringify(outcome)});})()`);
      compact(report.outcomes[outcome], outcome);
    }
    report.scenarios.push('completion, user stop and execution error release layout space');
    report.paused = await js(`(async()=>{
      await start('paused-history');await begin(200);
      scrollBox.dispatchEvent(new WheelEvent('wheel',{deltaY:-80,bubbles:true}));
      scrollBox.scrollTop=Math.max(0,scrollBox.scrollTop-700);await sleep(80);
      const anchor=visibleAnchor(),before=anchorOffset(anchor);await finish(200);
      return {anchor,before,after:anchorOffset(anchor),...sample()};
    })()`);
    assert.equal(report.paused.follow, false);
    assert.ok(Math.abs(report.paused.after - report.paused.before) < 3, 'paused historical reading retains the visible anchor');
    compact(report.paused, 'paused history');
    report.scenarios.push('historical reading remains paused and anchored during completion');
    report.older = await js(`(async()=>{
      const anchor=visibleAnchor(),before=anchorOffset(anchor);ctx._messageWindowSize=160;
      renderer._render();await sleep(100);return {before,after:anchorOffset(anchor),...sample()};
    })()`);
    assert.ok(report.older.count > 80, 'older history is actually mounted');
    assert.ok(Math.abs(report.older.after - report.older.before) < 3, 'mounting older rows keeps the existing reading anchor');
    compact(report.older, 'expanded history');
    report.scenarios.push('renderer history-window expansion preserves reading position');
    report.scopeSwitch = await js(`(async()=>{
      await start('old-scope');await begin(300);thought.done=true;
      message.blocks.push({kind:'text',index:1,done:false,text:'Done.'});renderer._render();
      await sleep(35);renderer.reset();ctx._ref='new-scope';ctx._snap.status='idle';ctx._snap.execution={};
      ctx._snap.tools=[];ctx._snap.messages=[{role:'user',text:'New conversation'},{role:'assistant',done:true,blocks:[{kind:'text',text:'New answer'}]}];
      renderer._render();await sleep(250);return {...sample(),animations:document.getAnimations().length};
    })()`);
    compact(report.scopeSwitch, 'new scope');
    assert.equal(report.scopeSwitch.count, 2);
    assert.equal(report.scopeSwitch.animations, 0, 'switching scopes cancels the prior fold animation');
    report.scenarios.push('switching scope during a fold leaves no animation or reserved height');
    report.ok = true;
  }).catch(error => { report.error = error.stack || String(error); }).finally(() => {
    if (win && !win.isDestroyed()) win.destroy();
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, baseline ? 'thinking-collapse-long-baseline.json' : 'thinking-collapse-long.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));app.exit(report.ok ? 0 : 1);
  });
}
