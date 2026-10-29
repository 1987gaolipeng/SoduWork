'use strict';
// Real Chromium media decoding and production Markdown/patch modules. No model,
// user profile, business API or production storage is accessed.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 90000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, WebContentsView, ipcMain, nativeImage } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
  const { pathToFileURL } = require('node:url');
  const assert = require('node:assert/strict');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-chat-media-'));
  const output = path.resolve(process.argv[2] || path.join(__dirname, '../../outputs/chat-media'));
  const client = path.resolve(__dirname, '..');
  const report = { ok: false, cases: [], isolatedProfile: true, realModel: false, businessWrites: false };
  app.setPath('userData', path.join(scratch, 'profile'));
  let win, server, fail = true;
  const views = [];
  const downloads = [];
  const run = source => win.webContents.executeJavaScript(source, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(source) { for (let i = 0; i < 120; i++) { if (await run(source)) return; await delay(50); } throw Error('Timeout: ' + source); }
  async function check(name, body) { await body(); report.cases.push(name); console.log('PASS ' + name); }
  app.whenReady().then(async () => {
    const watchDownloads = session => session.on('will-download', (event, item) => { downloads.push(item.getURL()); event.preventDefault(); });
    watchDownloads(electron.session.defaultSession);
    require('../main/work-preview').install({ ipcMain, BrowserWindow,
      WebContentsView: function (options) { const view = new WebContentsView(options); views.push(view); watchDownloads(view.webContents.session); return view; },
      shell: { openExternal: async () => { throw Error('Media must stay in the right workspace'); } } });
    fs.mkdirSync(output, { recursive: true });
    const clip = path.join(scratch, 'clip.mp4');
    const result = require('node:child_process').spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=24', '-t', '0.7', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', clip], { windowsHide: true, timeout: 20000 });
    assert.equal(result.status, 0, String(result.stderr || result.error));
    const video = fs.readFileSync(clip);
    const portraitClip = path.join(scratch, 'portrait.mp4');
    const portraitResult = require('node:child_process').spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x640:r=24', '-t', '0.7', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', portraitClip], { windowsHide: true, timeout: 20000 });
    assert.equal(portraitResult.status, 0, String(portraitResult.stderr || portraitResult.error));
    const portraitVideo = fs.readFileSync(portraitClip);
    const png = (w, h) => {
      const pixels = Buffer.alloc(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const rgb = x < w / 3 ? [234, 161, 109] : x < w * 2 / 3 ? [105, 162, 157] : [106, 139, 186];
        pixels[i] = rgb[2]; pixels[i + 1] = rgb[1]; pixels[i + 2] = rgb[0]; pixels[i + 3] = 255;
      }
      return nativeImage.createFromBitmap(pixels, { width: w, height: h }).toPNG();
    };
    const wide = png(1200, 400), tall = png(400, 1200), small = png(48, 32);
    server = http.createServer((request, response) => {
      if (request.url === '/page') { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Ordinary browser</title><h1>Ordinary browser</h1>'); return; }
      if (request.url.startsWith('/broken') && fail) { response.writeHead(404, { 'Cache-Control': 'no-store' }).end(); return; }
      const bytes = request.url.startsWith('/video-portrait') ? portraitVideo : request.url.startsWith('/video') ? video : request.url.startsWith('/tall') ? tall : request.url.startsWith('/small') ? small : wide;
      const send = () => {
        if (response.destroyed) return;
        const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range || '');
        const start = range ? Number(range[1]) : 0, end = range && range[2] ? Number(range[2]) : bytes.length - 1;
        response.writeHead(range ? 206 : 200, { 'Content-Type': request.url.startsWith('/video') ? 'video/mp4' : 'image/png',
          'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
          'Content-Disposition': 'attachment',
          ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) });
        response.end(bytes.subarray(start, end + 1));
      };
      if (request.url.startsWith('/slow')) setTimeout(send, 600); else send();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const html = path.join(scratch, 'fixture.html');
    fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><style>body{padding:20px;margin:0}#list{width:600px;max-width:100%;height:650px;overflow:auto}.nmsg{display:block!important}.ntext{min-width:0}</style><div id="list"></div>');
    win = new BrowserWindow({ show: false, width: 920, height: 800, webPreferences: { offscreen: true, preload: path.join(client, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await win.loadFile(html);
    for (const file of ['theme/variables.css', 'components/panels/panels-chat.css', 'components/panels/chat-media.css']) {
      await run(`new Promise(resolve=>{const link=document.createElement('link');link.rel='stylesheet';link.href=${JSON.stringify(pathToFileURL(path.join(client, file)).href)};link.onload=resolve;document.head.append(link)})`);
    }
    for (const file of ['vendor/markdown/purify.min.js', 'vendor/markdown/marked.umd.js', 'components/panels/chat-media.js', 'components/panels/chat-output-links.js', 'components/panels/chat-markdown.js', 'components/panels/chat-dom-patch.js']) {
      await run(fs.readFileSync(path.join(client, file), 'utf8') + '\nvoid 0;');
    }
    await run(`window.ctx={_ref:'media-a',esc:s=>String(s),_liveTextKey:'1:0'};window.md=ChatMarkdown.create(ctx,()=>{});
      window.list=document.getElementById('list');window.paint=source=>{ChatDomPatch.patchList(list,'<div class="nmsg ai" data-chat-node="message:1" data-message-owner="1"><div class="ntext">'+md.rich(source)+'</div></div>');ChatMedia.hydrate(list)};void 0;`);
    const block = (type, items) => '```soduwork-media\n' + JSON.stringify({ type, items }) + '\n```';
    const image = (name, title = name) => ({ url: origin + '/' + name, title });
    const show = source => run('paint(' + JSON.stringify(source) + ');void 0;');
    await check('ordinary links, Markdown tracking images and raw video stay inert', async () => {
      await show(`[ordinary](${origin}/wide)\n\n![tracking](${origin}/tracking)\n\n<video autoplay src="${origin}/video"></video>`);
      assert.equal(await run('list.querySelectorAll("img[src],video[src]").length'), 0);
      assert.equal(await run('list.querySelectorAll("a[href]").length'), 1);
    });
    await check('single landscape and portrait images stay complete within 360x280px and have 6px corners', async () => {
      for (const name of ['wide', 'tall', 'small']) {
        await show(block('image', [image(name)]));
        await until('list.querySelector(".nmedia-item")?.dataset.mediaState==="ready"');
        const size = await run(`(()=>{const n=list.querySelector('img'),r=n.getBoundingClientRect(),s=getComputedStyle(n),frame=n.parentElement,f=frame.getBoundingClientRect();return {w:r.width,h:r.height,ratio:n.naturalWidth/n.naturalHeight,fit:s.objectFit,radius:s.borderRadius,frameW:f.width,frameH:f.height,bg:getComputedStyle(frame).backgroundColor}})()`);
        assert(size.w <= 360 && size.h <= 280, JSON.stringify(size)); assert(Math.abs(size.w / size.h - size.ratio) < 0.01, JSON.stringify(size));
        assert.equal(size.fit, 'contain'); assert.equal(size.radius, '6px');
        assert.equal(size.bg, 'rgba(0, 0, 0, 0)');
        assert(Math.abs(size.frameW - size.w) < 1 && Math.abs(size.frameH - size.h) < 1, JSON.stringify(size));
        if (name === 'small') assert.deepEqual([size.w, size.h], [48, 32]);
        assert.equal(await run('list.querySelectorAll(".nmedia-original,figcaption").length'), 0);
        fs.writeFileSync(path.join(output, 'single-' + name + '.png'), (await win.webContents.capturePage()).toPNG());
      }
    });
    await check('gray placeholder reserves space until image decode, then retry recovers a failed link', async () => {
      await show(block('image', [image('slow')]));
      const before = await run(`(()=>{const n=list.querySelector('.nmedia-frame'),r=n.getBoundingClientRect();return {h:r.height,w:r.width,bg:getComputedStyle(n).backgroundColor,state:n.parentElement.dataset.mediaState}})()`);
      assert(before.h >= 160 && before.w > 0); assert.notEqual(before.bg, 'rgba(0, 0, 0, 0)');
      await until('list.querySelector(".nmedia-item").dataset.mediaState==="ready"');
      await show(block('image', [image('broken')]));
      await until('list.querySelector(".nmedia-item").dataset.mediaState==="error"');
      fail = false; await run('list.querySelector(".nmedia-retry").click();void 0;');
      await until('list.querySelector(".nmedia-item").dataset.mediaState==="ready"');
    });
    await check('2/3/4/9/10 images use exactly three equal square columns without filling missing slots', async () => {
      for (const count of [2, 3, 4, 9, 10]) {
        await show(block('gallery', Array.from({ length: count }, (_, i) => image('wide?i=' + i))));
        await until('list.querySelectorAll("[data-media-state=ready]").length===' + count);
        const state = await run(`(()=>{const g=list.querySelector('.nmedia-grid');return {columns:getComputedStyle(g).gridTemplateColumns.split(' ').length,rects:[...g.querySelectorAll('.nmedia-frame')].map(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}}),fits:[...g.querySelectorAll('img')].map(n=>getComputedStyle(n).objectFit)}})()`);
        assert.equal(state.columns, 3); assert.equal(state.rects.length, count);
        assert(state.rects.every(r => Math.abs(r.w - r.h) < 1 && Math.abs(r.w - state.rects[0].w) < 1));
        assert(state.fits.every(value => value === 'cover'));
        if (count > 3) assert(state.rects[3].y > state.rects[0].y);
      }
      await delay(200);
      fs.writeFileSync(path.join(output, 'gallery-light.png'), (await win.webContents.capturePage()).toPNG());
      await run('list.style.width="260px";void 0;');
      assert(await run('list.scrollWidth<=list.clientWidth+1'));
      assert.equal(await run('getComputedStyle(list.querySelector(".nmedia-grid")).gridTemplateColumns.split(" ").length'), 3);
      await delay(200);
      fs.writeFileSync(path.join(output, 'gallery-narrow.png'), (await win.webContents.capturePage()).toPNG());
      await run('document.body.style.cssText="background:#181818;--bg-0:#181818;--bg-2:#333;--ink-3:#bbb";void 0;');
      await delay(200);
      fs.writeFileSync(path.join(output, 'gallery-dark.png'), (await win.webContents.capturePage()).toPNG());
      await run('document.body.removeAttribute("style");void 0;');
      await run('list.style.width="600px";void 0;');
    });
    await check('separate groups and signed URLs remain ordered; invalid media falls back to readable code', async () => {
      await show(block('gallery', [image('wide?signature=1'), image('wide?signature=2')]) + '\n\nOther group\n\n' + block('image', [image('tall')]));
      assert.equal(await run('list.querySelectorAll(".nmedia-group").length'), 2);
      await show(block('image', [{ url: 'javascript:alert(1)' }]));
      assert.equal(await run('list.querySelectorAll(".nmedia-group").length'), 0);
      assert(await run('list.textContent.includes("javascript:")'));
    });
    await check('sidebar inline media and extra JSON escaping render while surrounding prose and ordinary code stay intact', async () => {
      const payload = JSON.stringify({ type: 'video', items: [image('video?sidebar=1')] });
      for (const value of [payload, payload.replaceAll('"', '\\"')]) {
        await show('Before `soduwork-media ' + value + '` after.');
        await until('list.querySelector("video")?.readyState>=2');
        assert.equal(await run('list.querySelectorAll(".nmedia-group").length'), 1);
        assert(await run('list.textContent.includes("Before") && list.textContent.includes("after.")'));
        assert.equal(await run('list.querySelectorAll("p .nmedia-group").length'), 0);
        assert(await run('list.querySelector(".nmedia-video").getBoundingClientRect().width<=360.1'));
      }
      await show('```javascript\nsoduwork-media ' + payload + '\n```');
      assert.equal(await run('list.querySelectorAll(".nmedia-group").length'), 0);
      await show('`soduwork-media {"type":"video","items":[{"url":"file:///private.mp4"}]}`');
      assert.equal(await run('list.querySelectorAll(".nmedia-group").length'), 0);
    });
    await check('real video decodes, autoplays muted and loops without native controls or rounded corners', async () => {
      await show(block('video', [image('video?signature=1')]));
      await until('list.querySelector("video")?.readyState>=2 && !list.querySelector("video").paused');
      const state = await run(`(()=>{const v=list.querySelector('video');return {muted:v.muted,loop:v.loop,controls:v.controls,radius:getComputedStyle(v).borderRadius,frame:getComputedStyle(v.parentElement).borderRadius}})()`);
      assert.deepEqual(state, { muted: true, loop: true, controls: false, radius: '0px', frame: '0px' });
      assert(await run('list.querySelector(".nmedia-video").getBoundingClientRect().width<=360.1'));
      assert.equal(await run('list.querySelectorAll("a,figcaption").length'), 0);
      await delay(1800); assert.equal(await run('list.querySelector("video").ended'), false);
      fs.writeFileSync(path.join(output, 'video.png'), (await win.webContents.capturePage()).toPNG());
    });
    await check('text repaint retains the playing element; offscreen and switched conversations pause it', async () => {
      const source = block('video', [image('video?signature=1')]);
      await run('window.originalVideo=list.querySelector("video");void 0;');
      await show(source + '\n\nNew prose');
      assert.equal(await run('list.querySelector("video")===originalVideo'), true);
      await run(`(()=>{const text=list.querySelector('.ntext'),next=text.cloneNode(false);next.innerHTML=md.rich(${JSON.stringify(source + '\n\nStreaming prose')});md._patchStreamNode(text,next);ChatMedia.hydrate(list)})();void 0;`);
      assert.equal(await run('list.querySelector("video")===originalVideo'), true);
      await run('list.style.marginTop="1000px";void 0;'); await until('originalVideo.paused');
      await run('list.style.marginTop="0";void 0;'); await until('!originalVideo.paused');
      await run('ctx._ref="media-b";void 0;'); await show(source);
      assert.equal(await run('list.querySelector("video")===originalVideo'), false);
      await until('originalVideo.paused');
      await show('Another conversation'); assert.equal(await run('list.querySelectorAll("video").length'), 0);
    });
    await check('landscape and portrait video frames fit the original ratio without upscaling or gray gutters', async () => {
      for (const name of ['video', 'video-portrait']) {
        await show(block('video', [image(name)]));
        await until('list.querySelector("video")?.readyState>=2');
        const size = await run(`(()=>{const v=list.querySelector('video'),r=v.getBoundingClientRect(),f=v.parentElement.getBoundingClientRect();return {w:r.width,h:r.height,frameW:f.width,frameH:f.height,naturalW:v.videoWidth,naturalH:v.videoHeight,bg:getComputedStyle(v.parentElement).backgroundColor}})()`);
        assert(size.w <= 360 && size.h <= 280 && size.w <= size.naturalW && size.h <= size.naturalH, JSON.stringify(size));
        assert(Math.abs(size.w / size.h - size.naturalW / size.naturalH) < 0.01, JSON.stringify(size));
        assert(Math.abs(size.w - size.frameW) < 1 && Math.abs(size.h - size.frameH) < 1, JSON.stringify(size));
        assert.equal(size.bg, 'rgba(0, 0, 0, 0)');
      }
    });
    await check('trusted local image outputs now load inline using the existing preview API', async () => {
      await run(`window.files=[{artifactId:'local-image',name:'result.png',relative:'result.png',changedInTurn:true,primary:true}];
        list.innerHTML=ChatOutputLinks.decorate('<div class="nmsg ai" data-delivery-final="true"><div class="ntext">result.png</div></div>',files,'local');
        ChatOutputLinks.hydrateImages(list,files,{ref:'local',api:{artifactAction:async()=>({ok:true,mimeType:'image/png',data:${JSON.stringify(wide.toString('base64'))}})}});void 0;`);
      await until('list.querySelector(".nmedia-item")?.dataset.mediaState==="ready"');
      assert.equal(await run('list.querySelector("img").naturalWidth'), 1200);
      assert.equal(await run('list.querySelectorAll(".noutput-image-caption").length'), 0);
      const local = await run(`(()=>{const img=list.querySelector('img'),frame=img.parentElement;return {w:img.getBoundingClientRect().width,frameW:frame.getBoundingClientRect().width,bg:getComputedStyle(frame).backgroundColor}})()`);
      assert.equal(local.bg, 'rgba(0, 0, 0, 0)'); assert(Math.abs(local.w - local.frameW) < 1, JSON.stringify(local));
    });
    await check('trusted video output uses the same silent looping player and retains it on decoration repaint', async () => {
      await run(`window.files=[{artifactId:'local-video',name:'result.mp4',relative:'result.mp4',changedInTurn:true,primary:true}];
        window.localPaint=()=>{ChatDomPatch.patchList(list,ChatOutputLinks.decorate('<div class="nmsg ai" data-chat-node="message:1" data-message-owner="1" data-delivery-final="true"><div class="ntext">result.mp4</div></div>',files,'local'));
        ChatOutputLinks.hydrateVideos(list,files,{ref:'local',api:{artifactAction:async()=>({ok:true,url:${JSON.stringify(origin + '/video')}})}})};localPaint();void 0;`);
      await until('list.querySelector("video")?.readyState>=2 && !list.querySelector("video").paused');
      assert.equal(await run('list.querySelector("video").controls'), false);
      assert(await run('list.querySelector("[data-output-video]").getBoundingClientRect().width<=360.1'));
      assert.equal(await run('window.priorLocalVideo=list.querySelector("video");localPaint();list.querySelector("video")===priorLocalVideo'), true);
    });
    await check('late authorized local media replies cannot enter a different account or output version', async () => {
      for (const kind of ['image', 'video']) {
        const name = kind === 'image' ? 'private.png' : 'private.mp4';
        for (const boundary of ['account', 'version']) {
          await run(`window.ownerScope='account-a';window.SoduWorkAPI={taskStorageKey:()=>ownerScope};window.finishPreview=null;
            window.files=[{artifactId:${JSON.stringify(kind + '-' + boundary)},name:${JSON.stringify(name)},relative:${JSON.stringify(name)},changedInTurn:true,primary:true,at:1}];
            list.innerHTML=ChatOutputLinks.decorate('<div class="nmsg ai" data-delivery-final="true"><div class="ntext">${name}</div></div>',files,'boundary');
            ChatOutputLinks.${kind === 'image' ? 'hydrateImages' : 'hydrateVideos'}(list,files,{ref:'boundary',api:{artifactAction:()=>new Promise(resolve=>window.finishPreview=resolve)}});void 0;`);
          await until('typeof finishPreview==="function"');
          await run(boundary === 'account' ? 'ownerScope="account-b";void 0;' : 'list.querySelector("[data-output-version]").dataset.outputVersion="2";void 0;');
          await run(`finishPreview(${JSON.stringify(kind === 'image' ? { ok: true, mimeType: 'image/png', data: wide.toString('base64') } : { ok: true, url: origin + '/video' })});void 0;`);
          await until('list.querySelector(".nmedia-item").dataset.mediaState==="error"');
          assert.equal(await run('list.querySelector("img,video").hasAttribute("src")'), false);
        }
      }
      await run('delete window.SoduWorkAPI;void 0;');
    });
    await check('COS-style attachment responses render in right media tabs without navigation, downloads or popups', async () => {
      await run(`new Promise(resolve=>{const link=document.createElement('link');link.rel='stylesheet';link.href=${JSON.stringify(pathToFileURL(path.join(client, 'components/panels/code-workbench.css')).href)};link.onload=resolve;document.head.append(link)})`);
      for (const file of ['panels-chat-tools.js', 'chat-workspace-info.js', 'chat-workspace-split.js', 'chat-workspace-controls.js', 'panels-chat-workspace.js']) {
        await run(fs.readFileSync(path.join(client, 'components/panels', file), 'utf8') + '\nvoid 0;');
      }
      await run(`document.body.innerHTML='<main class="nchat" id="chat"><div class="nchat-stage"><section class="nchat-main" id="list"></section></div></main>';
        document.head.insertAdjacentHTML('beforeend','<style>.nchat{height:100vh}.nchat-stage{display:flex;height:100%}.nchat-main{flex:1;min-width:0}</style>');
        window.list=document.getElementById('list');ChatWorkbench.bind(document.getElementById('chat'),()=>({ref:ctx._ref}));void 0;`);
      for (const [type, names, key] of [['image', ['tall?signature=full%2Fimage'], null], ['gallery', ['wide?index=0', 'wide?signature=group%2Fimage'], 'Enter'], ['video', ['video?signature=full%2Fvideo'], ' ']]) {
        const items = names.map(name => image(name)), target = items.at(-1).url;
        await show(block(type, items));
        await until('list.querySelectorAll("[data-media-state=ready]").length===' + items.length);
        await run(`(()=>{const media=[...list.querySelectorAll('img,video')].at(-1);${key ? 'media.dispatchEvent(new KeyboardEvent("keydown",{key:' + JSON.stringify(key) + ',bubbles:true,cancelable:true}))' : 'media.click()'};})();void 0;`);
        await until('document.querySelector("[data-wb-remote-media]")?.dataset.mediaState==="ready"');
        assert.equal(await run('document.querySelector("[data-wb-remote-media] img,[data-wb-remote-media] video").currentSrc'), target);
        assert.equal(await run('ChatWorkbench.state().open'), true);
        assert.equal(await run('document.querySelectorAll("dialog").length'), 0);
        assert.equal(await run('document.querySelector("[data-wb-address]").value'), decodeURI(target));
        fs.writeFileSync(path.join(output, 'right-' + type + '.png'), (await win.webContents.capturePage()).toPNG());
        if (type === 'video') {
          const player = await run('(()=>{const v=document.querySelector("[data-wb-remote-media] video");return {muted:v.muted,loop:v.loop,controls:v.controls,autoplay:v.autoplay}})()');
          assert.deepEqual(player, { muted: false, loop: false, controls: true, autoplay: false });
          assert.equal(await run('getComputedStyle(document.querySelector("[data-wb-remote-media] video")).borderRadius'), '0px');
          await run('window.rightVideo=document.querySelector("[data-wb-remote-media] video");ChatWorkbench.render(chat,{messages:[]},[]);void 0;');
          assert.equal(await run('document.querySelector("[data-wb-remote-media] video")===rightVideo'), true);
          await run('rightVideo.play();void 0;');
          await until('!rightVideo.paused');
          await run('document.querySelector("[data-wb-close]").click();void 0;');
          await until('rightVideo.paused');
        }
      }
      assert.equal(await run('document.querySelectorAll("[data-wb-tab]").length'), 3);
      assert.equal(views.length, 0); assert.deepEqual(downloads, []);
      fail = true;
      await run(`ChatWorkbench.openLink(${JSON.stringify(origin + '/broken?right=1')},{mediaType:'image'});void 0;`);
      await until('document.querySelector("[data-wb-remote-media]")?.dataset.mediaState==="error"');
      assert.equal(await run('document.querySelector("[data-wb-media-error]").hidden'), false);
      fail = false;
      await run('document.querySelector("[data-wb-media-error] button").click();void 0;');
      await until('document.querySelector("[data-wb-remote-media]")?.dataset.mediaState==="ready"');
      assert.deepEqual(downloads, []);
      fs.writeFileSync(path.join(output, 'right-media.png'), (await win.webContents.capturePage()).toPNG());
      await run(`ChatWorkbench.openLink(${JSON.stringify(origin + '/page')});void 0;`);
      for (let i = 0; i < 120 && !views.some(v => v.webContents.getTitle() === 'Ordinary browser'); i++) await delay(50);
      assert(views.some(v => v.webContents.getTitle() === 'Ordinary browser'));
      assert.equal(await run('document.querySelectorAll("[data-wb-remote-media]").length'), 0);
      assert.deepEqual(downloads, []);
    });
    report.ok = true;
  }).catch(async error => { report.error = error.stack || String(error); report.debug = await run('({body:document.querySelector(".ncw-body")?.innerHTML,media:[...document.querySelectorAll("[data-wb-remote-media] img,[data-wb-remote-media] video")].map(n=>({src:n.src,ready:n.readyState,complete:n.complete,naturalWidth:n.naturalWidth,error:n.error?.code})),workbench:window.ChatWorkbench?.state()})').catch(() => null); }).finally(() => {
    fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); if (win) win.destroy(); if (server) server.close(); app.exit(report.ok ? 0 : 1);
  });
}
