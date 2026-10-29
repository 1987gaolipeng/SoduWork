'use strict';

// Bundle hashing, decompression and atomic disk installation do not belong on
// Electron's UI thread. The worker receives no account or model credentials.
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { runtimeEntry } = require('./skill-frontmatter');

if (!isMainThread && ['soduwork-skill-install', 'soduwork-skill-scan'].includes(workerData?.kind)) {
  try {
    const app = { getPath: () => workerData.userData, skillRuntimeEntry: workerData.runtimeEntry };
    const cache = require('./skill-cache');
    const bytes = workerData.bytes && Buffer.from(workerData.bytes.buffer, workerData.bytes.byteOffset, workerData.bytes.byteLength);
    const result = bytes ? cache.install(app, bytes, workerData.checksum, workerData.tempToken) : cache._scan(app);
    parentPort.postMessage({ result });
  } catch (error) {
    parentPort.postMessage({ error: String(error.message || error) });
  } finally { parentPort.close(); }
}

// At most one decompressor per desktop, including requests for different
// capability sets. Failure must not poison the next independent attempt.
let tail = Promise.resolve();
function install(app, data, checksum) {
  if (!Buffer.isBuffer(data) || !data.length || data.length > 30 * 1024 * 1024)
    return Promise.reject(Error('Skill 包为空或超过 30MB'));
  if (!/^[a-f0-9]{64}$/.test(String(checksum || '')))
    return Promise.reject(Error('Skill 包完整性校验失败'));
  return run(app, data, checksum);
}

function scan(app) { return run(app); }

function run(app, data, checksum) {
  const userData = path.resolve(app.getPath('userData'));
  const entry = runtimeEntry(app, true);
  const job = tail.then(() => new Promise((resolve, reject) => {
    const tempToken = crypto.randomBytes(8).toString('hex');
    const cacheRoot = path.join(userData, 'skill-cache');
    const temp = data && path.join(cacheRoot, checksum + '.tmp-' + tempToken);
    const bytes = data && Uint8Array.from(data);
    const worker = new Worker(__filename, { workerData: {
      kind: data ? 'soduwork-skill-install' : 'soduwork-skill-scan', userData, bytes, checksum, tempToken, runtimeEntry: entry,
    }, transferList: bytes ? [bytes.buffer] : [] });
    let result, failure;
    const timer = setTimeout(() => {
      failure = Error(data ? 'Skill 包安装超时，请稍后重试' : 'Skill 缓存校验超时，请稍后重试');
      void worker.terminate().catch(() => {});
    }, 30000);
    worker.on('message', message => {
      if (message.error) failure = Error(message.error);
      else result = message.result;
    });
    worker.once('error', error => { failure = error; });
    worker.once('exit', async code => {
      clearTimeout(timer);
      // Only remove our known staging folder, after the worker has exited.
      // Keep complete immutable versions and other requests' folders intact.
      if (temp && path.dirname(temp) === cacheRoot) {
        try { await fs.rm(temp, { recursive: true, force: true }); } catch (_) { /* incomplete staging is ignored */ }
      }
      const valid = data ? Array.isArray(result) : result && Array.isArray(result.contracts) && Array.isArray(result.issues);
      if (failure || code !== 0 || !valid)
        reject(failure || Error('Skill 准备未完成，请稍后重试'));
      else resolve(result);
    });
  }));
  tail = job.then(() => {}, () => {});
  return job;
}

module.exports = { install, scan };
