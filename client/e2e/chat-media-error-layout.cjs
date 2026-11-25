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
          ids: [...new Set([...card.querySelectorAll('[data-open-app]')].map(link => link.dataset.openApp))].sort(),
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
    for (const file of ['panels-library.css', 'chat-deliveries.css']) {
      await win.webContents.insertCSS(fs.readFileSync(path.join(client, 'components/panels', file), 'utf8'));
    }
    const nativeIcon = await app.getFileIcon(path.join(client, 'desk.html'));
    await run('window.soduWorkAPI = { fileTypeIcon: async () => ({ ok: true, dataUrl: ' + JSON.stringify(nativeIcon.toDataURL()) + ' }) }; void 0;');
    await run(fs.readFileSync(path.join(client, 'components/panels/library-file-icons.js'), 'utf8') + '\nvoid 0;');
    await run(fs.readFileSync(path.join(client, 'components/panels/chat-composer-bindings.js'), 'utf8') + '\nvoid 0;');
    await run(`(() => {
      const messages = [{ role: 'user', submissionId: 'first' }, { role: 'assistant', done: true }];
      const ref = 'pi-history-card';
      const live = { artifactId: 'original', primary: true, changedInTurn: true, name: 'index.html',
        relative: 'index.html', kind: 'website', title: '我的简易网页', size: 128 };
      const frozen = { ...live, artifactId: 'version:frozen', versionId: 'frozen', originalArtifactId: 'original',
        userMessageIndex: 0, turnId: 'first', changedInTurn: false };
      const notes = { ...frozen, artifactId: 'version:notes', versionId: 'notes', originalArtifactId: 'original-notes',
        name: 'notes.pdf', relative: 'notes.pdf', kind: 'document', title: 'Notes' };
      const calls = [];
      const result = { ok: true, manifest: { revision: 'frozen-rev', files: [{ path: 'index.html' }] } };
      const bundle = { ok: true, manifest: { revision: 'bundle-rev', files: [{ path: 'index.html' }, { path: 'notes.pdf' }] } };
      const api = {
        inspectDelivery: async (ref, ids) => { calls.push(['inspect', ref, ids]); return ids.length > 1 ? bundle : result; },
        openLocalDelivery: async (ref, ids, options) => { calls.push(['reveal', ref, ids, options]); return { ok: true }; },
        openDeliveryArchive: async (ref, ids, options) => { calls.push(['archive', ref, ids, options]); return { ok: true }; },
        saveDelivery: async (ref, ids) => { calls.push(['export', ref, ids]); return { ok: true }; },
        prepareDelivery: async (ref, ids) => { calls.push(['prepare', ref, ids]); return result; },
      };
      window.SoduWorkAPI = { saveLibraryDelivery: async payload => {
        calls.push(['save', payload.manifest.revision]); return { ok: true, delivery: { id: 'saved', files: payload.manifest.files } };
      } };
      // Use the same delegated click binding as the conversation, with observable host commands.
      const controls = document.createElement('div');
      controls.hidden = true;
      controls.innerHTML = '<textarea id="nchatInput"></textarea><button id="nchatSend"></button><div id="nchatQueue"></div><div id="nchatTaskSuggest"></div>';
      document.body.append(controls);
      list.id = 'nchatList'; list.style.width = '560px';
      const context = { _ref: ref, _api: () => api, _paintBar() {} };
      ChatComposerBindings.create(context)._bind(document.body);
      window.ChatWorkbench = { openOutput(id, { source }) { calls.push(['preview', id, source.closest('.nmsg')?.dataset.chatNode || 'session']); } };
      const passive = { messages, localReplica: true, execution: { readOnly: true } };
      const incomplete = { ...passive, history: { truncated: true } };
      const prior = { ...frozen, artifactId: 'version:prior', versionId: 'prior', userMessageIndex: undefined, turnId: 'pi-archive:prior' };
      const loose = { ...live, artifactId: 'loose', name: 'old.html', relative: 'old.html' };
      const cases = {
        active: [[live, frozen], { messages }], away: [[], { messages: [] }],
        reopened: [[live, frozen], passive], legacy: [[live], passive], multiple: [[frozen, notes], passive],
        unassigned: [[prior], incomplete], unversioned: [[loose], incomplete], inferred: [[prior], passive],
        resumed: [[frozen, { ...live, changedInTurn: false }], {
          messages: [...messages, { role: 'user', submissionId: 'second' }, { role: 'assistant', done: true }],
        }],
      };
      function describe() {
        return [...list.querySelectorAll('.ndelivery')].map(card => ({
          owner: card.closest('.nmsg')?.dataset.chatNode || 'session', title: card.querySelector('[data-delivery-title]')?.textContent,
          icon: !!card.querySelector('.ndelivery-icon'), preview: card.querySelector('header [data-open-app]')?.dataset.openApp,
          actions: [...card.querySelectorAll('.ndelivery-actions button')].filter(b => b.checkVisibility()).map(b => b.title),
          list: !!card.querySelector('.ndelivery-files')?.checkVisibility(),
          exports: [...card.querySelectorAll('[data-delivery-export-version]')].filter(b => b.checkVisibility()).map(b => b.dataset.deliveryExportVersion),
        }));
      }
      window.deliveryFixture = { calls, describe, render(name) {
        const [files, snapshot] = cases[name];
        context._ref = name === 'away' ? 'other-chat' : ref;
        const html = snapshot.messages.map((message, i) => message.role === 'user'
          ? '<div class="nmsg user" data-chat-node="message:' + i + '"></div>'
          : '<div class="nmsg ai" data-output-task="" data-delivery-final="true" data-chat-node="message:' + i +
            '" data-delivery-current="' + (i === snapshot.messages.length - 1) + '"><div class="ntext">' +
            (i === 1 ? '<code>index.html</code>' : 'Done') + '</div></div>').join('');
        list.innerHTML = ChatOutputLinks.decorate(html, files, context._ref, { status: 'idle', ...snapshot });
        SoduWorkLibraryFileIcons.hydrate(list);
        return describe();
      } };
    })()`);
    async function clickDelivery(selector) {
      const point = await run(`(() => {
        const button = list.querySelector(${JSON.stringify(selector)});
        if (!button?.checkVisibility() || button.disabled) throw Error('Delivery button unavailable: ' + ${JSON.stringify(selector)});
        button.scrollIntoView({ block: 'nearest' });
        const bounds = button.getBoundingClientRect();
        const x = Math.round(bounds.x + bounds.width / 2), y = Math.round(bounds.y + bounds.height / 2);
        if (!button.contains(document.elementFromPoint(x, y))) throw Error('Delivery button occluded: ' + ${JSON.stringify(selector)});
        return { x, y };
      })()`);
      for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    }
    const card = { owner: 'message:1', title: '我的简易网页', icon: true, preview: 'version:frozen',
      actions: ['打开所在位置', '保存到资料库'], list: false, exports: [] };
    for (const view of ['active', 'away', 'reopened', 'resumed', 'legacy']) {
      const cards = await run('deliveryFixture.render(' + JSON.stringify(view) + ')');
      assert.deepEqual(cards, view === 'away' ? [] : [{ ...card, ...(view === 'legacy' ? { preview: 'original', actions: [] } : {}) }], view);
      if (view === 'active' || view === 'reopened') {
        await until('!!list.querySelector(".ndelivery-icon img:not([hidden])")?.naturalWidth');
        const bounds = await run(`(() => { const r = list.querySelector('.ndelivery').getBoundingClientRect();
          return { x: Math.floor(r.x) - 2, y: Math.floor(r.y) - 2, width: Math.ceil(r.width) + 4, height: Math.ceil(r.height) + 4 }; })()`);
        await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        fs.writeFileSync(path.join(output, 'single-' + view + '.png'), (await win.webContents.capturePage(bounds)).toPNG());
        await clickDelivery('.ndelivery-heading button');
        await until('deliveryFixture.calls.filter(item => item[0] === "preview").length === ' + (view === 'active' ? 1 : 2));
      }
    }
    await run('deliveryFixture.render("reopened")');
    await clickDelivery('[data-delivery-reveal]');
    await until('deliveryFixture.calls.some(item => item[0] === "reveal")');
    await clickDelivery('[data-delivery-retry]');
    await until('deliveryFixture.calls.some(item => item[0] === "save")');
    assert.equal((await run('deliveryFixture.describe()'))[0].list, false, 'inspection or saving may not reintroduce a single-file list');
    const [multiple] = await run('deliveryFixture.render("multiple")');
    assert.equal(multiple.title, '成果包.zip');
    assert.ok(multiple.actions.includes('打开压缩包'));
    assert.equal(multiple.list, true);
    assert.deepEqual(multiple.exports.sort(), ['version:frozen', 'version:notes']);
    await clickDelivery('.ndelivery-actions [data-delivery-archive]');
    await until('deliveryFixture.calls.some(item => item[0] === "archive")');
    for (const [i, id] of multiple.exports.entries()) {
      await clickDelivery('[data-delivery-export-version="' + id + '"]');
      await until('deliveryFixture.calls.filter(item => item[0] === "export").length === ' + (i + 1));
    }
    assert.deepEqual(await run('deliveryFixture.calls'), [
      ['preview', 'version:frozen', 'message:1'], ['preview', 'version:frozen', 'message:1'],
      ['inspect', 'pi-history-card', ['version:frozen']],
      ['reveal', 'pi-history-card', ['version:frozen'], { bundle: false, revision: 'frozen-rev' }],
      ['prepare', 'pi-history-card', ['version:frozen']], ['save', 'frozen-rev'],
      ['inspect', 'pi-history-card', ['version:frozen', 'version:notes']],
      ['archive', 'pi-history-card', ['version:frozen', 'version:notes'], { bundle: true, revision: 'bundle-rev' }],
      ['export', 'pi-history-card', ['version:frozen']], ['export', 'pi-history-card', ['version:notes']],
    ]);
    for (const [view, owner, id] of [
      ['inferred', 'message:1', 'version:prior'], ['unassigned', 'session', 'version:prior'], ['unversioned', 'session', 'loose'],
    ]) {
      const expected = { ...card, owner, preview: id, actions: view === 'unversioned' ? [] : card.actions };
      assert.deepEqual(await run('deliveryFixture.render(' + JSON.stringify(view) + ')'), [expected], view);
      await clickDelivery('.ndelivery-heading button');
      await until('deliveryFixture.calls.at(-1)[0] === "preview" && deliveryFixture.calls.at(-1)[1] === ' + JSON.stringify(id) +
        ' && deliveryFixture.calls.at(-1)[2] === ' + JSON.stringify(owner));
    }
    report.cases.push({ switchedChatDelivery: 'single-file cards stay compact when live, reopened, and continued; title, folder and library buttons work; multi-file versions export individually' });
    const recovered = await run(`(() => {
      const ordinary = { artifactId: 'current-index', name: 'index.html', relative: 'index.html', size: 99,
        kind: 'website', title: 'New website', primary: true };
      const old = { ...ordinary, artifactId: 'version:old', originalArtifactId: ordinary.artifactId, versionId: 'old',
        title: 'Original website', changedInTurn: false, archivedReadOnly: true };
      function render(files, prefixMessageCount, extraOld = false) {
        const turn = id => [{ role: 'user', submissionId: id }, { role: 'assistant', done: true }];
        const messages = [...turn('old'), ...(extraOld ? turn('another-old') : []), ...turn('new')];
        const html = messages.map((m, i) => m.role === 'user' ? '<div class="nmsg user"></div>' :
          '<div class="nmsg ai" data-output-task="" data-chat-node="message:' + i + '" data-delivery-final="true" data-delivery-current="' +
          (i === messages.length - 1) + '"><div class="ntext nmd"><a href="index.html">Open page</a> <code>index.html</code></div></div>').join('');
        const snap = { status: 'idle', messages, historyRecovery: { mode: 'device-history', prefixMessageCount } };
        list.innerHTML = ChatOutputLinks.decorate(html, files, 'restored', snap);
        ChatOutputLinks.linkify(list, files, 'second pass', false, snap);
        return { replies: [...list.querySelectorAll('.nmsg.ai')].map(m => ({
          title: m.querySelector('.ndelivery-heading [data-open-app]')?.dataset.openApp || null,
          link: m.querySelector('.nmd button')?.dataset.openApp || null,
          scoped: ChatOutputLinks.scoped(m, files).map(f => f.artifactId),
        })), session: list.querySelector(':scope > .ndelivery [data-open-app]')?.dataset.openApp || null };
      }
      const inferred = { ...old, turnId: 'pi-archive:legacy' };
      const known = { ...old, turnId: 'pi-history:legacy', userMessageIndex: 0 };
      return { known: render([known, ordinary], 2), inferred: render([inferred, ordinary], 2),
        emptyWorkspace: render([inferred], 2), noOriginal: render([ordinary], 2), ambiguous: render([inferred, ordinary], 4, true) };
    })()`);
    const oldReply = { title: 'version:old', link: 'version:old', scoped: ['version:old'] };
    const unavailable = { title: null, link: null, scoped: [] };
    assert.deepEqual(recovered.known.replies[0], oldReply);
    assert.deepEqual(recovered.inferred.replies[0], oldReply);
    assert.deepEqual(recovered.emptyWorkspace.replies[0], oldReply);
    assert.deepEqual(recovered.noOriginal.replies[0], unavailable);
    assert.deepEqual(recovered.ambiguous.replies.slice(0, 2), [unavailable, unavailable]);
    assert.equal(recovered.ambiguous.session, 'version:old');
    for (const result of [recovered.known, recovered.inferred, recovered.noOriginal, recovered.ambiguous])
      assert.equal(result.replies.at(-1).link, 'current-index');
    report.cases.push({ restoredWorkspace: 'card and Markdown resolve to the original in an empty or same-name workspace; ambiguous files stay at session scope' });
    report.ok = true;
  }).catch(error => { report.error = error.stack || String(error); }).finally(() => {
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    if (win) win.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
