'use strict';
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
app.setPath('userData', require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'soduwork-long-chat-')));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, 'fixtures/long-conversation.html'));
    const js = value => win.webContents.executeJavaScript(value);
    await js('fill(2000)');
    const first = await js('draw()');
    assert.equal(first.total, 2000); assert.equal(first.messages, 80); assert.equal(first.parses, 40);
    assert.equal(first.older, true);
    const next = await js('ctx._snap=JSON.parse(JSON.stringify(ctx._snap));ctx._snap.messages.at(-1).blocks[0].text+="新增";draw()');
    assert.equal(next.parses, 1); assert.equal(next.messages, 80);
    const older = await js('ctx._messageWindowSize+=80;draw()');
    assert.equal(older.messages, 160); assert.equal(older.first, 'message:1840');
    await js('ctx._messageWindowSize=3000');
    const full = await js('draw()');
    assert.equal(full.messages, 2000); assert.equal(full.older, false);
    const cache = await js('ctx._ref="other";fill(2);ctx._snap.messages[1].blocks[0].text="<img src=x onerror=alert(1)>";draw()');
    assert.equal(await js('!!document.querySelector("[onerror]")'), false);
    assert.equal(cache.messages, 2);
    const stream = await js(`ctx._ref="stream";fill(4);ctx._snap.messages[3].blocks=[{index:0,kind:"thinking",text:"过程"},{index:1,kind:"text",text:"## 实时"}];ctx._snap.status="streaming";draw();
      const oldHeading=document.querySelector('[data-chat-node="message:1"] .ntext h2');
      ctx._snap.messages[3].blocks[1].text+=String.fromCharCode(10,10)+"增量 <img src=x onerror=alert(1)>"+String.fromCharCode(10);draw();
      ({oldHeading:oldHeading===document.querySelector('[data-chat-node="message:1"] .ntext h2'),
        oldRich:!!document.querySelector('[data-chat-node="message:1"] .ntext h2'),
        liveRich:!!document.querySelector('[data-chat-node="message:3"] .ntext h2'),
        liveUpdated:document.querySelector('[data-chat-node="message:3"] .ntext').textContent.includes('增量'),
        sanitized:!document.querySelector('[onerror]')})`);
    // The production renderer now streams throttled, sanitized Markdown. Old
    // rows must retain their DOM while the live row receives the latest text.
    stream.liveUpdated = await js(`(async()=>{
      const deadline=performance.now()+2000;
      while(performance.now()<deadline){if(document.querySelector('[data-chat-node="message:3"] .ntext').textContent.includes('增量'))return true;await new Promise(r=>setTimeout(r,20));}
      return false;
    })()`);
    assert.deepEqual(stream, { oldHeading: true, oldRich: true, liveRich: true, liveUpdated: true, sanitized: true });
    const settled = await js('ctx._snap.status="idle";draw();({rich:!!document.querySelector("[data-chat-node=\\"message:3\\"] .ntext h2"),heading:!!document.querySelector("[data-chat-node=\\"message:3\\"] .ntext h2")})');
    assert.deepEqual(settled, { rich: true, heading: true });
    console.log(JSON.stringify({ ok: true, first, next, older, full }, null, 2));
  } finally { win.destroy(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
