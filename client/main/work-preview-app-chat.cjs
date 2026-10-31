'use strict';
// A page can submit only to its own native composer. Keep admission receipts on
// the existing app item so an H5 retry cannot duplicate a successfully sent turn.
const pending = new Map();
const appOwner = require('./work-preview-app-owner.cjs');
function send(item, params, attachmentOwner = item) {
  try { appOwner.assertCurrent(item); appOwner.assertCurrent(attachmentOwner); }
  catch (error) { return Promise.resolve({ ok: false, code: error.code, reason: error.message }); }
  const wc = item.composer?.view?.webContents;
  if (!wc || wc.isDestroyed()) return Promise.resolve({ ok: false, reason: '应用对话栏尚未就绪' });
  const receipts = item.chatReceipts ||= new Map();
  const fingerprint = JSON.stringify([options.mention === true,params.recipientUserId || '',params.query || '',params.text, params.attachmentIds || []]);
  const previous = receipts.get(params.requestId);
  if (previous) return previous.fingerprint === fingerprint && previous.owner === attachmentOwner ? previous.promise : Promise.resolve({ ok: false, reason: '请求编号已被其他内容使用' });
  if (receipts.size >= 100) return Promise.resolve({ ok: false, reason: '本窗口发送次数已达上限，请重新打开即用' });
  const id = require('node:crypto').randomUUID();
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  const timer = setTimeout(() => {
    // Leave the promise/receipt retained: a timeout is uncertain, never a retry.
    const row = pending.get(id); if (row) wc.removeListener('destroyed', row.onDestroyed);
    pending.delete(id); void row?.lease?.release().catch(() => {}); resolve({ ok: false, uncertain: true, reason: '发送回执超时，请在右侧对话核对，勿重复发送' });
  }, 60000);
  receipts.set(params.requestId, { fingerprint, owner: attachmentOwner, promise });
  const onDestroyed = () => finish(wc, { id, ok: false, reason: '应用对话栏已关闭' });
  pending.set(id, { wc, item, params, resolve, timer, onDestroyed, attachmentOwner });
  wc.once('destroyed', onDestroyed);
  if (params.attachmentIds?.length) {
    void (async () => {
      try {
        const lease = await require('./work-preview-app-attachments.cjs').checkout(attachmentOwner, params.attachmentIds);
        const row = pending.get(id);
        if (!row || wc.isDestroyed()) { await lease.release(); return; }
        row.lease = lease;
        appOwner.assertCurrent(item); appOwner.assertCurrent(attachmentOwner);
        wc.send('app-composer-submit', { id, text: params.text, attachments: lease.files });
      } catch (error) { finish(wc, { id, ok: false, reason: error.message }); }
    })();
  } else wc.send('app-composer-submit', { id, text: params.text,...(options.mention ? {kind:'mention',mention:{recipientUserId:params.recipientUserId,query:params.query,text:params.text}} : {}) });
  return promise;
}
function finish(sender, payload) {
  const row = pending.get(payload?.id);
  if (!row || row.wc !== sender) return { ok: false };
  pending.delete(payload.id); clearTimeout(row.timer); row.wc.removeListener('destroyed', row.onDestroyed);
  let active = true;
  try { appOwner.assertCurrent(row.item); appOwner.assertCurrent(row.attachmentOwner); } catch (_) { active = false; }
  const ok = active && payload.ok === true;
  void row.lease?.release().catch(() => {});
  if (!ok) row.item.chatReceipts.delete(row.params.requestId);
  row.resolve({ok,...(row.options.mention ? {opened:ok,...(ok ? {state:payload.state === 'select' ? 'select' : 'review'} : {})} : {accepted:ok}),...(ok ? {} : {reason})});
  return { ok: true };
}
function deferClose(item, win, event) {
  const inFlight = [...pending.values()].filter(row => row.item === item && row.params.attachmentIds?.length);
  if (!inFlight.length) return;
  event.preventDefault();
  if (item.attachmentClosePending) return;
  item.attachmentClosePending = true;
  void Promise.all(inFlight.map(row => item.chatReceipts.get(row.params.requestId).promise)).then(results => {
    item.attachmentClosePending = false;
    // A rejected or uncertain send leaves the window and its error visible.
    // Admission is the handoff boundary, not eventual model completion.
    if (results.every(result => result.accepted) && !win.isDestroyed()) win.close();
  });
}
module.exports = { send, finish, deferClose };
