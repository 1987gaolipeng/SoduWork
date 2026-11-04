'use strict';

// Mobile invokes the existing account-owned PC library, never arbitrary paths or OS actions.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const storage = require('./library-local-store.cjs');
const { execute } = require('./library-local-actions.cjs');
const { diskJournal } = require('./automation-conversations');
const CHUNK = 192 * 1024, LIMIT = 32 * 1024 * 1024;
const READ = new Set(['list', 'status', 'readChunk', 'readContent']);
const WRITE = new Set(['createFolder', 'updateFolder', 'deleteFolder', 'createItem', 'updateItem',
  'recordRemoteCopy', 'deleteItems', 'deleteItem', 'restoreItem', 'purgeItem', 'emptyTrash', 'uploadChunk', 'uploadFinish']);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
async function transferDir(app, owner, root, transfer) {
  const base = path.resolve(app.getPath('userData'), 'mobile-library-transfers');
  await fs.mkdir(base, { recursive: true });
  if ((await fs.lstat(base)).isSymbolicLink()) throw Error('临时资料目录包含链接');
  const dir = path.join(base, digest(JSON.stringify([owner, root, transfer])));
  let active = 0;
  for (const name of await fs.readdir(base)) {
    if (!/^[a-f0-9]{64}$/.test(name)) continue;
    const target = path.resolve(base, name), stat = await fs.lstat(target);
    if (path.dirname(target) !== base || stat.isSymbolicLink() || !stat.isDirectory()) continue;
    if (Date.now() - stat.mtimeMs > 24 * 3600 * 1000) await fs.rm(target, { recursive: true });
    else if (target !== dir) active++;
  }
  if (active >= 8) throw Error('待传文件较多，请完成当前上传后重试');
  await fs.mkdir(dir, { recursive: true });
  if ((await fs.lstat(dir)).isSymbolicLink()) throw Error('临时资料目录包含链接');
  return dir;
}
const clean = value => {
  if (Array.isArray(value)) return value.map(clean);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !['_object', 'path', 'workRoot', 'extra'].includes(k))
    .map(([k, v]) => [k, clean(v)]));
};

function create({ app, ownerOf = () => require('./device-auth').localOwner(app),
  rootOf = () => require('./device-auth').libraryWorkRoot(app) }) {
  const receipts = diskJournal(path.join(app.getPath('userData'), 'mobile-library-receipts'));
  return async function call(args, requestId, authorize) {
    if (!args || !READ.has(args.action) && !WRITE.has(args.action) ||
        Object.keys(args).some(k => !['action', 'id', 'body'].includes(k))) throw Error('资料操作不正确');
    const owner = ownerOf(), root = rootOf(), body = args.body || {};
    const guard = () => {
      if (!storage.OWNER.test(owner) || owner !== ownerOf() || root !== rootOf()) throw Error('账号或资料库位置已变化，请重新打开');
    };
    guard();
    const store = storage.create(app, owner, guard, root);
    const key = digest(JSON.stringify([owner, root, requestId]));
    const fingerprint = digest(JSON.stringify(args));
    const previous = WRITE.has(args.action) && receipts.read(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw Error('操作编号已使用');
      if (previous.result) return previous.result;
      throw Error('上次保存结果未确认，请刷新资料库核对；不会重复操作');
    }
    // Only explicitly supported fields reach the local service.
    const allowed = new Set(['scope', 'query', 'folderId', 'parentId', 'name', 'title', 'favorite', 'content',
      'remoteId', 'storage', 'filename', 'ids', 'kind', 'format', 'contentType', 'offset', 'revision', 'transfer', 'data', 'size', 'sha256', 'source', 'expectedUpdatedAt', 'expectedContentRevision']);
    if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !allowed.has(k))) throw Error('资料参数不正确');
    if (body.source && (typeof body.source !== 'object' || Object.keys(body.source).some(k => !['type', 'sessionId', 'conversationTitle'].includes(k)))) throw Error('资料来源不正确');
    if (WRITE.has(args.action)) await authorize();
    guard();
    const result = await store.run(async index => {
      if (args.action === 'updateItem' && body.expectedUpdatedAt != null) {
        const row = index.items.find(x => x.id === args.id && !x.deletedAt);
        if (!row || row.updatedAt !== body.expectedUpdatedAt) throw Error('资料已在其他地方修改，请重新打开后核对；未覆盖原内容');
      }
      if (args.action === 'updateItem' && body.expectedContentRevision != null) {
        const current = await execute(store, index, 'readContent', { id: args.id });
        if (digest(current.content) !== body.expectedContentRevision) throw Error('资料已在电脑修改，请重新打开后核对；未覆盖原内容');
      }
      if (args.action === 'list') {
        const result = await execute(store, index, 'list', body);
        const offset = Number(body.offset || 0);
        if (!Number.isSafeInteger(offset) || offset < 0) throw Error('分页参数不正确');
        const count = 50, total = Math.max(result.items.length, result.folders.length);
        const page = result.items.slice(offset, offset + count);
        for (const visible of page) {
          const prior = visible.extra?.lastRemoteCopy;
          if (prior && ['minio', 'nfs'].includes(prior.storage)) {
            visible.remoteCopy = {id: prior.id, storage: prior.storage, folderId: prior.folderId || ''};
          }
          if (typeof visible.extra?.hidden === 'boolean') visible.hidden = visible.extra.hidden;
          visible.deliverySnapshot = Boolean(visible.extra?.soduWorkDelivery);
          const row = index.items.find(x => x.id === visible.id);
          if (!row || row.deletedAt) continue;
          try { visible.size = (await store.checkedFile(await store.locate(row))).size; }
          catch (_) { /* Keep missing-file metadata visible so it can be recovered. */ }
        }
        return clean({ ...result, items: page,
          folders: result.folders.slice(offset, offset + count), nextOffset: offset + count < total ? offset + count : null });
      }
      if (args.action === 'readChunk') {
        const row = index.items.find(x => x.id === args.id && !x.deletedAt);
        if (!row) throw Error('资料不存在或已在回收站');
        const offset = Number(body.offset || 0);
        if (!Number.isSafeInteger(offset) || offset < 0) throw Error('读取位置不正确');
        const file = await store.checkedFile(await store.locate(row));
        if (file.size > LIMIT) throw Error('手机读取支持最大 32 MB 的文件');
        if (offset > file.size) throw Error('文件已变化，请刷新');
        const bytes = await store.read(row); guard();
        if (bytes.length > LIMIT) throw Error('手机读取支持最大 32 MB 的文件');
        const checksum = digest(bytes);
        const revision = digest(JSON.stringify([row.id, row._object, row.updatedAt, checksum]));
        if (offset && body.revision !== revision || body.revision && body.revision !== revision) throw Error('文件已变化，请重新读取');
        return { ok: true, data: bytes.subarray(offset, offset + CHUNK).toString('base64'), revision,
          sha256: checksum, size: bytes.length, offset, name: row.filename, contentType: row.contentType };
      }
      if (args.action === 'readContent') {
        const row = index.items.find(x => x.id === args.id && !x.deletedAt);
        if (!row || (await store.checkedFile(await store.locate(row))).size > 256 * 1024) throw Error('此文件请下载查看；在线文本编辑支持 256 KB');
        const result = await execute(store, index, 'readContent', { id: args.id });
        if (result.preview.totalBytes > 256 * 1024) throw Error('此文件请下载查看；在线文本编辑支持 256 KB');
        return clean({ ...result, item: { ...result.item, size: result.preview.totalBytes }, contentRevision: digest(result.content) });
      }
      if (args.action === 'uploadChunk' || args.action === 'uploadFinish') {
        if (!/^[a-zA-Z0-9_-]{8,80}$/.test(body.transfer || '') || !Number.isSafeInteger(body.size) || body.size < 1 || body.size > LIMIT) throw Error('上传信息不正确，手机文件最大 32 MB');
        const dir = await transferDir(app, owner, root, body.transfer);
        const metaPath = path.join(dir, 'meta.json'), meta = JSON.stringify({ owner, root, size: body.size });
        try { await fs.writeFile(metaPath, meta, { flag: 'wx' }); }
        catch (e) { if (e.code !== 'EEXIST') throw e; }
        if ((await fs.lstat(metaPath)).isSymbolicLink() || await fs.readFile(metaPath, 'utf8') !== meta) throw Error('上传编号已使用');
        if (args.action === 'uploadChunk') {
          const offset = body.offset, data = body.data;
          if (!Number.isSafeInteger(offset) || offset < 0 || offset % CHUNK || offset >= body.size || typeof data !== 'string' || data.length > CHUNK * 4 / 3) throw Error('文件分块不正确');
          const bytes = Buffer.from(data, 'base64');
          if (bytes.toString('base64') !== data || bytes.length !== Math.min(CHUNK, body.size - offset)) throw Error('文件分块不完整');
          const chunk = path.join(dir, String(offset));
          try { await fs.writeFile(chunk, bytes, { flag: 'wx' }); }
          catch (e) {
            if (e.code !== 'EEXIST') throw e;
            if ((await fs.lstat(chunk)).isSymbolicLink() || !(await fs.readFile(chunk)).equals(bytes)) throw Error('文件分块冲突');
          }
          return { ok: true, offset, size: bytes.length };
        }
        const parts = [];
        for (let offset = 0; offset < body.size; offset += CHUNK) {
          const chunk = path.join(dir, String(offset));
          if ((await fs.lstat(chunk)).isSymbolicLink()) throw Error('文件分块包含链接');
          const bytes = await fs.readFile(chunk);
          if (bytes.length !== Math.min(CHUNK, body.size - offset)) throw Error('上传尚未完整');
          parts.push(bytes);
        }
        const bytes = Buffer.concat(parts); guard();
        if (digest(bytes) !== body.sha256) throw Error('上传校验失败，请重新选择文件');
        await authorize(); guard();
        // The existing output receipt makes a crash after commit safe to retry.
        const result = await execute(store, index, 'upload', { name: body.name, folderId: body.folderId,
          contentType: body.contentType, dataBase64: bytes.toString('base64'), dedupeFolder: true,
          source: { ...body.source, outputKey: 'mobile-library:' + key } });
        // Keep chunks until the durable success receipt has been written below.
        return clean(result);
      }
      if (args.action === 'recordRemoteCopy') {
        if (!['minio', 'nfs'].includes(body.storage) || typeof body.remoteId !== 'string' ||
            !/^[a-z0-9-]{1,100}$/i.test(body.remoteId)) throw Error('远程副本回执无效');
        receipts.write(key, { fingerprint });
        return clean(await execute(store, index, 'updateItem', {id: args.id, body: {extra: {lastRemoteCopy: {
          id: body.remoteId, storage: body.storage, folderId: '', copiedAt: new Date().toISOString(),
        }}}}));
      }
      if (args.action === 'deleteItems' && (!Array.isArray(body.ids) || body.ids.length > 100 || !body.ids.length)) throw Error('一次可选择 1 至 100 份资料');
      if (WRITE.has(args.action)) receipts.write(key, { fingerprint });
      return clean(await execute(store, index, args.action, { id: args.id, body }));
    });
    guard();
    if (WRITE.has(args.action)) receipts.write(key, { fingerprint, result });
    if (args.action === 'uploadFinish') {
      const base = path.resolve(app.getPath('userData'), 'mobile-library-transfers');
      const dir = path.resolve(base, digest(JSON.stringify([owner, root, body.transfer])));
      // Cleanup must not turn an already committed save into an apparent failure.
      try {
        if (path.dirname(dir) === base && !(await fs.lstat(dir)).isSymbolicLink()) await fs.rm(dir, { recursive: true });
      } catch (_) { /* A subsequent transfer removes stale temporary chunks. */ }
    }
    return result;
  };
}
module.exports = { create, CHUNK, LIMIT };
