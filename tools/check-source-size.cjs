'use strict';

// Review aid, never a reason to split a cohesive module just to meet a number.
const fs = require('node:fs');
const path = require('node:path');
const { sourceFiles } = require('./source-files.cjs');
const LIMIT = 800;
const ROOT = path.resolve(__dirname, '..');
const BASELINE = 'tools/source-size-baseline.json';
const EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.py',
  '.dart', '.css', '.html', '.vue', '.sh', '.ps1']);
const EXCLUDED = /(?:^|\/)(?:node_modules|\.venv[^/]*|__pycache__|vendor|third[-_]party|dist[^/]*|releases)(?:\/|$)|^(?:outputs|work|mobile-web-dist)\/|^client\/(?:runner|\.runtime[^/]*|pi-chat(?:-src)?)\/|^hub-backend\/(?:uploads|downloads|workspaces)\/|^skin-server\/data\//;

function lineCount(text) {
  if (!text) return 0;
  const lines = text.split(/\r\n|\r|\n/);
  return lines.length - (lines.at(-1) === '' ? 1 : 0);
}

function category(file) {
  if (/(?:^|\/)(?:tests?|e2e)(?:\/|$)|(?:\.test\.[^.]+$|\/(?:smoke_|test_)[^/]+\.py$)/.test(file)) return 'test';
  if (file.startsWith('skills/')) return 'skill';
  if (/(?:^|\/)locales\//.test(file)) return 'resource';
  if (file.endsWith('.css')) return 'style';
  if (/^(?:tools|ops)\//.test(file)) return 'tool';
  return 'runtime';
}

function collect(root, files = sourceFiles(root)) {
  const rows = [];
  for (const file of files) {
    if (!EXTENSIONS.has(path.posix.extname(file)) || EXCLUDED.test(file)) continue;
    const full = path.join(root, file);
    // The index can still name a file after its parent directory became a link.
    // Check every component before reading a developer's private runtime/data.
    let current = root;
    let stat;
    for (const part of file.split('/')) {
      current = path.join(current, part);
      stat = fs.lstatSync(current, { throwIfNoEntry: false });
      if (!stat || stat.isSymbolicLink()) break;
    }
    if (!stat?.isFile() || stat.isSymbolicLink()) continue;
    const lines = lineCount(fs.readFileSync(full, 'utf8'));
    if (lines > LIMIT) rows.push({ file, lines, category: category(file) });
  }
  return rows.sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));
}

function report(rows, baseline) {
  if (baseline.version !== 1 || baseline.limit !== LIMIT ||
      !Array.isArray(baseline.files) || baseline.files.some(row =>
        typeof row.file !== 'string' || !Number.isInteger(row.lines) || row.lines <= LIMIT)) {
    throw Error('Invalid source size baseline');
  }
  const previous = new Map(baseline.files.map(row => [row.file, row.lines]));
  const inventory = rows.map(row => ({ ...row, previousLines: previous.get(row.file) ?? null,
    change: !previous.has(row.file) ? 'new' : row.lines > previous.get(row.file) ? 'grown' : 'known' }));
  return { advisory: true, limit: LIMIT, oversizedFiles: inventory.length,
    attention: inventory.filter(row => row.change !== 'known'), inventory };
}

function format(result, list = false) {
  const lines = [`Source size review (advisory): ${result.oversizedFiles} files exceed ${result.limit} lines; ${result.attention.length} new or grown.`];
  for (const row of list ? result.inventory : result.attention) {
    const delta = row.previousLines === null ? 'new' : `${row.lines - row.previousLines >= 0 ? '+' : ''}${row.lines - row.previousLines}`;
    lines.push(`  ${row.file}: ${row.lines} lines (${row.category}, ${delta})`);
  }
  lines.push('Review responsibilities and dependencies; size alone never fails this check. Use --list to see the inventory.');
  return lines.join('\n');
}

function main(args = process.argv.slice(2)) {
  if (args.some(arg => !['--list', '--json'].includes(arg))) throw Error('Usage: node tools/check-source-size.cjs [--list] [--json]');
  const result = report(collect(ROOT), JSON.parse(fs.readFileSync(path.join(ROOT, BASELINE), 'utf8')));
  console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : format(result, args.includes('--list')));
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { LIMIT, lineCount, category, collect, report, format, main };
