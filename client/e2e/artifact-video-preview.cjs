'use strict';

// Real encoded media, production artifact IPC/HTTP, and Chromium playback. No Hub or model is used.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const electron = require('electron');
const evidence = path.resolve(process.argv[2] || path.join(__dirname, '../../outputs/issue-229/video-preview'));

if (typeof electron === 'string') {
  const { spawn } = require('node:child_process');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-video-preview-'));
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify({ ok: false, phase: 'launching' }, null, 2));
  const env = { ...process.env, SODUWORK_VIDEO_TEST_ROOT: temporary };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = spawn(electron, [__filename, evidence], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
    log.push(bytes.toString()); process.stdout.write(bytes);
  });
  let failed = false;
  child.once('error', error => { failed = true; log.push(error.stack); });
  const timer = setTimeout(() => {
    failed = true; log.push('Electron media regression exceeded 90 seconds.');
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else child.kill('SIGKILL');
  }, 90000);
  child.once('close', code => {
    clearTimeout(timer);
    fs.writeFileSync(path.join(evidence, 'process.log'), log.join(''));
    // Only remove this invocation's generated directory, after its Electron process has closed.
    assert.equal(fs.realpathSync(path.dirname(temporary)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('soduwork-video-preview-'));
    try { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); }
    catch (error) { failed = true; console.error('Temporary profile cleanup failed:', error.message); }
    process.exitCode = failed || code !== 0 ? 1 : 0;
  });
} else {
  run().catch(error => { console.error(error); electron.app.exit(1); });
}

async function run() {
  const { app, BrowserWindow, ipcMain } = electron;
  const temporary = process.env.SODUWORK_VIDEO_TEST_ROOT;
  assert.ok(temporary && path.basename(temporary).startsWith('soduwork-video-preview-'));
  app.setPath('userData', path.join(temporary, 'profile'));
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.on('window-all-closed', () => {});
  const work = path.join(temporary, 'work'); fs.mkdirSync(work);
  const report = {
    ok: false, platform: process.platform, electron: process.versions.electron,
    chromium: process.versions.chrome, packaged: app.isPackaged, requests: [], checks: [],
    boundary: 'Isolated Electron with production preload, artifact IPC, preview HTTP and ChatMedia video construction. ' +
      'Synthetic VP8 WebM is actually encoded, decoded, played and sought. No installed client, mouse interaction, MP4 codec or real user video is verified.',
  };
  let win, runtime;
  try {
    await app.whenReady();
    win = new BrowserWindow({ show: false, width: 840, height: 560,
      webPreferences: { preload: path.resolve(__dirname, '../preload.js'), nodeIntegration: false,
        contextIsolation: true, backgroundThrottling: false, offscreen: true } });
    win.webContents.on('render-process-gone', (_event, details) => { report.rendererExit = details; });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<!doctype html><meta charset="utf-8"><title>Isolated video preview regression</title>' +
      '<style>body{margin:32px;background:#182334;color:white;font:18px Segoe UI,sans-serif}' +
      'video{width:720px;height:405px;background:#000}figure{margin:0}.nmedia-status,.nmedia-retry{display:none}</style>' +
      '<h1>Artifact video preview</h1><main id="preview"></main>'));
    const evaluate = source => win.webContents.executeJavaScript(source);
    const generated = await evaluate(`(async () => {
      const mime = ['video/webm;codecs=vp8', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
      if (!mime) throw Error('This Chromium build cannot encode WebM');
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const context = canvas.getContext('2d'), stream = canvas.captureStream(20);
      const chunks = [], recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 350000 });
      const stopped = new Promise((resolve, reject) => {
        recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
        recorder.onstop = resolve; recorder.onerror = event => reject(Error(event.error?.message || 'Encoding failed'));
      });
      let frame = 0;
      const draw = () => {
        context.fillStyle = 'hsl(' + (frame * 7 % 360) + ' 70% 35%)'; context.fillRect(0, 0, 320, 180);
        context.fillStyle = '#fff'; context.font = '24px sans-serif'; context.fillText('SoduWork test ' + frame, 25, 65);
        context.fillRect(frame * 5 % 280, 110, 40, 25); frame++;
      };
      draw(); recorder.start(); const timer = setInterval(draw, 50);
      await new Promise(resolve => setTimeout(resolve, 4000));
      clearInterval(timer); recorder.stop(); await stopped; stream.getTracks().forEach(track => track.stop());
      const blob = new Blob(chunks, { type: mime });
      return { mime, drawnFrames: frame, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) };
    })()`);
    const bytes = Buffer.from(generated.bytes);
    assert.equal(bytes.subarray(0, 4).toString('hex'), '1a45dfa3', 'The fixture is a real EBML/WebM file');
    assert.ok(bytes.length > 2048, 'The encoded fixture has enough bytes for a meaningful suffix request');
    const filePath = path.join(work, 'synthetic.webm'); fs.writeFileSync(filePath, bytes);
    fs.writeFileSync(path.join(evidence, 'synthetic.webm'), bytes);
    report.fixture = { mime: generated.mime, size: bytes.length, drawnFrames: generated.drawnFrames };
    const file = { artifactId: 'encoded-video', path: filePath, relative: 'synthetic.webm', name: 'synthetic.webm',
      kind: 'video', preview: true, at: fs.statSync(filePath).mtimeMs, primary: true, size: bytes.length };
    const handle = { cwd: work, sessionId: 'isolated-video', snapshot: () => ({ messages: [] }),
      outputSnapshot: () => ({ files: [file], delivery: { source: 'manifest', items: [file] } }) };
    const ref = 'isolated-video';
    require('../main/pi-session/artifact-ipc').install({ app, ipcMain, BrowserWindow,
      session: { get: id => id === ref ? handle : null }, workDir: () => path.join(temporary, 'managed') });
    runtime = require('../main/conversation/artifact-runtime');
    const preview = await evaluate(`soduWorkAPI.conversationSession.artifactAction(${JSON.stringify(ref)}, 'encoded-video', 'preview')`);
    assert.equal(preview.ok, true, preview.reason);
    assert.equal(new URL(preview.url).hostname, '127.0.0.1');
    report.checks.push('Production preload and artifact IPC resolve the real video to an isolated HTTP preview');

    const filter = { urls: [new URL(preview.url).origin + '/*'] };
    const records = new Map();
    win.webContents.session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      const entry = { id: details.id, path: new URL(details.url).pathname, type: details.resourceType,
        range: details.requestHeaders.Range || details.requestHeaders.range || '' };
      records.set(details.id, entry); report.requests.push(entry);
      callback({ requestHeaders: details.requestHeaders });
    });
    win.webContents.session.webRequest.onHeadersReceived(filter, (details, callback) => {
      const entry = records.get(details.id);
      if (entry) {
        entry.status = details.statusCode;
        const headers = Object.fromEntries(Object.entries(details.responseHeaders).map(([key, value]) => [key.toLowerCase(), value]));
        entry.contentRange = headers['content-range']?.[0] || '';
      }
      callback({ responseHeaders: details.responseHeaders });
    });
    // Exercise the problematic suffix form against the same real file; do not depend on Chromium choosing it.
    const suffix = await request(preview.url, 'bytes=-1024');
    report.suffix = { requestRange: 'bytes=-1024', status: suffix.status, contentRange: suffix.range,
      bodyLength: suffix.body.length, bytesMatch: suffix.body.equals(bytes.subarray(-1024)) };

    await evaluate(fs.readFileSync(path.resolve(__dirname, '../components/panels/chat-media.js'), 'utf8'));
    await evaluate(`(() => {
      const figure = ChatMedia.card(document, 'video', 'Synthetic video'); document.querySelector('#preview').append(figure);
      const video = window.video = figure.querySelector('video');
      video.autoplay = false; video.loop = false; video.controls = true;
      window.frameCount = 0; window.mediaEvents = [];
      for (const type of ['loadedmetadata', 'loadeddata', 'playing', 'pause', 'seeking', 'seeked', 'ended', 'error'])
        video.addEventListener(type, () => mediaEvents.push({ type, time: video.currentTime, error: video.error?.code || 0 }));
      const frame = () => { frameCount++; video.requestVideoFrameCallback(frame); };
      video.requestVideoFrameCallback(frame); video.src = ${JSON.stringify(preview.url)};
    })()`);
    await until(evaluate, 'video.readyState >= 2 && video.videoWidth === 320', 'Video metadata and decoded frame');
    report.metadata = await evaluate('({width:video.videoWidth,height:video.videoHeight,duration:String(video.duration),readyState:video.readyState})');
    await evaluate('video.play()');
    await until(evaluate, 'video.currentTime >= 0.65 && frameCount >= 5', 'Video playback advances and presents decoded frames');
    await evaluate('video.pause()');
    report.playback = await evaluate('({time:video.currentTime,frames:frameCount,decoded:video.getVideoPlaybackQuality().totalVideoFrames})');
    await evaluate('video.currentTime = 2.1');
    await until(evaluate, '!video.seeking && Math.abs(video.currentTime - 2.1) < 0.15 && mediaEvents.some(event => event.type === "seeked")', 'Seeking to a different frame');
    report.seek = await evaluate('({time:video.currentTime,frames:frameCount})');
    await evaluate('video.play()');
    await until(evaluate, `video.currentTime >= 2.5 && frameCount > ${report.playback.frames}`, 'Playback resumes after seeking');
    await evaluate('video.pause()');
    report.afterSeek = await evaluate('({time:video.currentTime,frames:frameCount,decoded:video.getVideoPlaybackQuality().totalVideoFrames,events:mediaEvents})');
    assert.ok(report.requests.some(entry => entry.type === 'media' && entry.range && entry.status === 206),
      'Chromium must consume a real partial HTTP media response');
    report.checks.push('Actual WebM metadata, advancing decoded frames, seek to 2.1 s, and resumed playback');
    fs.writeFileSync(path.join(evidence, 'video-after-seek.png'), (await win.webContents.capturePage()).toPNG());
    assert.equal(suffix.status, 206, 'A suffix range must be satisfiable');
    assert.equal(suffix.range, `bytes ${bytes.length - 1024}-${bytes.length - 1}/${bytes.length}`);
    assert.ok(report.suffix.bytesMatch, 'The suffix response must contain exactly the final 1024 video bytes');
    report.checks.push('Suffix bytes=-1024 returns HTTP 206 and the exact encoded video tail');
    report.ok = true;
  } catch (error) {
    report.error = error.stack || String(error);
  } finally {
    runtime?.closeAll();
    if (win && !win.isDestroyed()) win.destroy();
    fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    app.exit(report.ok ? 0 : 1);
  }
}

async function until(evaluate, condition, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const state = await evaluate(`({ok:Boolean(${condition}),error:window.video?.error?.message || ''})`);
    if (state.error) throw Error(`${label}: ${state.error}`);
    if (state.ok) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error(`Timed out: ${label}`);
}

function request(url, range) {
  return new Promise((resolve, reject) => {
    const req = require('node:http').get(url, { headers: { Range: range } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => resolve({ status: response.statusCode, range: response.headers['content-range'], body: Buffer.concat(chunks) }));
      response.once('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(Error('HTTP range request timed out')));
    req.once('error', reject);
  });
}
