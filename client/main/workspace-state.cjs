'use strict';

/* Navigation belongs to this process, not a user-data file. Closing a renderer
   keeps its destination; starting another process always starts at home.
   Native sessions/history own messages and execution, never this UI record. */

const WORKSPACE_VIEWS = new Set([
  'create', 'history', 'aidesk', 'account', 'settings', 'shortcuts', 'archive', 'skin', 'notices',
  'team', 'inbox', 'daily', 'schedules', 'skills', 'library', 'models',
  'model-editor', 'agents', 'cloud', 'codeacct', 'usage', 'memory', 'briefs',
  'approvals', 'add', 'workitems',
]);

function create({ ownerOf = () => '' } = {}) {
  let owner = '', generation = 0, last = null;

  function valid(value) {
    const view = String(value || '').trim();
    return WORKSPACE_VIEWS.has(view) ? view : '';
  }

  function context() {
    const next = String(ownerOf() || '');
    if (next !== owner) { owner = next; generation++; last = null; }
    return { owner, generation };
  }

  function reset() {
    context(); generation++; last = null;
  }

  function get() {
    context(); return last ? last.view : '';
  }

  function set(value) {
    const current = context();
    const row = typeof value === 'string' ? { view: value } : value;
    if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
    if (typeof value !== 'string' && (row.owner !== current.owner || row.generation !== current.generation)) return false;
    const view = valid(row.view);
    if (!view) return false;
    const chatId = view === 'create' ? String(row.chatId || '') : '';
    if (chatId && (!owner || !/^[A-Za-z0-9._:-]{1,200}$/.test(chatId))) return false;
    const reading = row.reading;
    last = { view, ...(chatId ? { chatId } : {}) };
    if (chatId && reading && Number.isFinite(reading.top) && reading.top >= 0 && typeof reading.follow === 'boolean') {
      last.reading = { top: Math.min(reading.top, 20_000_000), follow: reading.follow };
      if (Number.isSafeInteger(reading.messageLimit) && reading.messageLimit >= 80) {
        last.reading.messageLimit = Math.min(2000, reading.messageLimit);
      }
      if (Number.isSafeInteger(reading.messageStart) && reading.messageStart >= 0) {
        last.reading.messageStart = Math.min(1_000_000_000, reading.messageStart);
      }
      const anchor = reading.anchor;
      if (anchor && Number.isSafeInteger(anchor.index) && anchor.index >= 0 && Number.isFinite(anchor.offset)) {
        last.reading.anchor = { index: Math.min(1_000_000_000, anchor.index),
          offset: Math.max(-200_000, Math.min(200_000, anchor.offset)) };
      }
    }
    return true;
  }

  function resolve(payload = {}) {
    const current = context();
    // A deliberate destination never inherits fields from the previous one.
    if (Object.keys(payload).some(key => key !== 'panel')) {
      const out = { ...payload, view: valid(payload.view) || 'create' };
      delete out.workspaceRestore;
      return out;
    }
    const route = last || { view: 'create' };
    return { ...payload, ...route, ...(last ? {
      workspaceRestore: JSON.stringify({ ...route, ...current }),
    } : {}) };
  }

  function install({ ipcMain, BrowserWindow, getWorkspace }) {
    const trusted = event => {
      const win = BrowserWindow.fromWebContents(event.sender);
      return Boolean(win && !win.isDestroyed() && getWorkspace() === win);
    };
    ipcMain.on('workspace-view', (event, value) => { if (trusted(event)) set(value); });
    ipcMain.handle('workspace-state-context', event => trusted(event) ? context() : null);
    ipcMain.handle('workspace-state-reset', event => {
      if (!trusted(event)) return null;
      reset(); return context();
    });
  }

  return { get, set, valid, context, resolve, reset, install };
}

module.exports = { WORKSPACE_VIEWS, create };
