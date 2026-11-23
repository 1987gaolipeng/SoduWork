'use strict';

// Real Electron rendering and production Runner admission with controlled RPC replies.
// No real model, account, Hub, or existing conversation data is accessed.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 90000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..');
  const output = process.argv[2];
  assert.ok(output && path.isAbsolute(output), 'An absolute evidence directory is required');
  fs.mkdirSync(output, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-history-goal-'));
  app.setPath('userData', path.join(temporary, 'profile'));
  app.disableHardwareAcceleration();
  if (process.platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain');
  const baseline = process.argv.find(value => value.startsWith('--baseline='))?.slice(11) || '';
  assert.ok(!baseline || /^[a-f0-9]{7,40}$/.test(baseline), 'Baseline must be a commit SHA');
  const only = process.argv.find(value => value.startsWith('--only='))?.slice(7) || '';
  const baselineFiles = new Set(['components/workspace/workspace-chat-list.js',
    'main/agent-runtime/runner-adapter.js', 'main/agent-runtime/runner-task-goal.js']);
  const source = file => baseline && baselineFiles.has(file)
    ? require('node:child_process').execFileSync('git', ['show', baseline + ':client/' + file],
      { cwd: client, encoding: 'utf8' }) : fs.readFileSync(path.join(client, file), 'utf8');
  const report = { ok: false, baseline, cases: [], errors: [],
    boundary: 'Real Electron, production sidebar reconciliation, Runner adapter and goal UI; synthetic history and Runner RPC, no model execution.' };
  let win;
  const js = code => win.webContents.executeJavaScript(code, true);
  async function shot(name) {
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  async function boot() {
    const base = pathToFileURL(client + path.sep).href;
    const sheets = ['theme/variables.css', 'components/panels/work-intent.css',
      ...[...source('desk.html').matchAll(/<link\s+rel=["']stylesheet["']\s+href=["']([^"']+)["']/g)].map(match => match[1])];
    fs.writeFileSync(path.join(temporary, 'fixture.html'), '<!doctype html><meta charset="utf-8"><base href="' + base + '">' +
      [...new Set(sheets)].map(file => '<link rel="stylesheet" href="' + file + '">').join('') +
      '<style>#goalFixture{position:absolute;left:360px;right:35px;top:40px;padding:24px;background:white}' +
      '#goalFixture h1{font-size:22px}#fixturePrompt{white-space:pre-wrap;line-height:1.8;padding:20px;background:#f5f5f7}' +
      '#goalHost{margin-top:40px}</style><div class="workspace-shell"><nav class="ws-rail"></nav>' +
      '<aside class="ws-side"><div id="wsSideScroll"><section id="wsPinnedBox"><div id="pinned"></div></section>' +
      '<section id="wsChatsBox" class="ws-list"><div class="ws-list-title">会话历史</div><div id="chats"></div>' +
      '</section></div></aside></div><main id="goalFixture"><h1>普通对话与显式目标</h1>' +
      '<p id="fixturePrompt"></p><section id="goalHost"></section></main>');
    await win.loadFile(path.join(temporary, 'fixture.html'));
    await js(`window.errors=[];window.addEventListener('error',event=>errors.push(event.message));
      document.documentElement.dataset.workspaceView='create';document.documentElement.dataset.workspaceLayout='conversation';
      document.documentElement.dataset.skin='box';window.openedChats=[];
      window.SoduWorkAPI={hubBase:()=> 'https://fixture.invalid',clientAuthSnapshot:()=>({clientId:'fixture-device',user:{id:'fixture-user'}})};
      window.WorkspaceHost={open:(page,options)=>openedChats.push({page,options})};void 0;`);
    for (const file of ['components/panels/agent-brand.js', 'components/workspace/workspace-chat-history.js',
      'components/workspace/workspace-sidebar-state.js', 'components/workspace/workspace-chat-list.js',
      'components/panels/work-intent.js', 'components/panels/chat-session-controller.js']) await js(source(file) + '\nvoid 0;');
    await js(`window.ctx={...WorkspaceChatHistory,root:document.querySelector('.workspace-shell'),active:'create',
      activeChatId:'',chatItems:[],chatNames:new Map(),wsT:(_key,text)=>text,icon:()=>'',mount(){},_empty(){}};
      ctx.chats=document.querySelector('#chats');ctx.pinnedChats=document.querySelector('#pinned');
      window.list=WorkspaceChatList.create(ctx);Object.assign(ctx,list);void 0;`);
  }
  const icons = () => js(`[...document.querySelectorAll('[data-chat-id="history-mixed"] .ws-chat-runtime [data-agent-brand]')].map(node=>node.dataset.agentBrand)`);
  async function historyCases() {
    await js(`window.initialRow={id:'history-mixed',title:'离线产品帮助中心',usedHarnesses:['pi'],state:'completed',at:1000,count:2};
      window.historyReply=()=>({ok:true,chats:[{...initialRow}],localCatalog:{workspace:'isolated-profile',revision:1,items:[{id:'history-mixed'}]}});
      window.localRead=null;window.soduWorkAPI={conversationSession:{localHistorySupported:true,
        history:async options=>options?.source==='account'?{ok:true,chats:[]}:localRead?localRead():historyReply()}};
      void 0;`);
    assert.equal(await js('list.refreshLocalHistory()'), true);
    assert.deepEqual(await icons(), ['pi']);
    await js(`list.updateChatState({sessionId:'history-mixed',presence:{...initialRow,usedHarnesses:['pi','qwen']}});void 0;`);
    assert.deepEqual(await icons(), ['pi', 'qwen']);
    await js('list.refreshConversationHistory()');
    assert.deepEqual(await icons(), ['pi', 'qwen'], 'Background account/local refresh cannot erase observed runtime history');
    report.cases.push('Background history refresh retains both runtime icons without opening the conversation');
    await js(`localRead=()=>new Promise(resolve=>window.finishHistory=resolve);window.pendingHistory=list.refreshLocalHistory();void 0;`);
    await js(`list.updateChatState({sessionId:'history-mixed',presence:{...initialRow,usedHarnesses:['pi','qwen','dsh']}});
      finishHistory(historyReply());void 0;`);
    await js('pendingHistory');
    assert.deepEqual(await icons(), ['pi', 'qwen', 'dsh'], 'Late catalog reply preserves runtime additions from a newer presence event');
    assert.deepEqual(await js('openedChats'), [], 'Icons must stabilize before the first conversation click');
    await shot('history-without-opening');
    report.cases.push('An older pending history reply cannot replace newer multi-runtime provenance');
    await boot();
    await js(`window.soduWorkAPI={conversationSession:{localHistorySupported:true,history:async options=>
      options?.source==='account'?{ok:true,chats:[]}:{ok:true,chats:[{id:'history-mixed',title:'离线产品帮助中心',
      usedHarnesses:['pi','qwen','dsh'],state:'completed',at:1000,count:3}],
      localCatalog:{workspace:'isolated-profile',revision:2,items:[{id:'history-mixed'}]}}}};void 0;`);
    await js('list.refreshConversationHistory()');
    assert.deepEqual(await icons(), ['pi', 'qwen', 'dsh']);
    assert.deepEqual(await js('openedChats'), []);
    report.cases.push('A cold renderer shows the full authoritative runtime history before any conversation is opened');
  }
  async function goalCases() {
    const Module = require('node:module'), original = Module._extensions['.js'];
    if (baseline) Module._extensions['.js'] = (module, filename) => {
      const relative = path.relative(client, filename).split(path.sep).join('/');
      if (baselineFiles.has(relative)) module._compile(source(relative), filename);
      else original(module, filename);
    };
    let adapters;
    try { adapters = require('../main/agent-runtime/runner-adapter'); }
    finally { Module._extensions['.js'] = original; }
    const catalog = require('../main/agent-runtime/runtime-catalog');
    const prompt = '请在当前工程创建一个可离线浏览的产品帮助中心。使用原生 HTML、CSS 和 JavaScript，制作首页及 12 个内容页面。\n' +
      '每个内容页至少包含 6 个章节。请分阶段实际写入文件并验证页面链接，持续完成整个任务。\n保留 RUN_ID.txt，每完成阶段更新 PROGRESS.md。';
    for (const agent of ['dsh', 'kimi', 'qwen', 'opencode', 'codex-harness', 'codex']) {
      for (const explicit of [false, true]) {
        const calls = [], cwd = fs.mkdtempSync(path.join(temporary, 'chat-'));
        let contract;
        const adapter = adapters.createRunnerRuntimeAdapter({ runtimeSpec: catalog.runtime(agent),
          modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'fixture', baseUrl: 'https://fixture.invalid', key: 'fixture-key' } }) },
          runnerRuntime: { async rpc(op, input) {
            calls.push({ op, input });
            if (op === 'job.dispatch') {
              contract = input.ctx.taskGoal;
              return { ok: true, data: { ref: adapters._uuidV5('9af442c8-cd1d-4b91-a668-22da2b2635bf', input.dispatchId), state: 'running' } };
            }
            if (op === 'job.comment') { contract = input.taskGoal || contract; return { ok: true, data: { state: 'running' } }; }
            if (op === 'job.session') return { ok: true, data: { status: 'done',
              items: [{ seq: 1, kind: 'say', text: 'Fixture response' }],
              ...(contract ? { taskGoal: { ...contract, status: 'completed', budgetMs: 14400000, elapsedMs: 1000, steps: 1 } } : {}) } };
            throw Error('Unexpected RPC: ' + op);
          } },
        });
        const options = { cwd, ref: 'fixture-' + agent + '-' + explicit,
          ...(explicit ? { intent: 'goal', goal: prompt, acceptance: 'Verify every page link' } : {}) };
        const session = await adapter.createSession({ identity: {}, native: { runner: { openOptions: options } } });
        try {
          const handle = adapters.getRunnerSessionDetails(session).handle;
          assert.equal((await handle.submit(prompt, []).completion).ok, true);
          if (!explicit) assert.equal((await handle.submit('Please keep working until the entire task is complete.', []).completion).ok, true);
          const snapshot = handle.snapshot(), view = handle.goalView();
          await js(`window.goalCtx={_snap:${JSON.stringify(snapshot)},_sessionOptions:${JSON.stringify({ adapterId: agent, ...view })}};
            ChatSessionController.create(goalCtx)._syncRunnerTaskGoal();
            document.querySelector('#fixturePrompt').textContent=${JSON.stringify(agent + (explicit ? ' · 显式设置目标\n' : ' · 普通对话，未设置目标\n') + prompt)};
            document.querySelector('#goalHost').innerHTML=WorkIntent.rail('fixture');
            WorkIntent.showGoal(document.querySelector('#goalHost'),goalCtx._sessionOptions,'fixture',{ready:true});void 0;`);
          const visible = await js(`document.querySelector('#fixtureIntentRail').classList.contains('show')`);
          assert.equal(visible, explicit, agent + ': goal UI reflects only explicit goal admission');
          assert.equal(snapshot.execution.visible, explicit);
          const dispatch = calls.find(call => call.op === 'job.dispatch').input.ctx;
          assert.equal(dispatch.conversationMode, explicit ? 'goal' : 'adaptive');
          assert.equal(Boolean(dispatch.taskGoal), explicit);
          if (!explicit) assert.equal(calls.find(call => call.op === 'job.comment').input.taskGoal, undefined);
          if (['dsh', 'kimi'].includes(agent)) await shot(agent + (explicit ? '-explicit-goal' : '-ordinary-chat'));
          report.cases.push(agent + ': ' + (explicit ? 'explicit goal remains configured and visible' : 'ordinary first and follow-up turns do not admit or display a goal'));
        } finally { await session.dispose(); }
      }
    }
  }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1200, height: 850,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, done) => done({ cancel: true }));
    await boot();
    if (only !== 'goal') await historyCases();
    if (only !== 'history') await goalCases();
    assert.deepEqual(await js('errors'), []);
    report.ok = true;
  }).catch(async error => {
    report.errors.push(error.stack || String(error));
    if (win && !win.isDestroyed()) await shot('failure');
  }).finally(() => {
    win?.destroy();
    try { fs.rmSync(temporary, { recursive: true, force: true }); }
    catch (error) { report.cleanupError = error.code || error.message; }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); app.exit(report.ok ? 0 : 1);
  });
}
