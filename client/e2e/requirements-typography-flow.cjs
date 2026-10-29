'use strict';
// Production components and complete desktop styles with isolated fixture APIs.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env};
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[key];
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
const output = path.resolve(process.argv.slice(2).find(value => !value.startsWith('--')) || path.join(client, '../outputs/requirements-typography-flow'));
fs.mkdirSync(output, {recursive: true});
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-typography-')));
app.disableHardwareAcceleration();
const styles = [...fs.readFileSync(path.join(client, 'desk.html'), 'utf8')
  .matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)/g)]
  .map(match => pathToFileURL(path.join(client, match[1])).href);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = {ok: false, baseline, checks: [], layouts: [], errors: [], editHierarchies: {}, createHierarchies: {}, boundary: 'Hidden Electron, real pointer events, complete desktop CSS, fixture APIs; no business data or network'};
report.sources = Object.fromEntries(['components/requirements/requirements-board.css', 'components/requirements/requirements-detail.js',
  'components/requirements/requirement-fields.js', 'components/panels/work-entry-sheet.css', 'components/panels/work-entry-sheet.js',
  'components/panels/panels-compose-draft.js'].map(file => [file, require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(client, file))).digest('hex')]));
let win;
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({show: false, width: 1440, height: 1000,
      webPreferences: {offscreen: true, contextIsolation: true, sandbox: true, backgroundThrottling: false}});
    win.webContents.session.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*']}, (_request, done) => done({cancel: true}));
    win.webContents.on('console-message', event => {if (event.level === 'error') report.errors.push(event.message);});
    const js = source => win.webContents.executeJavaScript(source, true);
    const check = (condition, message) => {report.checks.push({message, passed: !!condition}); if (!baseline) assert.ok(condition, message);};
    const pointer = async (selector, hover = false) => {
      const point = await js(`(async()=>{const n=[...document.querySelectorAll(${JSON.stringify(selector)})].find(n=>n.getClientRects().length&&!n.disabled);
        if(!n)throw Error('Unavailable '+${JSON.stringify(selector)});n.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height/2);
        if(!n.contains(document.elementFromPoint(x,y)))throw Error('Occluded '+${JSON.stringify(selector)});return{x,y}})()`);
      const zoom = win.webContents.getZoomFactor();
      for (const type of hover ? ['mouseMove'] : ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({type,
        x: Math.round(point.x * zoom), y: Math.round(point.y * zoom), ...(type === 'mouseMove' ? {} : {button: 'left', clickCount: 1})});
      await wait(100);
    };
    const capture = async name => {await wait(80); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());};
    const script = async relative => js(`new Promise((resolve,reject)=>{const n=document.createElement('script');n.src=${JSON.stringify(pathToFileURL(path.join(client, relative)).href)};n.onload=()=>resolve(true);n.onerror=reject;document.head.append(n)})`);
    const key = async keyCode => {
      win.webContents.sendInputEvent({type: 'keyDown', keyCode});
      win.webContents.sendInputEvent({type: 'keyUp', keyCode}); await wait(70);
    };
    const load = async fixture => {
      await win.loadFile(path.join(__dirname, 'fixtures', fixture));
      await js(`Promise.all(${JSON.stringify(styles)}.map(href=>new Promise((resolve,reject)=>{const n=document.createElement('link');n.rel='stylesheet';n.href=href;n.onload=resolve;n.onerror=()=>reject(Error(href));document.head.append(n)}))).then(()=>true)`);
      await wait(150);
    };
    const typography = async (selector, label) => {
      const value = await js(`(()=>{const root=document.querySelector(${JSON.stringify(selector)}),visible=n=>n.getClientRects().length&&getComputedStyle(n).visibility!=='hidden';
        const text=[root,...root.querySelectorAll('*')].filter(n=>visible(n)&&([...n.childNodes].some(c=>c.nodeType===3&&c.textContent.trim())||n.matches('input,textarea,select')));
        const sizes=text.map(n=>({selector:n.tagName+'.'+n.className,text:(n.textContent||n.placeholder||'').trim().slice(0,55),size:parseFloat(getComputedStyle(n).fontSize)}));
        return{label:${JSON.stringify(label)},minimum:Math.min(...sizes.map(n=>n.size)),small:sizes.filter(n=>n.size<12),overflow:root.scrollWidth>root.clientWidth+1,width:root.clientWidth,viewport:innerWidth}})()`);
      report.layouts.push(value); check(value.minimum >= 12, label + ': every visible text is at least 12px');
      check(!value.overflow, label + ': content has no horizontal overflow');
      return value;
    };
    await load('requirements-board.html');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled: true});
    for (const [width, zoom] of [[1440, 1], [600, 1], [390, 1], [960, 1.25]]) {
      const label = width + (zoom === 1 ? '' : '-125');
      win.setContentSize(width, 1000); win.webContents.setZoomFactor(zoom); await wait(100);
      await pointer('#hbAddMenuToggle'); await pointer('[data-rq-create-chat]', true);
      const menu = await js(`(()=>{const box=n=>{const b=n.getBoundingClientRect();return{x:b.x,y:b.y,right:b.right,bottom:b.bottom,width:b.width,height:b.height}},menu=document.querySelector('#rqCreateMenu');return{width:innerWidth,box:box(menu),items:[...menu.querySelectorAll('button')].map(n=>({button:box(n),subtitle:box(n.querySelector('small')),height:getComputedStyle(n).height,background:getComputedStyle(n).backgroundColor}))}})()`);
      report.layouts.push({label:'menu-'+label,...menu}); await capture('menu-'+label);
      check(menu.items.every(({button,subtitle})=>subtitle.bottom<=button.bottom&&subtitle.right<=button.right&&subtitle.y>=button.y), 'menu-'+label+': hover contains complete subtitle');
      check(menu.box.x>=0&&menu.box.right<=menu.width+1, 'menu-'+label+': menu stays in viewport');
      await typography('.requirements-board', 'board-'+label);
      await key('ArrowDown');
      check(await js(`document.activeElement.matches('#rqCreateMenu button')`), 'menu-'+label+': keyboard moves within menu items');
      await key('Escape');
      check(await js(`document.querySelector('#rqCreateMenu').hidden&&document.activeElement.id==='hbAddMenuToggle'`), 'menu-'+label+': Escape closes menu and restores trigger focus');
    }
    win.webContents.setZoomFactor(1);
    win.setContentSize(600, 1000); await pointer('#hbAddMenuToggle');
    await js(`document.querySelector('[data-rq-create-manual] small').textContent='直接填写标题和完成标准，附上相关资料并指定需求负责人，所有说明都应完整显示。';void 0`);
    await pointer('[data-rq-create-manual]', true);
    check(await js(`(()=>{const n=document.querySelector('[data-rq-create-manual]'),s=n.querySelector('small'),r=n.getBoundingClientRect(),t=s.getBoundingClientRect();return t.bottom<=r.bottom&&s.scrollWidth<=s.clientWidth+1})()`), 'long menu description wraps inside full hover region');
    await capture('menu-long-description'); await key('Escape');
    for (const [width, zoom] of [[1440, 1], [600, 1], [390, 1], [960, 1.25]]) {
      const label = width + (zoom === 1 ? '' : '-125');
      win.setContentSize(width, 1000); win.webContents.setZoomFactor(zoom); await wait(100);
      await js(`RequirementsDetail.open('ready-0')`); await wait(100);
      await typography('.rq-detail', 'detail-'+label); await capture('detail-'+label);
      await pointer('[data-rq-edit]');
      await typography('.rq-detail', 'edit-'+label); await capture('edit-'+label);
      report.editTitleSize = await js(`parseFloat(getComputedStyle(document.querySelector('#rqEditForm [name="title"]')).fontSize)`);
      report.editHierarchy = await js(`Object.fromEntries([['title','#rqDetailTitle'],['section','.rq-edit-section h3'],['label','#rqEditForm label'],['body','#rqEditForm textarea']].map(([key,selector])=>[key,parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)]))`);
      report.editHierarchies[label] = report.editHierarchy;
      check(await js(`(()=>{const n=document.querySelector('.rq-detail-content');return n.scrollWidth<=n.clientWidth+1})()`), 'edit-'+label+': scrollable fields stay within content width');
      await pointer('[data-rq-edit-cancel]'); await pointer('[data-rq-dismiss]');
    }
    win.webContents.setZoomFactor(1);
    win.setContentSize(1440, 1000);
    for (const relative of ['components/panels/panels-icons.js', 'core/requirement-session-context.js',
      'components/panels/task-execution-context.js', 'components/panels/task-execution-client.js',
      'components/panels/panels-forward-select.js', 'components/panels/panels-forward-plugin.js',
      'components/panels/panels-forward-picker.js', 'components/panels/panels-forward-options.js',
      'components/panels/panels-forward.js', 'components/requirements/requirement-session-choice.js',
      'components/requirements/requirement-assignment.js']) await script(relative);
    await js(`SoduWorkAPI.clientId='fixture-receiver';
      SoduWorkAPI.prepareRequirementExecution=async id=>{fixtureCalls.push(['claim',id]);const task=tasks.find(t=>t.id===id);Object.assign(task,{readOnly:false,ownerClientId:'fixture-receiver',canClaimExecution:false});return structuredClone(task)};
      SoduWorkAPI.listTeammates=async()=>({mates:[]});
      SoduWorkAPI.getTasksSnapshot=async()=>({online:true,items:structuredClone(tasks)});
      SoduWorkAPI.taskExecutionOptions=async body=>({selection:{taskId:body.taskId,repoId:'',projectId:''},task:structuredClone(tasks.find(t=>t.id===body.taskId)),repos:[],workflows:[],blockedWorkflows:[],substrates:[],models:[],recommendation:{},availability:{agentReason:'隔离验证未连接执行端'}});
      SoduWorkAPI.dispatchToAI=async()=>{fixtureCalls.push(['dispatch']);throw Error('Unexpected dispatch')};
      window.soduWorkAPI={conversationSession:{history:async()=>({ok:true,chats:[]}),runtimes:async()=>({ok:true,runtimes:[]})}};
      window.NativeChat={enqueueTask:async()=>{fixtureCalls.push(['execute']);throw Error('Unexpected execution')},sessionInfo:()=>({})};
      const base=structuredClone(tasks.find(t=>t.id==='ready-0'));
      tasks.push({...base,id:'flow-transferred',title:'同事转来的权限修复需求',readOnly:true,canClaimExecution:true,canViewExecution:true,myRoles:['assignee'],ownerClientId:'fixture-sender'},
        {...base,id:'flow-observer',title:'仅团队可见的需求',readOnly:true,canClaimExecution:false,canViewExecution:false,canEditRequirement:false,myRoles:[]});
      RequirementsBoard.render(true);void 0`);
    await js(`RequirementsDetail.open('intake-0')`); await wait(120);
    check(await js(`document.querySelector('.rq-delivery-state')?.textContent==='尚未开始'&&!document.querySelector('.rq-detail [data-rq-chat]')&&!document.querySelector('.rq-detail [data-rq-assign]')&&!!document.querySelector('[data-rq-ready]')`), 'intake shows a preparation action and unstarted delivery status without an execution shortcut');
    await capture('intake-ready-action'); await pointer('[data-rq-ready]'); await wait(150);
    check(await js(`tasks.find(t=>t.id==='intake-0').triageStage==='ready'&&!!document.querySelector('.rq-detail [data-rq-assign]')`), 'moving intake to ready reveals the arrangement entry');
    check(await js(`!fixtureCalls.some(c=>['dispatch','execute','claim','chat','assign'].includes(c[0]))`), 'preparation transition does not dispatch or open a conversation');
    await capture('intake-now-ready'); await pointer('[data-rq-dismiss]');
    check(await js(`document.querySelector('[data-rq-assign="flow-transferred"]')?.textContent.includes('接手并安排执行')`), 'transferred ready card shows the authorized claim entry');
    await js(`RequirementsDetail.open('flow-transferred')`); await wait(120);
    check(await js(`document.querySelector('.rq-detail [data-rq-assign]')?.textContent.includes('接手并安排执行')&&document.querySelector('.rq-delivery-state')?.textContent==='尚未开始'&&!document.querySelector('.rq-detail [data-rq-chat]')`), 'transferred ready detail shows claim action and actual unstarted status');
    await capture('transferred-ready-action'); await pointer('.rq-detail [data-rq-assign]'); await wait(200);
    check(await js(`fixtureCalls.filter(c=>c[0]==='claim').length===1&&!!document.querySelector('.rq-assignment-backdrop')`), 'authorized transferred action claims once and opens the production execution selector');
    check(await js(`!document.querySelector('.rq-assignment-backdrop').textContent.match(/not a function|not defined|TypeError|ReferenceError/)`), 'production execution selector has no fixture integration errors');
    check(await js(`!fixtureCalls.some(c=>['dispatch','execute','chat'].includes(c[0]))`), 'claiming and opening the selector does not execute work');
    await typography('.rq-assignment-backdrop', 'transferred-assignment'); await capture('transferred-assignment');
    await pointer('[data-act="fwd-close"]'); await pointer('[data-rq-dismiss]');
    await js(`RequirementsDetail.open('flow-observer')`); await wait(100);
    check(await js(`!document.querySelector('.rq-detail [data-rq-assign],.rq-detail [data-rq-ready],.rq-detail [data-rq-chat]')`), 'a team observer without capabilities receives no execution or preparation controls');
    await pointer('[data-rq-dismiss]');
    check((await js('fixtureErrors')).length===0, 'board, detail, and assignment fixtures report no uncaught errors');
    await load('requirement-sheet-receipt.html');
    await script('components/requirements/requirement-fields.js');
    await js(`document.documentElement.dataset.theme='vivid';document.documentElement.dataset.deskPanel='workspace';document.documentElement.dataset.workspaceView='history';void 0`);
    for (const [width, zoom] of [[1440, 1], [600, 1], [390, 1], [960, 1.25]]) {
      const label = width + (zoom === 1 ? '' : '-125');
      win.setContentSize(width, 1000); win.webContents.setZoomFactor(zoom); await wait(100); await js(`openSheet()`); await wait(180);
      await typography('.wes-layer', 'create-'+label); await capture('create-'+label);
      report.creationInputs = await js(`[...document.querySelectorAll('.wes-layer input,.wes-layer textarea')].map(n=>({class:n.className,placeholder:n.placeholder,size:parseFloat(getComputedStyle(n).fontSize)}))`);
      const title = report.creationInputs.find(n=>n.placeholder==='需求标题');
      if (title) check(title.size===report.editTitleSize, 'create-'+label+': creation and edit title input sizes agree');
      report.createHierarchy = await js(`Object.fromEntries([['title','#wesTitle'],['section','.cp-sec-h'],['label','.cp-field-label'],['body','.cp-note']].map(([key,selector])=>[key,parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)]))`);
      report.createHierarchies[label] = report.createHierarchy;
      check(JSON.stringify(report.createHierarchy)===JSON.stringify(report.editHierarchies[label]), 'create-'+label+': title, section, label, and body hierarchy matches editing');
      await pointer('.wes-attach-head button', true); await capture('create-bottom-'+label);
      check(await js(`(()=>{const n=document.querySelector('.wes-body');return n.scrollWidth<=n.clientWidth+1})()`), 'create-'+label+': scrollable form stays within content width');
      await js(`WorkEntrySheet.close()`);
    }
    check(report.errors.length === 0, 'no renderer errors'); report.ok = true;
  } catch (error) {
    report.error = String(error.stack || error);
    if (win) await win.webContents.capturePage().then(image => fs.writeFileSync(path.join(output, 'failure.png'), image.toPNG())).catch(()=>{});
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ok:report.ok,checks:report.checks.length,failed:report.checks.filter(c=>!c.passed),error:report.error,output})); app.exit(report.ok ? 0 : 1);
  }
});
