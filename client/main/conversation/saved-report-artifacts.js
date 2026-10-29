'use strict';

// Compatibility for save_report versions which wrote under the host process
// cwd. Recover the exact submitted Markdown from a completed call/result pair,
// never read a path advertised by a model or an untrusted tool result.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const MAX_BYTES = 2 * 1024 * 1024;

function reports(tools) {
  const latest = new Map();
  for (const tool of tools || []) {
    if (tool?.name !== 'save_report' || tool.state !== 'done' || tool.isError ||
        tool.args?.report_path || typeof tool.args?.markdown !== 'string' || !tool.args.markdown.trim()) continue;
    const match = /^Report saved: ([^\r\n]+)\s*$/.exec(String(tool.result || ''));
    if (!match || Buffer.byteLength(tool.args.markdown, 'utf8') > MAX_BYTES) continue;
    const source = match[1].trim();
    const name = source.replace(/\\/g, '/').split('/').pop();
    if (!name || !/\.(md|markdown)$/i.test(name) || /[<>:"/\\|?*\x00-\x1f]/.test(name) ||
        /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(name)) continue;
    latest.set(source, { source, name, text: tool.args.markdown });
  }
  return [...latest.values()];
}

function child(root, parts) {
  let dir = root;
  for (const part of parts) {
    dir = path.join(dir, part);
    try { fs.mkdirSync(dir); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Unsafe report directory');
  }
  return dir;
}

function recover(cwd, tools) {
  const files = [];
  if (!cwd || !tools?.some(tool => tool?.name === 'save_report')) return files;
  for (const report of reports(tools)) {
    try {
      // In-workspace saves already flow through the ordinary file index.
      const source = path.resolve(cwd, report.source);
      const relative = path.relative(path.resolve(cwd), source);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) continue;
      const digest = crypto.createHash('sha256').update(report.source + '\0' + report.text).digest('hex').slice(0, 24);
      const root = fs.realpathSync(cwd);
      const dir = child(root, ['outputs', 'recovered-reports', digest]);
      const target = path.join(dir, report.name), receipt = path.join(dir, '.recovered');
      // A deleted recovered file stays deleted; a user edit is never replaced.
      if (!fs.existsSync(receipt)) {
        fs.writeFileSync(target, report.text, { encoding: 'utf8', flag: 'wx' });
        fs.writeFileSync(receipt, digest, { flag: 'wx' });
      }
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) continue;
      files.push({ path: target, name: report.name, relative: path.relative(root, target).split(path.sep).join('/'),
        size: stat.size, at: Math.round(stat.mtimeMs), changedInTurn: false, recovered: true });
    } catch (_) { /* Missing/deleted/unsafe output is never replaced or opened elsewhere. */ }
  }
  return files;
}

// Old versions stay on disk, including any user edits. Only the current
// completed version belongs in this session's public artifact index. Limit
// this filtering to our exact managed namespace; ordinary files are untouched.
function currentFiles(cwd, files, recovered) {
  if (!cwd) return files || [];
  const roots = [path.resolve(cwd)];
  try { roots.push(fs.realpathSync(cwd)); } catch (_) { /* Missing workspace. */ }
  const managed = /^outputs\/recovered-reports\/[a-f0-9]{24}\/[^/]+$/i;
  const key = file => {
    if (!file?.path) return '';
    for (const root of roots) {
      const relative = path.relative(root, path.resolve(file.path)).split(path.sep).join('/');
      if (managed.test(relative)) return process.platform === 'win32' ? relative.toLowerCase() : relative;
    }
    return '';
  };
  const current = new Map((recovered || []).map(file => [key(file), file]).filter(([id]) => id));
  return (files || []).flatMap(file => {
    const id = key(file);
    if (!id) return [file];
    const latest = current.get(id);
    // The current descriptor overrides scan timestamps' interpretation: a
    // recovered historical report is never a newly produced turn artifact.
    return latest ? [{ ...file, ...latest, changedInTurn: false }] : [];
  });
}

module.exports = { reports, recover, currentFiles };
