'use strict';
// No model, credentials or network in the worker. Capture immutable files,
// then release the turn before compression, CRC and upload have finished.
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const active = new Set();
if (!isMainThread && workerData?.kind === 'soduwork-delivery-package') {
  const session = { cwd: workerData.cwd, sessionId: workerData.sessionId,
    snapshot: () => workerData.snapshot, outputSnapshot: () => workerData.files,
    inFlight: () => workerData.inFlight, taskTitle: workerData.taskTitle,
    sessionTitle: workerData.sessionTitle };
  require('./delivery-package').prepare(session, workerData.ids, {
    ...workerData.options, onCaptured: captured => parentPort.postMessage({ captured }),
  }).then(result => {
    if (result.bytes) {
      const bytes = Uint8Array.from(result.bytes);
      parentPort.postMessage({ result: { ...result, bytes } }, [bytes.buffer]);
    } else parentPort.postMessage({ result });
  }).catch(error => parentPort.postMessage({ error: String(error.message || error), code: error.code }));
}
async function capture(session, ids, options = {}) {
  const indexed = await require('./artifact-runtime').snapshotAsync(session);
  if (active.size >= 2) return Promise.reject(Error('其他成果正在整理，当前文件已保留，可稍后重试保存'));
  let resolveCapture, rejectCapture, resolvePayload, rejectPayload;
  const captured = new Promise((resolve, reject) => { resolveCapture = resolve; rejectCapture = reject; });
  const payload = new Promise((resolve, reject) => { resolvePayload = resolve; rejectPayload = reject; });
  // A worker can fail after capture, before the upload queue reaches it.
  payload.catch(() => {});
  let worker, timer, frozen = false, settled = false;
  const finish = (error, result) => {
    if (settled) return;
    settled = true; clearTimeout(timer);
    // Abrupt termination during zlib initialization can abort Electron itself
    // (close before init). Reject/cancel the request immediately, but let this
    // bounded worker finish native compression and exit naturally. Keep its
    // concurrency slot until exit so cancelled jobs cannot accumulate.
    worker?.unref();
    if (error) { rejectCapture(error); rejectPayload(error); }
    else {
      const value = { ...result, ...(result.bytes ? { bytes: Buffer.from(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength) } : {}) };
      if (!frozen) resolveCapture({ ...value, payload });
      resolvePayload(value);
    }
  };
  try {
    worker = new Worker(__filename, { workerData: { kind: 'soduwork-delivery-package',
      cwd: session.cwd, sessionId: session.sessionId, ids,
      snapshot: { status: session.snapshot?.()?.status }, inFlight: Boolean(session.inFlight?.()),
      taskTitle: String(session.taskTitle || ''),
      sessionTitle: String(session.historyRow?.()?.title || ''),
      files: { ...indexed.got, files: indexed.items, delivery: { ...indexed.delivery, items: indexed.items } },
      options: { completedTurn: Boolean(options.completedTurn), turnSince: options.turnSince || 0 } } });
    active.add(worker);
    timer = setTimeout(() => finish(Error('成果整理较慢，文件已保留，可稍后重试保存')), options.completedTurn ? 2000 : 120000);
    worker.on('message', message => {
      if (message.error) finish(Object.assign(Error(message.error), { code: message.code }));
      else if (message.captured && !frozen && !settled) {
        frozen = true; clearTimeout(timer);
        timer = setTimeout(() => finish(Error('成果打包超时，文件已保留，可稍后重试')), 120000);
        resolveCapture({ ...message.captured, payload, cancel: () => finish(Error('成果保存已取消')) });
      } else if (message.result) finish(null, message.result);
    });
    worker.once('error', finish);
    worker.once('exit', () => { active.delete(worker); if (!settled) finish(Error('成果整理已结束，文件已保留，可重试保存')); });
  } catch (error) { finish(error); }
  return captured;
}
async function prepare(session, ids, options) { return (await capture(session, ids, options)).payload; }
module.exports = { capture, prepare };
