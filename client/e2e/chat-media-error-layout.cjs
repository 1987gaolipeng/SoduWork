'use strict';
// Real Chromium layout and image decoding with production media modules.
// The fixture has an isolated profile and never reads user files or calls a model.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 45000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, nativeImage } = electron;
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const assert = require('node:assert/strict');
  const { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-media-layout-'));
  const output = path.resolve(process.argv[2] || path.join(scratch, 'evidence'));
  app.setPath('userData', path.join(scratch, 'profile'));
  const report = { ok: false, cases: [], isolatedProfile: true, realModel: false };
  let win;
  const run = source => win.webContents.executeJavaScript(source, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(source) {
    for (let i = 0; i < 100; i++) { if (await run(source)) return; await delay(30); }
    throw Error('Timeout: ' + source);
  }
  async function metrics() {
    return run(`(() => {
      const figure = list.querySelector('.nmedia-item'), frame = figure.querySelector('.nmedia-frame');
      const retry = figure.querySelector('.nmedia-retry'), status = figure.querySelector('.nmedia-status');
      const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
      return { state: figure.dataset.mediaState, card: rect(figure.parentElement), frame: rect(frame),
        retry: rect(retry), nowrap: getComputedStyle(retry).whiteSpace, status: status.textContent,
        overflow: list.scrollWidth > list.clientWidth, image: rect(figure.querySelector('img')) };
    })()`);
  }
  app.whenReady().then(async () => {
    fs.mkdirSync(output, { recursive: true });
    const html = path.join(scratch, 'fixture.html');
    fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><style>body{margin:20px}#list{width:600px}</style><div id="list"></div>');
    win = new BrowserWindow({ show: false, width: 960, height: 720, webPreferences: {
      offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    } });
    await win.loadFile(html);
    for (const file of ['theme/variables.css', 'components/panels/panels-chat.css', 'components/panels/chat-media.css']) {
      await run(`new Promise((resolve, reject) => { const link = document.createElement('link'); link.rel = 'stylesheet';
        link.href = ${JSON.stringify(pathToFileURL(path.join(client, file)).href)};
        link.onload = resolve; link.onerror = () => reject(Error('Stylesheet failed')); document.head.append(link); })`);
    }
    for (const file of ['chat-media.js', 'chat-output-links.js', 'chat-dom-patch.js']) {
      await run(fs.readFileSync(path.join(client, 'components/panels', file), 'utf8') + '\nvoid 0;');
    }
    const png = (width, height) => nativeImage.createFromBitmap(Buffer.alloc(width * height * 4, 255), { width, height }).toPNG().toString('base64');
    await run(`window.list = document.getElementById('list'); window.calls = 0;
      window.api = { artifactAction: () => { calls++; return new Promise(resolve => window.finishPreview = resolve); } };
      window.paint = () => {
        window.finishPreview = null;
        const files = [{ artifactId: 'image-id', name: 'goldfish.png', relative: 'goldfish.png', at: 1, primary: true }];
        list.innerHTML = ChatOutputLinks.decorate('<div class="nmsg ai" data-delivery-final="true"><div class="ntext">goldfish.png</div></div>', files, 'layout-chat');
        ChatOutputLinks.hydrateImages(list, files, { ref: 'layout-chat', api });
      }; void 0;`);
    for (const width of [600, 260, 120]) {
      await run(`list.style.width = '${width}px'; paint(); void 0;`);
      await until('typeof finishPreview === "function"');
      const loading = await metrics();
      assert.equal(loading.state, 'loading');
      assert.equal(loading.card.w, Math.min(160, width), JSON.stringify(loading));
      assert.equal(loading.frame.h, 160); assert.equal(loading.overflow, false);
      await run('finishPreview({ ok: false, reason: "Synthetic preview failure" }); void 0;');
      await until('list.querySelector(".nmedia-item").dataset.mediaState === "error"');
      const failed = await metrics();
      assert.equal(failed.card.w, loading.card.w, JSON.stringify(failed));
      assert.equal(failed.nowrap, 'nowrap'); assert(failed.retry.h < 40, JSON.stringify(failed));
      assert(failed.retry.x >= failed.frame.x && failed.retry.x + failed.retry.w <= failed.frame.x + failed.frame.w);
      assert.equal(failed.status, '媒体加载失败'); assert.equal(failed.overflow, false);
      await delay(100);
      fs.writeFileSync(path.join(output, 'failed-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
      const calls = await run('calls');
      await run('list.querySelector(".nmedia-retry").click(); void 0;');
      await until('calls === ' + (calls + 1));
      assert.equal((await metrics()).state, 'loading');
      await run(`finishPreview({ ok: true, mimeType: 'image/png', data: ${JSON.stringify(png(48, 32))} }); void 0;`);
      await until('list.querySelector(".nmedia-item").dataset.mediaState === "ready"');
      const ready = await metrics();
      assert.deepEqual([ready.card.w, ready.card.h], [48, 32]);
      assert.deepEqual([ready.image.w, ready.image.h], [48, 32]);
      assert.equal(ready.retry.w, 0); assert.equal(ready.overflow, false);
      report.cases.push({ width, loading, failed, ready });
    }
    for (const [width, height] of [[1200, 400], [400, 1200]]) {
      await run('list.style.width = "600px"; finishPreview = null; paint(); void 0;');
      await until('typeof finishPreview === "function"');
      await run(`finishPreview({ ok: true, mimeType: 'image/png', data: ${JSON.stringify(png(width, height))} }); void 0;`);
      await until('list.querySelector(".nmedia-item").dataset.mediaState === "ready"');
      const ready = await metrics();
      assert(ready.image.w <= 360 && ready.image.h <= 280, JSON.stringify(ready));
      assert(Math.abs(ready.image.w / ready.image.h - width / height) < 0.01);
      assert(Math.abs(ready.frame.w - ready.image.w) < 1 && Math.abs(ready.frame.h - ready.image.h) < 1);
      report.cases.push({ natural: [width, height], ready });
    }
    await run(`list.style.width = '260px'; list.innerHTML = '<div class="nmedia-group nmedia-grid"></div>';
      window.SoduWorkI18n = { translateText: text => text === '重新加载' ? 'Reload image' : text };
      for (let i = 0; i < 3; i++) {
        const card = ChatMedia.card(document, 'image', 'image-' + i);
        list.firstChild.append(card); ChatMedia.load(card, () => '');
      } void 0;`);
    await until('list.querySelectorAll("[data-media-state=error]").length === 3');
    const gallery = await run(`[...list.querySelectorAll('.nmedia-frame')].map(frame => {
      const r = frame.getBoundingClientRect(), b = frame.querySelector('button').getBoundingClientRect();
      return { w: r.width, h: r.height, buttonHeight: b.height, inside: b.x >= r.x && b.right <= r.right };
    })`);
    assert(gallery.every(frame => Math.abs(frame.w - frame.h) < 1 && frame.inside && frame.buttonHeight < 40));
    assert(gallery.every(frame => Math.abs(frame.w - gallery[0].w) < 1));
    assert.equal(await run('list.scrollWidth > list.clientWidth'), false);
    report.cases.push({ narrowGallery: gallery });
    await run(fs.readFileSync(path.join(client, 'components/panels/chat-deliveries.js'), 'utf8') + '\nvoid 0;');
    await run(`window.SoduWorkI18n = undefined;
      window.historyFiles = [
        { artifactId: 'final', name: 'index.html', relative: 'index.html', primary: true },
        { artifactId: 'unmentioned', name: 'notes.pdf', relative: 'exports/notes.pdf', primary: true },
        ...['shots/menu.png', 'shots/fight.png', 'other/lost.png', 'old/ko.png', 'old/ko.png'].map((relative, i) =>
          ({ artifactId: 's' + i, relative, name: relative.split('/').pop(), primary: false, processEvidence: true }))
      ];
      window.paintHistory = (files, urls, historyImagesLoading = false) => {
        const md = '<div class="nmd"><p>Open <code>index.html</code></p><pre><code class="language-soduwork-media">' +
          JSON.stringify({ type: 'gallery', items: urls.map(url => ({ url })) }) + '</code></pre></div>';
        list.innerHTML = ChatOutputLinks.decorate('<div class="nmsg ai" data-delivery-final="true">' +
          ChatMedia.prepare(md, 'history') + '</div>', files, 'history', { localReplica: true, status: 'idle', historyImagesLoading });
      };
      window.historyReads = [];
      paintHistory(historyFiles, ['shots/menu.png', './shots/fight.png', 'shots/lost.png', 'old/ko.png']);
      ChatMedia.hydrate(list);
      ChatOutputLinks.hydrateImages(list, historyFiles, { ref: 'history', api: { artifactAction: async (...args) => {
        historyReads.push(args);
        return { ok: true, mimeType: 'image/png', data: ${JSON.stringify(png(48, 32))} };
      } } });
    `);
    assert.deepEqual(await run(`[...list.querySelectorAll('.nmd [data-output-image]')].map(n => n.dataset.outputImage)`), ['s0', 's1']);
    await until('list.querySelectorAll(".nmd img").length === 2 && [...list.querySelectorAll(".nmd img")].every(n => n.naturalWidth === 48)');
    assert.deepEqual(await run('historyReads'), [['history', 's0', 'image-full'], ['history', 's1', 'image-full']]);
    assert.equal(await run('list.querySelector(".ndelivery [data-open-app]").dataset.openApp'), 'final');
    assert.deepEqual(await run(`[...list.querySelectorAll(':scope > .ndelivery [data-open-app]')].map(n => n.dataset.openApp)`), ['unmentioned']);
    assert.equal(await run('list.querySelectorAll("[data-delivery-retry],[data-delivery-reveal],[data-delivery-archive]").length'), 0);
    assert.deepEqual(await run(`[...list.querySelectorAll('.nmd [role="status"]')].map(n => n.textContent).filter(Boolean)`),
      ['图片暂时无法预览 · shots/lost.png', '图片暂时无法预览 · old/ko.png']);
    await run(`paintHistory([], ['shots/lost.png'], true); void 0;`);
    assert.equal(await run('list.querySelector(".nmd [role=status]").textContent'), '正在读取图片… · shots/lost.png');
    const loadingMedia = await run('list.querySelector("[data-chat-media]").dataset.chatMedia');
    await run(`paintHistory([], ['shots/lost.png']); void 0;`);
    assert.notEqual(await run('list.querySelector("[data-chat-media]").dataset.chatMedia'), loadingMedia);
    assert.equal(await run('list.querySelector(".nmd [role=status]").textContent'), '图片暂时无法预览 · shots/lost.png');
    assert.equal(await run('list.querySelectorAll("button,img,a").length'), 0);
    await run(`paintHistory(historyFiles, ['shots/menu.png', '../shots/fight.png']); void 0;`);
    assert.equal(await run('Boolean(list.querySelector("pre code")) && !list.querySelector("img")'), true);
    report.cases.push({ historyGallery: 'two decoded screenshots, two unavailable entries, one message output and one session output' });
    async function deliveryGroups(messages, files, history = {}, historyRecovery) {
      return run(`(() => {
        const messages = ${JSON.stringify(messages)}, supplied = ${JSON.stringify(history)};
        const html = messages.map((message, index) => message.role === 'user'
          ? '<div class="nmsg user" data-chat-node="message:' + index + '">Create a report.</div>'
          : '<div class="nmsg ai" data-delivery-final="true" data-chat-node="message:' + index + '"><div class="ntext">' +
            (message.mentions ? '<code>' + message.mentions + '</code>' : 'Delivered.') + '</div>' +
            (message.installCard ? '<div class="nplugin-draft"><button data-install-plugin-draft="fixture">Install</button></div>' : '') + '</div>').join('');
        const snapshot = { messages, status: 'idle', localReplica: true, execution: { readOnly: true }, historyRecovery: ${JSON.stringify(historyRecovery)},
          history: { totalMessages: messages.length, messageStart: 0, truncated: false, ...supplied } };
        list.innerHTML = ChatOutputLinks.decorate(html, ${JSON.stringify(files)}, 'delivery-groups', snapshot);
        return { groups: [...list.querySelectorAll('.ndelivery')].map(card => ({
          owner: card.closest('.nmsg')?.dataset.chatNode || 'session',
          ids: [...card.querySelectorAll('[data-open-app]')].map(link => link.dataset.openApp).sort(),
        })), installOwners: [...list.querySelectorAll('[data-install-plugin-draft]')].map(button => button.closest('.nmsg')?.dataset.chatNode) };
      })()`);
    }
    const primary = (id, at) => ({ artifactId: id, name: id + '.txt', relative: id + '.txt', primary: true, at });
    const group = (owner, ...ids) => ({ owner, ids: ids.sort() });
    const user = { role: 'user' }, reply = { role: 'assistant', done: true };
    const oneTurn = [user, { ...reply, mentions: 'named.txt' }];
    const pair = [primary('named', 350), primary('extra', 330)];
    assert.deepEqual((await deliveryGroups(oneTurn, [...pair,
      { ...primary('support', 340), primary: false }, { ...primary('evidence', 345), processEvidence: true }])).groups,
      [group('message:1', 'named', 'extra')]);
    const bounded = [{ ...user, sentAt: 100 }, { ...reply, completedAt: 190, mentions: 'named.txt' },
      { ...user, sentAt: 300 }, { ...reply, completedAt: 400 }];
    assert.deepEqual((await deliveryGroups(bounded, [...pair, primary('early', 120), primary('between', 250)])).groups,
      [group('message:1', 'early', 'named'), group('message:3', 'extra'), group('session', 'between')]);
    const undated = [...oneTurn, user, reply];
    assert.deepEqual((await deliveryGroups(undated, pair)).groups, [group('message:1', 'named'), group('session', 'extra')]);
    assert.deepEqual((await deliveryGroups(oneTurn, pair, {}, { mode: 'device-history', incomplete: true })).groups,
      [group('message:1', 'named'), group('session', 'extra')]);
    const page = { totalMessages: 6, truncated: true, messageStart: 4, messageIndices: [4, 5] };
    assert.deepEqual((await deliveryGroups(oneTurn, pair, page)).groups, [group('message:1', 'named'), group('session', 'extra')]);
    assert.deepEqual(await deliveryGroups([user, { ...oneTurn[1], installCard: true }], pair, page),
      { groups: [group('session', 'named', 'extra')], installOwners: ['message:1'] });
    report.cases.push({ historyDeliveries: 'single turn, bounded turns, undated turns, incomplete archive, paginated history and legacy installation card' });
    report.ok = true;
  }).catch(error => { report.error = error.stack || String(error); }).finally(() => {
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    if (win) win.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
