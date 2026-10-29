#!/usr/bin/env node
/**
 * Enforce the reviewed innerHTML write-site inventory.
 *
 * 1. A file may not exceed its count in tools/unsanitized-html-baseline.json.
 *    Prefer textContent or explicitly escaped rendering for new output.
 * 2. Report template interpolation without a same-line esc()/_esc() call;
 *    --strict rejects these findings, including existing ones.
 *
 * Usage:
 *   node tools/check-unsanitized-html.cjs                   # Enforce additions.
 *   node tools/check-unsanitized-html.cjs --strict          # Reject all findings.
 *   node tools/check-unsanitized-html.cjs --update-baseline # After manual review.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const clientDir = path.join(root, 'client');
const scanDirs = ['app', 'components', 'core'].map(d => path.join(clientDir, d));
const baselinePath = path.join(__dirname, 'unsanitized-html-baseline.json');

const SKIP_DIRS = new Set(['node_modules', 'dist', '.runtime', 'tests', 'e2e']);
const WRITE_RE = /\.innerHTML\s*(\+=|=)/;

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.endsWith('.test.js') || e.name.endsWith('.test.cjs')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(p); }
    else if (e.name.endsWith('.js')) yield p;
  }
}

function scan() {
  const counts = new Map();
  const hits = [];
  for (const dir of scanDirs) {
    for (const file of walk(dir)) {
      const rel = path.relative(root, file).replace(/\\/g, '/');
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      let count = 0;
      lines.forEach((line, i) => {
        if (!WRITE_RE.test(line)) return;
        count += 1;
        if (line.includes('${') && !/\besc\s*\(|_esc\s*\(/.test(line)) {
          hits.push({ file: rel, line: i + 1, text: line.trim().slice(0, 160) });
        }
      });
      if (count) counts.set(rel, count);
    }
  }
  return { counts, hits };
}

function main() {
  const args = process.argv.slice(2);
  const update = args.includes('--update-baseline');
  const strict = args.includes('--strict');
  const { counts, hits } = scan();
  const current = Object.fromEntries([...counts.entries()].sort());

  if (update) {
    fs.writeFileSync(baselinePath, JSON.stringify(current, null, 2) + '\n', 'utf8');
    const total = Object.values(current).reduce((a, b) => a + b, 0);
    console.log(`[unsanitized-html] 基线已更新：${Object.keys(current).length} 个文件 / ${total} 个写入点`);
    return;
  }

  let baseline;
  try { baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')); } catch { baseline = {}; }
  let failed = false;
  const allFiles = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  for (const f of [...allFiles].sort()) {
    const before = baseline[f] || 0, now = current[f] || 0;
    if (now > before) {
      console.error(`[unsanitized-html] ✖ ${f}: innerHTML 写入点 ${before} → ${now}。` +
        `新写入点必须 esc()/_esc() 转义或改 textContent；确需放宽请人工审查后 --update-baseline。`);
      failed = true;
    }
  }
  const reportHits = strict ? hits : hits.filter(h => (baseline[h.file] || 0) < (counts.get(h.file) || 0));
  for (const h of reportHits) {
    console.error(`[unsanitized-html] ${strict ? '✖' : 'ℹ'} ${h.file}:${h.line} 未转义插值: ${h.text}`);
    if (strict) failed = true;
  }
  const total = Object.values(current).reduce((a, b) => a + b, 0);
  console.log(`[unsanitized-html] ${Object.keys(current).length} 个文件 / ${total} 个 innerHTML 写入点，` +
    (failed ? '检查未通过' : '无新增未转义写入点'));
  process.exit(failed ? 1 : 0);
}

main();
