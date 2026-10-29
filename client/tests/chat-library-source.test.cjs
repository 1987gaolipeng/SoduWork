'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const panel = fs.readFileSync(path.join(__dirname, '../components/panels/panels-chat.js'), 'utf8');
const controller = fs.readFileSync(path.join(__dirname, '../components/panels/chat-session-controller.js'), 'utf8');
const composer = fs.readFileSync(path.join(__dirname, '../components/panels/chat-composer-bindings.js'), 'utf8');

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      if (ch === '\\' && next) { i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${signature}`);
}

test('the modular chat entry keeps library ids out of runtime options and queues them for a new session', () => {
  assert.match(panel, /const libraryItemIds = Array\.isArray\(launchOptions\.libraryItemIds\)/);
  assert.match(panel, /delete launchOptions\.libraryItemIds/);
  assert.match(panel, /_pendingLibraryIds = chatId \? \[\] : libraryItemIds/);
  assert.match(panel, /_pendingLibraryIds = \[\]/);
});

test('the session controller associates pending ids only after a successful new session id', () => {
  const sessionId = controller.indexOf('ctx._sessionId = openedSessionId');
  const consume = controller.indexOf('ctx._pendingLibraryIds = []', sessionId);
  const associate = controller.indexOf('ctx._associateDraftLibrarySources', consume);
  assert.ok(sessionId >= 0);
  assert.ok(consume > sessionId);
  assert.ok(associate > consume);
  assert.match(controller.slice(sessionId, associate + 100), /if \(!chatId\)/);
});

test('composer captures the current conversation as the library source', () => {
  assert.match(composer, /LibraryTransfer\?\.bindSession/);
  assert.match(composer, /librarySource: \(\) => \(\{ sessionId: ctx\._sessionId/);
});

test('the production source association helper deduplicates compose and chat attachments', async () => {
  const associated = [];
  const context = {
    SoduWorkAPI: { associateLibrarySource: async (id, value) => associated.push({ id, ...value }) },
    ChatChrome: { sessionTitle: '  New chat  ' },
  };
  const vmContext = { global: context, _sessionId: 'created-session', _messageAttachments: { libraryItems: () => ['chat-draft', 'compose-a'] } };
  vm.createContext(vmContext);
  vm.runInContext(`
    ${extractFunction(panel, 'function _associateDraftLibrarySources(itemIds)')}
    _associateDraftLibrarySources(['compose-a', 'compose-b']);
  `, vmContext);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(associated, [
    { id: 'compose-a', sessionId: 'created-session', conversationTitle: 'New chat' },
    { id: 'compose-b', sessionId: 'created-session', conversationTitle: 'New chat' },
    { id: 'chat-draft', sessionId: 'created-session', conversationTitle: 'New chat' },
  ]);
});
