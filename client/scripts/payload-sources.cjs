'use strict';
// Give the native compiler the exact application bytes that Node inventoried.
// Filesystem filters can expose a different representation to another process.
// Opaque build inputs keep that representation out of distributable resources.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

async function stageSource(source, destination, expected) {
  if (!/^[a-f0-9]{64}$/.test(expected.sha256 || '')) throw Error('Missing payload digest: ' + source);
  const hash = crypto.createHash('sha256');
  let size = 0;
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  try {
    await pipeline(fs.createReadStream(source), new Transform({
      transform(chunk, _encoding, next) {
        size += chunk.length;
        if (size > expected.size) return next(Error('Payload changed after inventory: ' + source));
        hash.update(chunk); next(null, chunk);
      },
    }), fs.createWriteStream(destination));
    if (size !== expected.size || hash.digest('hex') !== expected.sha256) {
      throw Error('Payload changed after inventory: ' + source);
    }
  } catch (error) {
    await fs.promises.rm(destination, { force: true }).catch(() => {});
    throw error;
  }
  return destination;
}
module.exports = { stageSource };
