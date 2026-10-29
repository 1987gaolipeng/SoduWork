'use strict';
// Production chat renderer/DOM/Markdown in an isolated Electron profile.
// Synthetic transcript only; no account, model, or external service access.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], {
    env, windowsHide: true, stdio: 'inherit',
  }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict');
  const baseline = process.argv.includes('--baseline');
  const report = { ok: false, baseline, isolated: true, realModel: false, cases: [] };
  const output = path.resolve(__dirname, '../../outputs/client-freeze-20261013/chat-stream-' + (baseline ? 'baseline' : 'fixed') + '.json');
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-chat-stream-')));
  let win;
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1000, height: 800, skipTaskbar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await win.loadFile(path.join(__dirname, 'fixtures/long-conversation.html'));
    if (baseline) {
      const source = require('node:child_process').execFileSync('git', ['show', 'HEAD:client/components/panels/chat-message-renderer.js'], {
        cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', windowsHide: true,
      });
      await win.webContents.executeJavaScript(source + '\nrenderer.reset(); window.renderer = ChatMessageRenderer.create(ctx); void 0;');
    }
    report.results = await win.webContents.executeJavaScript(`(async () => {
      const input = document.createElement('textarea'); document.body.prepend(input); input.value = 'draft'; input.focus();
      ctx._snap = { status: 'streaming', usage: { input: 100, output: 1 },
        messages: Array.from({ length: 79 }, (_, i) => i % 2 === 0 ? { role: 'user', text: 'Synthetic request ' + i } :
          { role: 'assistant', done: true, blocks: [{ index: 0, kind: 'thinking', done: true, text: 'Historical reasoning '.repeat(200) },
            { index: 1, kind: 'text', done: true, text: '## Synthetic result ' + i + '\\n\\n' + 'Settled text '.repeat(100) }] }),
        tools: [{ id: 'running', name: 'inspect_data', after: 78, state: 'running', args: { query: 'synthetic query' }, partial: 'Synthetic output\\n'.repeat(3000) }] };
      ctx._snap.messages.push({ role: 'assistant', done: false, usage: { output: 1 }, blocks: [
        { index: 0, kind: 'thinking', done: true, text: 'Live reasoning' }, { index: 1, kind: 'text', done: false, text: 'Streaming answer' }] });
      const list = document.querySelector('#nchatList');
      let rebuilds = 0, metrics = 0, inputs = 0;
      const original = ChatTools.patchList; ChatTools.patchList = (...args) => { rebuilds++; return original(...args); };
      ctx._refreshTurnMetrics = () => { metrics++; };
      input.addEventListener('input', () => { inputs++; }); ctx._openTool.add('running'); renderer._render();
      const history = list.querySelector('[data-thinking-body="77:0"]');
      const historyText = history.firstChild;
      const tool = list.querySelector('[data-tool-node="running"] .ntool-body');
      let historyMutations = 0, toolMutations = 0, transcriptMutations = 0;const mutationDetails=[];
      const transcriptObserver = new MutationObserver(rows => { transcriptMutations += rows.length;rows.forEach(r=>mutationDetails.push({type:r.type,attribute:r.attributeName,tag:r.target.nodeName,cls:r.target.className})); });
      transcriptObserver.observe(list, { subtree: true, childList: true, characterData: true, attributes: true });
      const historicalObserver = new MutationObserver(rows => { historyMutations += rows.length; });
      const toolObserver = new MutationObserver(rows => { toolMutations += rows.length; });
      historicalObserver.observe(history, { subtree: true, childList: true, characterData: true });
      toolObserver.observe(tool, { subtree: true, childList: true, characterData: true });
      const sample = async (usage) => {
        const before = { rebuilds, historyMutations, toolMutations, transcriptMutations }, times = [];
        for (let i = 0; i < 120; i++) {
          if (usage) { ctx._snap.usage.output++; ctx._snap.messages.at(-1).usage.output++; }
          else ctx._snap.messages.at(-1).blocks.at(-1).text += ' next';
          const start = performance.now(); renderer._render(); times.push(performance.now() - start);
          input.dispatchEvent(new Event('input'));
          if (i % 10 === 0) await new Promise(resolve => setTimeout(resolve, 0));
        }
        await Promise.resolve();
        const sorted = times.toSorted((a, b) => a - b);
        return { rebuilds: rebuilds - before.rebuilds, historyMutations: historyMutations - before.historyMutations,
          toolMutations: toolMutations - before.toolMutations, transcriptMutations: transcriptMutations - before.transcriptMutations, mutations:mutationDetails.slice(before.transcriptMutations),
          totalMs: times.reduce((a, b) => a + b, 0),
          maxMs: sorted.at(-1), p95Ms: sorted[Math.floor(sorted.length * .95)] };
      };
      const text = await sample(false);
      // Let the Markdown throttle commit the final text delta before measuring
      // a pure usage-only burst; one deferred text paint is legitimate work.
      await new Promise(resolve => setTimeout(resolve, 150)); renderer._render(); await Promise.resolve();
      const usage = await sample(true);
      ctx._snap.tools[0].partial = 'LATEST-TOOL-OUTPUT\\n' + ctx._snap.tools[0].partial; renderer._render();
      const toolUpdated = list.querySelector('[data-tool-node="running"] .ntool-body').textContent.includes('LATEST-TOOL-OUTPUT');
      ctx._snap.status = 'idle'; ctx._snap.messages.at(-1).done = true; ctx._snap.messages.at(-1).blocks.at(-1).done = true;
      renderer._render();
      historicalObserver.disconnect(); toolObserver.disconnect(); transcriptObserver.disconnect();
      const finalAnswer = list.querySelector('[data-chat-node="message:79"] .ntext').textContent.includes('Streaming answer');
      const retainedHistoricalTextNode = history.firstChild === historyText;
      ctx._snap.messages = Array.from({ length: 1999 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user',
        text: 'Historical request ' + i, done: true, blocks: [{ kind: 'text', index: 0, done: true, text: '## Historical answer ' + i }] }));
      ctx._snap.messages.push({ role: 'assistant', done: false, blocks: [{ kind: 'text', index: 0, done: false, text: 'Long synthetic answer '.repeat(12000) }] });
      ctx._snap.tools = []; ctx._snap.status = 'streaming'; renderer._render();
      const longStart = performance.now(), beforeLong = rebuilds;
      for (let i = 0; i < 60; i++) {
        ctx._snap.messages.at(-1).blocks[0].text += ' delta'; ctx._snap.usage.output++;
        renderer._render(); if (i % 10 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
      const long = { totalMessages: ctx._snap.messages.length, visibleMessages: list.querySelectorAll('[data-chat-node^="message:"]').length,
        sourceChars: ctx._snap.messages.at(-1).blocks[0].text.length, liveChars: list.querySelector('[data-chat-node="message:1999"] .ntext').textContent.trim().length,
        rebuilds: rebuilds - beforeLong, wallMs: performance.now() - longStart };
      ctx._snap.status = 'idle'; ctx._snap.messages.at(-1).done = true; ctx._snap.messages.at(-1).blocks[0].done = true; renderer._render();
      long.finalComplete = list.querySelector('[data-chat-node="message:1999"] .ntext').textContent.trim() === ctx._snap.messages.at(-1).blocks[0].text.trim();
      return { text, usage, metrics, inputs,
        retainedInput: document.activeElement === input && input.value === 'draft', toolUpdated,
        finalAnswer, retainedHistoricalTextNode, long };
    })()`);
    if (!baseline) {
      for (const mode of ['text', 'usage']) {
        assert.equal(report.results[mode].rebuilds, 0, mode + ' does not rebuild the transcript');
        assert.equal(report.results[mode].historyMutations, 0, mode + ' leaves historical thinking untouched');
        assert.equal(report.results[mode].toolMutations, 0, mode + ' leaves unchanged tool output untouched');
      }
      assert.equal(report.results.retainedHistoricalTextNode, true);
      assert.equal(report.results.retainedInput, true);
      assert.equal(report.results.inputs, 240);
      assert.equal(report.results.usage.transcriptMutations, 0, 'usage-only updates do not mutate any transcript node');
      assert.equal(report.results.toolUpdated, true);
      assert.equal(report.results.finalAnswer, true);
      assert.ok(report.results.metrics >= 240);
      assert.equal(report.results.long.visibleMessages, 80);
      assert.equal(report.results.long.rebuilds, 0);
      assert.ok(report.results.long.sourceChars > 250000);
      assert.ok(report.results.long.liveChars >= 250000, 'stream keeps its earlier content and Markdown prefix');
      assert.equal(report.results.long.finalComplete, true);
    }
    report.cases.push('80-message transcript and 240 text/usage updates measured; historical/tool DOM changes, metrics, input focus and final output checked');
    report.ok = true;
  }).catch(error => { report.error = error.stack || String(error); }).finally(() => {
    if (win && !win.isDestroyed()) win.destroy();
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
  });
}
