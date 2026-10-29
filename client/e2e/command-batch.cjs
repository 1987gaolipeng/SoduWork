'use strict';

const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-command-batch-')));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, 'fixtures/long-conversation.html'));
    const result = await win.webContents.executeJavaScript(`(() => {
      ctx._messageWindowSize = 80;
      ctx._snap = {
        status: 'streaming',
        messages: [
          { role: 'user', text: '连续执行三条命令', blocks: [] },
          { role: 'assistant', blocks: [{ kind: 'toolcall', text: '' }] },
          { role: 'assistant', blocks: [{ kind: 'toolcall', text: '' }] },
          { role: 'assistant', blocks: [{ kind: 'toolcall', text: '' }] },
        ],
        tools: [
          { id: 'command-1', after: 1, name: 'bash', args: { command: 'npm run build' }, state: 'done', result: 'ok' },
          { id: 'command-2', after: 2, name: 'bash', args: { command: 'npm test' }, state: 'done', result: 'ok' },
          { id: 'command-3', after: 3, name: 'bash', args: { command: 'npm run lint' }, state: 'running', partial: '' },
        ],
      };
      draw();
      return {
        batches: document.querySelectorAll('.ntool-batch').length,
        rows: document.querySelectorAll('.ntool-batch .ntool').length,
        running: document.querySelectorAll('.ntool-batch.running').length,
        count: document.querySelector('.ntool-batch-count')?.textContent || '',
      };
    })()`);
    assert.deepEqual(result, { batches: 1, rows: 3, running: 1, count: '3 项' });
    console.log(JSON.stringify({ ok: true, result }));
  } finally {
    win.destroy();
    app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
