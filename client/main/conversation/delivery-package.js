'use strict';

// Export verified deliverables, not a directory snapshot. Relative dependencies
// are followed so a website/report remains usable after leaving this computer.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const runtime = require('./artifact-runtime');
const contract = require('./delivery-contract');
const zip = require('./zip-archive');
const MAX_BYTES = 64 * 1024 * 1024, MAX_FILES = 500;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const MIME = { '.md': 'text/markdown', '.markdown': 'text/markdown', '.html': 'text/html', '.htm': 'text/html',
  '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf', '.txt': 'text/plain',
  '.csv': 'text/csv', '.zip': 'application/zip', '.mp4': 'video/mp4',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
const BLOCKED = /(?:^|\/)(?:\.git|\.soduwork|\.soduwork-inputs|node_modules|\.venv|__pycache__|\.env(?:\.[^/]*)?|id_rsa|id_ed25519)(?:\/|$)|\.(?:pem|key|p12|pfx)$/i;
function safeRelative(value) {
  const raw = String(value || '').replace(/\\/g, '/');
  if (!raw || raw.startsWith('/') || raw.split('/').some(p => !p || p === '.' || p === '..' || p.endsWith('.') || p.endsWith(' ') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)) || /[\x00-\x1f\x7f:*?"<>|]/.test(raw) || BLOCKED.test(raw)) {
    throw Error('成果包含不适合交付的路径，请将最终文件整理到单独目录');
  }
  return raw.normalize('NFC');
}
/*
 * Choose delivery titles from requirement, conversation, then entry name. Remote
 * deduplication excludes title so renaming does not duplicate content.
 */
function deliveryTitle(session, entryPath) {
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const label = clean(session?.taskTitle) || clean(session?.sessionTitle)
    || clean(path.basename(entryPath, path.extname(entryPath)));
  return label ? label + ' · 会话成果' : '会话成果';
}
/* Mirrors the hub-side bundle filename derivation so a local save and the
   library row keep the same name. */
function zipName(value) {
  return (String(value).replace(/[\\/:*?"<>|]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120) || '成果') + '.zip';
}
function dependencyText(bytes, name) {
  const marker = bytes.subarray(0, 2).toString('hex');
  if (marker === 'fffe' || marker === 'feff') {
    try { return new TextDecoder(marker === 'fffe' ? 'utf-16le' : 'utf-16be', { fatal: true }).decode(bytes); }
    catch (_) { throw Error('成果文本编码无法解析：' + name); }
  }
  return bytes.toString('utf8');
}
function references(text, extension, includeExternal = false) {
  const result = [];
  const collect = pattern => { for (const m of text.matchAll(pattern)) result.push(m[1]); };
  if (/^\.(?:html?|svg)$/.test(extension)) {
    collect(/<(?:script|link|img|source|video|audio|iframe|image|use)\b[^>]*?\b(?:src|href|poster)\s*=\s*["']([^"']+)["']/gi);
    collect(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+\.(?:html?|pdf|md|markdown)(?:[?#][^"']*)?)["']/gi);
    for (const m of text.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) {
      if (!m[1].trim().startsWith('data:')) for (const part of m[1].split(',')) result.push(part.trim().split(/\s+/)[0]);
    }
  }
  if (/^\.(?:html?|css|svg)$/.test(extension)) {
    // Tokenize strings/comments before URL functions. A quoted data URI can
    // contain SVG url(#filter), which is not another stylesheet dependency.
    const css = extension === '.css' ? [text] : [
      ...Array.from(text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi), m => m[1]),
      ...Array.from(text.matchAll(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/gi), m => m[2]),
    ];
    for (const value of css) result.push(...require('./stylesheet-references').references(value));
  }
  if (/^\.(?:html?|m?js)$/.test(extension)) {
    collect(/\b(?:import|export)\s+(?:[^;\n]*?\s+from\s*)?["']([^"']+)["']/g);
    collect(/\b(?:import|fetch|Worker)\s*\(\s*["']([^"']+)["']/g);
  }
  if (/^\.(?:md|markdown)$/.test(extension)) collect(/!?\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+[^)]*)?\)/g);
  return [...new Set(result)].filter(v => v && (includeExternal || !/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(v)));
}
async function prepare(session, ids, options = {}) {
  if (!session?.cwd || !session.sessionId) throw Error('请重新打开会话后下载成果');
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_FILES || new Set(ids).size !== ids.length) throw Error('请选择有效的交付文件');
  const state = session.snapshot?.();
  if (!options.completedTurn && (session.inFlight?.() || ['running', 'streaming', 'queued'].includes(state?.status))) throw Error('文件仍在生成，请等本轮完成后下载');
  const root = await fs.realpath(session.cwd), entries = new Map(), caseNames = new Set();
  const manifestPath = path.join(root, '.soduwork/delivery.json');
  const statManifest = () => fs.stat(manifestPath).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  const manifestBefore = await statManifest();
  const declared = contract.readManifest(root);
  if (declared?.invalid) throw Error(declared.reason);
  const indexed = options.snapshot || runtime.snapshot(session);
  // Evidence can live in a reserved directory. Index its identity without
  // applying the stricter export-path policy to files that will not be exported.
  const evidencePath = value => String(value || '').replace(/\\/g, '/').normalize('NFC');
  const evidence = new Set((indexed?.items || []).filter(item => item.evidenceSource ||
    require('./delivery-selection').processRoles.has(item.role)).map(item => evidencePath(item.relative || path.relative(root, item.path))));
  for (const name of Array.isArray(declared?.processFiles) ? declared.processFiles : []) evidence.add(evidencePath(name));
  const external = declared?.runtime?.networkPolicy === 'online' ? declared.runtime.externalDependencies || [] : [];
  if (!Array.isArray(external) || external.length > 50 || external.some(v => typeof v !== 'string' || !v.trim() || v.length > 500)) throw Error('在线依赖清单格式不正确');
  const dependencies = new Set(external);
  let total = 0;
  async function add(raw, role, webRoot = '.') {
    const name = safeRelative(raw), lower = name.toLowerCase();
    if (evidence.has(name)) throw Error('交付物引用了过程或验证文件：' + name + '，请将实际资源与验证材料分开');
    if (entries.has(name)) { if (role === 'primary') entries.get(name).role = role; return; }
    if (caseNames.has(lower)) throw Error('成果中有大小写冲突的文件名，请先重命名');
    if (entries.size >= MAX_FILES) throw Error('一份交付最多包含 500 个文件，请精简交付目录');
    const filename = path.resolve(root, name), real = await fs.realpath(filename).catch(error => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw Error('成果依赖缺失：' + name);
      throw Error('无法读取成果文件：' + name + '，请检查文件访问权限', { cause: error });
    });
    if (real !== filename || !(path.relative(root, real)) || path.relative(root, real).startsWith('..') || path.isAbsolute(path.relative(root, real))) throw Error('成果不支持链接到其他位置：' + name);
    const handle = await fs.open(real, 'r');
    let bytes, before, after;
    try {
      before = await handle.stat();
      if (!before.isFile() || before.size + total > MAX_BYTES) throw Error('交付内容超过 64 MB 或不是普通文件');
      bytes = await handle.readFile(); after = await handle.stat();
    } finally { await handle.close(); }
    if (before.mtimeMs !== after.mtimeMs || before.size !== bytes.length || after.size !== bytes.length) throw Error('成果正在更新，请稍后重试');
    total += bytes.length; if (total > MAX_BYTES) throw Error('交付内容超过 64 MB');
    const ext = path.extname(name).toLowerCase();
    entries.set(name, { name, bytes, role, st: before, filename: real, sha256: hash(bytes), contentType: MIME[ext] || 'application/octet-stream' }); caseNames.add(lower);
    if (/^\.(?:html?|css|m?js|svg|md|markdown)$/.test(ext) && bytes.length <= 4 * 1024 * 1024) {
      const text = dependencyText(bytes, name);
      if (!/^\.(?:md|markdown)$/.test(ext)) for (const ref of references(text, ext, true)) {
        if (/^(?:https?:)?\/\//i.test(ref) && dependencies.size < 50) dependencies.add(ref.slice(0, 500));
      }
      for (const ref of references(text, ext)) {
        let token; try { token = decodeURIComponent(ref.split(/[?#]/)[0]); } catch (_) { throw Error('成果依赖路径无法识别：' + name); }
        if (!token) continue;
        if (external.some(route => typeof route === 'string' && route.startsWith('/') && !route.startsWith('//') && (token === route || token.startsWith(route.replace(/\/$/, '') + '/')))) continue;
        const relative = token.startsWith('/') ? path.posix.join(webRoot, token.slice(1)) : path.posix.join(path.posix.dirname(name), token);
        // Bare JS module names are supplied by the project's build/import map.
        if (/^\.m?js$/.test(ext) && !token.startsWith('.') && !token.startsWith('/')) continue;
        await add(relative, 'supporting', webRoot);
      }
    }
  }
  const selected = ids.map(id => { const found = runtime.resolveSnapshot(session, id, indexed);
    if (!found.ok) throw Error(found.reason); return found; });
  for (const found of selected) {
    const relative = path.relative(root, found.path).split(path.sep).join('/');
    await add(relative, 'primary', path.posix.dirname(relative));
  }
  for (const spec of declared?.deliverables || []) {
    if (!entries.has(spec.path || spec.entry)) continue;
    if (spec.files != null && !Array.isArray(spec.files)) throw Error('交付文件清单必须是文件路径列表');
    for (const rel of spec.files || []) {
      if (evidence.has(evidencePath(rel))) continue;
      const name = safeRelative(rel);
      // Explicit lists often contain globbed test output. Required references
      // were already traversed above, so dropping optional evidence is safe.
      if (evidence.has(name) || contract._isProcess({ relative: name, name: path.posix.basename(name) })) continue;
      await add(name, 'supporting');
    }
  }
  const rows = [...entries.values()].sort((a, b) => a.name < b.name ? -1 : 1);
  for (const row of rows) {
    const now = await fs.stat(row.filename);
    if (now.mtimeMs !== row.st.mtimeMs || now.size !== row.bytes.length || now.ino !== row.st.ino) throw Error('成果正在更新，请稍后重试');
  }
  const manifestStat = await statManifest();
  if (Boolean(manifestBefore) !== Boolean(manifestStat) || manifestBefore &&
      ['mtimeMs', 'ctimeMs', 'size', 'ino'].some(key => manifestBefore[key] !== manifestStat[key])) throw Error('成果清单正在更新，请稍后重试');
  const files = rows.map(r => ({ path: r.name, size: r.bytes.length, sha256: r.sha256, contentType: r.contentType, role: r.role }));
  const entryPath = path.relative(root, selected[0].path).split(path.sep).join('/');
  const externalDependencies = [...dependencies].sort();
  const revision = hash(JSON.stringify({ entryPath, files, externalDependencies }));
  const title = rows.length === 1 ? selected[0].item.title || path.basename(entryPath)
    : deliveryTitle(session, entryPath);
  const manifest = { schemaVersion: 1, source: 'local', sessionId: session.sessionId, revision, title, entryPath,
    kind: rows.length === 1 ? 'file' : 'bundle', files, externalDependencies };
  // Provenance is a display label, so renaming the chat must not change the
  // immutable file revision (or create another library entry).
  const conversationTitle = String(session.sessionTitle || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 240);
  if (conversationTitle) manifest.conversationTitle = conversationTitle;
  const journal = options.snapshot?.got?.fileChanges;
  const changedInTurn = !options.turnSince || rows.some(row => Math.round(row.st.mtimeMs) >= options.turnSince ||
    journal?.files?.some(change => change.path === row.name && ['created', 'modified', 'renamed'].includes(change.action) &&
      change.after?.exists && change.after.size === row.bytes.length && Math.round(change.after.mtimeMs) === Math.round(row.st.mtimeMs))) ||
    Boolean(manifestStat && Math.round(manifestStat.mtimeMs) >= options.turnSince);
  if (options.completedTurn && !changedInTurn) return { manifest, changedInTurn: false };
  if (options.metadataOnly) return { manifest, changedInTurn };
  const filename = rows.length === 1 ? path.basename(entryPath) : zipName(title);
  const contentType = rows.length === 1 ? rows[0].contentType : 'application/zip';
  // The immutable bytes are now captured. Background ZIP encoding must not
  // keep the next instruction waiting or run checksums on Electron's loop.
  if (options.onCaptured) {
    const version = (name, st) => st ? { path: name, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, ino: st.ino } : { path: name, missing: true };
    options.onCaptured({ manifest, filename, contentType, changedInTurn, byteLength: total,
      fileVersions: [...rows.map(row => version(row.name, row.st)), version('.soduwork/delivery.json', manifestStat)] });
  }
  const bytes = rows.length === 1 ? rows[0].bytes : await zip.createEntries(rows);
  return { manifest, bytes, changedInTurn, filename, contentType,
    ...(options.includeEntries ? { entries: rows.map(row => ({ name: row.name, bytes: row.bytes, contentType: row.contentType, role: row.role })) } : {}) };
}
module.exports = { prepare, references, safeRelative, deliveryTitle, zipName, MAX_BYTES, MAX_FILES };
