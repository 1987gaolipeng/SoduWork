#!/usr/bin/env node
'use strict';

// Source inventory complements browser checks; it cannot prove every runtime
// state. Business values, model instructions and internal comparisons are kept
// separately, never added to the UI catalog just to reduce a count.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const client = path.join(root, 'client');
const parser = require(require.resolve('@babel/parser', { paths: [path.join(root, 'hub-frontend')] }));
const postcss = require(require.resolve('postcss', { paths: [path.join(root, 'hub-frontend')] }));
const han = /[\u3400-\u9fff]/;
const normalize = text => String(text).replace(/\s+/g, ' ').trim();
const shape = text => normalize(text).replace(/\{\w+\}/g, '{value}');
const decode = text => String(text).replace(/&(#x[\da-f]+|#\d+|quot|apos|lt|gt|amp|nbsp);/gi, (_, entity) => {
  if (entity[0] === '#') return String.fromCodePoint(entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
  return ({ quot: '"', apos: "'", lt: '<', gt: '>', amp: '&', nbsp: ' ' })[entity.toLowerCase()];
});
const localeDir = path.join(client, 'core/locales');
const manifest = JSON.parse(fs.readFileSync(path.join(localeDir, 'manifest.json'), 'utf8'));
const catalog = Object.assign({}, ...manifest.map(file => require(path.join(localeDir, file))));
const shapes = new Set(Object.keys(catalog).map(shape));
const context = { SoduWorkLocaleMessages: { 'en-US': catalog }, console, localStorage: { getItem() { return 'en-US'; } }, addEventListener() {}, dispatchEvent() {}, CustomEvent: class {} };
context.window = context;
vm.runInNewContext(fs.readFileSync(path.join(client, 'core/i18n.js'), 'utf8'), context);
const translate = context.SoduWorkI18n.translateText;
const entries = new Map();
const parseErrors = [];
let sourceFiles = 0;
let embeddedScripts = 0;
let cssSourceFiles = 0;
const cssContentRules = [];
const cssErrors = [];
let dynamicId = 0;
let activeSource = '';
const exclusionPath = path.join(__dirname, 'i18n-source-exclusions.json');
const exclusions = fs.existsSync(exclusionPath) ? JSON.parse(fs.readFileSync(exclusionPath, 'utf8')) : [];
const finiteVariants = require('./i18n-source-variants.cjs');
const variantErrors = [];
for (const rule of finiteVariants) {
  for (const variant of rule.variants) {
    const result = translate(variant, 'en-US');
    if (result === variant || han.test(result)) variantErrors.push({ file: rule.file, source: rule.source, variant, result });
  }
}

function record(source, file, line, kind, reason, sourceLine) {
  source = normalize(decode(source));
  if (!han.test(source) || !source || source.length > 16000) return;
  const relativeFile = path.relative(root, file).replaceAll('\\', '/');
  const reviewed = exclusions.find(row => row.file === relativeFile && shape(row.source) === shape(source));
  if (reviewed) { kind = reviewed.category; reason = reviewed.reason; }
  const covered = shapes.has(shape(source)) || translate(source, 'en-US') !== source;
  const finite = finiteVariants.find(row => row.file === relativeFile && shape(row.source) === shape(source));
  const validFinite = finite && !variantErrors.some(error => error.file === relativeFile && error.source === finite.source);
  const category = kind.startsWith('excluded-') ? kind : validFinite ? 'translated-enum' : covered ? 'translated' : kind;
  if (validFinite) reason = finite.reason;
  const key = category + '\0' + shape(source);
  if (!entries.has(key)) entries.set(key, { source, category, reason, locations: [] });
  const location = { file: relativeFile, line, context: normalize(sourceLine).slice(0, 360) };
  const item = entries.get(key);
  if (!item.locations.some(x => x.file === location.file && x.line === line)) item.locations.push(location);
}

function combine(left, right) {
  const result = [];
  for (const a of left) for (const b of right) {
    result.push(a + b);
    if (result.length >= 40) return result;
  }
  return result;
}

function variants(node) {
  if (!node) return [''];
  if (node.type === 'StringLiteral') return [node.value];
  if (node.type === 'NumericLiteral') return [String(node.value)];
  const expression = activeSource.slice(node.start, node.end);
  if (/^(?:ICON|ICONS|IC|ICO|SVG|icons)\./.test(expression) || /^(?:_svg|_icon|ico|icon|_capSvg|_dkOfficeIcon)\(/.test(expression) || expression === 'icon') return ['<i></i>'];
  if (node.type === 'TemplateLiteral') {
    let rows = [node.quasis[0].value.cooked ?? node.quasis[0].value.raw];
    node.expressions.forEach((expr, index) => { rows = combine(rows, variants(expr)); rows = rows.map(x => x + (node.quasis[index + 1].value.cooked ?? node.quasis[index + 1].value.raw)); });
    return rows;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+' && hasString(node)) return combine(variants(node.left), variants(node.right));
  if (node.type === 'ConditionalExpression') return [...variants(node.consequent), ...variants(node.alternate)].slice(0, 40);
  // The non-fallback value is business data; keep it as an interpolation.
  if (node.type === 'LogicalExpression' && ['||', '??'].includes(node.operator)) return [`{arg${++dynamicId}}`, ...variants(node.right)];
  return [`{arg${++dynamicId}}`];
}

function hasString(node) {
  if (!node) return false;
  if (['StringLiteral', 'TemplateLiteral'].includes(node.type)) return true;
  return node.type === 'BinaryExpression' && node.operator === '+' && (hasString(node.left) || hasString(node.right));
}

const attrs = new Set(['title', 'placeholder', 'aria-label', 'aria-description', 'aria-valuetext', 'alt', 'data-tooltip', 'data-ph']);
const protectedTags = new Set(['script', 'style', 'pre', 'code', 'textarea']);
const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
function inspectMarkup(markup, file, line, sourceLine, staticHtml = false) {
  markup = markup.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, match => match.replace(/[^\r\n]/g, ' '));
  const markupLines = staticHtml ? markup.split(/\r?\n/) : null;
  const stack = [];
  const tokens = markup.matchAll(/<!--[\s\S]*?-->|<\/?[a-z][\w:-]*\b(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+/gi);
  for (const token of tokens) {
    const value = token[0];
    const tokenLine = staticHtml ? line + markup.slice(0, token.index).split('\n').length - 1 : line;
    const tokenContext = staticHtml ? markupLines[tokenLine - line] : sourceLine;
    if (value.startsWith('<!--')) continue;
    const tag = /^<(\/)?([\w:-]+)/.exec(value);
    if (tag) {
      const name = tag[2].toLowerCase();
      if (tag[1]) { const at = stack.map(x => x.name).lastIndexOf(name); if (at >= 0) stack.length = at; continue; }
      const protectedAttribute = !!stack.at(-1)?.protected || ['script', 'style', 'pre', 'code'].includes(name) || /\bdata-(?:user|message)-content\b|\btranslate\s*=\s*["']no["']|\bcontenteditable\s*=\s*["']true["']/.test(value);
      const protectedContent = protectedAttribute || protectedTags.has(name);
      for (const attr of value.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        if (attrs.has(attr[1])) record(attr[2] ?? attr[3], file, tokenLine, protectedAttribute ? 'excluded-data' : 'missing-ui', protectedAttribute ? 'Protected business-content attribute' : 'Visible HTML attribute', tokenContext);
      }
      if (!voidTags.has(name) && !/\/>$/.test(value)) stack.push({ name, protected: protectedContent });
    } else {
      record(value, file, tokenLine, stack.at(-1)?.protected ? 'excluded-data' : 'missing-ui', stack.at(-1)?.protected ? 'Protected business-content text' : 'Visible HTML text', tokenContext);
    }
  }
}

function categoryFor(node, ancestors, source) {
  const boundary = ancestors.findLastIndex(x => /Function|ArrowFunction/.test(x.type));
  ancestors = ancestors.slice(boundary + 1);
  const parent = ancestors.at(-1);
  if (parent?.type === 'ObjectProperty' && parent.key === node && !parent.computed) return ['excluded-internal', 'Object lookup key'];
  if (parent?.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(parent.operator)) return ['excluded-internal', 'Comparison value'];
  const nearestProperty = [...ancestors].reverse().find(x => x.type === 'ObjectProperty');
  const property = nearestProperty?.key?.name ?? nearestProperty?.key?.value ?? '';
  if (/^(?:systemPrompt|system_prompt|prompt|instructions|task_prompt|prompt_text|prefill|contextPrompts)$/.test(property)) return ['excluded-instructions', 'Model or workflow instruction field'];
  const declaration = [...ancestors].reverse().find(x => x.type === 'VariableDeclarator');
  if (/^(?:contextPrompts|systemPrompt|system_prompt|prompt|prompts|prefill|seedPrompt)$/.test(declaration?.id?.name || '')) return ['excluded-instructions', 'Generated chat input or model instructions'];
  const calls = ancestors.filter(x => x.type === 'CallExpression').map(x => source.slice(x.callee.start, x.callee.end));
  const comparisonCall = [...ancestors].reverse().find(x => x.type === 'CallExpression' && /\.(?:includes|indexOf|match|replace|test)$/.test(source.slice(x.callee.start, x.callee.end)));
  const pattern = comparisonCall?.arguments[0];
  if (calls.some(x => /^console\./.test(x)) || pattern && pattern.start <= node.start && pattern.end >= node.end) return ['excluded-internal', 'Matching or logging operand; replacement values remain audited'];
  if (calls.some(x => /(?:toast|notify|alert|confirm|Error|setError|setStatus|_status|_note|_setMsg|sendNotice)/i.test(x))) return ['missing-ui', 'Notification or displayed error'];
  const assignment = [...ancestors].reverse().find(x => x.type === 'AssignmentExpression');
  if (assignment && /\.(?:textContent|innerHTML|title|placeholder|ariaLabel)\b/.test(source.slice(assignment.left.start, assignment.left.end))) return ['missing-ui', 'DOM presentation assignment'];
  if (/^(?:label|title|placeholder|hint|empty|subtitle|help|ariaLabel|badge|tooltip)$/.test(property)) return ['missing-ui', 'Presentation field'];
  return ['review', 'Source literal needs context review'];
}

function scan(file) {
  sourceFiles++;
  const source = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.html')) {
    inspectMarkup(source, file, 1, 'Static HTML', true);
    for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      if (/\bsrc\s*=/.test(match[1]) || !match[2].trim() || /\btype\s*=\s*["'](?:application\/(?:ld\+)?json|importmap)/i.test(match[1])) continue;
      const contentStart = match.index + match[0].indexOf('>') + 1;
      const precedingLines = source.slice(0, contentStart).split('\n').length - 1;
      embeddedScripts++;
      scanJavaScript(file, '\n'.repeat(precedingLines) + match[2]);
    }
    return;
  }
  scanJavaScript(file, source);
}

function scanJavaScript(file, source) {
  activeSource = source;
  const lines = source.split(/\r?\n/);
  let tree;
  try { tree = parser.parse(source, { sourceType: 'unambiguous', allowReturnOutsideFunction: true, plugins: ['jsx', 'typescript'] }); }
  catch (error) { parseErrors.push({ file: path.relative(root, file), error: error.message }); return; }
  function visit(node, ancestors = []) {
    if (!node || typeof node !== 'object') return;
    const parent = ancestors.at(-1);
    const isText = node.type === 'StringLiteral' || node.type === 'TemplateLiteral' || node.type === 'BinaryExpression' && node.operator === '+';
    let assembledByParent = false;
    for (const ancestor of [...ancestors].reverse()) {
      if (ancestor.type === 'TemplateLiteral' || ancestor.type === 'BinaryExpression' && ancestor.operator === '+') { assembledByParent = true; break; }
      if (!['ConditionalExpression', 'LogicalExpression'].includes(ancestor.type)) break;
    }
    if (isText && !assembledByParent) {
      const [kind, reason] = categoryFor(node, ancestors, source);
      const line = node.loc?.start.line || 1;
      for (const text of variants(node)) {
        if (!han.test(text)) continue;
        if (/^\s*(?:[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*')\s*)+$/.test(text) && !kind.startsWith('excluded-')) inspectMarkup('<span ' + text + '></span>', file, line, lines[line - 1]);
        else if (/<\/?[a-z][\w:-]*\b[^>]*>/i.test(text) && !kind.startsWith('excluded-')) inspectMarkup(text, file, line, lines[line - 1]);
        else record(text, file, line, kind, reason, lines[line - 1]);
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'extra', 'start', 'end', 'comments', 'leadingComments', 'trailingComments'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(child => { if (child?.type) visit(child, [...ancestors, node]); });
      else if (value?.type) visit(value, [...ancestors, node]);
    }
  }
  visit(tree);
}

// Pseudo-element content does not enter the DOM, so it needs a matching CSS
// locale rule rather than a dictionary entry. Keep this check separate from JS.
function scanCss(file) {
  cssSourceFiles++;
  const relativeFile = path.relative(root, file).replaceAll('\\', '/');
  let sheet;
  try { sheet = postcss.parse(fs.readFileSync(file, 'utf8'), { from: file }); }
  catch (error) { cssErrors.push({ file: relativeFile, error: error.message }); return; }
  const decodeCss = value => value.replace(/\\([\da-f]{1,6})(?:\r\n|[\t\n\r\f ])?|\\([^\n\r\f])/gi, (_, hex, literal) => hex ? String.fromCodePoint(Math.min(parseInt(hex, 16) || 0xfffd, 0x10ffff)) : literal);
  const canonicalSelector = selector => normalize(selector).replace(/\s*([>+~])\s*/g, '$1');
  const conditions = node => {
    const result = [];
    for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
      if (ancestor.type === 'atrule') result.unshift(ancestor.name + ' ' + normalize(ancestor.params));
    }
    return JSON.stringify(result);
  };
  const declarations = [];
  sheet.walkDecls('content', declaration => {
    if (declaration.parent.type !== 'rule') return;
    postcss.list.comma(declaration.parent.selector).forEach(selector => declarations.push({
      selector: canonicalSelector(selector), value: decodeCss(declaration.value), important: declaration.important,
      line: declaration.source.start.line, conditions: conditions(declaration.parent),
    }));
  });
  for (const original of declarations.filter(item => han.test(item.value))) {
    const expected = ':root[lang="en-US"] ' + original.selector;
    const overrides = declarations.filter(item => item.selector.replace(/\[lang=(?:'en-US'|en-US)\]/g, '[lang="en-US"]') === expected && item.conditions === original.conditions && (!original.important || item.important));
    const override = overrides.at(-1);
    const valid = override && !han.test(override.value) && /["'][^"']*[a-z][^"']*["']/i.test(override.value);
    const item = { file: relativeFile, line: original.line, selector: original.selector, source: original.value, translation: override?.value || null, overrideLine: override?.line || null, category: valid ? 'translated-css' : 'missing-css' };
    cssContentRules.push(item);
    if (!valid) cssErrors.push({ ...item, error: 'Chinese CSS content requires an explicit English :root[lang="en-US"] override under the same CSS conditions' });
  }
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!['node_modules', 'vendor', 'locales', 'tests', 'e2e', 'dist', 'build'].includes(entry.name)) walk(full); }
    else if (/\.(?:js|ts|html)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)) scan(full);
    else if (entry.name.endsWith('.css')) scanCss(full);
  }
}
walk(path.join(client, 'components'));
walk(path.join(client, 'core'));
if (fs.existsSync(path.join(client, 'app'))) walk(path.join(client, 'app'));
if (fs.existsSync(path.join(client, 'theme'))) walk(path.join(client, 'theme'));
scan(path.join(client, 'desk-boot.js'));
scan(path.join(client, 'api.js'));
scan(path.join(client, 'index.html'));
scan(path.join(client, 'desk.html'));
const items = [...entries.values()].sort((a, b) => a.locations[0].file.localeCompare(b.locations[0].file) || a.locations[0].line - b.locations[0].line);
const counts = {};
items.forEach(item => { counts[item.category] = (counts[item.category] || 0) + 1; });
const report = { generatedAt: new Date().toISOString(), sourceFiles, embeddedScripts, cssSourceFiles, cssContentRules, cssErrors, catalogEntries: Object.keys(catalog).length, counts, parseErrors, variantErrors, scope: 'Client components, core, app, desk-boot.js, api.js, and static HTML plus executable embedded scripts in index.html/desk.html; CSS content declarations in those source directories and theme require English overrides. Native dialogs have separate checks. Runtime values and unvisited branches still require browser verification.', items };
const outputAt = process.argv.indexOf('--output');
const out = outputAt >= 0 ? path.resolve(process.argv[outputAt + 1]) : path.join(root, 'outputs/i18n-2026-09-29/client-source-audit.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ sourceFiles, embeddedScripts, cssSourceFiles, cssContentRules: cssContentRules.length, catalogEntries: report.catalogEntries, counts, parseErrors, variantErrors, cssErrors, output: out }, null, 2));
if (process.argv.includes('--strict') && (counts['missing-ui'] || counts.review || parseErrors.length || variantErrors.length || cssErrors.length)) process.exitCode = 1;
