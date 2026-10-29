'use strict';
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { assertNoLinks } = require('../plugin-resources');
const hash = value => createHash('sha256').update(value).digest('hex');
async function create({ app, owner, result, guard }) {
  if (result.manifest?.files?.length < 2 || !/^[a-f0-9]{64}$/.test(result.manifest?.revision || '') || !result.bytes) throw Error('当前成果不需要压缩包');
  const anchor = app.getPath('userData');
  const folder = path.join(anchor, 'delivery-archives', hash(owner), result.manifest.revision);
  const target = path.join(folder, path.basename(result.filename));
  assertNoLinks(anchor, target); await fs.mkdir(folder, { recursive: true }); assertNoLinks(anchor, target);
  await guard();
  try { await fs.writeFile(target, result.bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  assertNoLinks(anchor, target);
  const stat = await fs.stat(target);
  const mismatch = () => Error('本地压缩包校验失败，请重新生成成果');
  if (!stat.isFile() || stat.size !== result.bytes.length) throw mismatch();
  let offset = 0;
  for await (const chunk of createReadStream(target)) {
    if (!chunk.equals(result.bytes.subarray(offset, offset + chunk.length))) throw mismatch();
    offset += chunk.length;
  }
  if (offset !== result.bytes.length) throw mismatch();
  await guard(); assertNoLinks(anchor, target);
  return target;
}
module.exports = { create };
