'use strict';
const crypto = require('node:crypto');
const { safeFilename } = require('./attachment-files.js');
const { error, clone, ITEM, FOLDER, MAX_BYTES } = require('./library-local-store.cjs');
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const now = () => new Date().toISOString();
const publicRow = row => { const result = clone(row); delete result._object; return result; };
const outputKeys = row => Array.isArray(row.extra?.outputKeys) ? row.extra.outputKeys.filter(x => typeof x === 'string') : [];
function folder(index, id) {
  if (!id) return null;
  const row = FOLDER.test(String(id)) && index.folders.find(x => x.id === id);
  if (!row) throw error('LOCAL_LIBRARY_NOT_FOUND', '文件夹不存在或不属于当前账号');
  return row;
}
function item(index, id, deleted = false) {
  const row = ITEM.test(String(id)) && index.items.find(x => x.id === id);
  if (!row || (!deleted && row.deletedAt)) throw error('LOCAL_LIBRARY_NOT_FOUND', '资料不存在或已在回收站');
  return row;
}
function name(value, fallback) { return safeFilename(String(value || '').trim(), fallback).slice(0, 160); }
const nameKey = value => String(value || '').normalize('NFC').toLowerCase();
function visibleFilename(row) {
  const title = name(row.title, row.filename), suffix = row.filename.match(/(\.[^./\\]+)$/)?.[1] || '';
  return name(title.toLowerCase().endsWith(suffix.toLowerCase()) ? title : title + suffix, row.filename);
}
function checkItemName(index, row) {
  const key = nameKey(visibleFilename(row));
  if (index.items.some(other => other.id !== row.id && !other.deletedAt && other.folderId === row.folderId && nameKey(visibleFilename(other)) === key) ||
      index.folders.some(other => other.parentId === row.folderId && nameKey(other.name) === key)) {
    throw error('LIBRARY_NAME_CONFLICT', '当前文件夹下已有同名资料，请重命名后重试');
  }
}
function favorite(body, row) {
  if (has(body, 'favorite')) {
    if (typeof body.favorite !== 'boolean') throw error('LOCAL_LIBRARY_INVALID', '收藏状态必须为布尔值');
    row.favorite = body.favorite;
  }
}
function extra(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = clone(value);
  if (JSON.stringify(result).length > 256 * 1024) throw error('LOCAL_LIBRARY_INVALID', '资料附加信息过大');
  return result;
}
function source(body) {
  const input = body.source && typeof body.source === 'object' ? body.source : body;
  const requested = input.sourceType || input.type;
  const kind = ['library', 'conversation', 'task'].includes(requested) ? requested : 'library';
  const session = String(input.sessionId || input.sourceSessionId || '').slice(0, 128);
  const title = String(input.conversationTitle || input.sourceConversationTitle || '').slice(0, 240);
  return { sourceType: kind, sourceLabel: kind === 'conversation' ? '对话' : kind === 'task' ? '任务' : '资料库', sessionId: session, conversationTitle: title, sourceSessionId: session || null, sourceConversationTitle: title || null };
}
function classify(filename, mime) {
  if (/^image\//.test(mime) || /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(filename)) return 'image';
  if (/\.(xlsx?|csv|ods)$/i.test(filename)) return 'spreadsheet';
  if (/\.(pptx?|odp)$/i.test(filename)) return 'presentation';
  if (/\.(txt|md|markdown|docx?|pdf|html?|rtf)$/i.test(filename)) return 'document';
  return 'file';
}
function binary(body) {
  if (typeof body.dataBase64 !== 'string' || body.dataBase64.length > Math.ceil(MAX_BYTES / 3) * 4 ||
      body.dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.dataBase64)) {
    throw error('LOCAL_LIBRARY_INVALID', '文件编码无效或超过 64MB');
  }
  const bytes = Buffer.from(body.dataBase64, 'base64');
  if (bytes.toString('base64') !== body.dataBase64) throw error('LOCAL_LIBRARY_INVALID', '文件编码无效');
  return bytes;
}
function textBytes(row, body) {
  const format = String(body.format || '').toLowerCase();
  if (['spreadsheet', 'presentation'].includes(row.kind) || (row.kind === 'document' && format && !['txt', 'md', 'markdown'].includes(format))) {
    throw error('LOCAL_LIBRARY_FORMAT_UNSUPPORTED', '请使用本机应用创建此格式后导入；文本新建支持 TXT 和 Markdown');
  }
  if (typeof body.content !== 'string' && body.content != null) throw error('LOCAL_LIBRARY_INVALID', '文档内容必须为文本');
  return Buffer.from(body.content || '', 'utf8');
}
async function execute(store, index, action, payload) {
  const body = payload.body && typeof payload.body === 'object' ? payload.body : payload;
  if ((body.storage && body.storage !== 'local') || (body.backend && body.backend !== 'local')) throw error('LOCAL_LIBRARY_INVALID', '本机资料不能直接切换服务器存储，请创建远程副本');
  if (action === 'status') return { ok: true, backend: 'local', configured: true, available: true, state: 'ready', code: 'OK', message: '存储在当前电脑' };
  if (action === 'outputStatus') {
    const key = String(body.outputKey || '');
    if (key.length > 4096) throw error('LOCAL_LIBRARY_INVALID', '成果标识过长');
    const row = key && index.items.find(x => !x.deletedAt && outputKeys(x).includes(key));
    if (row) {
      try { await store.locate(row); return { ok: true, item: publicRow(row) }; }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    if (key && /^[a-f0-9]{64}$/i.test(body.sha256 || '')) {
      for (const existing of index.items.filter(x => !x.deletedAt && x.filename === body.name && x.size === body.size)) {
        let bytes;
        try { bytes = await store.read(existing); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== body.sha256.toLowerCase()) continue;
        existing.extra ||= {}; existing.extra.outputKeys = [...new Set([...outputKeys(existing), key])];
        await store.save(index); return { ok: true, item: publicRow(existing) };
      }
    }
    return { ok: true, item: null };
  }
  if (action === 'list') {
    const scope = ['all', 'folders', 'favorites', 'images', 'trash', 'recommended'].includes(body.scope) ? body.scope : 'recommended';
    const current = ['all', 'folders'].includes(scope) ? folder(index, body.folderId) : null;
    const query = String(body.query || '').trim().toLowerCase();
    const folders = ['all', 'folders', 'favorites'].includes(scope) ? index.folders.filter(x =>
      (scope === 'favorites' ? x.favorite : x.parentId === (current?.id || null)) && x.name.toLowerCase().includes(query)).map(x => ({ ...publicRow(x),
        itemCount: index.items.filter(i => i.folderId === x.id && !i.deletedAt).length,
        childCount: index.folders.filter(i => i.parentId === x.id).length })).sort((a, b) => a.name.localeCompare(b.name)) : [];
    let items = scope === 'folders' ? [] : index.items.filter(x => Boolean(x.deletedAt) === (scope === 'trash') &&
      (!['all', 'folders'].includes(scope) || x.folderId === (current?.id || null)) &&
      (scope !== 'favorites' || x.favorite) && (scope !== 'images' || x.kind === 'image') &&
      (!query || (x.title + ' ' + x.filename).toLowerCase().includes(query)));
    items = items.sort((a, b) => ['recommended', 'images', 'trash'].includes(scope) ? String(b.deletedAt || b.updatedAt).localeCompare(a.deletedAt || a.updatedAt) : a.title.localeCompare(b.title));
    return { ok: true, scope, storage: 'local', folder: current ? publicRow(current) : null, folders, items: items.map(publicRow), trashCount: index.items.filter(x => x.deletedAt).length };
  }
  if (action === 'createFolder' || action === 'updateFolder') {
    const row = action === 'createFolder' ? { id: 'local-folder-' + crypto.randomUUID(), parentId: folder(index, body.parentId)?.id || null,
      backend: 'local', favorite: false, createdAt: now() } : folder(index, payload.id);
    if (action === 'createFolder' || has(body, 'name')) {
      if (has(body, 'name') && !String(body.name || '').trim()) throw error('LOCAL_LIBRARY_INVALID', '文件夹名称不能为空');
      row.name = name(body.name, '新建文件夹');
      if (index.folders.some(x => x.id !== row.id && x.parentId === row.parentId && nameKey(x.name) === nameKey(row.name))) throw error('LIBRARY_NAME_CONFLICT', '当前文件夹下已有同名文件夹');
      if (index.items.some(x => !x.deletedAt && x.folderId === row.parentId && nameKey(visibleFilename(x)) === nameKey(row.name))) throw error('LIBRARY_NAME_CONFLICT', '当前文件夹下已有同名资料，请重命名后重试');
    }
    favorite(body, row); row.updatedAt = now();
    if (action === 'createFolder') index.folders.push(row);
    await store.save(index); return { ok: true, folder: publicRow(row) };
  }
  if (action === 'deleteFolder') {
    const row = folder(index, payload.id);
    if (index.folders.some(x => x.parentId === row.id) || index.items.some(x => x.folderId === row.id && !x.deletedAt)) throw error('LOCAL_LIBRARY_CONFLICT', '文件夹非空，请先移除资料和子文件夹');
    index.folders = index.folders.filter(x => x.id !== row.id); await store.save(index); return { ok: true };
  }
  if (action === 'createItem' || action === 'upload') {
    const timestamp = now(), imported = action === 'upload';
    const format = String(body.format || '').toLowerCase(), suffix = ['md', 'markdown'].includes(format) ? '.md' : '.txt';
    const filename = name(imported ? body.name : body.filename, name(body.title, '未命名资料') + suffix);
    const contentType = String(body.contentType || (imported ? 'application/octet-stream' : suffix === '.md' ? 'text/markdown' : 'text/plain')).slice(0, 160);
    const row = { id: 'local-' + crypto.randomUUID(), folderId: folder(index, body.folderId)?.id || null,
      kind: imported ? classify(filename, contentType) : String(body.kind || 'note'), title: name(body.title, filename), filename, contentType,
      backend: 'local', favorite: false, extra: extra(body.extra), ...source(body), createdAt: timestamp, updatedAt: timestamp, lastOpenedAt: null, deletedAt: null, isDeleted: false };
    const bytes = imported ? binary(body) : textBytes(row, body); row.size = bytes.length;
    const outputKey = imported && String(body.source?.outputKey || '');
    if (outputKey) {
      if (outputKey.length > 4096) throw error('LOCAL_LIBRARY_INVALID', '成果标识过长');
      // Compare actual bytes: this also recognizes pre-upgrade saves without
      // output metadata, while preserving independently changed versions.
      for (const existing of index.items.filter(x => !x.deletedAt && x.filename === filename && x.size === bytes.length)) {
        let saved;
        try { saved = await store.read(existing); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        if (!saved.equals(bytes)) continue;
        existing.extra ||= {};
        existing.extra.outputKeys = [...new Set([...outputKeys(existing), outputKey])];
        await store.save(index);
        return { ok: true, item: publicRow(existing), duplicate: true };
      }
      row.extra.outputKeys = [outputKey];
    }
    // An existing output receipt is idempotent; only new files need name validation.
    if (row.sourceType !== 'conversation' || body.rejectDuplicateName === true) checkItemName(index, row);
    row._object = await store.write(bytes, filename, index); index.items.push(row);
    await store.save(index); return { ok: true, item: publicRow(row) };
  }
  if (action === 'emptyTrash' || action === 'purgeItem') {
    const rows = action === 'emptyTrash' ? index.items.filter(x => x.deletedAt) : [item(index, payload.id, true)];
    if (rows.some(x => !x.deletedAt)) throw error('LOCAL_LIBRARY_CONFLICT', '只能彻底删除回收站中的资料');
    index.garbage.push(...rows.map(x => x._object)); const ids = new Set(rows.map(x => x.id));
    index.items = index.items.filter(x => !ids.has(x.id)); await store.save(index); await store.garbageCollect(index);
    return { ok: true, purged: action === 'emptyTrash' ? rows.length : true };
  }
  if (action === 'deleteItems') {
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(value => String(value || '').trim()).filter(Boolean))];
    const succeeded = [], failed = [];
    for (const id of ids) {
      try {
        const row = item(index, id);
        row.deletedAt = now(); row.isDeleted = true; row.favorite = false;
        succeeded.push(publicRow(row));
      } catch (failure) {
        failed.push({ id, code: failure.code || 'LOCAL_LIBRARY_ERROR', message: failure.message || String(failure) });
      }
    }
    await store.save(index); store.guard();
    return { ok: true, succeeded, failed };
  }
  const row = item(index, payload.id, action === 'restoreItem');
  if (action === 'readBinary' || action === 'readContent') {
    const bytes = await store.read(row);
    if (action === 'readBinary') return { ok: true, data: bytes.toString('base64'), name: visibleFilename(row), mimeType: row.contentType, size: bytes.length, item: publicRow(row) };
    if (!/\.(txt|md|markdown|csv|html?|json|xml|ya?ml|log|svg|css|js|ts|py|ini|toml)$/i.test(row.filename) && !/^text\//.test(row.contentType)) throw error('LOCAL_LIBRARY_FORMAT_UNSUPPORTED', '此格式请使用系统应用查看，不会上传到服务器预览');
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw error('LOCAL_LIBRARY_ENCODING_UNSUPPORTED', '文件不是 UTF-8 文本，请使用系统应用查看'); }
    return { ok: true, item: publicRow(row), content, preview: { encoding: 'utf-8', truncated: false, totalBytes: bytes.length } };
  }
  if (['openExternal', 'reveal', 'exportFile'].includes(action)) {
    const filename = visibleFilename(row);
    return { row: { ...row, filename }, target: await store.locate(row, filename) };
  }
  if (action === 'deleteItem') { row.deletedAt = now(); row.isDeleted = true; row.favorite = false; }
  else if (action === 'restoreItem') {
    if (!row.deletedAt) throw error('LOCAL_LIBRARY_CONFLICT', '资料不在回收站中');
    row.deletedAt = null; row.isDeleted = false;
    if (!index.folders.some(x => x.id === row.folderId)) row.folderId = null;
    // Conversation revisions intentionally keep independent same-name versions.
    if (row.sourceType !== 'conversation') checkItemName(index, row);
  } else if (action === 'associateSource') Object.assign(row, source(body));
  else if (action === 'updateItem') {
    let filenameChanged = false;
    if (has(body, 'folderId')) row.folderId = folder(index, body.folderId)?.id || null;
    if (has(body, 'title')) {
      const previousFilename = row.filename;
      row.title = name(body.title, row.title);
      row.filename = visibleFilename(row);
      filenameChanged = row.filename !== previousFilename;
    }
    if (has(body, 'title') || has(body, 'folderId')) checkItemName(index, row);
    favorite(body, row);
    if (has(body, 'extra')) row.extra = { ...row.extra, ...extra(body.extra) };
    if (has(body, 'content')) {
      if (!/\.(txt|md|markdown|csv|html?|json|xml|ya?ml|log|svg|css|js|ts|py|ini|toml)$/i.test(row.filename) && !/^text\//.test(row.contentType)) throw error('LOCAL_LIBRARY_FORMAT_UNSUPPORTED', '此格式请使用系统应用编辑');
      const bytes = textBytes(row, body), old = row._object;
      row._object = await store.write(bytes, row.filename, index); row.size = bytes.length; index.garbage.push(old);
    } else if (filenameChanged) {
      // Keep the object key in sync with the visible name. Write a new object
      // before committing metadata so a failed index save leaves the original
      // object usable and the staged copy reclaimable.
      const old = row._object;
      row._object = await store.write(await store.read(row), row.filename, index);
      index.garbage.push(old);
    }
  } else throw error('LOCAL_LIBRARY_ACTION_UNSUPPORTED', '不支持的本机资料操作');
  row.updatedAt = now(); await store.save(index);
  // A failed old-version cleanup must not turn a successful content commit
  // into a failed save. Its garbage entry remains for a later explicit purge.
  if (action === 'updateItem' && (has(body, 'content') || has(body, 'title'))) await store.garbageCollect(index).catch(() => {});
  store.guard();
  return { ok: true, item: publicRow(row), ...(action === 'deleteItem' ? { trashed: true } : action === 'restoreItem' ? { restored: true } : {}) };
}
module.exports = { execute };
