'use strict';
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const MAX_ACTIVE = 2, MAX_QUEUED = 8, TIMEOUT_MS = 120000;
const pending = [];
let active = 0;

if (!isMainThread && workerData?.kind === 'soduwork-share-zip') {
  try {
    const result = require('./zip-archive').createZip(workerData.root);
    // Also encode the transport payload here, not on Electron's main thread.
    parentPort.postMessage({ result: { ...result, data: undefined, base64: result.data.toString('base64') } });
  } catch (error) {
    parentPort.postMessage({ error: String(error.message || error), code: error.code });
  }
}

function canceled() { return Object.assign(Error('Folder packaging canceled'), { name: 'AbortError', code: 'ABORT_ERR' }); }
function drain() {
  while (active < MAX_ACTIVE && pending.length) {
    const job = pending.shift();
    if (job.settled) continue;
    active++;
    let worker;
    const release = () => { active--; drain(); };
    try {
      worker = new Worker(__filename, { workerData: { kind: 'soduwork-share-zip', root: job.root } });
      job.worker = worker;
      worker.once('message', message => {
        if (message.error) job.finish(Object.assign(Error(message.error), { code: message.code }));
        else job.finish(null, message.result);
      });
      worker.once('error', error => job.finish(error));
      worker.once('exit', () => {
        job.finish(Error('Folder packaging ended before completion'));
        release();
      });
    } catch (error) { job.finish(error); release(); }
  }
}

function create(root, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(canceled());
  if (active >= MAX_ACTIVE && pending.length >= MAX_QUEUED) {
    return Promise.reject(Object.assign(Error('Other folders are being packaged; please retry shortly'), { code: 'ZIP_BUSY' }));
  }
  return new Promise((resolve, reject) => {
    const job = { root: String(root), settled: false, worker: null };
    const abort = () => job.finish(canceled());
    const timer = setTimeout(() => job.finish(Object.assign(Error('Folder packaging timed out; please retry'), { code: 'ZIP_TIMEOUT' })), TIMEOUT_MS);
    job.finish = (error, result) => {
      if (job.settled) return;
      job.settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      const index = pending.indexOf(job);
      if (index >= 0) pending.splice(index, 1);
      // Never terminate a worker while native zlib is initializing (Electron
      // can abort). Reject promptly, but retain the slot until natural exit.
      if (error) job.worker?.unref();
      if (error) reject(error); else resolve(result);
    };
    signal?.addEventListener('abort', abort, { once: true });
    pending.push(job); drain();
  });
}
module.exports = { create };
