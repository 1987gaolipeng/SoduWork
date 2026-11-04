'use strict';

// History mutations belong to the archive, independent of a model session.
const conversationTitles = require('../conversation/titles');
const fs = require('node:fs/promises');
const path = require('node:path');
const historyAccess = require('../conversation/history-access');

// Prepare the current user's local recycle directory before asking the shell
// to delete anything. A failed preparation must leave the archive untouched.
const SID_PATTERN = /^S-1-\d+(?:-\d+)+$/;
function currentWindowsSid() {
  if (process.platform !== 'win32') return Promise.resolve('');
  return new Promise(resolve => {
    /* Use an absolute executable path to avoid incompatible Git Bash or MSYS tools on PATH. */
    const whoami = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe');
    require('node:child_process').execFile(whoami, ['/user', '/fo', 'csv', '/nh'],
      { timeout: 4000, windowsHide: true }, (error, stdout) => {
        if (error) return resolve('');
        const found = String(stdout || '').trim().match(/^"[^"\r\n]*","(S-1-\d+(?:-\d+)+)"$/);
        resolve(found ? found[1] : '');
      });
  });
}
async function ensureRecycleBinFor(volumeRoot) {
  if (process.platform !== 'win32' || !/^[a-z]:[\\/]$/i.test(volumeRoot)) return false;
  const sid = await currentWindowsSid();
  if (!SID_PATTERN.test(sid)) return false;
  try {
    // Do not follow a junction/symlink or recursively create arbitrary parents.
    for (const dir of [path.join(volumeRoot, '$Recycle.Bin'), path.join(volumeRoot, '$Recycle.Bin', sid)]) {
      let stat;
      try { stat = await fs.lstat(dir); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        try { await fs.mkdir(dir); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        stat = await fs.lstat(dir);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    }
    return true;
  } catch (_) { return false; }
}
async function trashWithRecovery(shell, filePath) {
  if (process.platform !== 'win32') return shell.trashItem(filePath);
  const volumeRoot = path.parse(String(filePath)).root;
  if (!await ensureRecycleBinFor(volumeRoot)) {
    throw Error('系统回收站尚未就绪，会话存档已保留，请检查回收站后重试');
  }
  try {
    await shell.trashItem(filePath);
  } catch (error) {
    const restored = await ensureRecycleBinFor(volumeRoot)
      .catch(() => false);
    if (!restored) throw error;
    try {
      await shell.trashItem(filePath);
    } catch (_) { throw error; /* If retry fails, preserve the original error rather than replacing it with a generic retry failure. */ }
  }
}

function install({ app, ipcMain, session, BrowserWindow, dialog, shell, cloudHistory, trash = trashWithRecovery }) {
  function authorize(id) {
    const captured = historyAccess.actor(app);
    historyAccess.assertOwner(app, id, captured);
    return () => historyAccess.assertCurrent(app, captured);
  }
  ipcMain.handle('pi-session-history-rename', async (_event, rawId, rawTitle) => {
    try {
      if (typeof rawId !== 'string' || !rawId.trim() || rawId.length > 512) throw Error('会话标识无效');
      const guard = authorize(rawId);
      const title = conversationTitles.normalize(rawTitle);
      const live = session.findBySessionId(rawId);
      const row = live ? live.historyRow() : await session.archivedConversation(app, rawId);
      if (!row) return { ok: false, reason: '找不到这条会话，请刷新列表后重试' };
      guard();
      const saved = conversationTitles.save(app, rawId, title);
      const presence = { ...row, ...saved };
      BrowserWindow.getAllWindows().forEach(win => {
        try {
          if (!win.isDestroyed()) win.webContents.send('pi-session-event', {
            kind: 'renamed', sessionId: rawId, ref: live?.ref || '', presence,
          });
        } catch (_) { /* A closing window must not turn a saved rename into a failure. */ }
      });
      return { ok: true, ...saved };
    } catch (error) {
      return { ok: false, reason: '改名未保存：' + String(error.message || error) };
    }
  });
  ipcMain.handle('pi-session-history-delete', async (event, rawId, rawOptions) => {
    const requestedId = String(rawId || '').trim();
    if (!requestedId) return { ok: false, reason: '没有指定要删除的会话' };
    try {
      const canonicalId = await cloudHistory?.resolveDeleteAlias(requestedId);
      const id = canonicalId || requestedId;
      const guard = authorize(id);
      let active = session.findBySessionId(id);
      if (active && typeof active.inFlight === 'function' && active.inFlight()) {
        return { ok: false, reason: '这条会话还在执行，完成或停止后再删除' };
      }
      const switched = canonicalId ? null : require('../conversation/runtime-segments').read(app, id);
      const found = switched || canonicalId ? null : await session.historyEntry(app, id);
      const piEntry = found && found.ok && found.entry && found.entry.path ? found.entry : null;
      /* Search runtime records when the conversation is absent from Pi archives. */
      const runnerRow = switched || piEntry ? null : await session.findRunnerRow(id);
      if (!switched && !piEntry && !runnerRow) {
        if (found && found.notFound) return { ok: true, id, alreadyDeleted: true };
        return (found && found.ok === false && found.reason)
          ? found : { ok: false, reason: '找不到这条会话' };
      }
      /*
       * Return deletion-specific localized text for the renderer's themed confirmation dialog.
       * Keep action classification and translation in the main process.
       */
      const options = switched ? {
        title: '删除聊天',
        message: '删除“' + String(switched.title || '这条会话') + '”？',
        detail: '这条会话在各 Agent 中的会话记录将一并删除，无法从回收站恢复；需求和工作目录里的成果文件不会删除。',
        buttons: ['取消', '删除会话'],
      } : piEntry ? {
        title: '删除聊天',
        message: '删除“' + String(piEntry.title || '这条会话') + '”？',
        detail: '会话存档会移到系统回收站；需求和工作目录里的成果文件不会删除。',
        buttons: ['取消', '移到回收站'],
      } : {
        title: '删除聊天',
        message: '删除“' + String(runnerRow.title || '这条会话') + '”？',
        detail: '这条会话会从执行底座的运行记录里移除；需求、底座自己的原生存档和工作目录里的成果文件不会删除。',
        buttons: ['取消', '删除记录'],
      };
      if (!(rawOptions && rawOptions.confirmed === true)) {
        const copy = require('../native-locale.cjs').dialogOptions(options);
        return { ok: false, needsConfirm: true, id, confirm: {
          title: copy.title, message: copy.message, detail: copy.detail,
          cancel: copy.buttons[0], confirm: copy.buttons[1],
        } };
      }
      guard();
      active = session.findBySessionId(id);
      if (active && typeof active.inFlight === 'function' && active.inFlight()) {
        return { ok: false, reason: '会话刚刚又开始执行了，请完成或停止后再删除' };
      }
      if (active && typeof active.close === 'function') await active.close();
      if (switched) {
        // Reuse the archive boundary and multi-segment deletion transaction;
        // deleting only the original archive makes the remaining segments
        // resurrect the conversation at the next history refresh.
        if (!session.isArchived(app, id)) {
          const archived = await session.archiveHistory(app, id);
          if (!archived?.ok) return archived || { ok: false, reason: '会话归档未完成，尚未删除' };
        }
        const deleted = await session.permanentlyDeleteHistory(app, id);
        if (!deleted?.ok) return { ...(deleted || {}), ok: false,
          reason: String(deleted?.reason || '删除未完成') + '，请在归档会话中重试' };
        try { conversationTitles.remove(app, id); } catch (_) { /* title metadata is best effort */ }
        return { ...deleted, ok: true, id };
      }
      guard();
      if (canonicalId) return cloudHistory.forget(canonicalId);
      if (piEntry) await trash(shell, piEntry.path);
      else {
        const forgot = await session.forgetRunner(app, id);
        if (!forgot.ok && !forgot.notFound) return forgot;
      }
      return { ok: true, id };
    } catch (error) {
      return { ok: false, reason: '删除没有完成：' + String(error && error.message || error) };
    }
  });
  ipcMain.handle('pi-session-history-archive', async (_event, rawId) => {
    const id = String(rawId || '').trim();
    if (!id) return { ok: false, reason: '没有指定要归档的会话' };
    try {
      const guard = authorize(id);
      const active = session.findBySessionId(id);
      if (active && typeof active.inFlight === 'function' && active.inFlight()) {
        return { ok: false, reason: '这条会话还在执行，完成或停止后再归档' };
      }
      guard();
      const result = await session.archiveHistory(app, id);
      if (result && result.ok && active && typeof active.close === 'function') await active.close();
      return result;
    } catch (error) {
      return { ok: false, reason: '归档没有完成：' + String(error && error.message || error) };
    }
  });
  ipcMain.handle('pi-session-history-restore', async (_event, rawId) => {
    const id = String(rawId || '').trim();
    if (!id) return { ok: false, reason: '没有指定要恢复的会话' };
    try { authorize(id)(); return await session.restoreHistory(app, id); }
    catch (error) { return { ok: false, reason: '恢复没有完成：' + String(error && error.message || error) }; }
  });
  ipcMain.handle('pi-session-history-archived', async () => {
    try {
      const captured = historyAccess.actor(app);
      const result = await session.archivedHistory(app);
      historyAccess.assertCurrent(app, captured);
      const identity = require('../conversation/requirement-context').cachedIdentity(app);
      const rows = require('../conversation/work-conversation-cards').visibleHistory(app, result.chats || [], identity);
      return { ...result, chats: rows.map(row => conversationTitles.decorate(app,
        require('../conversation/requirement-context').decorate(app, row, identity))) };
    } catch (error) {
      return { ok: false, reason: '读取归档历史失败：' + String(error && error.message || error), chats: [] };
    }
  });
  ipcMain.handle('pi-session-history-permanent-delete', async (_event, rawId) => {
    const id = String(rawId || '').trim();
    if (!id) return { ok: false, reason: '没有指定要彻底删除的会话' };
    try {
      const guard = authorize(id);
      if (typeof session.isArchived === 'function' && !session.isArchived(app, id)) {
        return { ok: false, reason: '只能从归档历史彻底删除会话' };
      }
      const active = session.findBySessionId(id);
      if (active && typeof active.inFlight === 'function' && active.inFlight()) {
        return { ok: false, reason: '这条会话还在执行，完成或停止后再删除' };
      }
      if (active && typeof active.close === 'function') await active.close();
      guard();
      const result = await session.permanentlyDeleteHistory(app, id);
      if (result && result.ok) {
        try { conversationTitles.remove(app, id); } catch (_) { /* title metadata is best effort */ }
      }
      return result;
    } catch (error) {
      return { ok: false, reason: '彻底删除没有完成：' + String(error && error.message || error) };
    }
  });
}

module.exports = { install, trashWithRecovery, currentWindowsSid, ensureRecycleBinFor };
