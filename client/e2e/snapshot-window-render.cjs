'use strict';
// Production snapshot projection + production chat DOM, synthetic transcript.
// The isolated Chromium process cannot access a model or the user's sessions.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict');
  const stream = require('../main/pi-session/event-stream');
  const external = require('../main/pi-session/snapshot-window');
  const report = { ok: false, isolated: true, realModel: false, cases: [] };
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-window-render-')));
  let win;
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1100, height: 820, webPreferences: { offscreen: true, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    const run = source => win.webContents.executeJavaScript(source);
    for (const mode of ['native', 'external']) {
      await win.loadFile(path.join(__dirname, 'fixtures/long-conversation.html'));
      const state = stream._blank();
      state.messages = Array.from({ length: 2000 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', done: true,
        text: 'Question ' + index, blocks: [{ kind: 'text', index: 0, done: true, text: 'Answer ' + index }] }));
      const fullAnswer = 'Complete long answer. '.repeat(2000) + 'END_OF_ANSWER';
      state.messages.at(-1).blocks[0].text = fullAnswer;
      state.tools = Array.from({ length: 10000 }, (_, index) => ({ id: 'call-' + index, name: 'read',
        state: index < 3 ? 'running' : 'done', after: index < 3 ? 0 : 1999,
        args: { path: 'document-' + index + '.txt' }, result: 'receipt-' + index }));
      const project = () => mode === 'native' ? stream.snapshot(state, { messageLimit: 80, toolLimit: 160 })
        : external.limitSnapshot(state, { messageLimit: 80, toolLimit: 160 });
      const paint = async () => {
        const snapshot = project();
        const started = performance.now();
        const rendered = await run(`ctx._snap=${JSON.stringify(snapshot)}; draw();
          ({messages:document.querySelectorAll('[data-chat-node^="message:"]').length,
            tools:Array.from(document.querySelectorAll('.ntool[data-tool-node]')).map(node=>node.dataset.toolNode),
            answer:document.querySelector('[data-message-owner="1999"] .ntext')?.textContent,
            firstOwner:document.querySelector('[data-chat-node^="message:"]')?.dataset.messageOwner})`);
        return { snapshot, rendered, elapsedMs: +(performance.now() - started).toFixed(2) };
      };
      const first = await paint();
      assert.equal(first.rendered.messages, 80);
      assert.equal(first.rendered.firstOwner, '1920');
      assert.equal(first.rendered.answer.trimEnd(), fullAnswer, 'Markdown paragraph terminators do not truncate the answer');
      assert.equal(first.rendered.tools.length, 160);
      assert.equal(new Set(first.rendered.tools).size, first.rendered.tools.length);
      for (const id of ['call-0', 'call-1', 'call-2', 'call-9999']) assert.ok(first.rendered.tools.includes(id), id);
      state.tools[0].state = 'done'; state.tools[1].state = 'error'; state.tools[1].isError = true;
      state.tools[2].result = 'updated live receipt';
      const next = await paint();
      assert.equal(next.snapshot.tools.some(tool => tool.id === 'call-0'), false);
      assert.equal(next.snapshot.tools.some(tool => tool.id === 'call-1'), false);
      assert.equal(next.snapshot.tools.find(tool => tool.id === 'call-2').result, 'updated live receipt');
      assert.equal(next.rendered.tools.includes('call-0'), false);
      assert.equal(next.rendered.tools.includes('call-1'), false);
      assert.equal(next.rendered.tools.includes('call-2'), true);
      assert.equal(state.messages.length, 2000); assert.equal(state.tools.length, 10000);
      assert.equal(state.tools[1].state, 'error', 'offscreen errors remain in the full transcript');
      report.cases.push({ mode, messages: first.rendered.messages, tools: first.rendered.tools.length,
        fullAnswerCharacters: fullAnswer.length, firstDrawMs: first.elapsedMs, nextDrawMs: next.elapsedMs });
    }
    report.ok = true;
  }).catch(error => { report.error = error.stack || String(error); }).finally(() => {
    if (win && !win.isDestroyed()) win.destroy();
    const output = path.resolve(__dirname, '../../outputs/chat-performance-20261023/window-render.json');
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); app.exit(report.ok ? 0 : 1);
  });
}
