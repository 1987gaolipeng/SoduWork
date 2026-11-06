'use strict';
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const flights = new Map(), pending = [];
let active = 0;

if (!isMainThread && workerData?.kind === 'soduwork-plugin-catalog') {
  try {
    // Electron inherits this property as read-only; plain Node does not define it.
    if (workerData.resourcesPath && !process.resourcesPath) process.resourcesPath = workerData.resourcesPath;
    if (workerData.resourcesPath && process.resourcesPath !== workerData.resourcesPath)
      throw Error('Plugin resource directory changed');
    const app = { isPackaged: workerData.isPackaged, getPath: () => workerData.userData };
    parentPort.postMessage({ items: require('./personal-plugins').catalog(app, workerData.includeDisabled) });
  } catch (error) { parentPort.postMessage({ error: error.message, code: error.code }); }
}

function drain() {
  while (active < 2 && pending.length) {
    const job = pending.shift();
    active++;
    let worker;
    const release = () => { clearTimeout(job.timer); active--; drain(); };
    try {
      worker = new Worker(__filename, { workerData: job.data });
      job.worker = worker;
      worker.once('message', value => value.error
        ? job.finish(Object.assign(Error(value.error), { code: value.code })) : job.finish(null, value.items));
      worker.once('error', error => job.finish(error));
      worker.once('exit', () => { job.finish(Error('Plugin catalog worker exited')); release(); });
    } catch (error) { job.finish(error); release(); }
  }
}

function catalog(app, includeDisabled = false) {
  const data = { kind: 'soduwork-plugin-catalog', userData: app.getPath('userData'),
    isPackaged: Boolean(app.isPackaged), resourcesPath: process.resourcesPath || '', includeDisabled };
  const key = JSON.stringify(data);
  if (flights.has(key)) return flights.get(key);
  if (pending.length >= 8) return Promise.reject(Error('Plugin catalog is busy'));
  const job = { data, settled: false, timer: null, worker: null };
  const promise = new Promise((resolve, reject) => {
    job.finish = (error, result) => {
      if (job.settled) return;
      job.settled = true;
      const queued = pending.indexOf(job);
      if (queued !== -1) pending.splice(queued, 1);
      if (!job.worker) clearTimeout(job.timer);
      if (error) reject(error); else resolve(result);
    };
  }).finally(() => flights.delete(key));
  // One deadline includes queueing. A stalled native call must not leave callers
  // pending forever or allow retries to create an unbounded number of threads.
  job.timer = setTimeout(() => {
    job.finish(Error('Plugin catalog read timed out'));
    if (job.worker) {
      // Termination is asynchronous. Only the exit event releases the slot.
      job.worker.terminate().catch(() => {});
      job.worker.unref();
    }
  }, 30000);
  flights.set(key, promise); pending.push(job); drain();
  return promise;
}
module.exports = { catalog };
