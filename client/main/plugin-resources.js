'use strict';

// Portable, inert resources: installation never evaluates bundled code.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const MAX_FILES = 300, MAX_FILE_BYTES = 8 * 1024 * 1024, MAX_BYTES = 8 * 1024 * 1024;
const KINDS = new Set(['template', 'example', 'asset', 'script', 'reference', 'ui']);
const ROOTS = new Set(['templates', 'examples', 'assets', 'scripts', 'references', 'ui']);
const SECRET = /(?:sk|pk|pat|ghp|glpat)-[A-Za-z0-9_-]{12,}|(?:api[_ -]?key|token|password)\s*[:=]\s*["']?[^\s"']{8,}/i;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function resourcePath(value) {
  if (typeof value !== 'string' || value !== value.normalize('NFC') || value.length > 240 ||
      /[\\\x00-\x1f\x7f:]/.test(value)) throw new Error('插件资源路径不合法');
  const parts = value.split('/');
  if (parts.length < 2 || !ROOTS.has(parts[0]) || parts.some(part => !part || part === '.' || part === '..' ||
      part.startsWith('.') || /[. ]$/.test(part) || /[<>"|?*]/.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('资源须放在 templates、examples、assets、scripts、references 或 ui 目录内');
  }
  if (/\.(?:exe|dll|com|msi|pfx|p12|pem|key)$/i.test(value)) throw new Error('插件资源不能包含安装程序或密钥文件');
  return value;
}

function normalize(raw, options) {
  const allowLegacyContent = Boolean(options && options.allowLegacyContent);
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_FILES) throw new Error('插件资源最多 300 个文件');
  let total = 0;
  const seen = new Set();
  return raw.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('插件资源条目不合法');
    const name = resourcePath(item.path), identity = name.toLowerCase();
    if (seen.has(identity)) throw new Error('插件资源路径重复：' + name);
    seen.add(identity);
    if (!KINDS.has(item.kind)) throw new Error('插件资源类型不合法：' + name);
    if (!['utf8', 'base64'].includes(item.encoding) || typeof item.content !== 'string') throw new Error('插件资源缺少文件内容：' + name);
    if (item.content.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) throw new Error('单个插件资源不能超过 8MB');
    const bytes = Buffer.from(item.content, item.encoding === 'utf8' ? 'utf8' : 'base64');
    if (item.encoding === 'base64' && bytes.toString('base64') !== item.content) throw new Error('插件资源 Base64 编码无效：' + name);
    if (item.encoding === 'utf8' && bytes.toString('utf8') !== item.content) throw new Error('插件资源 UTF-8 编码无效：' + name);
    total += bytes.length;
    if (bytes.length > MAX_FILE_BYTES || total > MAX_BYTES) throw new Error('插件资源合计最多 8MB');
    if (!allowLegacyContent &&
        (item.encoding === 'utf8' || /\.(?:json|[cm]?js|ts|py|sh|html|css|md|txt|ya?ml|xml|csv)$/i.test(name)) &&
        SECRET.test(bytes.toString('utf8'))) throw new Error('插件资源疑似包含凭据：' + name);
    const sha256 = hash(bytes);
    if (item.sha256 != null && item.sha256 !== sha256) throw new Error('插件资源校验不一致：' + name);
    return { path: name, kind: item.kind, encoding: 'base64', content: bytes.toString('base64'), sha256, size: bytes.length };
  }).sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}

function summary(items) { return items.map(({ path, kind, sha256, size }) => ({ path, kind, sha256, size })); }
function digest(items) { return hash(items.map(x => x.path + '\0' + x.sha256 + '\0' + x.kind + '\n').join('')); }
function inside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
function assertNoLinks(root, target) {
  if (!inside(root, target)) throw new Error('插件资源路径越界');
  let cursor = root;
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('插件资源目录不能是链接');
  for (const part of path.relative(root, target).split(path.sep)) {
    cursor = path.join(cursor, part);
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('插件资源不能经过链接或联接点'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

// Root is supplied by the active conversation registry, never by the renderer.
function collect(body, draftFile, workRoot) {
  if (body.resources == null) return body;
  if (!Array.isArray(body.resources) || body.resources.length > MAX_FILES) throw new Error('插件资源最多 300 个文件');
  const root = path.resolve(workRoot), base = path.dirname(path.resolve(draftFile));
  assertNoLinks(root, path.resolve(draftFile));
  let total = 0;
  const resources = body.resources.map(item => {
    const name = resourcePath(item && item.path);
    if (Object.prototype.hasOwnProperty.call(item, 'content')) return item;
    const file = path.resolve(base, name);
    assertNoLinks(root, file);
    if (!inside(fs.realpathSync(root), fs.realpathSync(file))) throw new Error('插件资源指向工作目录之外');
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES || (total += stat.size) > MAX_BYTES) throw new Error('插件资源不是文件或超过大小限制');
    return { ...item, encoding: 'base64', content: fs.readFileSync(file).toString('base64') };
  });
  return { ...body, resources: normalize(resources) };
}

function materialize(raw, workRoot, key, options) {
  const items = normalize(raw, options);
  if (!items.length) return { items: [], directory: '', digest: '', rescued: [], backups: [] };
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(key)) throw new Error('插件标识不合法');
  const root = path.resolve(workRoot);
  if (!fs.statSync(root).isDirectory()) throw new Error('当前会话工作目录不可用');
  const fingerprint = digest(items), directory = path.join(root, '.soduwork', 'plugins', key, fingerprint);
  const rescued = [], backups = [];
  // Content-addressed resource directories are intended to be immutable but may be edited externally.
  // Rejecting every later use would permanently block sends for that resource fingerprint.
  // Back up modified files before restoring manifest content.
  // Create a unique hidden backup directory for each repair.
  // Preserve existing resources, user backups, and successive edits without name collisions.
  const rescue = (file, label) => {
    let backup = '';
    try {
      const backupDirectory = fs.mkdtempSync(path.join(directory, '.local-'));
      backup = path.join(backupDirectory, ...label.split('/'));
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      assertNoLinks(root, backup);
      try { fs.renameSync(file, backup); }
      catch (error) {
        if (error.code !== 'EXDEV') throw error;
        // Some Windows filesystems reject rename even within one work directory.
        // Preserve the source unless both the copied and current bytes match.
        const original = hash(fs.readFileSync(file));
        fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
        assertNoLinks(root, backup);
        if (hash(fs.readFileSync(backup)) !== original || hash(fs.readFileSync(file)) !== original) {
          throw new Error('本机修改在备份期间发生变化');
        }
        fs.unlinkSync(file);
      }
    } catch (error) {
      if (error.code === 'ENOENT') return false; // Concurrent materialization already handled this file.
      throw new Error('插件资源 ' + label + ' 被本机修改且暂时无法备份，请关闭占用它的程序后重试：' + (backup || file));
    }
    if (!rescued.includes(label)) rescued.push(label);
    backups.push({ path: label, backup: path.relative(directory, backup).split(path.sep).join('/') });
    return true;
  };
  for (const item of items) {
    const file = path.join(directory, ...item.path.split('/'));
    assertNoLinks(root, file);
    if (!fs.existsSync(file)) continue;
    if (fs.statSync(file).isFile() && hash(fs.readFileSync(file)) === item.sha256) continue;
    rescue(file, item.path);
  }
  for (const item of items) {
    const file = path.join(directory, ...item.path.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    assertNoLinks(root, file);
    try { fs.writeFileSync(file, Buffer.from(item.content, 'base64'), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      assertNoLinks(root, file);
      if (hash(fs.readFileSync(file)) === item.sha256) continue;
      // If content changes during writing, preserve it and retry restoration once.
      rescue(file, item.path);
      fs.writeFileSync(file, Buffer.from(item.content, 'base64'), { flag: 'wx', mode: 0o600 });
    }
  }
  return { items: summary(items), directory, digest: fingerprint, rescued, backups };
}
function guidance(bundle) {
  if (!bundle.items.length) return '';
  const backups = Array.isArray(bundle.backups) ? bundle.backups : [];
  const rescueNote = backups.length
    ? '\n以下资源在本机被修改过，修改已分别备份，原始资源已恢复为随包版本；\n下面列出原文件 → 备份路径（相对于上述资源目录）。需要这些修改时先复制到自己的工作文件，不要直接改动资源原件：\n' +
      backups.map(x => '- ' + x.path + ' → ' + x.backup).join('\n')
    : '';
  return '本轮插件随包资源（已校验，复制模板后编辑，不修改原始资源）：\n' + bundle.directory + '\n' +
    bundle.items.slice(0, 6).map(x => '- ' + x.path + '（' + x.kind + '）').join('\n') +
    '\n完整资源共 ' + bundle.items.length + ' 个文件，可在该目录查看。安装不会执行脚本；使用资源仍须遵守当前任务授权。' + rescueNote;
}
module.exports = { normalize, summary, digest, collect, materialize, guidance, resourcePath, assertNoLinks, MAX_FILES, MAX_FILE_BYTES, MAX_BYTES };
