'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const store = require('./account-sync-store').create(workerData.file, { ...workerData.options, persistent: true });
parentPort.on('message', ({ id, method, args }) => {
  try { parentPort.postMessage({ id, value: store[method](...args) }); }
  catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
