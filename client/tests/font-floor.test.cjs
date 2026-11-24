const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FLOOR = 12;
const ROOT = path.resolve(__dirname, '..');
const ADMIN_ROOT = path.resolve(__dirname, '..', '..', 'hub-frontend', 'src');
const EXCLUDED_PARTS = new Set(['vendor', 'tests', 'e2e', '.runtime', '.git', 'dist', 'node_modules', 'pi-chat', 'outputs', '%SystemDrive%']);
const SOURCE_EXTENSIONS = new Set(['.css', '.scss', '.html', '.js', '.cjs', '.mjs', '.ts', '.jsx', '.tsx']);
const PIXEL = /(?<![\w.])(?:\d+(?:\.\d+)?|\.\d+)px/gi;
const FONT_SIZE = /font-size\s*:\s*([^;}{]+)/gi;
const FONT_SHORTHAND = /(?<![-\w])font\s*:\s*([^;}{]+)/gi;
const FONT_SIZE_NUMBER = /\bfontSize\s*:\s*(\d+(?:\.\d+)?)(?![\w.])/g;
const FONT_SIZE_STRING = /\bfontSize\s*:\s*["'](\d+(?:\.\d+)?)px["']/g;

function walk(root, files = []) {
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_PARTS.has(entry.name) || /^\.codex-runtime-profile(?:-|$)/.test(entry.name)) continue;
      walk(absolute, files);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(absolute);
  }
  return files;
}

function lowPixels(value) {
  return [...value.matchAll(PIXEL)]
    .map((match) => Number.parseFloat(match[0]))
    .filter((value) => value < FLOOR);
}

function hasFloorGuard(value) {
  if (/max\s*\(\s*var\(\s*--font-min-readable\b/i.test(value)) return true;
  return [...value.matchAll(/max\s*\(\s*(\d+(?:\.\d+)?)px\s*,/gi)]
    .some(([, size]) => Number.parseFloat(size) >= FLOOR);
}

function inspect(file) {
  const source = fs.readFileSync(file, 'utf8');
  const issues = [];
  const lineAt = (index) => source.slice(0, index).split('\n').length;
  for (const match of source.matchAll(FONT_SIZE)) {
    const value = match[1].trim();
    const hasFloor = hasFloorGuard(value);
    const hasScaledCalc = /calc\([^;{}]*var\(\s*--font-scale\b/i.test(value);
    const relative = value.match(/^(?:max\s*\([^,]+,\s*)?(0?\.\d+|\d+\.\d+)em\b/i);
    const hasSmallRelative = relative && Number.parseFloat(relative[1]) < 1;
    if ((lowPixels(value).length || hasScaledCalc || hasSmallRelative) && !hasFloor) {
      issues.push(`${file}:${lineAt(match.index)} font-size ${value}`);
    }
  }
  for (const match of source.matchAll(FONT_SHORTHAND)) {
    const value = match[1].trim();
    const first = [...value.matchAll(PIXEL)][0];
    const hasScaledCalc = /calc\([^;{}]*var\(\s*--font-scale\b/i.test(value);
    const relative = value.match(/(?:^|\s)(0?\.\d+|\d+\.\d+)em\b/i);
    const hasSmallRelative = relative && Number.parseFloat(relative[1]) < 1;
    if (((first && Number.parseFloat(first[0]) < FLOOR) || hasScaledCalc || hasSmallRelative) && !hasFloorGuard(value)) {
      issues.push(`${file}:${lineAt(match.index)} font ${value}`);
    }
  }
  for (const match of source.matchAll(FONT_SIZE_NUMBER)) {
    if (Number.parseFloat(match[1]) < FLOOR) {
      issues.push(`${file}:${lineAt(match.index)} fontSize ${match[1]}`);
    }
  }
  for (const match of source.matchAll(FONT_SIZE_STRING)) {
    if (Number.parseFloat(match[1]) < FLOOR) {
      issues.push(`${file}:${lineAt(match.index)} fontSize ${match[1]}px`);
    }
  }
  return issues;
}

test('production UI typography never drops below the 12px product floor', () => {
  const dialogueCss = fs.readFileSync(path.join(ROOT, 'components', 'panels', 'panels-chat.css'), 'utf8');
  const traceCss = fs.readFileSync(path.join(ROOT, 'components', 'panels', 'task-trace-view.css'), 'utf8');
  const themeCss = fs.readFileSync(path.join(ROOT, 'theme', 'variables.css'), 'utf8');
  const workspaceCss = fs.readFileSync(path.join(ROOT, 'theme', 'workspace-experience.css'), 'utf8');
  assert.match(themeCss, /--font-min-readable:\s*12px/);
  assert.match(workspaceCss, /--font-min-readable:\s*12px/);
  assert.match(workspaceCss, /--text-xs:12px;--text-sm:13px;--text-base:14px;--text-md:15px/);
  assert.match(dialogueCss, /#cpChat\{[\s\S]*?--font-min-readable:12px;--text-xs:12px;--text-sm:13px;--text-base:14px;--text-md:15px;/);
  assert.match(dialogueCss, /#cpChat \.nchat-scroll\{[\s\S]*?--font-min-readable:14px;--text-xs:14px;--text-sm:14px;--text-base:14px;--text-md:15px;/);
  assert.match(dialogueCss, /#composePanel\{--font-min-readable:12px;--text-xs:12px;--text-sm:13px;--text-base:14px;--text-md:15px\}/);
  assert.match(dialogueCss, /\.ntext\{[^}]*font-size:14px/);
  assert.match(traceCss, /\.tfd-shell\{[\s\S]*?--font-min-readable:12px;--text-xs:12px;--text-sm:13px;--text-base:14px;--text-md:15px;/,
    'trace cards must use the compact UI floor instead of the transcript reading token');
  const files = [...walk(ROOT), ...walk(ADMIN_ROOT)];
  const issues = files.flatMap(inspect);
  assert.deepEqual(issues, [], `Found text declarations below ${FLOOR}px:\n${issues.join('\n')}`);
});
