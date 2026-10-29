'use strict';

// Directory traversal, hashing and ZIP encoding must not stall Electron's UI or
// unrelated live conversations. The worker receives no credentials.
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const workspace = require('./portable-workspace');

if (!isMainThread && workerData?.kind === 'soduwork-portable-workspace') {
  const { action, root, metadata } = workerData;
  Promise.resolve(action === 'scan' ? workspace.scan(root) : workspace.create(root, metadata, {
    onProgress: value => parentPort.postMessage({ progress: value }),
  })).then(result => {
    if (result.bytes) {
      const bytes = Uint8Array.from(result.bytes);
      parentPort.postMessage({ result: { ...result, bytes } }, [bytes.buffer]);
    } else parentPort.postMessage({ result });
  }).catch(error => parentPort.postMessage({ error: String(error.message || error) }));
}

function run(action, root, metadata, options = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: {
      kind: 'soduwork-portable-workspace', action, root, metadata,
    } });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      void worker.terminate();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(Error('已取消准备云端交接'));
    const timer = setTimeout(() => finish(Error('工作目录准备超时，请缩小目录后重试')), options.timeout || 120000);
    worker.on('message', message => {
      if (message.progress) options.onProgress?.(message.progress);
      else if (message.error) finish(Error(message.error));
      else if (message.result) finish(null, { ...message.result,
        ...(message.result.bytes ? { bytes: Buffer.from(message.result.bytes) } : {}) });
    });
    worker.once('error', error => finish(error));
    worker.once('exit', () => { if (!settled) finish(Error('交接准备进程已退出，请重试')); });
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

module.exports = { scan: (root, options) => run('scan', root, undefined, options),
  create: (root, metadata, options) => run('create', root, metadata, options) };
