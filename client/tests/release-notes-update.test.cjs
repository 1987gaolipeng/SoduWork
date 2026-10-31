'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { present } = require('../main/release-notes-update.cjs');
const native = require('../main/native-locale.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
test('localized updater presentation never changes signed bytes and switches with UI language', async () => {
  const manifest = { version: '2.0.0', notes: 'Signed original', signature: 'signature' };
  const before = JSON.stringify(manifest); let calls = 0, notifications = 0;
  const runtime = { status: { manifest }, releaseNotesOf: async (_version, locale) => {
    calls++; return { summary: locale, sections: [] };
  } };
  native.setLocale('en-US');
  const first = { releaseNotes: manifest.notes };
  present(runtime, first, () => notifications++);
  assert.equal(first.releaseNotes, 'Signed original');
  await tick();
  const second = {}; present(runtime, second, () => notifications++);
  assert.equal(second.releaseNotes, 'en-US'); assert.equal(calls, 1);
  native.setLocale('zh-CN'); present(runtime, {}, () => notifications++); await tick();
  const third = {}; present(runtime, third, () => notifications++);
  assert.equal(third.releaseNotes, 'zh-CN'); assert.equal(notifications, 2);
  assert.equal(JSON.stringify(manifest), before);
});
test('late presentation requests cannot overwrite a newer update or a cleared status', async () => {
  let resolve, notifications = 0;
  const runtime = { status: { manifest: { version: '1.0.0' } }, releaseNotesOf: () => new Promise(r => { resolve = r; }) };
  present(runtime, {}, () => notifications++); await tick();
  runtime.status = {};
  resolve({ summary: 'Old version', sections: [] }); await tick();
  assert.equal(notifications, 0);
});
