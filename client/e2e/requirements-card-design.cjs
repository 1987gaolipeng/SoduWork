'use strict';
// Isolated production Electron UI, native input, explicit fixture API only.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env};
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename], {
    env, windowsHide: true, stdio: 'inherit', timeout: 120000,
  });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
const {app, BrowserWindow} = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const output = path.resolve(__dirname, '../../outputs/requirements-card-design-20261020');
fs.mkdirSync(output, {recursive: true});
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-card-design-')));
app.disableHardwareAcceleration();
const report = {ok: false, checks: [], layouts: [], themes: [], errors: [],
  boundary: 'Production CSS/renderer; native Electron input; fixture APIs; no business data or network'};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const titles = [
  ['梳理新成员加入项目后的协作指引', '补齐客户周报的统计范围与验收口径'],
  ['完善订单导出后的字段说明', '优化 ProductReleaseReadinessChecklistAndCustomerOnboardingWithoutWhitespace 的中英文长标题显示'],
  ['生成本周客户反馈分析与行动建议', '排查外部附件暂不可用时的恢复方式'],
  ['核对新版官网内容与移动端展示', '复核多底座协作插件的最终交付文件'],
  ['完成季度业务汇总与团队分享材料', '统一资料库的内容分类与归档规则'],
];
const samples = titles.flatMap((names, lane) => names.map((title, index) => ({
  id: `design-${lane}-${index}`, title, kind: ['requirement', 'bug', 'improvement', 'ticket', 'other'][lane],
  status: lane < 2 ? 'todo' : lane === 2 ? (index ? 'paused' : 'doing') : 'done',
  triageStage: lane === 0 ? (index ? 'clarifying' : 'intake') : 'ready',
  ...(lane === 4 ? {reviewedAt: Date.now()} : {}),
  ...(lane === 2 && !index ? {ai: {state: 'running', name: 'Pi · 反馈分析助手'}} : {}),
  priority: ['critical', 'high', 'normal', 'low'][(lane * 2 + index) % 4],
  note: '保留客户原始材料中的事实，按完成标准逐项核对，交付可直接使用的成果。',
  acceptanceCriteria: ['内容准确且覆盖全部范围', '文件可打开并清楚标注交付版本'],
  tags: index ? ['跨团队协作与客户体验优化', 'QuarterlyReviewAndProductReadiness', '客户反馈', '验收记录'] : ['产品体验', '本周重点'],
  assigneeName: index ? '客户成功与解决方案团队 · 欧阳长名字' : ['王维', '杨善明', '张敏', '陈小博', '李欣'][lane],
  assigneeUserId: 'design-owner-' + lane, origin: 'local', ownerClientId: 'device-a',
  readOnly: false, canEditRequirement: true, canViewExecution: true, myRoles: ['creator', 'executor'],
  projectName: index ? '企业客户服务流程持续改进项目' : '客户端体验优化',
  requirementVersion: 1, createdAt: Date.now() - lane * 10000, due: '2026-10-25',
})));
let win;
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({show: false, width: 1440, height: 1000,
      webPreferences: {offscreen: true, contextIsolation: true, sandbox: true, backgroundThrottling: false}});
    win.webContents.session.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*']}, (_request, done) => done({cancel: true}));
    win.webContents.on('console-message', event => {if (event.level === 'error') report.errors.push(event.message);});
    const js = source => win.webContents.executeJavaScript(source, true);
    const click = async selector => {
      let point;
      for (let attempt = 0; attempt < 30; attempt++) {
        point = await js(`(async()=>{const n=[...document.querySelectorAll(${JSON.stringify(selector)})].find(n=>n.getClientRects().length&&!n.disabled);if(!n)return null;n.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=n.getBoundingClientRect(),x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height/2);return n.contains(document.elementFromPoint(x,y))?{x,y}:null})()`);
        if (point) break; await wait(40);
      }
      assert.ok(point, 'Visible target: ' + selector);
      const zoom = win.webContents.getZoomFactor();
      point = {x: Math.round(point.x * zoom), y: Math.round(point.y * zoom)};
      for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({
        type, ...point, ...(type === 'mouseMove' ? {} : {button: 'left', clickCount: 1}),
      });
      await wait(70);
    };
    const key = async keyCode => {
      win.webContents.focus();
      win.webContents.sendInputEvent({type: 'keyDown', keyCode});
      if (keyCode === 'Return') win.webContents.sendInputEvent({type: 'char', keyCode: '\r'});
      win.webContents.sendInputEvent({type: 'keyUp', keyCode}); await wait(60);
    };
    const capture = async name => {
      await wait(50); const image = await win.webContents.capturePage();
      assert.equal(image.isEmpty(), false);
      fs.writeFileSync(path.join(output, name + '.png'), image.toPNG());
    };
    const layout = async label => {
      const value = await js(`(()=>{const cards=[...document.querySelectorAll('.rq-card')],grid=document.querySelector('.rq-kanban'),bounds=n=>n.getBoundingClientRect();return{
        viewport:innerWidth,outerOverflow:document.documentElement.scrollWidth>innerWidth+1,
        fiveLanes:document.querySelectorAll('.rq-lane').length===5,twoPerLane:[...document.querySelectorAll('.rq-lane')].every(n=>n.querySelectorAll('.rq-card').length>=2),
        boardScroll:{client:grid.clientWidth,content:grid.scrollWidth},
        cardOverflow:cards.filter(n=>n.scrollWidth>n.clientWidth+1).map(n=>n.dataset.hbid),
        escapingFlags:cards.filter(n=>{const c=bounds(n),f=bounds(n.querySelector('.rq-priority-flag'));return f.right>c.right+1||f.left<c.left-1||f.bottom>c.bottom+1||f.top<c.top-1}).map(n=>n.dataset.hbid),
        crowdedHeaders:cards.filter(n=>{const f=bounds(n.querySelector('.rq-card-top .rq-priority-flag')),m=bounds(n.querySelector('.rq-card-menu')),l=bounds(n.querySelector('.rq-card-labels'));return f.right>m.left||l.right>f.left}).map(n=>n.dataset.hbid),
        crowdedMeta:cards.filter(n=>{const o=bounds(n.querySelector('.rq-owner')),t=bounds(n.querySelector('.rq-card-trailing'));return o.right>t.left-1}).map(n=>n.dataset.hbid),
        tooManyTags:cards.some(n=>n.querySelectorAll('.rq-user-tag').length>2),
        flagLabels:cards.every(n=>n.querySelector('.rq-priority-flag')?.getAttribute('aria-label')?.startsWith('优先级：')),
        titleClamped:cards.every(n=>getComputedStyle(n.querySelector('.rq-card-title')).webkitLineClamp==='3')}})()`);
      assert.equal(value.outerOverflow, false, label + ': outer overflow');
      assert.equal(value.fiveLanes && value.twoPerLane, true, label + ': five populated columns');
      assert.deepEqual(value.cardOverflow, [], label + ': card overflow');
      assert.deepEqual(value.escapingFlags, [], label + ': flags outside card');
      assert.deepEqual(value.crowdedHeaders, [], label + ': priority collides with type or menu');
      assert.deepEqual(value.crowdedMeta, [], label + ': owner collides with metadata');
      assert.equal(value.tooManyTags, false, label + ': tags capped at two');
      assert.equal(value.flagLabels && value.titleClamped, true, label + ': accessibility and long titles');
      if (value.viewport >= 1366) assert.ok(value.boardScroll.content <= value.boardScroll.client + 1, label + ': wide five columns fit');
      report.layouts.push({label, ...value});
    };
    await win.loadFile(path.join(__dirname, 'fixtures/requirements-board.html'));
    // Offscreen windows have no native foreground focus; enable Chromium focus
    // semantics after loading without showing or activating a desktop window.
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled: true});
    await js(`SoduWorkAPI.clientId='device-a';tasks=${JSON.stringify(samples)};fixtureApprovals=[];RequirementsBoard.render(true);void 0`);
    // The default is now "needs my action", which excludes completed cards.
    // This layout suite explicitly exercises every lifecycle column.
    await click('[data-rq-scope="all"]');
    for (const theme of ['azure', 'ruby', 'steady', 'warm', 'minimal']) {
      await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      const colors = await js(`(()=>{const s=getComputedStyle(document.documentElement);return{accent:s.getPropertyValue('--accent').trim(),flags:[...new Set([...document.querySelectorAll('.rq-priority-flag')].map(n=>getComputedStyle(n).color))]}})()`);
      assert.equal(colors.flags.length, 4, theme + ': four different priority colors');
      report.themes.push({theme, ...colors});
      for (const zoom of [1, 1.25]) for (const width of [1440, 1366, 820, 480]) {
        win.setContentSize(width, 1000); win.webContents.setZoomFactor(zoom); await wait(90);
        await js(`document.querySelector('.rq-kanban').scrollLeft=0;void 0`);
        const label = theme + '-' + width + '-' + Math.round(zoom * 100);
        await layout(label);
        if (width === 1440 || (theme === 'azure' && [820, 480].includes(width))) await capture(label);
      }
      win.setContentSize(1440, 1000); win.webContents.setZoomFactor(1); await wait(80);
      await click('[data-rq-actions="design-0-0"]');
      assert.equal(await js(`document.querySelector('[data-rq-actions="design-0-0"]').getAttribute('aria-expanded')`), 'true');
      assert.ok(await js(`!!document.querySelector('[data-rq-delete="design-0-0"]')`), theme + ': native menu contains actions');
      await key('Escape');
      await click('[data-rq-open="design-0-0"]');
      assert.equal(await js(`document.querySelector('#rqDetailTitle').textContent`), samples[0].title);
      await key('Escape');
      assert.equal(await js(`document.activeElement.dataset.rqOpen`), 'design-0-0', theme + ': detail restores focus');
      await key('Tab');
      const focused = await js(`(()=>{const n=document.activeElement,s=getComputedStyle(n);return{tag:n.tagName,html:n.outerHTML.slice(0,600),visible:n.matches(':focus-visible'),outline:s.outlineStyle}})()`);
      report.themes.at(-1).keyboardFocus = focused;
      assert.equal(focused.tag === 'BUTTON' && focused.visible, true, theme + ': keyboard focus visible ' + JSON.stringify(focused));
      await key('Return');
      assert.ok(await js(`fixtureCalls.some(row=>row[0]==='assign')||!!document.querySelector('.rq-menu:popover-open')||!!document.querySelector('.rq-detail')`), theme + ': keyboard activates next action');
      await key('Escape');
    }
    assert.equal(new Set(report.themes.map(value => value.accent)).size, 5, 'Uses five real theme definitions');
    assert.deepEqual(await js('fixtureErrors'), []);
    assert.deepEqual(report.errors, []);
    report.checks.push('40 theme/viewport/zoom combinations; no outer/card overflow or owner/flag collision',
      'Chinese and unbroken English titles, long owners/projects, two tags plus remaining count, all stages and priority colors',
      'Native menu/detail click, Escape focus restoration, Tab visible focus and Return activation across five themes');
    report.ok = true;
  } catch (error) {
    report.error = String(error.stack || error);
    if (win) fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG());
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ok: report.ok, checks: report.checks, layouts: report.layouts.length, themes: report.themes, error: report.error}));
    app.exit(report.ok ? 0 : 1);
  }
});
