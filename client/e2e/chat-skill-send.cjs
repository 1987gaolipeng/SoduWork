'use strict';
// Real keyboard/mouse -> composer -> production preload/IPC -> real Pi SDK.
// Only account discovery and the model HTTP endpoint use isolated fixtures.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE', 'CHROME_DEVEL_SANDBOX']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..'), root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-chat-skills-'));
  const out = path.resolve(client, '../outputs/chat-skill-send-20261001/electron');
  fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(root, 'profile'));
  const report = { ok: false, cases: [], errors: [] }, sends = [], resolved = [], holds = new Map();
  let win, fixture, handle, revoked = false, cancelCalls = 0, releaseReceipt;
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code, true);
  async function until(check, label, timeout = 15000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const value = typeof check === 'string' ? await js(check) : await check(); if (value) return value; await delay(25); }
    throw Error('Timed out: ' + label);
  }
  async function click(selector) {
    const point = await js(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});if(!b||b.disabled)throw Error('unavailable button: '+${JSON.stringify(selector)});b.scrollIntoView({block:'nearest'});const r=b.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);if(!b.contains(document.elementFromPoint(x,y)))throw Error('occluded button');return{x,y}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
  }
  function enterKey() {
    for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Return' });
  }
  async function type(text) {
    await js(`(()=>{const input=document.querySelector('#nchatInput');input.value='';input.focus()})()`);
    await win.webContents.insertText(text);
  }
  async function pasteText(text) {
    const allowed = await js(`(()=>{const input=document.querySelector('#nchatInput');input.value='';input.focus();
      const data=new DataTransfer();data.setData('text/plain',${JSON.stringify(text)});
      return input.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}))})()`);
    assert.equal(allowed, true, 'long pasted instructions must retain native text insertion');
    // Synthetic ClipboardEvent has no browser default action. Real Chromium
    // insertText supplies that action without touching the user's clipboard.
    await win.webContents.insertText(text);
    assert.equal(await js('document.querySelector("#nchatInput").value'), text);
  }
  async function choose(name, mouse = false) {
    await type('#' + name);
    await until(`document.querySelector('.cp-skill-menu.show [data-skill-name="${name}"]')`, 'skill option ' + name);
    if (mouse) await click('[data-skill-name="' + name + '"]'); else enterKey();
    await until(`document.querySelector('.cp-skill-tag [data-remove-skill="${name}"]')`, 'selected skill chip');
    assert.equal(await js('document.querySelector("#nchatInput").value'), '');
  }
  const messages = request => JSON.stringify(request.messages);
  const system = request => JSON.stringify(request.messages.filter(message => message.role === 'system'));
  function publish(touched = {}) {
    if (win && !win.isDestroyed()) win.webContents.send('pi-session-event', {
      ...touched, ref: 'skills', kind: touched.kind || 'snapshot', snapshot: handle.uiSnapshot?.() || handle.snapshot(),
    });
  }
  async function settled(count) {
    await until(() => fixture.requests.length >= count && !handle.inFlight(), 'turn settled ' + count);
    await until('document.querySelector("#nchatInput").value===""', 'composer cleared');
  }
  app.whenReady().then(async () => {
    const catalog = ['company-research', 'web-audit'].map(name => {
      const dir = path.join(root, 'skills', name); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Isolated ${name} validation\n---\nSkill marker: ${name}-verified.\n`);
      return { name, description: '技能回归验证', path: dir, installed: true, selectable: true };
    });
    fixture = await require('./fixtures/resumed-pi.cjs').create(path.join(root, 'pi'));
    const defaults = [
      ['split-bid-documents', '---\nname: split-bid-documents\n---\nPrivate missing-description source.'],
      ['debug-radar', '---\nname: debug-radar\ndescription: Workflow: debug\n---\nPrivate malformed source.'],
      ['issue-gardener', '---\nname: issue-gardener\ndescription: Workflow: plan\n---\nPrivate malformed source.'],
      ['healthy-default', '---\nname: healthy-default\ndescription: Healthy default\n---\nDefault guidance.'],
    ].map(([name, source]) => {
      const dir = path.join(root, '.codex', 'skills', name); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), source); return dir;
    });
    handle = await fixture.open({ skillDirs: defaults, optionalSkillDirs: defaults, resolveSkills: async names => {
      resolved.push(names.slice()); if (revoked) throw Error('技能已撤回');
      return { items: names.map(name => catalog.find(row => row.name === name)).filter(Boolean) };
    } });
    assert.deepEqual(handle.skills, ['healthy-default']);
    assert.match(handle.skillWarnings.join(' '), /split-bid-documents/);
    assert.match(handle.skillWarnings.join(' '), /debug-radar/);
    assert.match(handle.skillWarnings.join(' '), /issue-gardener/);
    fixture.reply(body => {
      const last = [...body.messages].reverse().find(message => message.role === 'user');
      const text = JSON.stringify(last?.content || '');
      const key = ['HOLD_QUEUE', 'HOLD_STEER'].find(name => text.includes(name));
      if (!key) return { text: '已按本轮要求完成。' };
      return { respond(response) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: ' + JSON.stringify({ id: key, object: 'chat.completion.chunk', model: 'fixture-model',
          choices: [{ index: 0, delta: { role: 'assistant', content: '正在整理。' }, finish_reason: null }] }) + '\n\n');
        holds.set(key, { response, closed: false });
        response.on('close', () => { holds.get(key).closed = true; });
      } };
    });
    win = new BrowserWindow({ show: false, width: 1100, height: 800,
      webPreferences: { preload: path.join(client, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    handle.on(publish);
    win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => callback({ cancel: true }));
    const ipcSource = read('main/pi-session/ipc.js');
    const start = ipcSource.indexOf('  async function sendConversation(');
    const end = ipcSource.indexOf("  require('./runtime-selection-ipc').install", start);
    assert(start >= 0 && end > start, 'production send IPC boundaries must exist');
    const snippet = ipcSource.slice(start, end);
    vm.runInNewContext(snippet, { ipcMain: { handle(channel, handler) {
      ipcMain.handle(channel, async (...args) => {
        if (channel === 'pi-session-send') sends.push({ text: args[2], options: args[4] });
        const result = await handler(...args);
        if (channel === 'pi-session-send' && args[2] === 'ACK_HOLD')
          await new Promise(resolve => { releaseReceipt = resolve; });
        return result;
      });
    } }, app, path, BrowserWindow, console, require: require('node:module').createRequire(path.join(client, 'main/pi-session/ipc.js')),
      updateWorkloads: { guard: () => ({ ok: true }) }, session: { get: () => handle },
      sendIdentityOf: async () => ({}), identityOf: async () => ({}), memories: { assertOwner() {} },
      pluginDebug: { guard: () => null }, _cloudHandoff: { guard: () => false },
      _uiWindow: { snapshot: session => session.uiSnapshot?.() || session.snapshot() },
      _contextSnapshot: (_session, snapshot) => snapshot,
      taskInput: {}, attachments: require('../main/pi-session/attachments'),
      workDir: () => path.join(root, 'work'), _publish: (_windows, _handle, touched) => publish(touched), _scheduleRelease() {},
    });
    ipcMain.handle('pi-session-open', () => ({ ok: true, ref: 'skills', sessionId: 'skills', adapterId: 'pi', displayName: 'Pi',
      cwd: fixture.cwd, model: { label: 'Local test model' }, snapshot: handle.snapshot() }));
    ipcMain.handle('pi-session-snapshot', () => ({ ok: true, snapshot: handle.snapshot() }));
    ipcMain.handle('pi-session-cancel', () => { cancelCalls++; return handle.cancel(); });
    ipcMain.handle('conversation-capabilities', () => ({ ok: true, policyOk: true, skills: catalog }));
    for (const [channel, value] of Object.entries({ 'pi-session-probe': { ok: true }, 'pi-session-history': { ok: true, chats: [] }, 'pi-session-outputs': { ok: true, items: [] },
      'pi-session-release': { ok: true }, 'pi-session-runtime-models': { ok: true, items: [] }, 'work-preview-hide': { ok: true }, 'work-preview-destroy': { ok: true } })) ipcMain.handle(channel, () => value);
    ipcMain.handle('pi-session-workdir', () => ({ ok: true, dir: fixture.cwd }));
    ipcMain.handle('pi-session-mode', () => ({ mode: 'full' }));
    const source = path.join(__dirname, 'fixtures/workbench-annotations.html'), scripts = [];
    const html = fs.readFileSync(source, 'utf8').replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_match, attrs, body) => {
      const src = attrs.match(/src=["']([^"']+)/); scripts.push(src ? fs.readFileSync(path.resolve(path.dirname(source), src[1]), 'utf8') : body); return '';
    });
    const file = path.join(root, 'chat.html');
    fs.writeFileSync(file, html.replace(/<link\b[^>]*rel="stylesheet"[^>]*>/gi, '')
      .replace('<meta charset="utf-8">', '<meta charset="utf-8"><base href="' + pathToFileURL(client + path.sep).href + '">'));
    await win.loadFile(file);
    for (const file of ['theme/variables.css', 'components/panels/work-composer.css', 'components/panels/panels-chat.css',
      'components/panels/panels-compose-skills.css', 'components/panels/chat-collaboration.css', 'components/panels/conversation-attachments.css'])
      await js(`(()=>{const l=document.createElement('link');l.rel='stylesheet';l.href=${JSON.stringify(pathToFileURL(path.join(client, file)).href)};document.head.appendChild(l)})()`);
    await js(read('components/panels/compose-candidate-navigation.js'));
    await js(read('components/panels/panels-compose-skills.js'));
    for (const script of scripts) await js(script + '\nvoid 0;');
    await js('NativeChat.enter("", "skills", {adapterId:"pi"})');
    await until('NativeChat.sessionInfo().ref==="skills"', 'existing conversation ready');
    await choose('company-research');
    assert.equal(sends.length, 0, 'first Enter selects rather than submits');
    await delay(180);
    fs.writeFileSync(path.join(out, 'selected-skill.png'), (await win.webContents.capturePage()).toPNG());
    enterKey(); await settled(1);
    assert.deepEqual(sends[0].options.skills, ['company-research']);
    assert.equal(sends[0].text, '#company-research');
    assert.ok(system(fixture.requests[0]).includes('company-research'));
    assert.ok(messages(fixture.requests[0]).includes('SKILL.md'));
    assert.equal(handle.snapshot().messages.filter(row => row.role === 'user').at(-1).text, '#company-research',
      'internal skill locations cannot leak into the visible user message');
    assert.equal(await js('document.querySelectorAll(".cp-skill-tag").length'), 0);
    report.cases.push('选择技能后第二次 Enter 可发送无正文的技能消息；生产 IPC 与真实 Pi 请求均保留技能，发送后清除选择。');

    await choose('web-audit', true); await type('核对报告'); await click('#nchatSend'); await settled(2);
    assert.equal(sends[1].text, '核对报告');
    assert.deepEqual(sends[1].options.skills, ['web-audit']);
    assert.ok(system(fixture.requests[1]).includes('web-audit'));
    assert.ok(!system(fixture.requests[1]).includes('company-research'));
    await type('普通后续消息'); enterKey(); await settled(3);
    assert.deepEqual(sends[2].options.skills, []);
    assert.ok(!system(fixture.requests[2]).includes('web-audit'));
    report.cases.push('鼠标选择技能并附加正文后仅发送一次；下一轮普通消息不会继承上轮技能。');

    await type('HOLD_QUEUE'); enterKey(); await until(() => holds.has('HOLD_QUEUE'), 'active stream held');
    await choose('company-research');
    await until('document.querySelector("#nchatSend").title.includes("排队")', 'queue button rendered');
    assert.match(await js('document.querySelector("#nchatSend").title'), /排队/);
    await click('#nchatSend');
    await until(() => handle.snapshot().execution.queue.length === 1, 'skill-only queued');
    assert.equal(cancelCalls, 0); assert.equal(holds.get('HOLD_QUEUE').closed, false);
    holds.get('HOLD_QUEUE').response.end('data: ' + JSON.stringify({ id: 'HOLD_QUEUE', object: 'chat.completion.chunk',
      model: 'fixture-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } }) + '\n\ndata: [DONE]\n\n');
    await settled(5);
    assert.ok(system(fixture.requests[4]).includes('company-research'));
    assert.deepEqual(resolved[resolved.length - 1], ['company-research']);
    report.cases.push('运行中只选技能时按钮变为排队发送，不会误停止；出队时再加载所选技能。');

    await type('HOLD_STEER'); enterKey(); await until(() => holds.has('HOLD_STEER'), 'steer stream held');
    await choose('web-audit'); enterKey();
    const queued = await until(() => handle.snapshot().execution.queue[0], 'steer skill queued');
    const steer = '[data-queue-action="send-now"][data-queue-id="' + queued.id + '"]';
    await until(`document.querySelector(${JSON.stringify(steer)})&&!document.querySelector(${JSON.stringify(steer)}).disabled`, 'steer button ready');
    await click(steer); await settled(7);
    assert.ok(holds.get('HOLD_STEER').closed);
    assert.ok(system(fixture.requests[6]).includes('web-audit'));
    assert.equal(handle.snapshot().execution.queue.length, 0);
    report.cases.push('通过引导提前发送排队的技能消息，技能与内容一起生效且只执行一次。');

    revoked = true; await choose('company-research'); await type('失效技能的工作'); enterKey();
    await until('document.querySelector("#nchatInput").value==="失效技能的工作" && document.querySelector("[data-remove-skill=company-research]")', 'failed skill draft and chip restored');
    assert.equal(fixture.requests.length, 7, 'revoked skill must not silently execute without skill');
    await until('document.body.textContent.includes("技能已撤回")', 'visible skill failure reason');
    assert.equal(await js('document.querySelector("#nchatInput").value'), '失效技能的工作');
    revoked = false; enterKey(); await settled(8);
    assert.ok(system(fixture.requests[7]).includes('company-research'));
    report.cases.push('执行前技能失效会明确报错并还原技能和正文；修复授权后原稿可重新提交。');

    await choose('web-audit'); await click('[data-remove-skill="web-audit"]');
    await type('移除技能后发送'); enterKey(); await settled(9);
    assert.deepEqual(sends[sends.length - 1].options.skills, []);
    report.cases.push('移除已选技能后发送普通消息，不携带旧技能。');

    await choose('company-research'); await type('切换会话后继续');
    await js('NativeChat.reset()');
    await js('NativeChat.enter("", "skills", {adapterId:"pi"})');
    await until('NativeChat.sessionInfo().ref==="skills"', 'conversation reopened');
    assert.equal(await js('document.querySelector("#nchatInput").value'), '切换会话后继续');
    assert.ok(await js('document.querySelector("[data-remove-skill=company-research]")!==null'));
    assert.equal(await js('NativeChat.getDraft("new")'), '', 'old chat draft cannot leak into a new chat');
    await js('document.querySelector("#nchatInput").focus()');
    enterKey(); await settled(10);
    assert.deepEqual(sends[sends.length - 1].options.skills, ['company-research']);
    assert.ok(system(fixture.requests[9]).includes('company-research'));
    report.cases.push('切换并重新打开会话后，未发送的技能与正文一同保留，不污染新会话草稿。');

    await type('#web-audit');
    await until('document.querySelector(".cp-skill-menu.show [data-skill-name=web-audit]")', 'IME candidate menu');
    const beforeIme = sends.length;
    await js('document.querySelector("#nchatInput").dispatchEvent(new KeyboardEvent("keydown", {key:"Enter",isComposing:true,bubbles:true}))');
    assert.equal(sends.length, beforeIme);
    assert.equal(await js('document.querySelectorAll(".cp-skill-tag").length'), 0);
    report.cases.push('中文输入法确认候选词时，不会误选择技能或误发送消息。');

    await type('ACK_HOLD'); enterKey(); await settled(11);
    await until(() => releaseReceipt, 'delayed send receipt');
    await choose('company-research'); await type('稍后发送的新草稿');
    releaseReceipt(); await delay(150);
    assert.equal(await js('NativeChat.getDraft("skills")'), '稍后发送的新草稿');
    assert.deepEqual(await js('NativeChat.getDraftSkills("skills")'), ['company-research']);
    await js('NativeChat.reset()');
    await js('NativeChat.enter("#web-audit\\n\\n首条自动发送", "skills", {adapterId:"pi", skills:["web-audit"]})');
    await settled(12);
    assert.equal(sends.at(-1).text, '#web-audit\n\n首条自动发送');
    assert.equal(await js('document.querySelector("#nchatInput").value'), '');
    assert.ok(system(fixture.requests[11]).includes('web-audit'));
    report.cases.push('延迟发送回执不会清空新选技能的草稿；显式首条自动发送会正确消费旧草稿。');
    const longText = '请按完整要求处理：' + '详细输入与约束。'.repeat(500) + '\n最后要求：输出 CSV，保留尾部约束。';
    await choose('web-audit');
    await pasteText('#web-audit ' + longText); enterKey(); await settled(13);
    assert.equal(sends.at(-1).text, '#web-audit ' + longText);
    assert.deepEqual(sends.at(-1).options.skills, ['web-audit']);
    assert.ok(system(fixture.requests[12]).includes('web-audit'));
    assert.ok(messages(fixture.requests[12]).includes('输出 CSV'));
    report.cases.push('明确选择技能后，长文本与正文中的技能示例经生产 IPC 到达真实 Pi SDK，尾部要求保留。');
    await choose('company-research'); await pasteText(longText); enterKey(); await settled(14);
    assert.equal(sends.at(-1).text, longText);
    assert.deepEqual(sends.at(-1).options.skills, ['company-research']);
    assert.ok(system(fixture.requests[13]).includes('company-research'));
    assert.ok(messages(fixture.requests[13]).includes('输出 CSV'));
    report.cases.push('先选技能再粘贴长正文时，技能和全文一起发送，不转成 TXT 或泛化占位句。');
    await choose('company-research');
    const commandExample = '/skill:company-research /login #1 都是原文';
    await type(commandExample); await click('#nchatSend'); await settled(15);
    assert.deepEqual(sends.at(-1).options.skills, ['company-research']);
    assert.equal(sends.at(-1).text, commandExample);
    assert.ok(system(fixture.requests[14]).includes('company-research'));
    const commandUser = [...fixture.requests[14].messages].reverse().find(message => message.role === 'user');
    assert.ok(JSON.stringify(commandUser.content).includes(commandExample), 'SDK must not expand a literal command even when that skill is explicitly selected');
    assert.ok(!JSON.stringify(commandUser.content).includes('<skill name='));
    report.cases.push('明确选中的技能通过结构化元数据生效，同名 /skill: 命令示例仍作为完整正文，SDK 不扩展正文。');
    const plainBodies = [
      '#1 帮我写一篇500字的作文\n#2 帮我去AI味',
      '#web-audit 请把它当作正文中的例子，颜色是 #fff。',
      '/skill:web-audit 请把它当作正文中的例子，保留原文。',
    ];
    for (const [index, body] of plainBodies.entries()) {
      await type(body); await click('#nchatSend'); await settled(16 + index);
      assert.equal(sends.at(-1).text, body);
      assert.deepEqual(sends.at(-1).options.skills, []);
      assert.ok(!system(fixture.requests[15 + index]).includes('web-audit'));
      assert.ok(!system(fixture.requests[15 + index]).includes('company-research'));
      const last = [...fixture.requests[15 + index].messages].reverse().find(message => message.role === 'user');
      assert.ok(JSON.stringify(last.content).includes(body.replace(/\n/g, '\\n')));
      assert.equal(await js('document.querySelectorAll(".cp-skill-tag").length'), 0);
    }
    report.cases.push('未选技能时，用户提供的 #1/#2 原文、真实技能名称和 /skill: 示例都完整发送，skills 为空且不触发技能预检或 SDK 命令扩展。');
    for (const request of fixture.requests) {
      assert.ok(system(request).includes('healthy-default'));
      for (const name of ['split-bid-documents', 'debug-radar', 'issue-gardener'])
        assert.ok(!system(request).includes(name), 'invalid defaults never enter model skill catalog');
    }
    report.cases.push('缺少 description 和两种坏 YAML 默认技能并存时，真实 Electron 键鼠发送、排队、切换会话及续聊正常，健康默认技能保持可用。');
    const beforeDraftSends = sends.length;
    await js('NativeChat.reset(); document.getElementById("cpChat").remove();');
    for (const file of ['panels-compose-capabilities.js', 'plugin-ui-host.js', 'panels-compose-work-actions.js', 'compose-surface.js', 'panels-compose.js'])
      await js(read('components/panels/' + file));
    await js(`(()=>{const l=document.createElement('link');l.rel='stylesheet';l.href=${JSON.stringify(pathToFileURL(path.join(client, 'components/panels/panels.css')).href)};document.head.appendChild(l);openComposePanel({newSession:true})})()`);
    await js('document.getElementById("cpInput").focus()');
    await win.webContents.insertText('#company-research');
    await until('document.querySelector("#cpTask .cp-skill-menu.show [data-skill-name=company-research]")', 'new conversation skill option');
    await click('#cpTask [data-skill-name="company-research"]');
    await until('document.querySelector("#cpTask [data-remove-skill=company-research]")', 'new conversation selected skill');
    const newDraft = '#1 写作文\n#2 去AI味；这是尚未发送的新对话草稿';
    await js('document.getElementById("cpInput").focus()');
    await win.webContents.insertText(newDraft);
    assert.equal(await js('NativeChat.getDraft("new")'), newDraft);
    assert.deepEqual(await js('NativeChat.getDraftSkills("new")'), ['company-research']);
    await js('closeComposePanel(); openComposePanel({newSession:true});');
    assert.equal(await js('document.getElementById("cpInput").value'), newDraft);
    assert.ok(await js('document.querySelector("#cpTask [data-remove-skill=company-research]")!==null'));
    assert.deepEqual(await js('NativeChat.getDraftSkills("new")'), ['company-research']);
    assert.equal(sends.length, beforeDraftSends, 'draft reopening must not send another model request');
    report.cases.push('新对话菜单明确选中的技能与编号正文写入同一草稿记录，关闭后重开新对话保留技能 chip 与原文，不会在初始化清空选择时回写丢失。');
    assert.deepEqual(await js('errors'), []); assert.deepEqual(report.errors, []);
    await delay(180);
    fs.writeFileSync(path.join(out, 'completed.png'), (await win.webContents.capturePage()).toPNG());
    report.ok = true;
  }).catch(async error => { report.error = error.stack || String(error); report.snapshot = handle?.snapshot();
    report.requests = fixture?.requests; report.sends = sends; try {
    fs.writeFileSync(path.join(out, 'failure.png'), (await win.webContents.capturePage()).toPNG());
  } catch {} }).finally(async () => {
    try { await fixture?.close(); } catch (error) { report.cleanup = String(error); report.ok = false; }
    if (win && !win.isDestroyed()) win.destroy();
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, cases: report.cases.length, error: report.error, report: path.join(out, 'report.json') }));
    app.exit(report.ok ? 0 : 1);
  });
}
