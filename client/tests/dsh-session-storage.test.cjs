'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const loader = path.resolve(__dirname, '../../hub-backend/app/services/dsh_session_storage.mjs');

test('DSH staging keeps file classification and never publishes an incomplete generation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-dsh-storage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { writeSyncedTempFile } = await import(pathToFileURL(loader).href);
  for (const suffix of ['.jsonl', '.jsonl.zstd']) {
    const target = path.join(root, 'session.v4' + suffix);
    const before = Buffer.from('old durable session');
    await fs.writeFile(target, before);
    const payload = Buffer.alloc(65536, 42);
    const temps = await Promise.all([writeSyncedTempFile(target, payload), writeSyncedTempFile(target, payload)]);
    assert.notEqual(temps[0], temps[1]);
    assert.deepEqual(await fs.readFile(target), before, 'staging never overwrites the current journal');
    for (const temporary of temps) {
      assert.equal(path.dirname(temporary), root);
      assert.ok(temporary.endsWith(suffix));
      assert.doesNotMatch(path.basename(temporary), /^session(?:\.v[0-9]+)?\.jsonl(?:\.zstd)?$/);
      assert.deepEqual(await fs.readFile(temporary), payload);
    }
  }
});

test('DSH staging cleans up a failed write without masking the failure', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-dsh-storage-fail-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { writeSyncedTempFile } = await import(pathToFileURL(loader).href);
  const target = path.join(root, 'session.v4.jsonl');
  await assert.rejects(writeSyncedTempFile(target, { invalidPayload: true }), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.deepEqual(await fs.readdir(root), []);
});

test('DSH no-replace publication keeps native collision and filesystem errors', async () => {
  const { publishNewFile } = await import(pathToFileURL(loader).href);
  const calls = [];
  const move = (...args) => { calls.push(args); return 1; };
  publishNewFile(move, () => { throw Error('not queried on success'); }, 'source.txt', 'target.txt');
  assert.equal(calls[0][2], 8, 'WRITE_THROUGH only; never REPLACE_EXISTING or COPY_ALLOWED');
  for (const [native, code] of [[80, 'EEXIST'], [183, 'EEXIST'], [17, 'EXDEV'], [5, 'EACCES']]) {
    let attempts = 0;
    assert.throws(() => publishNewFile(() => { attempts++; return 0; }, () => native, 'a', 'b'), { code });
    assert.equal(attempts, 1, 'a failed atomic publication must not retry by overwriting');
  }
});
