'use strict';
// Reproduce feedback inside the real requirement detail with the complete desktop cascade.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env};
  for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[name];
  const result = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)], {
    env, windowsHide: true, stdio: 'inherit', timeout: 180000,
  });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
const {app, BrowserWindow} = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const client = path.resolve(__dirname, '..');
const baseline = process.argv.includes('--baseline');
const output = path.resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) || path.join(client, 'outputs/task-evolution-compact'));
fs.mkdirSync(output, {recursive: true});
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-evaluation-')));
app.disableHardwareAcceleration();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const styles = [...fs.readFileSync(path.join(client, 'desk.html'), 'utf8')
  .matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)/g)]
  .map(match => pathToFileURL(path.join(client, match[1])).href);
const report = {ok: false, baseline, checks: [], layouts: [], errors: [],
  boundary: 'Hidden Electron, real requirement detail/trace/evaluation, full desktop CSS, native pointer and keyboard; fixture APIs, HTTP(S) blocked'};
report.sources = Object.fromEntries(['components/panels/task-evolution-view.js', 'components/panels/task-evolution-view.css'].map(file =>
  [file, require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(client, file))).digest('hex')]));
let win;
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({show: false, width: 1440, height: 1000,
      webPreferences: {offscreen: true, contextIsolation: true, sandbox: true, backgroundThrottling: false}});
    win.webContents.session.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*']}, (_request, done) => done({cancel: true}));
    win.webContents.on('console-message', event => {if (event.level === 'error') report.errors.push(event.message);});
    const js = code => win.webContents.executeJavaScript(code, true);
    const check = (value, message) => {report.checks.push({message, passed: !!value}); if (!baseline) assert.ok(value, message);};
    const key = async (keyCode, modifiers = []) => {
      win.webContents.sendInputEvent({type:'keyDown', keyCode, modifiers});
      if (keyCode === 'Return' || keyCode === 'Space') win.webContents.sendInputEvent({type:'char',keyCode:keyCode === 'Return' ? '\r' : ' ',modifiers});
      win.webContents.sendInputEvent({type:'keyUp', keyCode, modifiers});
      await wait(65);
    };
    const pointer = async selector => {
      const point = await js(`(async()=>{const n=document.querySelector(${JSON.stringify(selector)});
        if(!n||n.disabled||!n.getClientRects().length)throw Error('Unavailable '+${JSON.stringify(selector)});
        n.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        const b=n.getBoundingClientRect(),x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height/2);
        if(!n.contains(document.elementFromPoint(x,y)))throw Error('Occluded '+${JSON.stringify(selector)});return{x,y}})()`);
      const zoom = win.webContents.getZoomFactor();
      for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({type,
        x: Math.round(point.x * zoom), y: Math.round(point.y * zoom), ...(type === 'mouseMove' ? {} : {button: 'left', clickCount: 1})});
      await wait(100);
    };
    const capture = async name => {
      await js(`document.querySelector('.tev-shell').scrollIntoView({block:'center',behavior:'instant'});void 0`);
      await wait(100);
      fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
    };
    await win.loadFile(path.join(__dirname, 'fixtures/requirements-board.html'));
    await js(`Promise.all(${JSON.stringify(styles)}.map(href=>new Promise((resolve,reject)=>{
      const n=document.createElement('link');n.rel='stylesheet';n.href=href;n.onload=resolve;n.onerror=()=>reject(Error(href));document.head.append(n)}))).then(()=>true)`);
    for (const file of ['task-trace-view.js', 'task-evolution-view.js', 'task-trace-runtime.js']) {
      await js(`new Promise((resolve,reject)=>{const n=document.createElement('script');n.src=${JSON.stringify(pathToFileURL(path.join(client, 'components/panels', file)).href)};n.onload=()=>resolve(true);n.onerror=reject;document.head.append(n)})`);
    }
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled: true});
    await js(`window.evaluationCalls=[];window.decisionCalls=[];window.failEvaluation=false;
      window.evaluationTrace={task:{id:'delivered-0',title:'官网内容和访问验证已交付',status:'done'},
        summary:{lifecycle:{title:'需求已完成',state:'succeeded',nextAction:'查看成果与验收记录',progress:{done:4,total:4,unit:'阶段'}}},
        card:{taskId:'delivered-0'},delivery:{authority:'manual'},runs:[],stages:[],phases:[],ai:[],execution:{sessions:[]},
        evolution:{state:'awaiting_evaluation',available:true,access:{canEvaluate:true,canReview:true},
          guardrail:'评价不会直接改变当前流程；改进建议需经审议后进入新版本。'}};
      SoduWorkAPI.taskTrace=async()=>structuredClone(evaluationTrace);
      SoduWorkAPI.saveTaskEvaluation=async(id,data)=>{evaluationCalls.push([id,structuredClone(data)]);
        if(failEvaluation)throw Error('fixture save failure');
        Object.assign(evaluationTrace.evolution,{state:'evaluated',myEvaluation:{...data,evaluatorName:'测试成员',revision:1},evaluation:{...data,evaluatorName:'测试成员',revision:1}});
      };
      SoduWorkAPI.decideTaskEvolution=async(...args)=>{decisionCalls.push(args);evaluationTrace.evolution.proposal.state=args[2]};
      void 0`);
    const open = async () => {
      await js(`RequirementsDetail.open('delivered-0')`); await wait(120);
      await pointer('[data-rq-execution]>summary'); await wait(120);
      await pointer('.tev-shell>summary'); await pointer('[data-tev-start]');
    };
    for (const [theme, width, zoom] of [['vivid',1440,1], ['vivid',600,1], ['vivid',390,1], ['azure',960,1.25], ['minimal',600,1]]) {
      win.setContentSize(width, 1000); win.webContents.setZoomFactor(zoom);
      await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)};void 0`); await wait(90);
      await open();
      const label = theme + '-' + width + '-' + zoom;
      const layout = await js(`(()=>{const form=document.querySelector('.tev-form'),input=form.elements.createProposal,label=input.parentElement,span=label.querySelector('span');
        const box=n=>{const b=n.getBoundingClientRect();return{x:b.x,y:b.y,right:b.right,bottom:b.bottom,width:b.width,height:b.height}};
        const texts=[...form.querySelectorAll('legend,span,textarea,summary,button')].filter(n=>n.getClientRects().length);
        return{checkbox:box(input),labelBox:box(label),text:box(span),form:box(form),textarea:box(form.elements.summary),
          rowDirection:getComputedStyle(label).flexDirection,border:parseFloat(getComputedStyle(form).borderTopWidth),
          overflow:form.scrollWidth>form.clientWidth+1,advancedOpen:form.querySelector('details').open,
          buttons:[...form.querySelectorAll('footer button')].map(box),minimumFont:Math.min(...texts.map(n=>parseFloat(getComputedStyle(n).fontSize)))}})()`);
      report.layouts.push({label,...layout}); await capture('form-' + label);
      check(layout.checkbox.width >= 14 && layout.checkbox.width <= 20 && layout.checkbox.height >= 14 && layout.checkbox.height <= 20,
        label + ': native checkbox stays small inside requirement CSS');
      check(layout.rowDirection === 'row' && layout.text.x >= layout.checkbox.right,
        label + ': checkbox and label share one inline row');
      check(layout.border === 0, label + ': feedback form adds no nested bordered card');
      check(!layout.overflow && layout.form.height < 370 && layout.textarea.height <= 72,
        label + ': compact form and short reflection fit without horizontal overflow');
      check(layout.minimumFont >= 12 && !layout.advancedOpen, label + ': readable text and optional experience collapsed');
      check(layout.buttons.every(b=>b.height<=36), label + ': save and cancel remain small');
      await pointer('[data-tev-cancel]');
      check(await js(`document.querySelector('[data-tev-form]').hidden&&document.activeElement.matches('[data-tev-start]')`),
        label + ': cancel closes form and returns keyboard focus to its trigger');
      await pointer('[data-rq-dismiss]');
    }
    if (baseline) {report.ok = report.checks.every(c=>c.passed); return;}
    win.webContents.setZoomFactor(1); win.setContentSize(1440, 1000);
    await open();
    check(await js(`document.activeElement.name==='summary'`), 'opening feedback focuses the reflection field');
    await key('Tab', ['shift']); await key('Right');
    check(await js(`document.activeElement.value==='partial'&&document.querySelector('[name=outcome]:checked').value==='partial'`),
      'keyboard can select a result using native radio arrow navigation');
    check(await js(`(()=>{const n=document.activeElement.nextElementSibling;return parseFloat(getComputedStyle(n).outlineWidth)>=2})()`),
      'radio keyboard selection has a visible focus indicator');
    await key('Tab'); await win.webContents.insertText('交付可用，图表说明还可以更清楚。');
    await key('Tab'); await key('Return');
    check(await js(`document.querySelector('.tev-more').open`), 'keyboard expands optional experience');
    await key('Tab'); await win.webContents.insertText('资料引用完整');
    await key('Tab'); await win.webContents.insertText('补充图表说明');
    await key('Tab'); await win.webContents.insertText('交付前对照清单');
    await key('Tab'); await key('Space');
    check(await js(`!document.querySelector('[name=createProposal]').checked`), 'Space toggles the small native checkbox');
    await capture('advanced-keyboard');
    win.setContentSize(390, 1000); await wait(100);
    check(await js(`(()=>{const n=document.querySelector('.tev-form');return n.scrollWidth<=n.clientWidth+1&&getComputedStyle(n.querySelector('.tev-more>div')).gridTemplateColumns.split(' ').length===1})()`),
      'expanded experience becomes one readable column at narrow width');
    await capture('advanced-narrow');
    win.setContentSize(1440, 1000); await wait(100);
    await pointer('.tev-form button[type=submit]');
    const saved = await js(`evaluationCalls[0]`);
    assert.deepEqual(saved, ['delivered-0', {outcome:'partial',score:3,summary:'交付可用，图表说明还可以更清楚。',
      workedWell:'资料引用完整',improvement:'补充图表说明',reusableLesson:'交付前对照清单',createProposal:false}]);
    check(true, 'native form saves unchanged evaluation payload and unchecked proposal choice');
    check(await js(`document.querySelector('.tev-evaluation').textContent.includes('部分达到')&&document.querySelector('.tev-evaluation').textContent.includes('交付前对照清单')`),
      'successful save refreshes the evaluation from authoritative trace');
    await capture('saved');
    await pointer('[data-tev-start]');
    check(await js(`document.querySelector('[name=summary]').value==='交付可用，图表说明还可以更清楚。'&&!document.querySelector('.tev-more').open`),
      'updating restores saved fields with optional experience still collapsed');
    await pointer('[data-tev-cancel]');
    check(await js(`evaluationCalls.length===1`), 'cancel does not submit evaluation or create a proposal');
    await pointer('[data-tev-start]');
    await js(`failEvaluation=true;void 0`); await pointer('.tev-form button[type=submit]');
    check(await js(`!!document.querySelector('[data-tev-error]').textContent&&!document.querySelector('.tev-form button[type=submit]').disabled&&document.querySelector('[name=summary]').value.includes('交付可用')`),
      'save failure is visible, preserves draft, and permits retry');
    await capture('save-error');
    await js(`failEvaluation=false;void 0`); await pointer('.tev-form button[type=submit]');
    check(await js(`evaluationCalls.length===3&&evaluationCalls[2][1].createProposal===true`), 'retry retains the original default checked proposal semantics');
    const refresh = async () => {await js(`TaskExecutionJourney.mount(document.querySelector('[data-rq-trace]'),{taskId:'delivered-0',compact:true,force:true,refreshMs:0})`); await wait(100);};
    await js(`evaluationTrace.evolution.state='awaiting_decision';evaluationTrace.evolution.proposal={id:'proposal-1',state:'pending',targetKind:'workflow',title:'补齐交付检查',problem:'说明不完整',proposal:'交付前按清单复核'};void 0`); await refresh();
    await capture('proposal-pending');
    await pointer('[data-tev-decision=accepted]');
    check(await js(`decisionCalls.length===1&&JSON.stringify(decisionCalls[0])===JSON.stringify(['delivered-0','proposal-1','accepted',''])`),
      'acceptance continues to record the same controlled improvement decision');
    await js(`evaluationTrace.evolution.proposal.state='pending';void 0`); await refresh();
    await pointer('[data-tev-reject-open]'); await win.webContents.insertText('本次无需更改工作流'); await key('Tab'); await key('Return');
    check(await js(`JSON.stringify(decisionCalls[1])===JSON.stringify(['delivered-0','proposal-1','rejected','本次无需更改工作流'])`),
      'rejection preserves task, proposal, decision, and review note');
    await js(`evaluationTrace.evolution.access={canEvaluate:false,canReview:false};evaluationTrace.evolution.proposal.state='pending';void 0`); await refresh();
    check(await js(`!document.querySelector('[data-tev-start],[data-tev-decision],[data-tev-reject-open]')&&document.querySelector('[data-tev-form]').hidden`),
      'read-only users receive no evaluation or controlled improvement actions');
    await capture('read-only');
    check((await js('fixtureErrors')).length === 0 && report.errors.length === 0, 'no uncaught or renderer errors');
    report.ok = true;
  } catch (error) {
    report.error = String(error.stack || error);
    if (win) fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG());
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ok:report.ok,checks:report.checks.length,failed:report.checks.filter(c=>!c.passed),error:report.error,output}));
    app.exit(report.ok ? 0 : 1);
  }
});
