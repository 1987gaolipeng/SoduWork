'use strict';
// Windows packages keep application templates in their JavaScript consumers.
// They must not become loose documents that a filesystem filter can wrap before
// the runtime reads them. This changes reviewed build output, never user files.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { isNoticePath } = require('../build/verify-payload.cjs');

const PI = 'resources/pi/node_modules/@earendil-works/pi-coding-agent';
const DOCUMENTS = new Set([
  'resources/pi/node_modules/bignumber.js/doc/API.html',
  'resources/pi/node_modules/tslib/tslib.es6.html',
  'resources/pi/node_modules/tslib/tslib.html',
]);
const RULES = [
  { id: 'pi-export', template: PI + '/dist/core/export-html/template.html',
    entry: PI + '/dist/core/export-html/index.js',
    consumer: file => file === PI + '/dist/core/export-html/index.js' ||
      (file.startsWith(PI + '/dist/bundle/') && file.endsWith('.js')),
    expression: /\breadFileSync\d*\(join\d*\(templateDir,\s*"template\.html"\),\s*"utf-8"\)/g,
    filename: 'template.html' },
  ...['resources/skills/brainstorming', 'resources/runner/_internal/skills/brainstorming'].map((base, index) => ({
    id: 'brainstorm-frame-' + index, template: base + '/scripts/frame-template.html',
    entry: base + '/scripts/server.cjs', consumer: file => file === base + '/scripts/server.cjs',
    expression: /\bfs\.readFileSync\(path\.join\(__dirname, 'frame-template\.html'\), 'utf-8'\)/g,
    filename: 'frame-template.html',
  })),
];

function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function decode(bytes, file) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw Error('Invalid UTF-8 build resource: ' + file); }
}
function inside(root, relative) {
  const target = path.resolve(root, relative), prefix = root + path.sep;
  if (!target.startsWith(prefix)) throw Error('HTML resource escaped build directory: ' + relative);
  return target;
}
async function collectFiles(root) {
  const files = new Set();
  async function visit(relative) {
    const absolute = inside(root, relative), stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) throw Error('HTML resource cannot be a symbolic link: ' + relative);
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(absolute)) await visit(relative + '/' + name);
    } else if (stat.isFile()) files.add(relative);
    else throw Error('Unsupported build resource type: ' + relative);
  }
  for (const name of await fs.readdir(root)) await visit(name);
  return files;
}
function embeddedValue(source, rule, file) {
  const marker = '/* SODUWORK_HTML_TEMPLATE:' + rule.id + ':';
  const start = source.indexOf(marker);
  if (start === -1) return null;
  if (source.indexOf(marker, start + marker.length) !== -1) throw Error('Duplicate embedded HTML template: ' + file);
  const match = /^([a-f0-9]{64}) \*\/\s*("(?:[^"\\]|\\[\s\S])*")/.exec(source.slice(start + marker.length));
  if (!match) throw Error('Invalid embedded HTML template: ' + file);
  const value = JSON.parse(match[2]);
  if (digest(Buffer.from(value, 'utf8')) !== match[1]) throw Error('Changed embedded HTML template: ' + file);
  return { value, sha256: match[1] };
}

async function prepareHtmlResources(appOutDir) {
  if (typeof appOutDir !== 'string' || !path.isAbsolute(appOutDir)) throw Error('An absolute packaged application directory is required');
  const root = path.resolve(appOutDir), rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Error('Packaged application directory must be a real directory');
  // Source trees do not contain this packaged-only sentinel. Check it through
  // the same symlink-rejecting walk as every mutation target before writing.
  const files = await collectFiles(root);
  if (!files.has('resources/app.asar')) throw Error('Missing packaged resources/app.asar; refusing to modify source resources');
  const knownTemplates = new Set(RULES.map(rule => rule.template));
  const remainingHtml = [...files].filter(file => /\.html?$/i.test(file) && !knownTemplates.has(file) && !DOCUMENTS.has(file));
  for (const file of remainingHtml) {
    if (!isNoticePath(file)) throw Error('Unreviewed loose HTML resource in Windows package: ' + file);
  }
  const writes = new Map(), removals = new Set([...files].filter(file => DOCUMENTS.has(file))), embeddedTemplates = [];
  for (const rule of RULES) {
    const hasTemplate = files.has(rule.template), consumers = [...files].filter(rule.consumer);
    if (!hasTemplate && !files.has(rule.entry) && consumers.length === 0) continue;
    if (!files.has(rule.entry)) throw Error('Missing HTML template consumer: ' + rule.entry);
    const bytes = hasTemplate ? await fs.readFile(inside(root, rule.template)) : null;
    const value = bytes ? decode(bytes, rule.template) : null;
    if (bytes && (!bytes.length || value.includes('\0') || !/<html\b/i.test(value))) throw Error('Invalid HTML template source: ' + rule.template);
    let expectedDigest = bytes ? digest(bytes) : null;
    let count = 0;
    for (const file of consumers) {
      const source = decode(await fs.readFile(inside(root, file)), file);
      const embedded = embeddedValue(source, rule, file);
      const matches = [...source.matchAll(rule.expression)];
      if (embedded) {
        if (source.includes(rule.filename) || (expectedDigest && expectedDigest !== embedded.sha256)) {
          throw Error('HTML template changed after embedding: ' + file);
        }
        expectedDigest = embedded.sha256;
        count++; continue;
      }
      if (matches.length === 0 && !source.includes(rule.filename) && file !== rule.entry) continue;
      if (matches.length !== 1 || !hasTemplate) throw Error('Unsupported HTML template consumer layout: ' + file);
      const replacement = '/* SODUWORK_HTML_TEMPLATE:' + rule.id + ':' + expectedDigest + ' */ ' + JSON.stringify(value);
      const next = source.replace(rule.expression, () => replacement);
      if (next.includes(rule.filename)) throw Error('Unreviewed HTML template reference: ' + file);
      writes.set(file, next); count++;
    }
    if (!count) throw Error('No HTML template consumer was prepared: ' + rule.template);
    if (hasTemplate) removals.add(rule.template);
    embeddedTemplates.push({ path: rule.template, consumers: count, changed: hasTemplate });
  }
  // Plan and validate the whole package first. Unknown HTML or dependency drift
  // must fail before any reviewed resource is rewritten or removed.
  for (const [relative, source] of writes) await fs.writeFile(inside(root, relative), source, 'utf8');
  for (const relative of removals) await fs.unlink(inside(root, relative));
  return { embeddedTemplates, excludedDocuments: [...removals].filter(file => DOCUMENTS.has(file)), remainingHtml };
}

module.exports = { prepareHtmlResources };
