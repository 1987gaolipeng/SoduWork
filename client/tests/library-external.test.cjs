'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
test('library native handoff preserves bytes, reveals files and rejects unsafe IDs and programs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'library-native-'));
  const handlers = {}, opened = [], revealed = [];
  require('../main/library-external.cjs').install({
    app: { getPath: () => root }, ipcMain: { handle: (id, fn) => { handlers[id] = fn; } },
    BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }) },
    shell: { openPath: async file => { opened.push(file); return ''; }, showItemInFolder: file => revealed.push(file) }
  });
  const event = { sender: {} }, payload = { itemId: 'test-item-123', filename: 'report.pdf', data: Buffer.from('private bytes').toString('base64') };
  try {
    await handlers['library-open-external'](event, payload);
    assert.equal(fs.readFileSync(opened[0], 'utf8'), 'private bytes');
    await handlers['library-reveal'](event, payload);
    assert.equal(revealed[0], opened[0]);
    for (const itemId of ['../escape', 'C:outside', '........']) {
      await assert.rejects(handlers['library-reveal'](event, { ...payload, itemId }));
    }
    await assert.rejects(handlers['library-open-external'](event, { ...payload, filename: 'run.exe' }));
    assert.equal(opened.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('opening and revealing the same saved version preserves edits to its local copy', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'library-native-version-'));
  const handlers = {}, opened = [], revealed = [];
  require('../main/library-external.cjs').install({
    app: { getPath: () => root }, ipcMain: { handle: (id, fn) => { handlers[id] = fn; } },
    BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }) },
    shell: { openPath: async file => { opened.push(file); return ''; }, showItemInFolder: file => revealed.push(file) }
  });
  const event = { sender: {} };
  const payload = { itemId: 'test-item-123', filename: 'report.docx', data: Buffer.from('original document').toString('base64') };
  try {
    await handlers['library-open-external'](event, payload);
    const local = opened[0];
    fs.writeFileSync(local, 'saved changes from system application');
    await handlers['library-reveal'](event, payload);
    assert.equal(revealed[0], local);
    assert.equal(fs.readFileSync(local, 'utf8'), 'saved changes from system application');
    await handlers['library-open-external'](event, payload);
    assert.equal(opened[1], local);
    assert.equal(fs.readFileSync(local, 'utf8'), 'saved changes from system application');

    await handlers['library-open-external'](event, { ...payload, data: Buffer.from('new library version').toString('base64') });
    assert.notEqual(opened[2], local);
    assert.equal(path.basename(opened[2]), 'report.docx');
    assert.equal(fs.readFileSync(opened[2], 'utf8'), 'new library version');
    assert.equal(fs.readFileSync(local, 'utf8'), 'saved changes from system application');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
