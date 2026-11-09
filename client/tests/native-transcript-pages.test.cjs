'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const create = require('../main/conversation/native-transcript-pages.cjs').create;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-native-page-')), file = path.join(root, 'history.jsonl');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { file, read: create() };
}
const message = (id, text = '多语言 😀 ' + id) => JSON.stringify({ type: 'message', id: String(id), message: { role: 'user', content: text } });
test('native history exposes visible user text without rewriting archive or pagination identity', async t => {
  const f = fixture(t), context = require('../main/pi-session/connector-context.cjs');
  const augmented = context.augment('next turn', 'Internal connector capability guide');
  const source = [message('one', augmented), JSON.stringify({type:'message', id:'two',
    message:{role:'user',content:[{type:'text',text:augmented}]}}),
    JSON.stringify({type:'message',id:'three',message:{role:'assistant',content:augmented}})].join('\n');
  fs.writeFileSync(f.file, source);
  const first = await f.read(f.file, {limit:1});
  assert.equal(first.items[0].id, 'one'); assert.equal(first.items[0].text, 'next turn');
  assert.equal(first.nextOffset, 1);
  const rest = await f.read(f.file, {offset:first.nextOffset,limit:10});
  assert.deepEqual(rest.items.map(row=>row.text), ['next turn', augmented]);
  assert.equal(rest.nextOffset, null);
  assert.equal(fs.readFileSync(f.file,'utf8'), source);
});
test('native pages preserve CRLF, multibyte text, metadata gaps and final unterminated lines', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, [message(1), '{}', message(2), '{bad', message(3)].join('\r\n'));
  const first = await f.read(f.file, { limit: 1 });
  assert.deepEqual(first.items.map(row => row.id), ['1']); assert.equal(first.nextOffset, 1);
  const next = await f.read(f.file, { offset: first.nextOffset, limit: 1 });
  assert.equal(next.items[0].text, '多语言 😀 2'); assert.equal(next.nextOffset, 2);
  const final = await f.read(f.file, { offset: next.nextOffset, limit: 1 });
  assert.equal(final.items[0].id, '3'); assert.equal(final.nextOffset, null);
  fs.writeFileSync(f.file, message('replacement'));
  assert.equal((await f.read(f.file, { limit: 1 })).items[0].id, 'replacement');
});
test('sequential pages use bounded byte checkpoints rather than repeated prefix scans', async t => {
  const f = fixture(t), rows = Array.from({ length: 10000 }, (_, i) => message(i, '文'.repeat(80) + i));
  fs.writeFileSync(f.file, rows.join('\n'));
  const starts = [], original = fs.createReadStream;
  t.mock.method(fs, 'createReadStream', (file, options) => { starts.push(options.start); return original(file, options); });
  let after = 0, count = 0;
  do {
    const page = await f.read(f.file, { offset: after, limit: 100 });
    assert.equal(page.items[0].id, String(count)); count += page.items.length; after = page.nextOffset;
  } while (after != null);
  assert.equal(count, 10000); assert.equal(starts.length, 100);
  assert.ok(starts.slice(1).every((value, i) => value > starts[i]));
});
test('archive replacement during a page invalidates the result and preserves retry', async t => {
  const f = fixture(t); fs.writeFileSync(f.file, message(1));
  let changed = false;
  await assert.rejects(f.read(f.file, {}, () => {
    if (!changed) { changed = true; fs.writeFileSync(f.file, message('changed')); }
  }), /正在更新/);
  assert.equal((await f.read(f.file, {})).items[0].id, 'changed');
});
