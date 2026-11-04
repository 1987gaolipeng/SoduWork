'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { create, CHUNK } = require('../main/mobile-library.cjs');
const storage = require('../main/library-local-store.cjs');
const { execute } = require('../main/library-local-actions.cjs');
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-library-'));
  const root = path.join(temp, 'work'); fs.mkdirSync(root);
  t.after(() => { if (path.dirname(temp) === os.tmpdir()) fs.rmSync(temp, { recursive: true, force: true }); });
  let owner = 'a'.repeat(32), seq = 0;
  const app = { getPath: () => temp };
  const deps = { app, ownerOf: () => owner, rootOf: () => root };
  let handler = create(deps);
  return { temp, root, switchOwner: () => { owner = 'b'.repeat(32); }, restart: () => { handler = create(deps); },
    externalEdit: (id, content) => { const store = storage.create(app, owner, () => {}, root);
      return store.run(async index => { const row = index.items.find(x => x.id === id); fs.writeFileSync(await store.locate(row), content); }); },
    call: (action, body = {}, id = '', receipt = 'request-' + ++seq, guard = async () => {}) =>
      handler({ action, id, body }, receipt, guard),
    pc: (action, payload) => { const store = storage.create(app, owner, () => {}, root); return store.run(index => execute(store, index, action, payload)); } };
}
test('phone CRUD and desktop service share the same account store, folder and recycle bin', async t => {
  const f = fixture(t);
  const folder = (await f.call('createFolder', { name: 'mobile' })).folder;
  const item = (await f.call('createItem', { title: 'Note', format: 'txt', content: 'first', folderId: folder.id })).item;
  assert.equal((await f.pc('list', { scope: 'all', folderId: folder.id })).items[0].id, item.id);
  await f.call('updateItem', { content: 'edited', favorite: true, title: 'New', folderId: '' }, item.id);
  assert.equal((await f.pc('readContent', { id: item.id })).content, 'edited');
  assert.equal((await f.call('list', { scope: 'favorites' })).items.length, 1);
  await f.call('deleteItem', {}, item.id);
  await assert.rejects(f.call('readChunk', {}, item.id), /回收站/);
  await f.call('restoreItem', {}, item.id);
  await f.call('deleteFolder', {}, folder.id);
  await f.call('deleteItem', {}, item.id); await f.call('purgeItem', {}, item.id);
  assert.equal((await f.pc('list', { scope: 'trash' })).items.length, 0);
});

test('external PC edits are readable without stale size metadata and cannot overwrite a newer mobile draft', async t => {
  const f = fixture(t), item = (await f.call('createItem', { title: 'external', content: '' })).item;
  await f.externalEdit(item.id, 'PC_TO_MOBILE_LIBRARY_OK');
  const content = await f.call('readContent', {}, item.id);
  assert.equal(content.content, 'PC_TO_MOBILE_LIBRARY_OK');
  assert.equal(content.item.size, 23);
  assert.equal((await f.call('list')).items[0].size, 23);
  const chunk = await f.call('readChunk', {}, item.id);
  assert.equal(Buffer.from(chunk.data, 'base64').toString(), content.content);
  await f.externalEdit(item.id, 'PC_TO_MOBILE_LIBRARY_NO'); // Same byte length; hash must still detect it.
  await assert.rejects(f.call('readChunk', { revision: chunk.revision }, item.id), /变化/);
  await assert.rejects(f.call('updateItem', { content: 'stale', expectedUpdatedAt: item.updatedAt,
    expectedContentRevision: content.contentRevision }, item.id), /电脑修改/);
  assert.equal((await f.pc('readContent', { id: item.id })).content, 'PC_TO_MOBILE_LIBRARY_NO');
  const latest = await f.call('readContent', {}, item.id);
  await f.call('updateItem', { content: 'mobile edit', expectedContentRevision: latest.contentRevision }, item.id);
  assert.equal((await f.pc('readContent', { id: item.id })).content, 'mobile edit');
});
test('chunk upload round trip is checksummed, retryable after restart, and leaves no staging data', async t => {
  const f = fixture(t), bytes = crypto.randomBytes(CHUNK + 73), transfer = 'transfer-fixture';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    await f.call('uploadChunk', { transfer, size: bytes.length, offset, data: bytes.subarray(offset, offset + CHUNK).toString('base64') });
  }
  const body = { transfer, size: bytes.length, name: 'result.bin', sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  const saved = await f.call('uploadFinish', body, '', 'finish-fixture');
  assert.equal(fs.readdirSync(path.join(f.temp, 'mobile-library-transfers')).length, 0);
  f.restart();
  assert.deepEqual(await f.call('uploadFinish', body, '', 'finish-fixture'), saved);
  const first = await f.call('readChunk', {}, saved.item.id);
  const second = await f.call('readChunk', { offset: CHUNK, revision: first.revision }, saved.item.id);
  assert.ok(Buffer.concat([Buffer.from(first.data, 'base64'), Buffer.from(second.data, 'base64')]).equals(bytes));
  assert.equal(first.sha256, body.sha256);
  assert.equal((await f.pc('list', {})).items.length, 1);
  assert.equal(saved.item._object, undefined);
  assert.equal(saved.item.extra, undefined);
});
test('foreign account, revoked authorization and path injection cannot read or write PC files', async t => {
  const f = fixture(t), item = (await f.call('createItem', { title: 'private', content: 'secret' })).item;
  await assert.rejects(f.call('updateItem', { content: 'changed' }, item.id, 'bad-auth', async () => { throw Error('revoked'); }), /revoked/);
  assert.equal((await f.pc('readContent', { id: item.id })).content, 'secret');
  await assert.rejects(f.call('uploadChunk', { transfer: '../outside', size: 1, offset: 0, data: 'YQ==' }), /上传信息/);
  await assert.rejects(f.call('list', { path: f.root }), /参数/);
  await assert.rejects(f.call('openExternal', {}, item.id), /操作/);
  f.switchOwner();
  assert.equal((await f.call('list')).items.length, 0);
  await assert.rejects(f.call('readChunk', {}, item.id), /不存在/);
});

test('copying identical bytes into a selected folder preserves the original and the destination', async t => {
  const f = fixture(t), folder = (await f.call('createFolder', { name: 'destination' })).folder;
  const save = async (transfer, folderId = '') => {
    await f.call('uploadChunk', { transfer, size: 3, offset: 0, data: 'QUJD' });
    return (await f.call('uploadFinish', { transfer, size: 3, name: 'proof.txt', folderId,
      sha256: crypto.createHash('sha256').update('ABC').digest('hex') })).item;
  };
  const original = await save('original-transfer');
  const copied = await save('copied-transfer', folder.id);
  assert.notEqual(copied.id, original.id);
  assert.equal(copied.folderId, folder.id);
  assert.equal((await f.pc('readContent', { id: original.id })).content, 'ABC');
  assert.equal((await f.pc('list', { scope: 'all', folderId: folder.id })).items[0].id, copied.id);
});
test('file changes, missing chunks, hash mismatch and account changes during authorization are rejected', async t => {
  const f = fixture(t), item = (await f.call('createItem', { title: 'note', content: 'one' })).item;
  const first = await f.call('readChunk', {}, item.id);
  await f.pc('updateItem', { id: item.id, body: { content: 'two changed' } });
  await assert.rejects(f.call('updateItem', { content: 'stale mobile draft', expectedUpdatedAt: item.updatedAt }, item.id), /修改/);
  assert.equal((await f.pc('readContent', { id: item.id })).content, 'two changed');
  await assert.rejects(f.call('readChunk', { offset: 1, revision: first.revision }, item.id), /变化/);
  const body = { transfer: 'incomplete-fixture', size: CHUNK + 1, name: 'file.bin', sha256: '0'.repeat(64) };
  await assert.rejects(f.call('uploadFinish', body), /ENOENT/);
  await f.call('uploadChunk', { transfer: 'checksum-fixture', size: 1, offset: 0, data: 'YQ==' });
  await assert.rejects(f.call('uploadFinish', { ...body, transfer: 'checksum-fixture', size: 1 }), /校验/);
  await assert.rejects(f.call('createFolder', { name: 'wrong' }, '', 'changed-owner', async () => f.switchOwner()), /账号/);
  assert.equal((await f.call('list', { scope: 'all' })).folders.length, 0);
});


test('batch trash reports partial success and never touches unselected files', async t => {
  const f = fixture(t);
  const a = (await f.call('createItem', {title:'selected', content:'first'})).item;
  const b = (await f.call('createItem', {title:'keep', content:'other'})).item;
  const result = await f.call('deleteItems', {ids:[a.id, 'missing']});
  assert.deepEqual(result.succeeded.map(row => row.id), [a.id]);
  assert.deepEqual(result.failed.map(row => row.id), ['missing']);
  assert.deepEqual((await f.pc('list', {scope:'all'})).items.map(row => row.id), [b.id]);
  await assert.rejects(f.call('deleteItems', {ids:Array(101).fill(b.id)}), /100/);
});

test('remote copy receipts identify the destination and preserve the local original', async t => {
  const f = fixture(t);
  const item = (await f.call('createItem', { title: 'original', content: 'keep' })).item;
  await assert.rejects(f.call('recordRemoteCopy', { storage: 'local', remoteId: 'x' }, item.id));
  await f.call('recordRemoteCopy', { storage: 'nfs', remoteId: 'copy-1' }, item.id);
  const row = (await f.call('list', { scope: 'all' })).items[0];
  assert.deepEqual(row.remoteCopy, { id: 'copy-1', storage: 'nfs', folderId: '' });
  assert.equal(row.extra, undefined);
  assert.equal((await f.pc('readContent', { id: item.id })).content, 'keep');
});
