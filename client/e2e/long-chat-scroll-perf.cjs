'use strict';
/*
 * Long-chat rendering performance A/B for the content-visibility fix
 * (client/components/panels/panels-chat.css, commit 261a04d4).
 *
 * Both modes run against the same fixture page that loads the production
 * panels-chat.css and chat-message-renderer.js. Mode A (fix-on) uses the
 * stylesheet as committed; mode B (fix-off) injects an override that restores
 * the pre-fix behaviour (content-visibility: visible). The page is reloaded
 * between passes so every measurement starts from an identical empty state.
 *
 * Run: node_modules/.bin/electron e2e/long-chat-scroll-perf.cjs [--count N] [--passes P]
 * Output: one progress line per pass, then a single JSON summary on stdout.
 */
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : dflt;
};
const COUNT = opt('count', 1000);
const PASSES = opt('passes', 3);

app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'soduwork-chat-perf-')));

const PAGE_HELPERS = `
(() => {
  const raf = () => new Promise(r => requestAnimationFrame(() => r()));
  const raf2 = async () => { await raf(); await raf(); };
  const codeLines = Array.from({ length: 30 }, (_, i) =>
    '    step_' + i + ' = pipeline.compute(' + i + ')  // 处理第 ' + i + ' 段数据').join('\\n');
  const markdown = (i) => [
    '## 分析结论 ' + i, '',
    '这一轮我们复核了数据管道的**吞吐**与*延迟*表现，逐段统计后的结论如下：', '',
    '| 指标 | 数值 | 说明 |', '| --- | --- | --- |',
    '| 吞吐 | ' + (1000 + i) + ' 行/s | 稳定 |',
    '| 延迟 | ' + (12 + i % 7) + ' ms | 可接受 |', '',
    '处理流程示例：', '', '\\u0060\\u0060\\u0060python', 'def run_pipeline():',
    codeLines, '    return True', '\\u0060\\u0060\\u0060', '',
    '要点清单：', '', '1. 保持缓冲区水位恒定', '2. 避免重复解析全文', '3. 记录每段耗时', '',
    '补充说明：' + '示例内容，完整保留。 '.repeat(40),
  ].join('\\n');
  window.__fill = (n) => {
    ctx._snap.messages = Array.from({ length: n }, (_, i) => i % 2 === 0
      ? { role: 'user', text: '需求 ' + i + '：请复核这段管道日志并给出结论。' }
      : { role: 'assistant', blocks: i % 10 === 1
          ? [{ index: 0, kind: 'thinking', text: '先检查缓冲区，再逐段统计耗时，最后与基线对比。' + '逐步推演。 '.repeat(60) },
             { index: 1, kind: 'text', text: markdown(i) }]
          : [{ index: 0, kind: 'text', text: markdown(i) }] });
    ctx._snap.tools = [];
    ctx._messageWindowSize = n + 10;
    ctx._snap.status = 'idle';
    ctx._ref = 'perf-' + n;
  };
  window.__setMode = (fixOn) => {
    let s = document.getElementById('cv-ab-override');
    if (!fixOn) {
      if (!s) {
        s = document.createElement('style');
        s.id = 'cv-ab-override';
        s.textContent = '.nchat-inner>[data-chat-node]{content-visibility:visible !important}';
        document.head.appendChild(s);
      }
    } else if (s) s.remove();
    return getComputedStyle(document.querySelector('.nchat-inner > [data-chat-node]') || document.createElement('div')).contentVisibility;
  };
  window.__open = async () => {
    const list = document.getElementById('nchatList');
    list.innerHTML = '';
    window.__phase = 'open';
    const t0 = performance.now();
    renderer._render();
    const js = performance.now() - t0;
    void document.getElementById('nchatScroll').scrollHeight; // force layout
    const layout = performance.now() - t0;
    await raf2();
    const rows = document.querySelectorAll('[data-chat-node^="message:"]').length;
    return { ms: +layout.toFixed(1), jsMs: +js.toFixed(1), rows,
             height: document.getElementById('nchatScroll').scrollHeight,
             domNodes: document.querySelectorAll('*').length };
  };
  window.__scroll = async (mode) => {
    const scroll = document.getElementById('nchatScroll');
    scroll.scrollTop = scroll.scrollHeight; // start at the live bottom
    await raf2();
    window.__phase = 'scroll-' + mode;
    const t0 = performance.now();
    let deltas = [];
    if (mode === 'fast') {
      // Drag-the-scrollbar gesture: sweep from the live bottom to the top and
      // back, one 3000px jump per frame. Wall time also depends on how much
      // real height each mode exposes (estimated vs laid-out rows), so the
      // per-frame gap stats are the comparable jank metric.
      const tops = [];
      for (let top = scroll.scrollHeight; top > 0; top -= 3000) tops.push(top);
      tops.push(0);
      const seq = [...tops, ...[...tops].reverse()];
      let last = performance.now();
      for (const top of seq) {
        scroll.scrollTop = top; await raf();
        const now = performance.now(); deltas.push(now - last); last = now;
      }
    } else {
      // Reading gesture: small wheel steps around one region.
      scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) * 0.4; await raf();
      const read = [];
      let last = performance.now();
      for (let i = 0; i < 90; i++) {
        scroll.scrollTop += i < 45 ? 120 : -120; await raf();
        const now = performance.now(); read.push(now - last); last = now;
      }
      deltas = read;
    }
    const total = performance.now() - t0;
    window.__phase = 'idle';
    const frameStats = (list) => ({
      frames: list.length,
      jankFrames: list.filter(d => d > 50).length,
      worstFrame: +Math.max(...list).toFixed(1),
      p95Frame: +(list.slice().sort((a, b) => a - b)[Math.floor(list.length * 0.95)] || 0).toFixed(1),
      msPerFrame: +(list.reduce((a, b) => a + b, 0) / list.length).toFixed(1),
    });
    return { ms: +total.toFixed(0), frames: frameStats(deltas) };
  };
  window.__plLog = [];
  window.__lastHtml = '';
  const __origPatchList = ChatTools.patchList;
  ChatTools.patchList = function (host, html) {
    const t = performance.now();
    const r = __origPatchList(host, html);
    window.__lastHtml = String(html || '');
    window.__plLog.push({ ms: +(performance.now() - t).toFixed(1), kb: +(window.__lastHtml.length / 1024).toFixed(0) });
    return r;
  };
  window.__stream = async () => {
    const scroll = document.getElementById('nchatScroll');
    scroll.scrollTop = scroll.scrollHeight; await raf2();
    window.__phase = 'stream';
    ctx._snap.status = 'streaming';
    const m = ctx._snap.messages[ctx._snap.messages.length - 1];
    // First streaming draw after the open render takes the full-rebuild path.
    const t0 = performance.now();
    m.blocks[m.blocks.length - 1].text += ' 增量数据点 0，管道保持稳定。';
    renderer._render();
    const renderMs = performance.now() - t0;
    const t1 = performance.now();
    void scroll.scrollHeight;
    const layoutMs = performance.now() - t1;
    const lastPatch = window.__plLog[window.__plLog.length - 1] || { ms: 0, kb: 0 };
    let parseMs = 0;
    if (window.__lastHtml) {
      const tp = document.createElement('template');
      const t2 = performance.now();
      tp.innerHTML = window.__lastHtml;
      parseMs = performance.now() - t2;
    }
    const firstMs = performance.now() - t0;
    await raf2();
    // Steady state: structural fingerprint unchanged, only the live tail patches.
    const steady = [];
    for (let i = 1; i < 31; i++) {
      const bt = performance.now();
      m.blocks[m.blocks.length - 1].text += ' 增量数据点 ' + i + '，管道保持稳定。';
      renderer._render();
      void scroll.scrollHeight; // what the bottom-follow path reads each frame
      steady.push(performance.now() - bt);
      await raf();
    }
    ctx._snap.status = 'idle';
    renderer._render();
    window.__phase = 'idle';
    return { firstMs: +firstMs.toFixed(1), renderMs: +renderMs.toFixed(1),
             patchMs: lastPatch.ms, patchKB: lastPatch.kb, parseMs: +parseMs.toFixed(1), layoutMs: +layoutMs.toFixed(1),
             steadyAvg: +(steady.reduce((a, b) => a + b, 0) / steady.length).toFixed(2),
             steadyMax: +Math.max(...steady).toFixed(1) };
  };
  window.__longtasks = () => window.__lt.splice(0);
  window.__lt = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__lt.push({ phase: window.__phase, ms: +e.duration.toFixed(0) });
    }).observe({ entryTypes: ['longtask'] });
  } catch (_) {}
})();`;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : +((s[mid - 1] + s[mid]) / 2).toFixed(1);
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1280, height: 900,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  const results = [];
  try {
    for (let p = 0; p < PASSES * 2; p++) {
      const fixOn = p % 2 === 1; // alternate modes, starting with fix-off
      await win.loadFile(path.join(__dirname, 'fixtures/long-conversation.html'));
      await win.webContents.executeJavaScript(PAGE_HELPERS);
      await win.webContents.executeJavaScript(`__fill(${COUNT})`);
      const mode = await win.webContents.executeJavaScript(`__setMode(${fixOn})`);
      const open = await win.webContents.executeJavaScript('__open()');
      await win.webContents.executeJavaScript('__longtasks()'); // discard open-phase jank
      const fast = await win.webContents.executeJavaScript('__scroll("fast")');
      const fastLt = await win.webContents.executeJavaScript('__longtasks()');
      const local = await win.webContents.executeJavaScript('__scroll("local")');
      const localLt = await win.webContents.executeJavaScript('__longtasks()');
      const stream = await win.webContents.executeJavaScript('__stream()');
      const streamLt = await win.webContents.executeJavaScript('__longtasks()');
      const ltStats = (entries) => ({
        count: entries.length,
        max: entries.length ? Math.max(...entries.map(e => e.ms)) : 0,
        worst: entries.length ? entries.reduce((a, b) => (b.ms > a.ms ? b : a)).ms : 0,
      });
      const rec = {
        fixOn, mode,
        open, fast, local, stream,
        lt: { fast: ltStats(fastLt), local: ltStats(localLt), stream: ltStats(streamLt) },
      };
      results.push(rec);
      console.error('[pass ' + p + (fixOn ? ' fix-ON ' : ' fix-OFF') + '] open=' + open.ms + 'ms rows=' + open.rows +
        ' height=' + open.height + 'px domNodes=' + open.domNodes +
        ' fast=' + fast.ms + 'ms(jank=' + fast.frames.jankFrames + ',worst=' + fast.frames.worstFrame + 'ms)' +
        ' local=' + local.ms + 'ms(jank=' + local.frames.jankFrames + ')' +
        ' stream(first=' + stream.firstMs + ',steadyMax=' + stream.steadyMax + ')');
    }
    const agg = (mode, pick) => median(results.filter(r => r.fixOn === mode).map(pick));
    const side = (mode) => ({
      openMs: agg(mode, r => r.open.ms),
      openJsMs: agg(mode, r => r.open.jsMs),
      realHeightPx: results.find(r => r.fixOn === mode).open.height,
      domNodes: results.find(r => r.fixOn === mode).open.domNodes,
      sweepMs: agg(mode, r => r.fast.ms), sweepFrames: agg(mode, r => r.fast.frames.frames),
      sweepJankFrames: agg(mode, r => r.fast.frames.jankFrames),
      sweepWorstFrameMs: agg(mode, r => r.fast.frames.worstFrame),
      sweepP95FrameMs: agg(mode, r => r.fast.frames.p95Frame),
      sweepLongtasks: agg(mode, r => r.lt.fast.count),
      readJankFrames: agg(mode, r => r.local.frames.jankFrames),
      readWorstFrameMs: agg(mode, r => r.local.frames.worstFrame),
      streamFirstMs: agg(mode, r => r.stream.firstMs),
      streamFirstRenderMs: agg(mode, r => r.stream.renderMs),
      streamFirstPatchMs: agg(mode, r => r.stream.patchMs),
      streamFirstParseMs: agg(mode, r => r.stream.parseMs),
      streamFirstLayoutMs: agg(mode, r => r.stream.layoutMs),
      streamPatchKB: results.find(r => r.fixOn === mode).stream.patchKB,
      streamSteadyAvgMs: agg(mode, r => r.stream.steadyAvg),
      streamSteadyMaxMs: agg(mode, r => r.stream.steadyMax),
    });
    console.log(JSON.stringify({ count: COUNT, passes: PASSES, fixOff: side(false), fixOn: side(true) }, null, 2));
  } finally { win.destroy(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
