'use strict';

// Locate current files without exporting them, launching their contents, or
// confusing a cloud session's local cache with the computer that did the work.
const fs = require('node:fs/promises');
const path = require('node:path');
const artifacts = require('./artifact-runtime');
const { isTrusted } = require('../access-control/preferences');

const fail = (code, message) => Object.assign(Error(message), { code });
function within(root, target, allowRoot = false) {
  const relative = path.relative(root, target);
  return (!relative && allowRoot) || Boolean(relative && relative !== '..' &&
    !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
function install({ app, ipcMain, session, shell,
  ownerOf = app => require('../device-auth').localOwner(app),
  isRemote = handle => Boolean(handle.passiveCloudView),
  resolveSession = async handle => handle,
  snapshotFiles = artifacts.snapshotAsync, fileSystem = fs }) {
  for (const action of ['open-local', 'continue-local', 'open-archive']) ipcMain.handle('conversation-delivery-' + action, async (event, ref, ids) => {
    try {
      if (!isTrusted(event)) throw fail('DELIVERY_FORBIDDEN', '请在 SoduWork 会话中打开成果位置');
      if (!Array.isArray(ids) || !ids.length || ids.length > 500 || new Set(ids).size !== ids.length ||
          ids.some(id => typeof id !== 'string' || !id || id.length > 200)) {
        throw fail('DELIVERY_INVALID_SELECTION', '请选择有效的本机成果');
      }
      const original = session.get(ref);
      if (!original) throw fail('DELIVERY_LOCAL_UNAVAILABLE', '会话已关闭，请重新打开');
      const handle = await resolveSession(original);
      const sourceDirectory = original.cwd;
      const cloudCache = handle !== original && handle.cloudArtifactCache === true;
      const directory = String(handle.cwd || '');
      const owner = handle.deliveryOwner;
      const validateHandle = () => {
        if (!isTrusted(event)) throw fail('DELIVERY_FORBIDDEN', '请在 SoduWork 会话中打开成果位置');
        if (session.get(ref) !== original || original.cwd !== sourceDirectory || handle.cwd !== directory) {
          throw fail('DELIVERY_CONTEXT_CHANGED', '会话已变化，请重新打开成果');
        }
        if (!cloudCache && (handle.passiveCloudView || isRemote(handle))) {
          throw fail('DELIVERY_REMOTE', '云端成果尚未回流，请稍后重新打开会话');
        }
        const state = handle.snapshot?.();
        if (handle.inFlight?.() || ['running', 'streaming', 'queued', 'compacting'].includes(state?.status)) {
          throw fail('DELIVERY_BUSY', '文件仍在生成，请等本轮完成后打开位置');
        }
      };
      const guard = async () => {
        validateHandle();
        if (cloudCache) {
          const currentView = await resolveSession(original);
          if (!currentView.cloudArtifactCache || currentView.cwd !== directory || currentView.deliveryOwner !== owner) {
            throw fail('DELIVERY_FORBIDDEN', '账号或服务已变化，请重新打开原会话');
          }
        }
        let current;
        try { current = await ownerOf(app); }
        catch { throw fail('DELIVERY_FORBIDDEN', '请先登录原账号，再打开本机成果'); }
        if (!owner || owner !== current || handle.deliveryOwner !== owner) {
          throw fail('DELIVERY_FORBIDDEN', '账号或服务已变化，请重新打开原会话');
        }
        validateHandle();
        if (handle.deliveryOwner !== owner) throw fail('DELIVERY_FORBIDDEN', '账号或服务已变化，请重新打开原会话');
      };
      await guard();
      const indexed = (await snapshotFiles(handle))?.items || [];
      const selected = ids.map(id => {
        const item = indexed.find(row => row.artifactId === id);
        if (!item) throw fail('DELIVERY_LOCAL_UNAVAILABLE', '本机成果已不存在，请查看已保存版本');
        return item;
      });
      const root = await fileSystem.realpath(directory);
      const resolve = async item => {
        if (!item.path || !within(path.resolve(directory), path.resolve(item.path))) {
          throw fail('DELIVERY_FORBIDDEN', '成果不在当前会话工作目录内');
        }
        const target = await fileSystem.realpath(item.path);
        if (!within(root, target)) throw fail('DELIVERY_FORBIDDEN', '成果链接指向工作目录以外');
        const stat = await fileSystem.stat(target);
        if (!stat.isFile()) throw fail('DELIVERY_FORBIDDEN', '成果不是普通文件');
        return target;
      };
      const targets = await Promise.all(selected.map(resolve));
      let folder = path.dirname(targets[0]);
      while (!targets.every(target => within(folder, target))) folder = path.dirname(folder);
      if (!within(root, folder, true)) throw fail('DELIVERY_FORBIDDEN', '成果文件夹超出会话工作目录');
      // Async disk checks yield to rendering. Recheck ownership and paths after
      // them so logout, session replacement, and symlink swaps cannot open files.
      await guard();
      if (await fileSystem.realpath(directory) !== root ||
          !(await Promise.all(selected.map(resolve))).every((target, i) => target === targets[i])) {
        throw fail('DELIVERY_CONTEXT_CHANGED', '成果位置已变化，请重新打开');
      }
      await guard();
      if (action === 'continue-local') {
        if (!cloudCache) throw fail('DELIVERY_INVALID_SELECTION', '请在当前本地会话继续操作');
        return await require('./cloud-result-local').create({ app, directory, owner, items: indexed, ids, guard });
      }
      if (action === 'open-archive') {
        const result = await require('./delivery-package-worker').prepare(handle, ids);
        const archive = await require('./local-delivery-archive').create({ app, owner, result, guard });
        shell.showItemInFolder(archive);
        return { ok: true };
      }
      if (targets.length === 1) shell.showItemInFolder(targets[0]);
      else {
        const error = await shell.openPath(folder);
        if (error) throw fail('DELIVERY_OPEN_FAILED', '无法打开成果文件夹，请检查本机文件管理器');
      }
      return { ok: true };
    } catch (error) {
      const missing = ['ENOENT', 'ENOTDIR'].includes(error.code);
      return { ok: false, code: missing ? 'DELIVERY_LOCAL_UNAVAILABLE' : error.code?.startsWith('DELIVERY_') ? error.code : 'DELIVERY_FORBIDDEN',
        reason: missing ? '本机成果已不存在，请查看已保存版本' : error.code?.startsWith('DELIVERY_') ? error.message : '暂时无法打开成果，请检查会话权限与本机文件' };
    }
  });
}
module.exports = { install };
