'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    {env, windowsHide: true, stdio: 'inherit'});
  const timer = setTimeout(() => child.kill(), 60000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const {app, BrowserWindow, ipcMain, nativeImage, session, net} = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict'), {pathToFileURL} = require('node:url');
  const client = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-history-preview-'));
  const out = path.resolve(process.argv[2] || path.join(client, '../outputs/local-start/bug-001-preview'));
  fs.mkdirSync(out, {recursive: true}); app.setPath('userData', path.join(temp, 'profile'));
  let win, copied;
  const report = {ok: false, cases: [], isolated: true, clipboard: 'captured at native writer; OS clipboard unchanged'};
  const js = code => win.webContents.executeJavaScript(code, true);
  const until = async code => {
    for (let i = 0; i < 100; i++) { if (await js(code)) return; await new Promise(r => setTimeout(r, 30)); }
    throw Error('Timed out: ' + code);
  };
  app.whenReady().then(async () => {
    const cwd = path.join(temp, 'project'), old = path.join(temp, 'work/temp/chat-original/.soduwork-inputs');
    fs.mkdirSync(cwd); fs.mkdirSync(old, {recursive: true});
    const image = nativeImage.createFromBitmap(Buffer.from([60, 120, 240, 255]), {width: 1, height: 1});
    const target = path.join(old, '历史截图.png'); fs.writeFileSync(target, image.toPNG());
    const contract = require('../main/pi-session/attachment-contract');
    const rows = contract.parse(contract.augment('历史消息', [{path: target, name: '历史截图.png', mimeType: 'image/png', size: image.toPNG().length}])).files;
    const handle = {cwd, snapshot: () => ({messages: [{role: 'user', attachments: rows}]})};
    require('../main/conversation/image-clipboard').writeImage = async value => { copied = value.toBitmap(); };
    require('../main/pi-session/artifact-ipc').install({app, ipcMain, BrowserWindow,
      workDir: () => path.join(temp, 'work'), session: {get: ref => ref === 'chat-reopened' ? handle : null}});
    const href = file => pathToFileURL(path.join(client, file)).href, desk = href('desk.html');
    const html = '<meta charset="utf-8"><link rel="stylesheet" href="' + href('theme/variables.css') + '">' +
      '<link rel="stylesheet" href="' + href('components/panels/conversation-attachments.css') + '">' +
      '<main id="messages"></main><script src="' + href('components/panels/conversation-attachments.js') + '"></script>';
    const isolated = session.fromPartition('history-preview-test');
    isolated.protocol.handle('file', request => request.url === desk
      ? new Response(html, {headers: {'content-type': 'text/html; charset=utf-8'}})
      : net.fetch(request, {bypassCustomProtocolHandlers: true}));
    win = new BrowserWindow({show: false, width: 900, height: 650, webPreferences: {
      session: isolated, preload: path.join(client, 'preload.js'), contextIsolation: true, nodeIntegration: false}});
    await win.loadURL(desk);
    await js(`window.options={ref:'chat-reopened',api:soduWorkAPI.conversationSession};messages.innerHTML=ConversationAttachments.messageHtml(${JSON.stringify(rows)});
      ConversationAttachments.hydrateMessageImages(messages,options);void 0;`);
    await until('Boolean(messages.querySelector("img")?.naturalWidth)');
    report.cases.push('historical message thumbnail loads under a new runtime ref');
    await js('ConversationAttachments.openMessageImage(messages.querySelector("[data-catt-message-image]"),options)');
    await until('Boolean(document.querySelector(".catt-preview-body img")?.naturalWidth)');
    await js('document.querySelector("[data-catt-preview-copy]").click()');
    await until('document.querySelector("[data-catt-preview-copy] span").textContent === "已复制"');
    assert.deepEqual(copied, image.toBitmap());
    report.cases.push('full-size preview and copy use the original historical image bytes');
    const other = path.join(old, '其他会话.png'); fs.writeFileSync(other, image.toPNG());
    const denied = await js(`options.api.attachmentImage('chat-reopened',${JSON.stringify(contract.previewRef(other))},'full')`);
    assert.equal(denied.ok, false); report.cases.push('unrecorded image in the same old folder remains denied');
    await new Promise(resolve => setTimeout(resolve, 150));
    fs.writeFileSync(path.join(out, 'preview.png'), (await win.webContents.capturePage()).toPNG());
    report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); }).finally(() => {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); win?.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
