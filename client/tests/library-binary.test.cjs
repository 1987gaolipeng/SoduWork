'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { readFile, readResponse } = require('../main/library-binary.cjs');
test('binary IPC keeps exact bytes and rejects local files before allocating above the transfer limit', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-library-binary-'));
  t.after(() => { assert.ok(dir.startsWith(path.join(os.tmpdir(),'soduwork-library-binary-'))); fs.rmSync(dir, {recursive:true,force:true}); });
  const file = path.join(dir,'中文资料.bin'), bytes = Buffer.from([0,255,13,10,42]);
  fs.writeFileSync(file,bytes);
  assert.deepEqual(readFile(file,bytes.length),bytes);
  assert.throws(() => readFile(file,4),/64MB/);
  assert.throws(() => readFile(dir,100),/可上传|EISDIR|EPERM/);
});
test('binary transfer enforces declared and streamed lengths including missing Content-Length', async () => {
  const bytes = Buffer.from([0,255,13,10]);
  assert.deepEqual(await readResponse(new Response(bytes),4),bytes);
  await assert.rejects(readResponse(new Response(bytes,{headers:{'content-length':'100'}}),4),/64MB/);
  let cancelled = false;
  const stream = new ReadableStream({start(c){c.enqueue(bytes);c.enqueue(bytes);},cancel(){cancelled=true;}});
  await assert.rejects(readResponse(new Response(stream),4),/64MB/);
  assert.equal(cancelled,true);
});
