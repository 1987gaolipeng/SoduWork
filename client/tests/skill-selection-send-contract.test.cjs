'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { makeGlobals, stubGlobals } = require('./fixture/chat-draft-harness.cjs');
function fixture() {
  const opened = [], sends = [], f = makeGlobals();
  const api = { open: async options => { opened.push(options); return { ok: true, ref: 'ref-A', sessionId: 'chat-A', snapshot: { messages: [] } }; },
    send: async (_ref, text, _attachments, options) => { sends.push({ text, options }); return { ok: true }; },
    history: async () => ({ chats: [] }), onEvent: () => () => {}, outputs: async () => ({ items: [] }) };
  stubGlobals(f.g, { piSession: api }); f.g.window = f.g;
  global.document = f.document;
  vm.createContext(f.g);
  for (const file of ['chat-draft-recovery.js', 'chat-composer-bindings.js', 'chat-session-controller.js', 'panels-chat.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels', file), 'utf8'), f.g);
  return { ...f, opened, sends };
}
test('the first send receives selected skills once without retaining them in session open options', async () => {
  const f = fixture();
  assert.equal(await f.g.NativeChat.enter('#1 写作文\n#2 去AI味', '', { skills: ['company-research'] }), true);
  assert.deepEqual(Array.from(f.sends[0].options.skills), ['company-research']);
  assert.equal(f.sends[0].text, '#1 写作文\n#2 去AI味');
  assert.equal(f.opened[0].skills, undefined, 'a turn selection must not become a session default');
  assert.equal(await f.g.NativeChat.send('#company-research 后续普通文本'), true);
  assert.deepEqual(Array.from(f.sends[1].options.skills), []);
});
