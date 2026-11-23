'use strict';
// Production model UI and styles with the existing synthetic API fixture.
// Never connects to a Hub or a paid provider. --preview keeps an isolated window.
const { app, BrowserWindow, Menu, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const root = process.argv[2], preview = process.argv.includes('--preview');
if (!root || !path.isAbsolute(root)) throw Error('Absolute evidence directory required');
fs.mkdirSync(root, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-model-layout-')));
const report = { ok: false, cases: [], boundary: 'Synthetic API; Chromium zoom is not native Windows display scaling.' };
let win;
const js = code => win.webContents.executeJavaScript(code);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function shot(name) {
  fs.writeFileSync(path.join(root, name + '.png'), (await win.webContents.capturePage()).toPNG());
}
async function locale(value) {
  await js(`SoduWorkI18n.setLocale(${JSON.stringify(value)},{persist:false,broadcast:false});void 0`);
  await wait(80);
}
async function run() {
  const isolated = session.fromPartition('model-sidebar-layout');
  isolated.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_req, cb) => cb({ cancel: true }));
  win = new BrowserWindow({ show: false, width: 1500, height: 950,
    title: 'Issue 54 — isolated model layout preview',
    webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, offscreen: !preview, backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, 'fixtures/model-settings.html'));
  for (let n = 0; n < 100; n++) {
    if (await js('!!document.querySelector("#mdQ")')) break;
    await wait(40);
  }
  await js(`selectService('personal');fill('[data-pkey]','synthetic-unsaved-input');
    const link=document.createElement('link');link.rel='stylesheet';link.href='../../theme/enlarged-theme.css';document.head.append(link);`);
  await locale('en-US'); await wait(150); await shot('english-wide');
  if (preview) {
    await locale('zh-CN');
    await js(`document.querySelector('.md-model-row').scrollIntoView({block:'center'})`);
    const previewTitle = 'Issue #54 — Models-only preview / 仅模型页面·测试数据';
    win.setTitle(previewTitle);
    win.webContents.on('page-title-updated', event => event.preventDefault());
    await js(`(()=>{
      const previewStyle=document.createElement('style');previewStyle.textContent='button[data-view]:disabled,button[data-rail-view]:disabled,#wsBack:disabled{opacity:.45;cursor:not-allowed}';document.head.append(previewStyle);
      const markUnavailable=()=>document.querySelectorAll('button[data-view],button[data-rail-view],#wsBack').forEach(button=>{
        const view=button.dataset.view||button.dataset.railView;
        if(view!=='models'){button.disabled=true;button.title='仅模型页面验证窗口：其他页面未加载 / Models-only preview';}
      });
      markUnavailable();new MutationObserver(markUnavailable).observe(document.body,{childList:true,subtree:true});
      WorkspaceHost.open=()=>alert('仅模型页面验证窗口：其他页面未加载。正式客户端不受影响。 / This preview loads My models only.');
    })()`);
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Preview', submenu: [
      { label: 'Models only · Synthetic data / 仅模型页·测试数据', enabled: false },
      ...['en-US','zh-CN','ja-JP','ko-KR'].map(value => ({ label: value, click: () => locale(value) })),
      { type: 'separator' },
      ...[1, 1.25, 1.5].map(value => ({ label: `Zoom ${value * 100}%`, click: () => win.webContents.setZoomFactor(value) })),
      { label: 'Enlarged text', type: 'checkbox', click: item => js(`document.documentElement.dataset.theme=${JSON.stringify(item.checked ? 'enlarged' : 'azure')}`) },
      { type: 'separator' }, { role: 'quit' }
    ] }]));
    const unavailable = await js(`([...document.querySelectorAll('button[data-view],button[data-rail-view],#wsBack')].filter(b=>(b.dataset.view||b.dataset.railView)!=='models').map(b=>({disabled:b.disabled,title:b.title})))`);
    assert.ok(unavailable.length>0&&unavailable.every(b=>b.disabled&&b.title.includes('Models-only')));
    report.preview = { title: win.getTitle(), unavailableNavigation: unavailable.length };
    report.ok = true;
    win.show(); await wait(200); await shot('preview-ready'); return;
  }
  // The overall page can still be two-column while the model row itself is
  // already narrow. Check the actual user-visible label, not only page overflow.
  for (const width of [1080, 1160, 1280]) {
    win.setSize(width, 950); win.webContents.setZoomFactor(1); await wait(400);
    await win.webContents.capturePage();
    await js(`document.querySelector('.md-model-row').scrollIntoView({block:'center'})`);
    await wait(100);
    const model = await js(`(()=>{const row=document.querySelector('.md-model-row'),name=row.querySelector('.md-model-name>span[data-user-content]');
      const r=name.getBoundingClientRect();return {width:r.width,height:r.height,lineHeight:parseFloat(getComputedStyle(name).lineHeight),text:name.textContent};})()`);
    report.cases.push({ name: 'model-row-'+width, model });
    await shot('model-row-'+width);
    assert.ok(model.width >= 140 && model.height <= model.lineHeight*3, 'Model name squeezed into a vertical column: '+JSON.stringify(model));
  }
  for (const language of ['en-US', 'zh-CN', 'ja-JP', 'ko-KR']) {
    await locale(language);
    assert.equal(await js(`document.querySelector('#mdQ').placeholder`), {
      'en-US':'Services or models', 'zh-CN':'服务或模型',
      'ja-JP':'サービス・モデル', 'ko-KR':'서비스 또는 모델'
    }[language], `${language}: production search translation missing`);
    for (const [width, height, zoom, theme] of [[1500,950,1,'azure'],[1080,950,1,'azure'],[1150,800,1.25,'azure'],[820,700,1.5,'enlarged'],[1500,620,1,'enlarged']]) {
      win.setSize(width, height); win.webContents.setZoomFactor(zoom);
      await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.querySelector('#mdBody').scrollTop=0;`);
      await wait(400);
      await win.webContents.capturePage();
      const actualZoom = win.webContents.getZoomFactor();
      assert.ok(Math.abs(actualZoom - zoom) < 0.01, 'Requested Chromium zoom was not applied');
      const metrics = await js(`(()=>{
        const input=document.querySelector('#mdQ'),button=document.querySelector('#mdAddInline');
        const a=input.getBoundingClientRect(),b=button.getBoundingClientRect(),body=document.querySelector('#mdBody');
        const style=getComputedStyle(input),canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');ctx.font=style.font;
        const available=input.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
        const heading=document.querySelector('.cfg-master-head strong');
        const modelName=document.querySelector('.md-model-name>span[data-user-content]'),modelBounds=modelName.getBoundingClientRect();
        const modelRow=modelName.closest('.md-model-row').getBoundingClientRect();
        const cards=[...document.querySelectorAll('.md-cap-badge')].map(e=>e.getBoundingClientRect());
        const cardWidths=cards.map(r=>r.width),cardHeights=cards.map(r=>r.height);
        const cardsAligned=cards.every(r=>Math.abs(r.top-cards[0].top)<1)||cards.every(r=>Math.abs(r.left-cards[0].left)<1);
        const actions=document.querySelector('.md-model-actions').getBoundingClientRect();
        const status=document.querySelector('.md-model-status').getBoundingClientRect();
        input.focus();const focused=document.activeElement===input;button.focus();
        const list=document.querySelector('.cfg-master-scroll');list.scrollTop=100000;
        return {viewport:innerWidth,available,placeholder:ctx.measureText(input.placeholder).width,
          separate:a.right<=b.left+1||b.right<=a.left+1||a.bottom<=b.top+1||b.bottom<=a.top+1,
          toolbarAddFits:!!button.closest('.md-master-toolbar')&&b.bottom<=a.top&&button.scrollWidth<=button.clientWidth+1,
          overflow:body.scrollWidth-body.clientWidth,
          sidebarOverflow:document.querySelector('.cfg-master').scrollWidth-document.querySelector('.cfg-master').clientWidth,
          overflowElements:[...body.querySelectorAll('*')].filter(e=>e.getClientRects().length&&e.getBoundingClientRect().right>body.getBoundingClientRect().right+1).slice(0,8).map(e=>e.className),
          headingFits:heading.scrollWidth<=heading.clientWidth+1&&heading.scrollHeight<=heading.clientHeight+1,
          translatedSearch:input.placeholder,
          modelNameWidth:modelBounds.width,modelNameLines:modelBounds.height/parseFloat(getComputedStyle(modelName).lineHeight),
          modelActionsFit:[...document.querySelectorAll('.md-model-actions button')].every(e=>{const r=e.getBoundingClientRect();return r.left>=modelRow.left-1&&r.right<=modelRow.right+1}),
          capabilityGroupAligned:cards.length===3&&cardsAligned&&Math.max(...cardWidths)-Math.min(...cardWidths)<=1&&Math.max(...cardHeights)-Math.min(...cardHeights)<=1,
          actionsBelowCapabilities:actions.top>=Math.max(...cards.map(r=>r.bottom)),
          statusBesideOrAboveActions:status.right<=actions.left+1||status.bottom<=actions.top+1,
          statusInFooter:!!document.querySelector('.md-model-footer .md-model-status')&&!document.querySelector('.md-model-report'),
          focus:focused&&document.activeElement===button,listHeight:list.clientHeight,
          listScrollable:list.scrollHeight<=list.clientHeight||list.scrollTop>0,
          draft:document.querySelector('[data-pkey]')?.value};})()`);
      const name = `${language}-${width}-${zoom}-${theme}`;
      assert.ok(Math.abs(metrics.viewport - win.getContentSize()[0] / zoom) <= 2, `${name}: viewport did not settle`);
      report.cases.push({ name, metrics });
      assert.ok(metrics.available >= metrics.placeholder, `${name}: search placeholder clipped: ${JSON.stringify(metrics)}`);
      assert.ok(metrics.separate && metrics.sidebarOverflow <= 1, `${name}: overlapping controls or sidebar overflow`);
      assert.ok(metrics.overflow <= 1 && metrics.modelNameWidth >= 140 && metrics.modelNameLines <= 3 && metrics.modelActionsFit, `${name}: model label/actions or detail overflow`);
      assert.ok(metrics.toolbarAddFits&&metrics.capabilityGroupAligned&&metrics.actionsBelowCapabilities, `${name}: irregular control grouping`);
      assert.ok(metrics.statusInFooter&&metrics.statusBesideOrAboveActions, `${name}: unchecked status overlaps or is detached from actions`);
      assert.ok(metrics.headingFits && metrics.focus && metrics.listHeight >= 72 && metrics.listScrollable, `${name}: heading/focus/list usability`);
      assert.equal(metrics.draft, 'synthetic-unsaved-input', `${name}: layout change lost draft`);
      await shot(name);
      if (width===1080 || width===820) {
        await js(`document.querySelector('.md-model-row').scrollIntoView({block:'center'})`);
        await wait(100); await shot(language+(width===1080?'-grouped-model-list':'-narrow-model-list'));
      }
    }
  }
  await locale('en-US');win.setSize(1080,950);win.webContents.setZoomFactor(1);await wait(400);
  for(const label of ['Synthetic-model-'.repeat(10), '长名称・モデル表示・모델이름-'.repeat(8)]) {
    await js(`_mdMyModels[0].label=${JSON.stringify(label)};_mdRender();document.querySelector('.md-model-row').scrollIntoView({block:'center'});`);
    await wait(100);
    const result=await js(`(()=>{const e=document.querySelector('.md-model-name>span[data-user-content]'),r=e.getBoundingClientRect(),body=document.querySelector('#mdBody');return {text:e.textContent,width:r.width,overflow:body.scrollWidth-body.clientWidth};})()`);
    assert.equal(result.text,label);assert.ok(result.width>=140&&result.overflow<=1,'Long model label lost or squeezed');
    report.cases.push({name:label.startsWith('Synthetic')?'long-latin-label':'long-cjk-label',result});
  }
  await js(`_mdMyModels[0].label='business-review-model';_mdRender()`);
  // Layout-only synthetic records: never start a capability probe.
  for (const [state, result] of [
    ['pending', {pending:true,checks:{connection:{status:'passed'}}}],
    ['error', {error:'Synthetic capability check failed. '.repeat(8)}],
    ['checked', {checks:{imageInput:{status:'passed',code:'verified'}}}],
    ['evidence-unavailable', null]
  ]) {
    await js(`_mdChecks.clear();_mdMyModels[0].capabilityEvidenceError=${state==='evidence-unavailable'};
      ${result ? `_mdChecks.set(_mdCheckKey('personal','business-review-model'),${JSON.stringify({ ...result, usesSavedService: true })});` : ''}
      _mdRender();document.querySelector('.md-cap-report')?.setAttribute('open','');
      document.querySelector('.md-model-report').scrollIntoView({block:'center'});`);
    await wait(100);
    const details=await js(`(()=>{const row=document.querySelector('.md-model-row'),r=row.querySelector('.md-model-report'),a=row.querySelector('.md-model-actions');return {
      detached:!r.closest('.md-model-footer')&&!row.querySelector('.md-model-status'),
      below:r.getBoundingClientRect().top>=a.getBoundingClientRect().bottom,
      overflow:document.querySelector('#mdBody').scrollWidth-document.querySelector('#mdBody').clientWidth,
      pendingDisabled:row.querySelector('[data-mdcheck]').disabled,
      expanded:!!row.querySelector('details[open]'),alert:!!r.querySelector('[role="alert"]')};})()`);
    assert.ok(details.detached&&details.below&&details.overflow<=1, `${state}: detailed report layout`);
    assert.equal(details.pendingDisabled,state==='pending');
    if(state==='checked') assert.ok(details.expanded);
    if(state==='error'||state==='evidence-unavailable') assert.ok(details.alert);
    report.cases.push({name:'report-'+state,details});await shot('report-'+state);
  }
  await js(`_mdChecks.clear();delete _mdMyModels[0].capabilityEvidenceError;_mdRender()`);
  // Exercise existing fixture persistence, not a real model probe.
  await js(`document.querySelector('#mdSave').click()`);
  for (let n = 0; n < 100 && !(await js('saved.length>0')); n++) await wait(30);
  assert.equal(await js('saved.at(-1).keys.personal'), 'synthetic-unsaved-input');
  assert.equal(await js('testCalls.length+capabilityCalls.length'), 0);
  assert.deepEqual(await js('errors'), []);
  report.ok = true;
}
app.whenReady().then(run).catch(async error => {
  report.error = error.stack;
  if (win) await shot('failure');
}).finally(() => {
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  if (!preview || report.error) { win?.destroy(); app.exit(report.ok ? 0 : 1); }
});
app.on('window-all-closed', () => app.quit());
