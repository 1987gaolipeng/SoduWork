'use strict';
const { randomUUID } = require('node:crypto');
const { isTrusted } = require('./preferences');
const catalog = require('../agent-runtime/runtime-catalog');
const INVALID = '完全访问确认已失效，请重新选择';
const BUSY = '正在确认或创建对话，请稍候';
const validDraft = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
const supported = adapter => catalog.runtime(adapter || 'pi')?.accessControl?.modes?.includes('full') === true &&
  catalog.runtime(adapter || 'pi')?.accessControl?.supported === true;

// Ephemeral consent belongs to this exact top-level document and draft. It is
// never stored in chat metadata or accepted as a renderer-supplied boolean.
function create({ BrowserWindow, confirmFullAccess }) {
  const owners = new WeakMap();
  function owner(event) {
    if (!isTrusted(event)) throw Error('请在 SoduWork 工作区中打开对话');
    const contents = event.sender;
    let state = owners.get(contents);
    if (!state) {
      state = { drafts: new Map() };
      owners.set(contents, state);
      const clear = () => state.drafts.clear();
      contents.on('destroyed', clear);
      contents.on('render-process-gone', clear);
      contents.on('did-start-navigation', (_event, _url, _inPlace, main) => { if (main) clear(); });
    }
    return state;
  }
  function current(event, state, record) {
    return isTrusted(event) && event.sender.mainFrame === record.frame &&
      event.sender.getURL() === record.url && state.drafts.get(record.draftId) === record;
  }
  async function confirm(event, input = {}) {
    let state, record;
    try {
      state = owner(event);
      if (!validDraft(input.draftId)) throw Error(INVALID);
      if (!supported(input.adapterId)) throw Error('当前底座暂不支持新权限模式，请选择兼容权限或其他底座');
      if ([...state.drafts.values()].some(row => row.state === 'confirming' || row.state === 'reserved')) throw Error(BUSY);
      if (state.drafts.size >= 32 && !state.drafts.has(input.draftId)) throw Error(INVALID);
      record = { draftId: input.draftId, frame: event.sender.mainFrame, url: event.sender.getURL(), state: 'confirming' };
      state.drafts.set(input.draftId, record);
      const allowed = await confirmFullAccess(BrowserWindow.fromWebContents(event.sender), { anchor: input.anchor, source: event.sender });
      if (allowed !== true || !current(event, state, record)) {
        if (state.drafts.get(input.draftId) === record) state.drafts.delete(input.draftId);
        return { ok: false, cancelled: true };
      }
      record.consentId = randomUUID();
      record.state = 'ready';
      return { ok: true, consentId: record.consentId };
    } catch (error) {
      if (record && state?.drafts.get(record.draftId) === record) state.drafts.delete(record.draftId);
      return { ok: false, reason: String(error.message || error) };
    }
  }
  function revoke(event, input = {}) {
    try {
      const state = owner(event);
      if (!validDraft(input.draftId)) throw Error(INVALID);
      state.drafts.delete(input.draftId);
      return { ok: true };
    } catch (error) { return { ok: false, reason: String(error.message || error) }; }
  }
  function reserve(event, opts, expectedIdentity) {
    const state = owner(event), record = state.drafts.get(opts.accessDraftId);
    if (expectedIdentity || opts.chatId || opts.taskSession || opts.taskRef || opts.automationId ||
        opts.accessMode !== 'full' || !validDraft(opts.accessDraftId) ||
        !record || !current(event, state, record) || typeof opts.accessConsentId !== 'string' ||
        record.consentId !== opts.accessConsentId || !supported(opts.adapterId)) throw Error(INVALID);
    if (record.state === 'reserved') throw Error(BUSY);
    if (record.state !== 'ready') throw Error(INVALID);
    record.state = 'reserved';
    let opening = null, committed = false;
    const assertValid = () => {
      if (!current(event, state, record) || record.state !== 'reserved') throw Error(INVALID);
    };
    return {
      assertValid,
      track(promise) { opening = promise; },
      commit() {
        assertValid();
        committed = true;
        state.drafts.delete(record.draftId);
      },
      finish() {
        if (committed) return;
        // A timed-out initialization retains its reservation until any late
        // runtime has actually closed. Retrying cannot create a hidden twin.
        Promise.resolve(opening).then(async result => {
          if (result?.ok && result.session) {
            if (typeof result.session.close !== 'function') throw Error('Unclosable session');
            if (await result.session.close() === false) throw Error('Session closure was not confirmed');
          }
          if (current(event, state, record) && record.state === 'reserved') record.state = 'ready';
        }, () => {
          if (current(event, state, record) && record.state === 'reserved') record.state = 'ready';
        }).catch(() => { if (state.drafts.get(record.draftId) === record) state.drafts.delete(record.draftId); });
      },
    };
  }
  function install(ipcMain) {
    ipcMain.handle('pi-session-confirm-new-chat-access', confirm);
    ipcMain.handle('pi-session-revoke-new-chat-access', revoke);
  }
  return { confirm, revoke, reserve, install };
}
module.exports = { create };
