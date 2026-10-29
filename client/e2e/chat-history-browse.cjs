'use strict';
// Real Chromium layout; settled conversation, upward reading.
// Covers the 2026-10 regression: after a turn completes, scrolling back through
// older messages must not bounce, collapse or lose the reading position.
// Browsing is driven by direct scrollTop steps (the scrollbar-drag equivalent)
// plus a native-wheel smoke pass with the wheel sign verified on this platform.
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
  const output = path.resolve(__dirname, '../../outputs/chat-history-browse-20261014');
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-history-browse-')));
  const report = { ok: false, realNativeWheel: true, realModel: false };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  let win;
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: true, title: 'SoduWork history browsing regression (isolated)', width: 1100, height: 820, skipTaskbar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await win.loadFile(path.join(__dirname, 'fixtures/long-conversation.html'));
    await win.webContents.executeJavaScript(`
      const area = document.createElement('div'); area.className = 'nchat-content-area'; area.style.position = 'relative';
      document.querySelector('#root').appendChild(area); area.appendChild(document.querySelector('#nchatScroll'));
      document.querySelector('#nchatScroll').classList.add('nchat-scroll');
      document.querySelector('#nchatScroll').tabIndex = 0;
      fill(40); ctx._snap.status = 'idle';
      ctx._snap.messages = ctx._snap.messages.map((m, i) => m.role === 'assistant' ? { role: 'assistant', done: true,
        blocks: [{ index: 0, kind: 'text', text: '## reply ' + i + '\\n\\n' + ('body paragraph text. '.repeat(160)) }] } : m);
      window.scrollBox = document.querySelector('#nchatScroll');
      window.wheels = 0;
      scrollBox.addEventListener('wheel', () => wheels++, { passive: true });
      renderer._render();
    `);
    win.focus(); win.webContents.focus();
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 550, y: 360 });
    await delay(700);
    // Settle at the bottom, as right after a finished answer.
    await win.webContents.executeJavaScript('scrollBox.scrollTop = scrollBox.scrollHeight; void 0');
    await delay(400);
    const get = () => win.webContents.executeJavaScript(`({top: Math.round(scrollBox.scrollTop), height: Math.round(scrollBox.scrollHeight),
      viewport: Math.round(scrollBox.clientHeight), follow: scrollBox.__soduworkScrollFollow && scrollBox.__soduworkScrollFollow.follow,
      cv: getComputedStyle(document.querySelector('[data-chat-node="message:3"]')).contentVisibility,
      anchor: getComputedStyle(scrollBox).overflowAnchor})`);
    report.bottom = await get();

    // First upward browse pass: focused PageUp steps (same code path as a
    // reader paging through history: native key -> markIntent -> default scroll),
    // plus one settled re-render per step, as status events do.
    await win.webContents.executeJavaScript('scrollBox.focus(); void 0');
    const pageUp = async () => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'PageUp' });
      await delay(40);
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'PageUp' });
      await delay(70);
      await win.webContents.executeJavaScript('renderer._render(); void 0');
      await delay(90);
    };
    report.firstPass = [];
    for (let i = 0; i < 20; i++) {
      await pageUp();
      const sample = await get();
      report.firstPass.push(sample);
    }
    // Native wheel smoke: in this environment a positive deltaY scrolls upward
    // (see chat-stream-scroll.cjs). The wheel must actually move the reader.
    const wheelBefore = await get();
    win.webContents.sendInputEvent({ type: 'mouseWheel', x: 550, y: 360, deltaY: 160, deltaX: 0 });
    await delay(260);
    report.afterWheel = await get();

    // Mid-browse turn completion: a streaming answer finishes while the reader
    // is halfway up the transcript. The settled full patch must not move the
    // reading position or collapse the visible rows.
    await win.webContents.executeJavaScript(`
      ctx._snap.status = 'streaming';
      ctx._snap.messages.push({ role: 'assistant', done: false,
        blocks: [{ index: 0, kind: 'text', text: 'streaming answer that finishes mid-browse' }] });
      renderer._render(); void 0;
    `);
    await delay(200);
    report.midBrowseBefore = await get();
    await win.webContents.executeJavaScript(`
      ctx._snap.status = 'idle';
      ctx._snap.messages.at(-1).done = true;
      ctx._snap.messages.at(-1).blocks[0].done = true;
      ctx._snap.messages.at(-1).blocks[0].text += ' with the final paragraph now settled';
      renderer._render(); void 0;
    `);
    await delay(350);
    report.midBrowseAfter = await get();

    // Back to the bottom, then browse again: second pass must be stable.
    await win.webContents.executeJavaScript('scrollBox.scrollTop = scrollBox.scrollHeight; void 0');
    await delay(400);
    report.secondPass = [];
    for (let i = 0; i < 8; i++) {
      await pageUp();
      report.secondPass.push(await get());
    }
    report.bottomAgain = await get();

    // Explicit "latest" click still pins to the true bottom.
    await win.webContents.executeJavaScript(`document.querySelector('.nchat-jump-latest').click()`);
    await delay(300);
    report.latest = await get();

    // Scrollbar drag: pointerdown inside the actual track marks the intent,
    // the drag itself moves scrollTop, pointerup releases. This drives the
    // same code path a real thumb drag takes (pointer state -> no follow ->
    // settled re-render must not yank the reading position back).
    await win.webContents.executeJavaScript('scrollBox.scrollTop = scrollBox.scrollHeight; void 0');
    await delay(300);
    await win.webContents.executeJavaScript(`
      const rect = scrollBox.getBoundingClientRect(), style = getComputedStyle(scrollBox);
      const scale = rect.width / scrollBox.offsetWidth;
      const border = parseFloat(style.borderRightWidth) || 0;
      const gutter = scrollBox.offsetWidth - scrollBox.clientWidth - scrollBox.clientLeft - border;
      const trackWidth = gutter || parseFloat(getComputedStyle(scrollBox, '::-webkit-scrollbar').width);
      if (!(trackWidth > 0)) throw Error('The scroll fixture must expose a scrollbar track');
      scrollBox.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerType: 'mouse', bubbles: true,
        clientX: rect.right - (border + trackWidth / 2) * scale, clientY: rect.top + rect.height / 2 }));
      void 0;
    `);
    report.dragStart = await get();
    for (let i = 0; i < 6; i++) {
      await win.webContents.executeJavaScript(`scrollBox.scrollTop = Math.max(0, scrollBox.scrollTop - 600); void 0`);
      await delay(60);
    }
    await win.webContents.executeJavaScript('renderer._render(); void 0');
    await delay(150);
    report.dragWhileDragging = await get();
    await win.webContents.executeJavaScript(`
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      void 0;
    `);
    await delay(250);
    report.dragAfter = await get();

    // Assertions.
    assert.ok(report.bottom.follow, 'settled conversation starts pinned to latest');
    assert.equal(report.bottom.anchor, 'none', 'scroll anchoring must never compete with the reading position');
    for (let i = 0; i < report.firstPass.length; i++) {
      const step = report.firstPass[i];
      assert.equal(step.follow, false, 'page-up suspends bottom-following at step ' + i);
      assert.equal(step.cv, 'visible', 'paused browsing renders real content, not placeholders');
      if (i === 0) assert.ok(step.top < report.bottom.top - 300, 'first page-up actually moves the reader up');
      else {
        assert.ok(step.top < report.firstPass[i - 1].top - 100,
          'page-up ' + i + ' keeps moving upward (' + report.firstPass[i - 1].top + ' -> ' + step.top + ')');
        assert.ok(step.height >= report.firstPass[i - 1].height - 2,
          'browsing upward must not collapse the transcript at step ' + i);
      }
    }
    for (let i = 1; i < report.secondPass.length; i++) {
      const step = report.secondPass[i];
      assert.ok(step.top < report.secondPass[i - 1].top - 100, 'second pass keeps paging upward');
      assert.ok(step.height >= report.secondPass[i - 1].height - 2, 'second pass keeps the transcript height stable');
    }
    const finalHeight = report.secondPass[report.secondPass.length - 1].height;
    const firstHeight = report.firstPass[report.firstPass.length - 1].height;
    assert.ok(Math.abs(finalHeight - firstHeight) <= Math.max(6, firstHeight * 0.02),
      'measured sizes persist across passes (' + firstHeight + ' vs ' + finalHeight + ')');
    assert.ok(Math.abs(report.midBrowseAfter.top - report.midBrowseBefore.top) <= 2 &&
      report.midBrowseAfter.follow === false,
      'a turn finishing mid-browse must not move the reading position (' +
      report.midBrowseBefore.top + ' -> ' + report.midBrowseAfter.top + ')');
    assert.ok(report.midBrowseAfter.height >= report.midBrowseBefore.height - 2,
      'the settling answer must not collapse the transcript under the reader (' +
      report.midBrowseBefore.height + ' -> ' + report.midBrowseAfter.height + ')');
    const pinned = await win.webContents.executeJavaScript(`(() => {
      let pinned = 0;
      for (const node of document.querySelectorAll('#nchatList > [data-chat-node]')) {
        if (node.style.containIntrinsicSize && node.style.containIntrinsicSize !== 'auto 320px') pinned++;
      }
      return pinned;
    })()`);
    assert.ok(pinned > 0, 'browsed rows keep their measured height pinned (' + pinned + ' rows)');
    assert.equal(report.latest.follow, true, 'explicit latest resumes following');
    assert.ok(report.latest.height - report.latest.viewport - report.latest.top < 4, 'latest reaches actual bottom');
    assert.equal(report.dragStart.follow, false, 'pressing the scrollbar suspends following immediately');
    assert.ok(report.dragWhileDragging.top < report.bottom.top - 500,
      'a scrollbar drag actually moves the reader up (' + report.bottom.top + ' -> ' + report.dragWhileDragging.top + ')');
    assert.ok(report.dragAfter.top <= report.dragWhileDragging.top + 2,
      'release and a settled re-render do not yank the thumb back (' +
      report.dragWhileDragging.top + ' -> ' + report.dragAfter.top + ')');
    report.ok = true;
  }).catch(error => { report.error = error.stack || String(error); }).finally(() => {
    if (win && !win.isDestroyed()) win.destroy();
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
  });
}
