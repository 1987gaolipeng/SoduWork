'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('plugin improvement keeps the full draft out of the visible composer', () => {
  const capabilities = read('components/panels/panels-capabilities.js');
  const composer = read('components/panels/panels-compose.js');
  const ipc = read('main/pi-session/ipc.js');
  const visible = capabilities.slice(
    capabilities.indexOf('const prefill = hasDraft'),
    capabilities.indexOf('const contextPrompts = hasDraft'));

  assert.match(visible, /'改进「' \+ draftName \+ '」：'/);
  assert.doesNotMatch(visible, /JSON\.stringify\(existingDraft/);
  assert.match(capabilities, /contextPrompts: contextPrompts/);
  assert.match(composer, /contextPrompts: _entryContextPrompts\.slice\(\)/);
  assert.match(ipc, /\.\.\._entryContextPrompts\(opts\.contextPrompts\)/);
});
