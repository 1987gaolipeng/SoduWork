'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const followUp = require('../components/panels/message-follow-up.js');

test('buildPayload carries colleague text into a new unsent conversation', () => {
  const payload = followUp.buildPayload({
    senderName: '\u540c\u4e8b\u7532',
    text: '\u8bf7\u57fa\u4e8e\u8fd9\u4efd\u62a5\u544a\u7ee7\u7eed\u4f18\u5316',
    conversationId: 'sender-local-conversation',
  }, []);

  assert.equal(payload.tab, 'chat');
  assert.equal(payload.newSession, true);
  assert.equal(payload.source, 'mate-message-follow-up');
  assert.match(payload.prefill, /\u8bf7\u57fa\u4e8e\u8fd9\u4efd\u62a5\u544a\u7ee7\u7eed\u4f18\u5316/);
  assert.match(payload.contextPrompts[0], /\u540c\u4e8b\u7532/);
  assert.equal('chatId' in payload, false);
  assert.equal('conversationId' in payload, false);
  assert.equal('send' in payload, false);
});

test('buildPayload preserves imported files without mutating them', () => {
  const files = [{ name: '\u62a5\u544a.md', size: 12, type: 'text/markdown' }];
  const payload = followUp.buildPayload({ text: '\u8bf7\u4f18\u5316' }, files);
  assert.deepEqual(payload.initialFiles, files);
  assert.notEqual(payload.initialFiles, files);
  assert.equal(payload.initialFiles[0], files[0]);
});

test('buildPayload truncates oversized message text at the composer limit', () => {
  const payload = followUp.buildPayload({ text: 'a'.repeat(9000) }, []);
  assert.equal(payload.prefill.length <= 8000, true);
  assert.equal(payload.contextPrompts[0].length <= 16000, true);
});

test('hasTransferableContent rejects empty messages without files', () => {
  assert.equal(followUp.hasTransferableContent({ text: '   ', attachments: [] }), false);
  assert.equal(followUp.hasTransferableContent({ text: '', attachments: [{ id: 'a' }] }), true);
  assert.equal(followUp.hasTransferableContent({ text: '\u5185\u5bb9', attachments: [] }), true);
});

test('collectFiles reads message attachments through the trusted binary bridge', async () => {
  const calls = [];
  const api = {
    async mateMessageFile(id) {
      calls.push(['meta', id]);
      return { id, filename: '\u62a5\u544a.md', size: 3, contentType: 'text/markdown', url: '/attachments/' + id };
    },
    attachmentUrl(row) { calls.push(['url', row.id]); return 'https://hub.test' + row.url + '?ticket=valid'; },
  };
  const bridge = {
    async readAttachmentBinary(payload) {
      calls.push(['binary', payload.filename]);
      return { ok: true, name: payload.filename, mimeType: 'text/markdown', size: 3, data: 'YWJj' };
    },
  };
  const files = await followUp.collectFiles({ attachments: [{ id: 'attachment-1', name: '\u62a5\u544a.md', size: 3 }] }, api, bridge);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, '\u62a5\u544a.md');
  assert.equal(files[0].type, 'text/markdown');
  assert.deepEqual(calls, [
    ['meta', 'attachment-1'],
    ['url', 'attachment-1'],
    ['binary', '\u62a5\u544a.md'],
  ]);
});

test('collectFiles rejects a partial import instead of opening an incomplete session', async () => {
  const api = {
    async mateMessageFile(id) { return { id, filename: id + '.txt', size: 3, url: '/attachments/' + id }; },
    attachmentUrl(row) { return 'https://hub.test' + row.url + '?ticket=valid'; },
  };
  const bridge = { async readAttachmentBinary() { throw new Error('\u9644\u4ef6\u5df2\u5931\u6548'); } };
  await assert.rejects(
    followUp.collectFiles({ attachments: [{ id: 'attachment-1', name: 'a.txt', size: 3 }] }, api, bridge),
    /\u9644\u4ef6\u5df2\u5931\u6548/
  );
});

test('collectFiles refuses incomplete or oversized attachment lists instead of dropping files', async () => {
  await assert.rejects(
    followUp.collectFiles({ attachments: [{ name: 'missing-id.txt' }] }, {}, {}),
    /\u6d88\u606f\u9644\u4ef6\u4fe1\u606f\u4e0d\u5b8c\u6574/
  );
  await assert.rejects(
    followUp.collectFiles({ attachments: Array.from({ length: 21 }, (_, index) => ({ id: 'a-' + index })) }, {}, {}),
    /\u6d88\u606f\u9644\u4ef6\u6570\u91cf\u8d85\u8fc7/
  );
});

test('openInNewSession opens only after every attachment is imported', async () => {
  const opened = [];
  const api = {
    async mateMessageFile(id) { return { id, filename: 'a.txt', size: 3, url: '/attachments/' + id }; },
    attachmentUrl(row) { return 'https://hub.test' + row.url + '?ticket=valid'; },
  };
  const bridge = { async readAttachmentBinary(payload) { return { ok: true, name: payload.filename, size: 3, data: 'YWJj' }; } };
  const ok = await followUp.openInNewSession({ text: '\u8bf7\u4f18\u5316', attachments: [{ id: 'a' }] }, {
    api, bridge, open: payload => opened.push(payload), notify: () => {},
  });
  assert.equal(ok, true);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].newSession, true);
  assert.equal(opened[0].initialFiles.length, 1);
});

test('openInNewSession does not open or send when attachment import fails', async () => {
  let opened = 0;
  let sent = 0;
  const api = {
    async mateMessageFile() { return { filename: 'a.txt', size: 3, url: '/attachments/a' }; },
    attachmentUrl() { return 'https://hub.test/attachments/a?ticket=valid'; },
  };
  const bridge = { async readAttachmentBinary() { throw new Error('\u9644\u4ef6\u5df2\u5931\u6548'); } };
  const ok = await followUp.openInNewSession({ text: '\u8bf7\u4f18\u5316', attachments: [{ id: 'a' }] }, {
    api, bridge, open: () => { opened += 1; }, send: () => { sent += 1; }, notify: () => {},
  });
  assert.equal(ok, false);
  assert.equal(opened, 0);
  assert.equal(sent, 0);
});

test('openInNewSession aborts when the owning account scope changes during import', async () => {
  let opened = 0;
  let current = true;
  let release;
  const api = {
    async mateMessageFile() { return { filename: 'a.txt', size: 3, url: '/attachments/a' }; },
    attachmentUrl() { return 'https://hub.test/attachments/a?ticket=valid'; },
  };
  const bridge = {
    async readAttachmentBinary() {
      await new Promise(resolve => { release = resolve; });
      return { ok: true, name: 'a.txt', size: 3, data: 'YWJj' };
    },
  };
  const pending = followUp.openInNewSession({ text: '\u8bf7\u4f18\u5316', attachments: [{ id: 'a' }] }, {
    api, bridge, isCurrent: () => current, open: () => { opened += 1; }, notify: () => {},
  });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  current = false;
  release();
  assert.equal(await pending, false);
  assert.equal(opened, 0);
});

test('openInNewSession reports a rejected workspace route', async () => {
  let notified = '';
  const ok = await followUp.openInNewSession({ text: '\u8bf7\u4f18\u5316' }, {
    open: () => false,
    notify: message => { notified = message; },
  });
  assert.equal(ok, false);
  assert.match(notified, /\u65b0\u4f1a\u8bdd\u5165\u53e3/);
});
