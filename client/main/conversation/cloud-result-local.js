'use strict';

// Continue from a private copy; a later cloud turn must never overwrite edits
// made in a local conversation, or gain access to that conversation's files.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { safeName } = require('./cloud-output-cache');
const { assertNoLinks } = require('../plugin-resources');
const MAX_BYTES = 128 * 1024 * 1024;
async function create({ app, directory, owner, items, ids, guard }) {
  const selected = ids.map(id => items.find(item => item.artifactId === id));
  if (!items.length || items.length > 200 || selected.some(item => !item)) throw Error('成果已变化，请重新打开会话');
  const root = await fs.realpath(directory), captured = [];
  let total = 0;
  for (const item of items) {
    const relative = safeName(item.relative);
    if (!relative || !item.path || path.resolve(item.path) !== path.resolve(directory, relative)) throw Error('成果文件位置无效');
    assertNoLinks(directory, item.path);
    const real = await fs.realpath(item.path), rel = path.relative(root, real);
    if (!rel || rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) throw Error('成果文件超出会话目录');
    const handle = await fs.open(real, 'r');
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size !== item.size || Math.round(before.mtimeMs) !== item.at || total + before.size > MAX_BYTES) throw Error('成果文件已变化或过大，请刷新后重试');
      const bytes = await handle.readFile(), after = await handle.stat();
      if (bytes.length !== before.size || ['size', 'mtimeMs', 'ctimeMs', 'ino'].some(key => before[key] !== after[key])) throw Error('成果文件正在变化，请稍后重试');
      total += bytes.length; captured.push({ relative, bytes, item });
    } finally { await handle.close(); }
  }
  await guard();
  const anchor = app.getPath('userData');
  const parent = path.join(anchor, 'local-results', createHash('sha256').update(owner).digest('hex'));
  assertNoLinks(anchor, parent); await fs.mkdir(parent, { recursive: true }); assertNoLinks(anchor, parent);
  const cwd = await fs.mkdtemp(path.join(parent, 'result-'));
  for (const file of captured) {
    const target = path.join(cwd, file.relative);
    assertNoLinks(anchor, target); await fs.mkdir(path.dirname(target), { recursive: true }); assertNoLinks(anchor, target);
    await fs.writeFile(target, file.bytes, { flag: 'wx', mode: 0o600 });
  }
  await guard();
  const first = selected[0], filePath = path.join(cwd, first.relative), stat = await fs.stat(filePath);
  return { ok: true, cwd, title: first.name || path.basename(filePath),
    preview: /\.(?:html?|xhtml|md|txt|csv|json|pdf|png|jpe?g|gif|webp|svg|mp4|webm)$/i.test(filePath),
    file: { path: filePath, name: path.basename(filePath), size: stat.size,
      lastModified: stat.mtimeMs, kind: /\.pdf$/i.test(filePath) ? 'pdf' : 'file', nativeReference: true } };
}
module.exports = { create };
