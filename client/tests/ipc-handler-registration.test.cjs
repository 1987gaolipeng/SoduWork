'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('thinking IPC handler is registered only by the runtime-selection module', () => {
  const root = path.resolve(__dirname, '..', 'main', 'pi-session');
  const sessionIpc = fs.readFileSync(path.join(root, 'ipc.js'), 'utf8');
  const runtimeSelectionIpc = fs.readFileSync(path.join(root, 'runtime-selection-ipc.js'), 'utf8');
  const channel = "ipcMain.handle('pi-session-set-thinking'";

  const occurrences = source => source.split(channel).length - 1;
  assert.equal(occurrences(sessionIpc), 0);
  assert.equal(occurrences(runtimeSelectionIpc), 1);
});
