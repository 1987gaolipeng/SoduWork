'use strict';

/*
 * Hard brand gate for the public source tree.
 *
 * The public distribution must not contain the legacy keyword anywhere:
 * not in file contents and not in file paths. Unlike the retired compatibility
 * inventories, there are no approved exceptions: every hit is an error. The
 * canonical product identifiers use the SoduWork spelling family
 * (SoduWork, soduWorkAPI, soduwork.access-policy/v1, .soduwork/, SODUWORK_*).
 *
 * Scanned inventory: git-tracked files plus untracked-but-not-ignored files
 * (mirrors tools/source-files.cjs), so a stray uncommitted copy cannot hide.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const LEGACY = new RegExp([
  ['s', 'o', 'd', 'o'].join(''),
  ['b', 'u', 'b', 'b', 'l', 'y'].join(''),
  ['b', 'o', 'x', 'h', 'u', 'b'].join(''),
  ['b', 'o', 'x', '_', 'h', 'u', 'b'].join(''),
  ['b', 'o', 'x', '-', 'h', 'u', 'b'].join(''),
  ['x', '-', 'b', 'o', 'x'].join(''),
  // Transitional spellings: the four-letter prefix not followed by Work
  // (SoduWork/soduWorkAPI/soduwork are the canonical family).
  ['s', 'o', 'd', 'u', '(?!', ['w', 'o', 'r', 'k'].join(''), ')'].join(''),
].join('|'), 'i');

function inventory() {
  return execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split('\0').filter(name => name).sort();
}

function scan() {
  const errors = [];
  const scanned = { files: 0, hits: 0 };
  for (const name of inventory()) {
    if (LEGACY.test(name)) errors.push(`${name}: legacy keyword in path`);
    const full = path.join(root, name);
    const stat = fs.statSync(full, { throwIfNoEntry: false });
    if (!stat?.isFile()) continue;
    scanned.files += 1;
    const data = fs.readFileSync(full);
    // Skip binary blobs: compressed bytes can coincide with the keyword and are
    // not human-readable copy. Text extensions and UTF-8 text are scanned.
    if (data.includes(0)) continue;
    const text = data.toString('utf8');
    if (!LEGACY.test(text)) continue;
    scanned.hits += 1;
    const lines = text.split(/\r?\n/);
    const lineHits = [];
    lines.forEach((line, index) => {
      if (LEGACY.test(line)) {
        lineHits.push(index + 1);
        if (errors.length < 200) errors.push(`${name}:${index + 1}: ${line.trim().slice(0, 160)}`);
      }
    });
    scanned.hits += lineHits.length;
  }
  return { ok: errors.length === 0, scanned, errors };
}

if (require.main === module) {
  const result = scan();
  if (!result.ok) {
    console.error(`Brand gate failed: ${result.errors.length} legacy keyword reference(s) found.`);
    for (const error of result.errors.slice(0, 200)) console.error(error);
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ok: true, scannedFiles: result.scanned.files,
      message: 'No legacy keyword in public source paths or contents.' }));
  }
}

module.exports = { root, scan, LEGACY };
