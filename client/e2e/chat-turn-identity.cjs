'use strict';
// Production transcript/crew/interaction code in isolated Chromium. No model or network calls.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' })
    .on('error', error => { console.error(error); process.exitCode = 1; })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..'), output = path.resolve(client, '../outputs/chat-turn-identity');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-turn-identity-'));
  app.setPath('userData', profile);
  app.disableHardwareAcceleration();
  const report = { ok: false, scope: 'Isolated Chromium, production renderer/crew/brand/CSS/bindings, deterministic snapshots', results: [], layouts: [] };
  const scripts = ['vendor/markdown/marked.umd.js', 'vendor/markdown/purify.min.js',
    'components/panels/agent-brand.js', 'components/panels/chat-crew.js',
    'components/panels/chat-thinking-collapse.js', 'components/panels/chat-dom-patch.js',
    'components/panels/panels-chat-tools.js', 'components/panels/chat-context-meter.js',
    'components/panels/chat-scroll-follow.js', 'components/panels/chat-markdown.js',
    'components/panels/chat-acceptance-results.js', 'components/panels/chat-message-renderer.js',
    'components/panels/chat-composer-bindings.js'];
  // Use the desktop entry's actual links so missing production styles cannot be masked.
  const desktop = fs.readFileSync(path.join(client, 'desk.html'), 'utf8');
  const styles = [...desktop.matchAll(/<link\b[^>]*href="([^"]+\.css)"[^>]*>/g)]
    .map(match => match[1]).filter(file => /(?:variables|panels-chat|agent-brand|chat-crew)\.css$/.test(file));
  fs.mkdirSync(output, { recursive: true });
  const fixture = path.join(output, 'fixture.html');
  fs.writeFileSync(fixture, `<!doctype html><html lang="zh-CN" data-theme="azure"><meta charset="utf-8">
    <base href="${pathToFileURL(client + path.sep).href}"><title>Conversation turn identity regression</title>
    ${styles.map(file => '<link rel="stylesheet" href="' + file + '">').join('\n')}
    <style>body{margin:0;color:var(--ink);background:var(--bg-0);font:14px var(--font-ui)}#cpChat{height:100vh}</style>
    <div id="cpChat" class="nchat"><div class="nchat-main">
      <div class="nchat-head-actions"><button id="fixtureLocation">打开位置</button></div>
      <div id="nchatScroll" class="nchat-scroll"><div id="nchatList" class="nchat-inner"></div></div>
      <div hidden><textarea id="nchatInput"></textarea><button id="nchatSend"></button>
        <div id="nchatQueue"></div><div id="nchatTaskSuggest"></div><button id="nchatWd"></button></div>
    </div></div>
    <script>window.errors=[];addEventListener('error',e=>errors.push(e.message));
      addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));</script>
    ${scripts.map(file => '<script src="' + file + '"></script>').join('\n')}
    <script>
      const noop=()=>{};
      window.ctx={_ref:'turn-identity',_sessionOptions:{},_collabTasks:new Map(),_collabEntries:()=>[],
        _openTool:new Set(),_openThink:new Set(),_closedThink:new Set(),_openToolGroup:new Set(),
        _pendingAttachmentNames:[],_outs:[],_api:()=>null,_mount:()=>document.querySelector('#cpChat'),
        _messageWindowSize:80,_syncThinkingClock:noop,_renderQueue:noop,_renderTaskStartPrompt:noop,
        _syncSlowStatusTicker:noop,_paintBar:noop,_thinkingStatusHtml:()=>'',esc:ChatTools.esc,
        _snap:{status:'idle',execution:{running:false},tools:[],messages:[]}};
      window.renderer=ChatMessageRenderer.create(ctx);ctx._render=renderer._render;
      ChatComposerBindings.create(ctx)._bind(ctx._mount());
      window.fixtureReady=true;
    </script></html>`);
  let win;
  const js = code => win.webContents.executeJavaScript(code, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const source = (agentId = 'pi', runId = 'run-one') => ({ agentId, runId, nodeKey: agentId + '-node' });
  const thinking = (text, index = 0, done = true) => ({ kind: 'thinking', index, text, done });
  const prose = (text, index = 1, done = true) => ({ kind: 'text', index, text, done });
  const assistant = (blocks, who = source(), done = true) => ({ role: 'assistant', blocks, sourceAgent: who, done, stopReason: done ? 'stop' : '' });
  const user = text => ({ role: 'user', text, sentAt: Date.parse('2026-10-23T02:00:00Z') });
  const tool = (id, after, who = source()) => ({ id, name: 'read', toolKind: 'read',
    args: { path: id + '.md' }, state: 'done', after, result: 'Local fixture content: ' + id, sourceAgent: who });
  const call = (id, index) => ({ kind: 'toolcall', index, done: true,
    toolCall: { id, name: 'read', arguments: { path: id + '.md' } } });
  const snapshot = (messages, tools = [], live = false) => ({ messages, tools,
    status: live ? 'streaming' : 'idle', execution: { running: live } });
  async function until(check) {
    for (let i = 0; i < 100; i++) { if (await js(check)) return; await delay(30); }
    throw Error('Timed out: ' + check);
  }
  async function publish(value, reset = false) {
    await js(`(()=>{${reset ? "renderer.reset();ctx._openThink.clear();ctx._closedThink.clear();ctx._openToolGroup.clear();document.querySelector('#nchatList').replaceChildren();" : ''}
      ctx._snap=${JSON.stringify(value)};renderer._render();})()`);
    await delay(180);
  }
  async function headers(count) {
    assert.equal(await js('document.querySelectorAll("#nchatList .nchat-agent-source").length'), count,
      'exactly one source header per attributed user turn');
  }
  async function stacked(label) {
    const result = await js(`(()=>{const head=document.querySelector('.nchat-agent-source');
      return {headerBars:document.querySelectorAll('.nchat-head-actions .nchat-crewline').length,
        beads:Array.from(head.querySelectorAll('.agent-brand'),el=>{const r=el.getBoundingClientRect();
          return {left:r.left,right:r.right,center:r.top+r.height/2,height:r.height}})}})()`);
    report.layouts.push({ label, ...result });
    assert.equal(result.headerBars, 0, 'execution identities stay out of the title bar: ' + label);
    assert.ok(result.beads.length >= 2, 'fixture has multiple participants');
    result.beads.slice(1).forEach((bead, index) => {
      const previous = result.beads[index];
      assert.ok(Math.abs(bead.center - previous.center) < 1, 'beads share one horizontal center: ' + label);
      assert.ok(bead.left > previous.left && bead.left < previous.right, 'beads overlap horizontally: ' + label);
    });
  }
  async function click(selector) {
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});
      const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(220);
  }
  async function openToolBatches() {
    while (await js('Boolean(document.querySelector("[data-tool-group][aria-expanded=false]"))')) {
      await click('[data-tool-group][aria-expanded=false]');
    }
  }
  async function timeline() {
    return js(`Array.from(document.querySelectorAll('#nchatList .nthink,#nchatList .ntext,#nchatList .ntool'),e=>({
      kind:e.matches('.nthink')?'thinking':e.matches('.ntext')?'text':'tool',
      text:e.matches('.nthink')?e.querySelector('.nthink-body').textContent:e.matches('.ntext')?e.textContent.trim():e.dataset.toolNode,
      height:e.getBoundingClientRect().height,top:e.getBoundingClientRect().top}))`);
  }
  async function expectTimeline(expected) {
    const rows = await timeline();
    assert.deepEqual(rows.map(row => [row.kind, row.text]), expected, 'thoughts, prose and tool cards retain chronological order and text');
    for (const [index, row] of rows.entries()) {
      assert.ok(row.height > 0, 'timeline row is visible: ' + row.kind);
      if (index) assert.ok(row.top >= rows[index - 1].top, 'timeline visual order matches source order');
    }
  }
  async function screenshot(name) {
    await js('document.querySelector("#nchatScroll").scrollTop=0');
    await delay(150);
    fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  async function viewport(width) {
    win.setContentSize(width, 820);
    // Windows display scaling can round native window bounds by one CSS pixel.
    // Fix Chromium's viewport so the narrow/wide assertions exercise exact widths.
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',
      { width, height: 820, deviceScaleFactor: 1, mobile: false });
    await delay(150);
  }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1100, height: 820, webPreferences: {
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, done) => done({ cancel: true }));
    await win.loadFile(fixture); await until('window.fixtureReady===true');
    win.webContents.debugger.attach('1.3'); await viewport(1100);
    assert.deepEqual(await js('window.errors'), []);

    const first = assistant([thinking('先确认材料范围。', 0, false)], source(), false);
    let state = snapshot([user('核对材料并给出结论'), first], [], true);
    await publish(state, true); await headers(1);
    assert.equal(await js('document.querySelector(".nthink").classList.contains("open")'), true);
    await click('.nthink-head');
    assert.equal(await js('document.querySelector(".nthink-head").getAttribute("aria-expanded")'), 'false');
    await js('window.savedThought=document.querySelector(".nthink");window.savedHeader=document.querySelector(".nchat-agent-source")');
    first.blocks[0].text += ' 接着检查来源。';
    await publish(state); await headers(1);
    assert.equal(await js('document.querySelector(".nthink")===window.savedThought'), true);
    assert.equal(await js('document.querySelector(".nthink").classList.contains("open")'), false);
    assert.equal(await js('document.querySelector(".nthink-body").getBoundingClientRect().height'), 0);
    assert.equal(await js('document.querySelector(".nchat-agent-source")===window.savedHeader'), true);
    report.results.push('A live thought can be collapsed through production click handling; subsequent deltas preserve the thought node, collapsed state and single identity');

    first.blocks[0].done = true;
    first.blocks.push(prose('我会先读取两份材料。', 1, false));
    await publish(state); await headers(1);
    await until('document.querySelector(".ntext").textContent.includes("我会先读取")');
    await js('window.savedProse=document.querySelector(".ntext")');
    first.blocks[1].text += ' 然后逐项核对。';
    await publish(state);
    await until('document.querySelector(".ntext").textContent.includes("然后逐项核对")');
    assert.equal(await js('document.querySelector(".ntext")===window.savedProse'), true);
    assert.equal(await js('document.querySelector(".nthink").classList.contains("open")'), false);
    first.done = true; first.stopReason = 'toolUse'; first.blocks[1].done = true;
    first.blocks.push(call('read-one', 2), call('read-two', 3));
    state.tools = [tool('read-one', 1), tool('read-two', 1)];
    const later = assistant([thinking('两份材料已齐，继续比较。'), prose('结论：两份材料内容一致。')], source('pi', 'run-two'));
    state.messages.push(later); state.status = 'idle'; state.execution.running = false;
    await publish(state); await openToolBatches(); await headers(1);
    const expected = [['thinking', first.blocks[0].text], ['text', first.blocks[1].text],
      ['tool', 'read-one'], ['tool', 'read-two'], ['thinking', later.blocks[0].text], ['text', later.blocks[1].text]];
    await expectTimeline(expected);
    report.results.push('Thinking, growing prose, two tools, later thinking and final prose remain visible in order with one identity across run IDs');
    await screenshot('sequence-1100');

    // Tool and message attribution can differ within one user turn and across run IDs.
    state.tools[1].sourceAgent = source('claude', 'run-tools');
    later.sourceAgent = source('codex', 'run-final');
    await js(`ctx._activeCollabTaskId='crew-task';ctx._collaborationTrace={runs:[{id:'run-one',state:'running',nodes:[
      {key:'first',name:'Read',state:'succeeded',executor:{resolved:{agentKind:'pi'}}},
      {key:'second',name:'Write',state:'running',executor:{resolved:{agentKind:'codex'}}}]}]};
      ctx._collabEntries=()=>[{taskId:'crew-task',trace:ctx._collaborationTrace}];ChatCrew.bind()`);
    first.taskId = 'crew-task';
    state.status = 'streaming'; state.execution.running = true;
    await publish(state); await openToolBatches(); await headers(1); await expectTimeline(expected);
    await stacked('live');
    state.status = 'idle'; state.execution.running = false;
    await publish(state); await openToolBatches();
    await stacked('completed');
    const brands = await js('Array.from(document.querySelectorAll(".nchat-agent-source .agent-brand"),e=>Array.from(e.classList).find(c=>c.startsWith("agent-brand-")))');
    assert.deepEqual(new Set(brands), new Set(['agent-brand-pi', 'agent-brand-claude', 'agent-brand-codex']));
    assert.equal(brands.length, 3, 'one stack deduplicates its participants');
    report.results.push('Messages and tools from Pi, Claude and Codex across three run IDs form one deduplicated crew stack');

    for (const width of [1100, 360]) {
      await viewport(width);
      const layout = await js(`(()=>{const elements=[document.documentElement,document.body,document.querySelector('#nchatScroll'),document.querySelector('#nchatList'),
        ...document.querySelectorAll('.nmsg,.nchat-agent-source')];return{width:innerWidth,
        rows:elements.map(e=>({tag:e.id||e.className||e.tagName,width:e.clientWidth,scrollWidth:e.scrollWidth,
          left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right}))}})()`);
      assert.equal(layout.width, width);
      for (const row of layout.rows) {
        assert.ok(row.scrollWidth <= row.width + 1, 'no horizontal overflow: ' + JSON.stringify(row));
        assert.ok(row.left >= -1 && row.right <= width + 1, 'row stays inside viewport: ' + JSON.stringify(row));
      }
      await stacked('viewport-' + width);
      report.layouts.push(layout); await screenshot('crew-' + width);
    }
    report.results.push('Production transcript and crew CSS fit 1100 px and 360 px without horizontal overflow');
    await viewport(1100);
    await click('.nchat-agent-source');
    await until('document.querySelectorAll("#crewPop .crew-pop-row").length===2');
    assert.equal(await js('document.querySelector("#crewPop").hidden'), false);
    await js('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    assert.equal(await js('document.querySelector("#crewPop").hidden'), true);
    report.results.push('Transcript stack still opens the actual task trace; Escape closes the detail popover without a title-bar duplicate');

    state.messages.push(user('再检查第二轮'), assistant([prose('第二轮已完成。', 0)], source('pi', 'run-one')));
    await publish(state); await headers(2);
    const perTurn = await js(`(()=>{let turn=-1;const rows=[];for(const el of document.querySelector('#nchatList').children){
      if(el.matches('.nmsg.user')){turn++;rows.push({headers:0,brands:[]})}
      if(el.matches('.nchat-agent-source')){rows[turn].headers++;rows[turn].brands=Array.from(el.querySelectorAll('.agent-brand'),
        b=>Array.from(b.classList).find(c=>c.startsWith('agent-brand-')))}}return rows})()`);
    assert.deepEqual(perTurn.map(row => row.headers), [1, 1]);
    assert.deepEqual(perTurn[1].brands, ['agent-brand-pi'], 'new turn never inherits earlier collaborators even when run ID repeats');
    await screenshot('two-turns-1100');
    await win.loadFile(fixture); await until('window.fixtureReady===true');
    await publish(JSON.parse(JSON.stringify(state))); await openToolBatches(); await headers(2);
    await expectTimeline([...expected, ['text', '第二轮已完成。']]);
    await stacked('history-reload');
    assert.equal(await js('document.querySelectorAll(".nthink.open").length'), 0);
    report.results.push('Two user turns have one header each; identical run IDs do not share collaborators, and a fresh document reload restores content/order/headers from JSON history');

    const noProse = snapshot([user('直接检查材料'), assistant([thinking('先检查实际材料。'), call('silent-read', 1)])], [tool('silent-read', 1)]);
    await publish(noProse, true); await headers(1);
    assert.equal(await js('document.querySelectorAll(".ntext").length'), 0, 'no narrative is invented between thinking and tools');
    await expectTimeline([['thinking', '先检查实际材料。'], ['tool', 'silent-read']]);
    await screenshot('thinking-tools-1100');
    report.results.push('Thinking followed directly by tools retains one identity and no invented prose');

    const toolFirst = snapshot([user('立即读材料')], [tool('early-read', 0)], true);
    await publish(toolFirst, true); await headers(1);
    assert.equal(await js('document.querySelectorAll(".ntext").length'), 0);
    assert.equal(await js(`(()=>{const h=document.querySelector('.nchat-agent-source'),t=document.querySelector('.ntool');
      return Boolean(h.compareDocumentPosition(t)&Node.DOCUMENT_POSITION_FOLLOWING)})()`), true);
    toolFirst.messages.push(assistant([prose('材料已读取。', 0)], source('codex', 'late-run')));
    toolFirst.status = 'idle'; toolFirst.execution.running = false;
    await publish(toolFirst); await headers(1);
    await expectTimeline([['tool', 'early-read'], ['text', '材料已读取。']]);
    assert.equal(await js('document.querySelectorAll(".nchat-agent-source .agent-brand").length'), 2);
    await screenshot('tool-first-1100');
    report.results.push('A tool arriving before any assistant message owns the single header, and later output extends its crew without adding another header');
    assert.deepEqual(await js('window.errors'), []);
    report.ok = true;
  }).catch(async error => {
    report.error = error.stack || String(error);
    if (win && !win.isDestroyed()) {
      try { report.diagnostics = await js('({errors:window.errors,html:document.querySelector("#nchatList")?.innerHTML})'); await screenshot('failure'); } catch (_) {}
    }
  }).finally(() => {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, diagnostics: report.diagnostics ? { errors: report.diagnostics.errors } : undefined }, null, 2));
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(report.ok ? 0 : 1);
  });
}
