'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const OWNER_A = 'a'.repeat(32), OWNER_B = 'b'.repeat(32);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-library-local-'));
  const workRoot = path.join(root, 'work-root');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handlers = new Map(); let owner = OWNER_A;
  const sender = { mainFrame: {}, isDestroyed: () => false,
    getURL: () => pathToFileURL(path.resolve(__dirname, '../desk.html')).href };
  const event = { sender, senderFrame: sender.mainFrame };
  const opened = [], revealed = [];
  const deps = { app: { getPath: () => root }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    ownerOf: () => owner, shell: { openPath: async p => { opened.push(p); return ''; }, showItemInFolder: p => revealed.push(p) },
    BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }) },
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: path.join(root, 'export.txt') }) } };
  const install = () => require('../main/library-local.cjs').install(deps);
  install();
  return { root, workRoot, deps, handlers, event, opened, revealed, install, setOwner: value => { owner = value; },
    call: (action, payload = {}) => handlers.get('library-local-call')(event, action, { owner, workRoot, ...payload }),
    context: () => handlers.get('library-local-context')(event, { workRoot }),
    account: (value = OWNER_A) => path.join(workRoot, 'SoduWorkLibrary', 'accounts', value) };
}
const create = (f, body = {}) => f.call('createItem', { kind: 'document', title: body.filename ? body.filename.replace(/\.[^.]+$/, '') : '说明', content: '原始内容', format: 'txt', ...body });
const data = value => Buffer.from(value).toString('base64');

test('output receipts survive restart, deduplicate legacy bytes and respect deletion and account boundaries', async t => {
  const f = fixture(t), upload = { name: 'result.html', dataBase64: data('<html>result</html>') };
  const legacy = (await f.call('upload', upload)).item;
  const outputKey = '["attachment","task","attachment"]';
  const metadata = { outputKey, name: upload.name, size: Buffer.from(upload.dataBase64, 'base64').length,
    sha256: require('node:crypto').createHash('sha256').update(Buffer.from(upload.dataBase64, 'base64')).digest('hex') };
  assert.equal((await f.call('outputStatus', { ...metadata, sha256: '0'.repeat(64) })).item, null);
  assert.equal((await f.call('outputStatus', metadata)).item.id, legacy.id);
  const saved = await f.call('upload', { ...upload, source: { outputKey } });
  assert.equal(saved.item.id, legacy.id); assert.equal(saved.duplicate, true);
  f.install();
  assert.equal((await f.call('outputStatus', { outputKey })).item.id, legacy.id);
  const results = await Promise.all([1, 2].map(() => f.call('upload', { ...upload, source: { outputKey } })));
  assert.ok(results.every(r => r.item.id === legacy.id));
  assert.equal((await f.call('list', { scope: 'all' })).items.length, 1);
  f.setOwner(OWNER_B); assert.equal((await f.call('outputStatus', { outputKey })).item, null);
  f.setOwner(OWNER_A); await f.call('deleteItem', { id: legacy.id });
  assert.equal((await f.call('outputStatus', { outputKey })).item, null);
  const replacement = await f.call('upload', { ...upload, source: { outputKey } });
  assert.notEqual(replacement.item.id, legacy.id);
});

test('same destination suffixes duplicate imports while creates, folders and trash remain independent', async t => {
  const f = fixture(t);
  const original = (await f.call('upload', { name: 'Report.txt', dataBase64: data('first') })).item;
  const duplicate = (await f.call('upload', { name: 'report.TXT', dataBase64: data('second') })).item;
  assert.equal(duplicate.filename, 'report（1）.TXT');
  const third = (await f.call('upload', { name: 'report.TXT', dataBase64: data('third') })).item;
  assert.equal(third.filename, 'report（2）.TXT');
  await assert.rejects(create(f, { filename: 'Report.txt' }), /同名/);
  const folder = (await f.call('createFolder', { name: 'other' })).folder;
  await create(f, { filename: 'Report.txt', folderId: folder.id });
  await f.call('deleteItem', { id: original.id });
  await create(f, { filename: 'Report.txt' });
  assert.equal((await f.call('list', { scope: 'all' })).items.length, 3);
});

test('batch delete moves local items to trash and preserves per-item failures', async t => {
  const f = fixture(t);
  const first = (await create(f, { filename: 'first.txt' })).item;
  const second = (await create(f, { filename: 'second.txt' })).item;
  const result = await f.call('deleteItems', { ids: [first.id, second.id, 'local-missing'] });
  assert.deepEqual(result.succeeded.map(row => row.id), [first.id, second.id]);
  assert.equal(result.failed[0].id, 'local-missing');
  assert.deepEqual((await f.call('list', { scope: 'all' })).items, []);
  assert.equal((await f.call('list', { scope: 'trash' })).items.length, 2);
});

test('output receipts remain idempotent after their display name receives a suffix', async t => {
  const f = fixture(t), outputKey = 'output-with-collision';
  await f.call('upload', { name: 'result.txt', dataBase64: data('unrelated') });
  const first = (await f.call('upload', { name: 'result.txt', dataBase64: data('saved'), source: { outputKey } })).item;
  assert.equal(first.filename, 'result（1）.txt');
  const retry = await f.call('upload', { name: 'result.txt', dataBase64: data('saved'), source: { outputKey } });
  assert.equal(retry.item.id, first.id);
  assert.equal(retry.duplicate, true);
});

test('renamed file exports its new basename and rejects collisions without modifying bytes', async t => {
  const f = fixture(t), row = (await create(f, { filename: 'before.txt' })).item;
  await f.call('reveal', { id: row.id });
  const originalPath = f.revealed.at(-1);
  await f.call('updateItem', { id: row.id, body: { title: 'after' } });
  assert.equal((await f.call('readBinary', { id: row.id })).name, 'after.txt');
  await f.call('reveal', { id: row.id });
  assert.equal(path.basename(f.revealed.at(-1)), 'after.txt');
  assert.equal(fs.existsSync(originalPath), false);
  await f.call('openExternal', { id: row.id });
  assert.equal(path.basename(f.opened.at(-1)), 'after.txt');
  const other = (await create(f, { filename: 'taken.txt' })).item;
  await assert.rejects(f.call('updateItem', { id: row.id, body: { title: 'taken.txt' } }), /同名/);
  assert.equal((await f.call('readBinary', { id: row.id })).name, 'after.txt');
  assert.equal((await f.call('readContent', { id: other.id })).content, '原始内容');
});

test('parallel duplicate saves commit only one original and moves/restores cannot introduce collisions', async t => {
  const f = fixture(t);
  const saves = await Promise.allSettled([create(f, { filename: 'parallel.txt' }), create(f, { filename: 'PARALLEL.txt' })]);
  assert.equal(saves.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(saves.find(result => result.status === 'rejected').reason.code, 'LIBRARY_NAME_CONFLICT');
  const original = saves.find(result => result.status === 'fulfilled').value.item;
  const folder = (await f.call('createFolder', { name: 'other' })).folder;
  const sibling = (await create(f, { filename: 'parallel.txt', folderId: folder.id })).item;
  await assert.rejects(f.call('updateItem', { id: sibling.id, body: { folderId: '' } }), /同名/);
  await f.call('deleteItem', { id: original.id });
  await create(f, { filename: 'parallel.txt', content: 'replacement' });
  await assert.rejects(f.call('restoreItem', { id: original.id }), /同名/);
  assert.equal((await f.call('list', { scope: 'trash' })).items[0].id, original.id);
  assert.equal((await f.call('readContent', { id: sibling.id })).content, '原始内容');
});

test('legacy renamed metadata exports the visible name and blocks its duplicates without moving the original object', async t => {
  const f = fixture(t), row = (await create(f, { filename: 'before.txt' })).item;
  await f.call('reveal', { id: row.id }); const originalPath = f.revealed[0];
  const indexPath = path.join(f.account(), 'index.json'), index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  index.items[0].title = 'after'; fs.writeFileSync(indexPath, JSON.stringify(index));
  const bytes = await f.call('readBinary', { id: row.id });
  assert.equal(bytes.name, 'after.txt');
  assert.equal(Buffer.from(bytes.data, 'base64').toString(), '原始内容');
  await f.call('reveal', { id: row.id });
  assert.equal(path.basename(f.revealed.at(-1)), 'after.txt');
  const duplicate = (await f.call('upload', { name: 'AFTER.txt', dataBase64: data('replacement') })).item;
  assert.equal(duplicate.filename, 'AFTER（1）.txt');
  assert.equal(fs.existsSync(originalPath), true);
  assert.equal(JSON.parse(fs.readFileSync(indexPath, 'utf8')).items[0]._object, index.items[0]._object);
});

test('file and folder names share a destination namespace in both creation directions', async t => {
  const f = fixture(t);
  const file = (await create(f, { filename: 'report.txt' })).item;
  await assert.rejects(f.call('createFolder', { name: 'REPORT.txt' }), /同名/);
  const folder = (await f.call('createFolder', { name: 'archive.txt' })).folder;
  const duplicate = (await f.call('upload', { name: 'ARCHIVE.txt', dataBase64: data('replacement') })).item;
  assert.equal(duplicate.filename, 'ARCHIVE（1）.txt');
  await assert.rejects(create(f, { filename: 'archive.txt' }), /同名/);
  await assert.rejects(f.call('updateFolder', { id: folder.id, body: { name: 'report.txt' } }), /同名/);
  await assert.rejects(f.call('updateItem', { id: file.id, body: { title: 'archive' } }), /同名/);
  assert.equal((await f.call('readContent', { id: file.id })).content, '原始内容');
  assert.equal((await f.call('list', { scope: 'all' })).folders[0].name, 'archive.txt');
});

test('restoring a conversation revision preserves its same-name versions', async t => {
  const f = fixture(t);
  const original = (await create(f, { filename: 'version.txt', sourceType: 'conversation', sessionId: 'conversation-one', content: 'first version' })).item;
  await f.call('deleteItem', { id: original.id });
  const next = (await create(f, { filename: 'version.txt', sourceType: 'conversation', sessionId: 'conversation-one', content: 'second version' })).item;
  await f.call('restoreItem', { id: original.id });
  assert.equal((await f.call('list', { scope: 'all' })).items.length, 2);
  assert.equal((await f.call('readContent', { id: original.id })).content, 'first version');
  assert.equal((await f.call('readContent', { id: next.id })).content, 'second version');
  const manual = (await f.call('upload', { name: 'version.txt', dataBase64: data('manual') })).item;
  assert.equal(manual.filename, 'version（1）.txt');
});

test('favoriting a legacy colliding folder does not reinterpret the operation as a new name', async t => {
  const f = fixture(t), folder = (await f.call('createFolder', { name: 'docs' })).folder;
  await create(f, { filename: 'docs', sourceType: 'conversation', sessionId: 'conversation-one' });
  const updated = await f.call('updateFolder', { id: folder.id, body: { favorite: true } });
  assert.equal(updated.folder.favorite, true); assert.equal(updated.folder.name, 'docs');
});

test('explicit notification saves reject a duplicate filename without replacing the original', async t => {
  const f = fixture(t);
  const first = (await f.call('upload', { name: 'shared.txt', dataBase64: data('first') })).item;
  await assert.rejects(f.call('upload', { name: 'shared.txt', dataBase64: data('second'), rejectDuplicateName: true }), /同名/);
  assert.equal((await f.call('readContent', { id: first.id })).content, 'first');
  assert.equal((await f.call('list', { scope: 'all' })).items.length, 1);
});

test('client files, nested folders, filters and edits survive store restart without a Hub', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.context(), { owner: OWNER_A, workRoot: f.workRoot });
  assert.equal((await f.call('status')).available, true);
  const parent = (await f.call('createFolder', { name: '项目' })).folder;
  const child = (await f.call('createFolder', { name: '资料', parentId: parent.id })).folder;
  assert.match(parent.id, /^local-folder-/);
  const item = (await create(f, { folderId: child.id })).item;
  assert.match(item.id, /^local-/); assert.equal(item.backend, 'local');
  await f.call('updateFolder', { id: child.id, body: { name: '文档', favorite: true } });
  await assert.rejects(f.call('deleteFolder', { id: parent.id }), /非空|子文件夹/);
  await assert.rejects(f.call('createFolder', { name: '文档', parentId: parent.id }), /同名/);
  const edited = await f.call('updateItem', { id: item.id, body: { content: '最新中文', title: '新标题', favorite: true } });
  assert.equal(edited.item.size, Buffer.byteLength('最新中文'));
  await f.call('associateSource', { id: item.id, sourceType: 'conversation', sessionId: 'session-123', conversationTitle: '来源' });
  f.install();
  const listed = await f.call('list', { scope: 'all', folderId: child.id });
  assert.equal(listed.folder.name, '文档'); assert.equal(listed.items[0].sourceSessionId, 'session-123');
  assert.equal((await f.call('list', { scope: 'favorites' })).items.length, 1);
  assert.equal((await f.call('list', { query: '不存在' })).items.length, 0);
  assert.equal((await f.call('readContent', { id: item.id })).content, '最新中文');
  assert.equal(Buffer.from((await f.call('readBinary', { id: item.id })).data, 'base64').toString(), '最新中文');
  await f.call('updateItem', { id: item.id, folderId: null });
  await f.call('deleteFolder', { id: child.id }); await f.call('deleteFolder', { id: parent.id });
});

test('the first work-directory access migrates the legacy userData library without using it afterward', async t => {
  const f = fixture(t);
  const store = require('../main/library-local-store.cjs').create(f.deps.app, OWNER_A, () => {});
  const { execute } = require('../main/library-local-actions.cjs');
  await store.run(index => execute(store, index, 'upload', { name: 'legacy.txt', dataBase64: data('legacy bytes') }));
  const legacy = path.join(f.root, 'library', 'accounts', OWNER_A);
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.renameSync(path.join(f.root, 'SoduWorkLibrary', 'accounts', OWNER_A), legacy);
  fs.rmSync(path.join(f.root, 'SoduWorkLibrary'), { recursive: true, force: true });
  assert.equal(fs.existsSync(path.join(legacy, 'index.json')), true);
  const listed = await f.call('list', { scope: 'all' });
  assert.equal(listed.items[0].filename, 'legacy.txt');
  assert.equal(fs.existsSync(path.join(f.account(), 'index.json')), true);
  assert.equal(Buffer.from((await f.call('readBinary', { id: listed.items[0].id })).data, 'base64').toString(), 'legacy bytes');
});

test('trash retains bytes, restores to root after folder deletion, and purges only deleted files', async t => {
  const f = fixture(t), folder = (await f.call('createFolder', { name: '临时' })).folder;
  const item = (await create(f, { folderId: folder.id })).item;
  await assert.rejects(f.call('purgeItem', { id: item.id }), /回收站/);
  await f.call('deleteItem', { id: item.id });
  assert.equal((await f.call('list')).items.length, 0);
  assert.equal((await f.call('list', { scope: 'trash' })).trashCount, 1);
  await assert.rejects(f.call('readBinary', { id: item.id }), /不存在|回收站/);
  await f.call('deleteFolder', { id: folder.id });
  assert.equal((await f.call('restoreItem', { id: item.id })).item.folderId, null);
  assert.equal((await f.call('readContent', { id: item.id })).content, '原始内容');
  await f.call('deleteItem', { id: item.id }); await f.call('purgeItem', { id: item.id });
  const a = (await create(f, { title: 'a' })).item, b = (await create(f, { title: 'b' })).item, live = (await create(f, { title: 'live' })).item;
  await f.call('deleteItem', { id: a.id }); await f.call('deleteItem', { id: b.id });
  assert.equal((await f.call('emptyTrash')).purged, 2);
  assert.equal((await f.call('list')).items[0].id, live.id);
  assert.equal((await f.call('list', { scope: 'trash' })).items.length, 0);
});

test('binary import preserves source and exact empty/non-text bytes; reveal/open/export use local files', async t => {
  const f = fixture(t), source = path.join(f.root, 'source.bin'), bytes = Buffer.from([0, 255, 1, 128]);
  fs.writeFileSync(source, bytes);
  const item = (await f.call('upload', { name: '../数据.bin', dataBase64: fs.readFileSync(source).toString('base64') })).item;
  assert.deepEqual(fs.readFileSync(source), bytes);
  assert.deepEqual(Buffer.from((await f.call('readBinary', { id: item.id })).data, 'base64'), bytes);
  await f.call('reveal', { id: item.id }); assert.ok(f.revealed[0].startsWith(f.account()));
  await assert.rejects(f.call('openExternal', { id: item.id }), /系统|格式|打开/);
  const empty = (await f.call('upload', { name: 'empty.txt', dataBase64: '' })).item;
  assert.equal((await f.call('readBinary', { id: empty.id })).size, 0);
  await f.call('openExternal', { id: empty.id }); assert.ok(f.opened[0].startsWith(f.account()));
  await f.call('exportFile', { id: item.id }); assert.deepEqual(fs.readFileSync(path.join(f.root, 'export.txt')), bytes);
  await assert.rejects(f.call('upload', { name: 'bad', dataBase64: 'not base64!' }), /编码/);
});

test('trusted sender, account isolation, forged IDs and stale owner are rejected', async t => {
  const f = fixture(t), item = (await create(f)).item;
  f.setOwner(OWNER_B);
  assert.equal((await f.call('list')).items.length, 0);
  for (const action of ['readBinary', 'readContent', 'updateItem', 'deleteItem', 'restoreItem', 'purgeItem', 'reveal']) {
    await assert.rejects(f.call(action, { id: item.id }), /不存在/);
  }
  await assert.rejects(f.call('list', { owner: OWNER_A }), /账号/);
  await assert.rejects(f.call('readBinary', { id: '../../secret' }), /标识|不存在/);
  await assert.rejects(f.call('createItem', { folderId: 'local-folder-foreign' }), /文件夹/);
  const childFrame = { ...f.event, senderFrame: {} };
  await assert.rejects(f.handlers.get('library-local-call')(childFrame, 'list', { owner: OWNER_B }), /窗口|页面/);
  f.setOwner(''); await assert.rejects(f.call('list'), /登录|账号/);
  f.setOwner(OWNER_A); assert.equal((await f.call('list')).items[0].id, item.id);
});

test('account change during native save dialog never exports the old account file', async t => {
  const f = fixture(t), item = (await create(f)).item;
  f.deps.dialog.showSaveDialog = async () => { f.setOwner(OWNER_B); return { canceled: false, filePath: path.join(f.root, 'leak.txt') }; };
  await assert.rejects(f.call('exportFile', { id: item.id }), /账号/);
  assert.equal(fs.existsSync(path.join(f.root, 'leak.txt')), false);
});

test('read uses externally edited original bytes and rejects an account switch while IO is pending', async t => {
  const f = fixture(t), item = (await create(f)).item;
  await f.call('reveal', { id: item.id });
  fs.writeFileSync(f.revealed[0], 'edited in system application');
  const fresh = await f.call('readBinary', { id: item.id });
  assert.equal(Buffer.from(fresh.data, 'base64').toString(), 'edited in system application');
  assert.equal(fresh.size, Buffer.byteLength('edited in system application'));
  const original = fsp.readFile;
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  fsp.readFile = async (file, ...args) => {
    const bytes = await original(file, ...args);
    if (file === f.revealed[0]) { entered(); await gate; }
    return bytes;
  };
  try {
    const reading = f.call('readBinary', { id: item.id });
    await started; f.setOwner(OWNER_B); release();
    await assert.rejects(reading, /账号/);
  } finally { release(); fsp.readFile = original; }
});

test('metadata updates retain source and extras, and native export cancellation leaves no file', async t => {
  const f = fixture(t), item = (await create(f, { extra: { important: 'preserved' }, sourceType: 'conversation', sessionId: 'session-one', conversationTitle: '对话' })).item;
  assert.equal(item.sessionId, 'session-one'); assert.equal(item.conversationTitle, '对话');
  const updated = (await f.call('updateItem', { id: item.id, body: { extra: { lastRemoteCopy: { id: 'remote-copy', storage: 'nfs' } } } })).item;
  assert.equal(updated.extra.important, 'preserved'); assert.equal(updated.extra.lastRemoteCopy.id, 'remote-copy');
  assert.equal((await f.call('readContent', { id: item.id })).content, '原始内容');
  f.deps.dialog.showSaveDialog = async () => ({ canceled: true });
  assert.equal((await f.call('exportFile', { id: item.id })).cancelled, true);
  assert.equal(fs.existsSync(path.join(f.root, 'export.txt')), false);
  const imported = (await f.call('upload', { name: 'conversation.txt', dataBase64: data('saved output'), source: { type: 'conversation', sessionId: 'upload-session', conversationTitle: '上传对话' } })).item;
  assert.equal(imported.sourceType, 'conversation'); assert.equal(imported.sessionId, 'upload-session');
  assert.equal(imported.sourceLabel, '对话');
});

test('serial mutations do not lose concurrent edits and index failure preserves previous bytes', async t => {
  const f = fixture(t), item = (await create(f)).item;
  await Promise.all([f.call('updateItem', { id: item.id, content: 'new bytes' }), f.call('updateItem', { id: item.id, favorite: true })]);
  assert.equal((await f.call('readContent', { id: item.id })).content, 'new bytes');
  assert.equal((await f.call('list')).items[0].favorite, true);
  const original = fsp.rename;
  fsp.rename = async (from, to) => { if (to === path.join(f.account(), 'index.json')) { const e = Error('disk full'); e.code = 'ENOSPC'; throw e; } return original(from, to); };
  try { await assert.rejects(f.call('updateItem', { id: item.id, content: 'lost write' }), /disk full/); }
  finally { fsp.rename = original; }
  f.install(); assert.equal((await f.call('readContent', { id: item.id })).content, 'new bytes');
});

test('corrupt index fails closed, and directory links cannot redirect local library writes', async t => {
  const f = fixture(t); await f.call('status');
  fs.writeFileSync(path.join(f.account(), 'index.json'), '{broken');
  await assert.rejects(f.call('list'), /索引|损坏/);
  await assert.rejects(create(f), /索引|损坏/);
  assert.equal(fs.readFileSync(path.join(f.account(), 'index.json'), 'utf8'), '{broken');
  f.setOwner(OWNER_B);
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, f.account(OWNER_B), 'junction');
  await assert.rejects(create(f), /链接|目录/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('UTF-8 BOM does not invalidate an otherwise valid local index', async t => {
  const f = fixture(t), row = (await create(f)).item;
  const indexPath = path.join(f.account(), 'index.json');
  const content = fs.readFileSync(indexPath, 'utf8');
  fs.writeFileSync(indexPath, '\uFEFF' + content, 'utf8');
  const listed = await f.call('list');
  assert.equal(listed.items[0].id, row.id);
  assert.equal((await f.call('readContent', { id: row.id })).content, '原始内容');
});

test('large valid base64 imports include 8MiB and the 64MiB boundary without regex stack overflow', async t => {
  const f = fixture(t);
  for (const size of [8 * 1024 * 1024, 64 * 1024 * 1024]) {
    const encoded = Buffer.alloc(size, 173).toString('base64');
    const item = (await f.call('upload', { name: 'large-' + size + '.bin', dataBase64: encoded })).item;
    assert.equal(item.size, size);
    await f.call('reveal', { id: item.id }); assert.equal(fs.statSync(f.revealed.at(-1)).size, size);
    if (size === 64 * 1024 * 1024) await assert.rejects(f.call('upload', { name: 'too-large.bin', dataBase64: encoded + 'AAAA' }), /64MB/);
  }
});

test('an index commit failure after object creation reclaims only the uncommitted new object', async t => {
  const f = fixture(t), item = (await create(f)).item;
  await f.call('reveal', { id: item.id }); const originalPath = f.revealed[0];
  const original = fsp.rename; let writes = 0;
  fsp.rename = async (from, to) => {
    if (to === path.join(f.account(), 'index.json') && ++writes === 2) { const error = Error('commit failed'); error.code = 'ENOSPC'; throw error; }
    return original(from, to);
  };
  try { await assert.rejects(f.call('updateItem', { id: item.id, content: 'uncommitted bytes' }), /commit failed/); }
  finally { fsp.rename = original; }
  assert.equal((await f.call('readContent', { id: item.id })).content, '原始内容');
  assert.equal(fs.existsSync(originalPath), true);
  assert.equal(fs.readdirSync(path.join(f.account(), 'objects')).length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.account(), 'index.json'))).garbage, []);
});

test('native exports reject every account library directory including Windows case variants', async t => {
  const f = fixture(t), item = (await create(f)).item;
  let destination = path.join(f.account(OWNER_B), 'index.json');
  f.deps.dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
  await assert.rejects(f.call('exportFile', { id: item.id }), /内部目录/);
  if (process.platform === 'win32') {
    destination = path.join(f.account(), 'index.json').toUpperCase();
    await assert.rejects(f.call('exportFile', { id: item.id }), /内部目录/);
  }
  assert.equal((await f.call('list')).items.length, 1);
});

test('account switch after writing staged bytes safely reclaims the uncommitted account file', async t => {
  const f = fixture(t), original = fsp.writeFile;
  fsp.writeFile = async (file, ...args) => {
    const result = await original(file, ...args);
    if (String(file).includes(path.sep + 'objects' + path.sep)) f.setOwner(OWNER_B);
    return result;
  };
  try { await assert.rejects(create(f), /账号/); }
  finally { fsp.writeFile = original; }
  f.setOwner(OWNER_A);
  assert.equal((await f.call('list')).items.length, 0);
  assert.deepEqual(fs.readdirSync(path.join(f.account(), 'objects')), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.account(), 'index.json'))).garbage, []);
});

test('account switch after the index commit never deletes the newly committed referenced bytes', async t => {
  const f = fixture(t), item = (await create(f)).item, original = fsp.rename;
  let writes = 0;
  fsp.rename = async (from, to) => {
    const result = await original(from, to);
    if (to === path.join(f.account(), 'index.json') && ++writes === 2) f.setOwner(OWNER_B);
    return result;
  };
  try { await assert.rejects(f.call('updateItem', { id: item.id, content: 'committed safely' }), /账号/); }
  finally { fsp.rename = original; }
  f.setOwner(OWNER_A);
  assert.equal((await f.call('readContent', { id: item.id })).content, 'committed safely');
  assert.equal(fs.readdirSync(path.join(f.account(), 'objects')).length, 1);
});
