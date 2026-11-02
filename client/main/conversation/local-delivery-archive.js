'use strict';
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { assertNoLinks } = require('../plugin-resources');
const hash = value => createHash('sha256').update(value).digest('hex');
async function create({ app, owner, result, guard }) {
  if (!result.manifest?.files?.length || result.contentType !== 'application/zip' || !/\.zip$/i.test(result.filename || '') ||
      !/^[a-f0-9]{64}$/.test(result.manifest?.revision || '') || !result.bytes) throw Error('当前成果不是压缩包');
  const anchor = app.getPath('userData');
  const folder = path.join(anchor, 'delivery-archives', hash(owner), result.manifest.revision);
  const target = path.join(folder, path.basename(result.filename));
  assertNoLinks(anchor, target); await fs.mkdir(folder, { recursive: true }); assertNoLinks(anchor, target);
  await guard();
  try { await fs.writeFile(target, result.bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  assertNoLinks(anchor, target);
  const stat = await fs.stat(target);
  const mismatch = () => Object.assign(Error('本地压缩包与交付版本不一致，请重新生成成果后再试'), {code:'DELIVERY_ARCHIVE_INVALID'});
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
