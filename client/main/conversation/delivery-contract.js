'use strict';

/* The workspace is evidence. Only a declared or inferred result is a deliverable. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const artifactTitle = require('./artifact-title');

const SCHEMA_VERSION = 1;
const MAX_ITEMS = 500;
const MANIFEST_RELATIVE = '.soduwork/delivery.json';
const KINDS = Object.freeze({
  '.docx': 'document',
  '.doc': 'document',
  '.odt': 'document',
  '.pptx': 'presentation',
  '.ppt': 'presentation',
  '.odp': 'presentation',
  '.xlsx': 'spreadsheet',
  '.xls': 'spreadsheet',
  '.ods': 'spreadsheet',
  '.csv': 'spreadsheet',
  '.pdf': 'pdf',
  '.html': 'website',
  '.htm': 'website',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.gif': 'image',
  '.svg': 'image',
  '.mp4': 'video',
  '.webm': 'video',
  '.mov': 'video',
  '.m4v': 'video',
  '.ogv': 'video',
  '.zip': 'archive',
  '.skill': 'archive',
  '.7z': 'archive',
  '.tar': 'archive',
  '.gz': 'archive',
  '.md': 'document',
  '.markdown': 'document',
  '.txt': 'document',
  '.json': 'file',
});
const DIRECT = new Set([
  'document', 'presentation', 'spreadsheet', 'pdf', 'video', 'archive',
]);
const PROCESS_DIRS = new Set([
  'src', 'source', 'test', 'tests', 'spec', 'specs', 'coverage',
  'node_modules', '.git', '.pi', '.soduwork', 'log', 'logs', 'tmp', 'temp',
]);
const PROCESS_FILES = new Set([
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  'bun.lockb', 'pyproject.toml', 'requirements.txt', 'code-review.json',
  'delivery-review.json', 'workflow-decision.json',
  'readme.md', 'readme.txt', 'changelog.md', 'license.txt', 'agents.md', 'contributing.md',
]);
const PROCESS_PREFIXES = [
  'tsconfig', 'vite.config', 'webpack.config', 'eslint.config',
  'test-result', 'coverage',
];
const PROCESS_WORDS = [
  'test', 'spec', 'fixture', 'mock', 'cache', 'debug', 'trace', 'log',
  'screenshot', 'screen-shot', 'command-output', 'terminal-output',
  'browser-output', 'tool-output', '\u4e34\u65f6', '\u8349\u7a3f',
  '\u622a\u56fe',
];
// A deliverable title can legitimately name a test plan or a testing tool.
// Treat Chinese testing terms as process evidence only when
// it names a report/result, matching the server-side delivery classifier.
const PROCESS_PHRASES = ['\u6d4b\u8bd5\u62a5\u544a', '\u6d4b\u8bd5\u7ed3\u679c',
  '\u6d4b\u8bd5\u8bc1\u636e', '\u9a8c\u6536\u62a5\u544a', '\u9a8c\u6536\u8bc1\u636e'];
const FINAL_WORDS = [
  'final', 'result', 'report', 'summary', 'deliverable', 'output',
  'proposal', 'presentation', 'prototype', '\u6210\u679c', '\u7ed3\u679c',
  '\u62a5\u544a', '\u65b9\u6848', '\u4ea4\u4ed8', '\u6210\u54c1',
  '\u7ec8\u7a3f', '\u539f\u578b',
];

const clean = (value, limit) =>
  String(value == null ? '' : value).trim().slice(0, limit);
const relative = (value) =>
  String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
const kindOf = (value) =>
  KINDS[path.extname(String(value || '')).toLowerCase()] || '';
const previewOf = (kind) =>
  ['website', 'pdf', 'image', 'video'].includes(kind);

function artifactId(kind, value) {
  const key = String(kind || 'file') + '\0' + relative(value);
  return 'art_' + crypto.createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 24);
}

function actionsOf(kind) {
  return kind === 'website' || kind === 'video'
    ? ['preview', 'open', 'reveal']
    : ['open', 'reveal'];
}

function inside(root, target) {
  const base = path.resolve(root || '.');
  const part = path.relative(base, path.resolve(target || ''));
  return Boolean(part && !part.startsWith('..') && !path.isAbsolute(part));
}

function hasWord(value, words) {
  const text = String(value || '').toLowerCase();
  return words.some((word) => text.includes(word));
}

function isProcessName(value) {
  const text = String(value || '').toLowerCase();
  if (PROCESS_PHRASES.some((phrase) => text.includes(phrase))) return true;
  return PROCESS_WORDS.some((word) => {
    // Keep short ASCII markers boundary-aware so names like “latest.md” do
    // not become process evidence merely because they contain “test”.
    if (/^[a-z0-9-]+$/.test(word)) {
      const escaped = word.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
      return new RegExp('(^|[^a-z0-9])' + escaped + '([^a-z0-9]|$)', 'i').test(text);
    }
    return text.includes(word);
  });
}

function publicFile(file, spec, cwd) {
  const requestedKind = clean(spec && spec.kind, 32);
  const inferredKind = kindOf(file.name || file.path);
  /* "file" is the manifest's generic fallback, not an instruction to erase a
     format that can be determined from the real artifact.  Keeping .md as
     "file" made the document gate demand an unnecessary PDF repair cycle. */
  const kind = (!requestedKind || requestedKind === 'file')
    ? (inferredKind || 'file') : requestedKind;
  const requestedTitle = clean(spec && (spec.title || spec.label), 160);
  const rel = relative(file.relative || file.rel || file.name);
  return {
    ...file,
    artifactId: artifactId(kind, rel),
    relative: rel,
    kind,
    title: requestedTitle || artifactTitle.fromFile(cwd, file) || String(file.name || '\u672a\u547d\u540d\u6210\u679c'),
    summary: clean(spec && spec.summary, 500),
    preview: typeof (spec && spec.preview) === 'boolean'
      ? spec.preview
      : previewOf(kind),
    primary: !spec || spec.primary !== false,
    ...(spec?.role ? { role: spec.role } : {}),
    ...(Array.isArray(spec?.replaces) ? { replaces: spec.replaces.filter(value => typeof value === 'string') } : {}),
    actions: actionsOf(kind),
    runtime: kind === 'website'
      ? { type: 'static', autoStart: true }
      : null,
    changedInTurn: Boolean(file.changedInTurn),
  };
}

function readManifest(cwd) {
  try {
    const file = path.join(cwd || '', MANIFEST_RELATIVE);
    if (!fs.statSync(file).isFile()) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const valid = raw &&
      Number(raw.schemaVersion) === SCHEMA_VERSION &&
      Array.isArray(raw.deliverables);
    if (valid) return raw;
    return {
      invalid: true,
      reason: '\u4ea4\u4ed8\u6e05\u5355\u683c\u5f0f\u4e0d\u7b26\u5408 SoduWork v1 \u534f\u8bae',
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return {
      invalid: true,
      reason: '\u4ea4\u4ed8\u6e05\u5355\u65e0\u6cd5\u8bfb\u53d6\uff1a' +
        String(error && error.message || error),
    };
  }
}

function fromManifest(cwd, files, manifest) {
  const byRel = new Map(
    (files || []).map((file) => [relative(file.relative), file]),
  );
  const items = [];
  const warnings = [];
  // Keep one overflow entry so packaging rejects an oversized manifest instead
  // of silently publishing a truncated delivery.
  const declared = manifest.presentation === 'summary' ? [] : (manifest.deliverables || []).slice(0, MAX_ITEMS + 1);
  declared.forEach((spec) => {
    const rel = relative(spec && (spec.path || spec.entry));
    const full = path.resolve(cwd, rel);
    if (!rel || rel.includes('../') || !inside(cwd, full)) {
      warnings.push(
        '\u5df2\u5ffd\u7565\u4e0d\u5b89\u5168\u7684\u4ea4\u4ed8\u8def\u5f84',
      );
      return;
    }
    let file = byRel.get(rel);
    if (!file) {
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile()) throw new Error('\u4e0d\u662f\u6587\u4ef6');
        file = {
          path: full,
          relative: rel,
          name: path.basename(full),
          size: stat.size,
          at: Math.round(stat.mtimeMs),
        };
      } catch (_) {
        warnings.push(
          '\u4ea4\u4ed8\u6587\u4ef6\u4e0d\u5b58\u5728\uff1a' + rel,
        );
        return;
      }
    }
    items.push(publicFile(file, spec, cwd));
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    source: 'manifest',
    presentation: manifest.presentation === 'summary' ? 'summary' : 'artifacts',
    summary: clean(manifest.summary, 800),
    items: items.slice(0, MAX_ITEMS + 1),
    warnings,
  };
}

function isProcess(file) {
  const rel = relative(file.relative || file.name);
  const name = path.basename(rel).toLowerCase();
  const stem = name.replace(/\.[^.]+$/, '');
  const inProcessDir = rel
    .toLowerCase()
    .split('/')
    .slice(0, -1)
    .some((part) => PROCESS_DIRS.has(part));
  const configured = PROCESS_FILES.has(name) ||
    PROCESS_PREFIXES.some((prefix) => {
      return stem === prefix || stem.startsWith(prefix + '.');
    });
  // Browser verification commonly uses numbered shots. Classify them here,
  // once, so the artifact index and every runtime's UI receive the same flag.
  // A delivery manifest can still explicitly declare a requested screenshot.
  const verificationShot = kindOf(name) === 'image' &&
    /^(?:verify|verification)[-_.](?:(?:shot|frame)(?:[-_.]?\d+)?|top|bottom|desktop|mobile|after[-_]click)$/i.test(stem);
  const jsonProcess = path.extname(name) === '.json' && (
    name.startsWith('.') || name === 'npm-shrinkwrap.json' ||
    /(?:^|[-_.])(?:config|settings|lock|credentials?|secrets?|auth|tokens?|service[-_]account)(?:[-_.]|$)/i.test(stem) ||
    rel.split('/').slice(0, -1).some(part => part.startsWith('.') || /^(?:cache|config|configs|settings)$/i.test(part))
  );
  return inProcessDir || configured || verificationShot || jsonProcess || isProcessName(stem);
}

function websiteRank(file) {
  const rel = relative(file.relative);
  const entry = /(?:^|\/)index\.html?$/i.test(rel) ? 2 : 0;
  const built = /(?:^|\/)(?:dist|build|public)(?:\/|$)/i.test(rel) ? 1 : 0;
  return entry + built;
}

function infer(files, cwd) {
  // A repository's entry HTML and documentation are source files. Explicit
  // manifests can still declare a standalone report/site produced in a repo.
  const project = Boolean(cwd && ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'CMakeLists.txt']
    .some(name => fs.existsSync(path.join(cwd, name))));
  const rows = (files || []).filter((file) => !isProcess(file) && (!project ||
    !['website', 'document'].includes(kindOf(file.name)) ||
    !/\.(?:html?|md|markdown|txt)$/i.test(file.name) ||
    /(?:^|\/)(?:outputs|deliverables|exports)\//i.test(relative(file.relative))));
  const sites = rows
    .filter((file) => kindOf(file.name) === 'website')
    .sort((a, b) => {
      return Number(Boolean(b.changedInTurn)) - Number(Boolean(a.changedInTurn)) ||
        websiteRank(b) - websiteRank(a) ||
        Number(b.at || 0) - Number(a.at || 0);
    });
  const items = [];
  if (sites[0]) {
    items.push(publicFile(sites[0], {
      kind: 'website',
      title: artifactTitle.fromFile(cwd, sites[0]) || (sites[0].name === 'index.html'
        ? '\u7f51\u7ad9\u9884\u89c8'
        : sites[0].name),
      summary: '\u53ef\u5728 SoduWork \u53f3\u4fa7\u5de5\u4f5c\u533a\u76f4\u63a5\u6253\u5f00',
      preview: true,
    }));
  }
  rows.forEach((file) => {
    if (items.some((item) => item.path === file.path)) return;
    const kind = kindOf(file.name);
    const stem = String(file.name || '').replace(/\.[^.]+$/, '');
    const namedResult = hasWord(stem, FINAL_WORDS);
    // JSON often holds configuration or source data. Infer only an output
    // directory or a standalone workspace root result; manifests stay authoritative.
    const jsonResult = /\.json$/i.test(file.name) && (
      /(?:^|\/)(?:outputs|deliverables|exports)\//i.test(relative(file.relative)) ||
      (!project && (namedResult || !relative(file.relative || file.name).includes('/')))
    );
    // A final-named image next to a website is ambiguous: it may be a browser
    // capture or a page asset. Only a manifest or the media index declares it
    // as a separate deliverable; dependency collection still includes site assets.
    if (DIRECT.has(kind) || jsonResult ||
        ((kind === 'document' || (kind === 'image' && !sites.length)) && namedResult)) {
      items.push(publicFile(file));
    }
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    source: 'inferred',
    summary: '',
    items: items
      .sort((a, b) => Number(b.at || 0) - Number(a.at || 0))
      .slice(0, MAX_ITEMS),
    warnings: [],
  };
}

function classify(cwd, files) {
  const manifest = readManifest(cwd);
  const result = manifest && !manifest.invalid
    ? fromManifest(cwd, files, manifest)
    : infer(files, cwd);
  // A completed media download explicitly declares a deliverable. Match only
  // the actual workspace inventory and retain the existing delivery manifest.
  try {
    if (result.presentation === 'summary') return { ...result, workspaceFileCount: (files || []).length, omittedCount: (files || []).length };
    const indexFile = path.join(cwd, 'outputs', '.soduwork-media-index.json');
    if (fs.statSync(indexFile).size <= 256 * 1024) {
      const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      const generated = new Set(Object.values(index).filter(value => typeof value === 'string')
        .map(value => 'outputs/' + value.replace(/\\/g, '/')));
      const present = new Set(result.items.map(item => item.relative));
      const media = (files || []).filter(file => generated.has(file.relative) && !present.has(file.relative) &&
        ['image', 'video'].includes(kindOf(file.relative)) && !isProcess(file));
      result.items = [...media.map(file => publicFile(file, { primary: true })), ...result.items].slice(0, MAX_ITEMS);
    }
  } catch (_) { /* No completed media index in ordinary workspaces. */ }
  if (manifest && manifest.invalid) {
    result.warnings.push(manifest.reason);
  }
  result.workspaceFileCount = (files || []).length;
  result.omittedCount = Math.max(
    0,
    result.workspaceFileCount - result.items.length,
  );
  return result;
}

// A final reply can nominate an output already observed during this turn.
// A link alone never grants access to a file or satisfies execution checks.
function fromReply(cwd, snapshot, scanned) {
  if (!cwd || !scanned?.files?.length) return scanned;
  const existing = scanned.delivery?.source === 'manifest';
  if (existing && (!scanned.turnSince || scanned.delivery.presentation === 'summary' || scanned.delivery.warnings?.length))
    return scanned;
  const selection = require('./delivery-selection');
  const { request, answer } = selection.turn(snapshot || {});
  if (!answer) return scanned;
  if (answer.length > 256 * 1024) return scanned;
  const markdown = require('../../core/markdown');
  const linked = new Set();
  markdown.walkTokens(markdown.lexer(answer), token => {
    if (token.type !== 'link' || !token.href || /^(?:[a-z][a-z0-9+.-]*:|[/]{2}|#)/i.test(token.href)) return;
    try {
      const target = path.resolve(cwd, decodeURIComponent(token.href));
      if (kindOf(target) && inside(cwd, target)) linked.add(target);
    } catch (_) { /* Invalid URL encoding is not a file reference. */ }
  });
  if (!linked.size) return scanned;
  if (existing) {
    // An explicitly updated manifest and policies for grouped, withdrawn or
    // networked outputs remain authoritative. A stale simple list from an
    // older producer should not mask this turn's newly verified deliverable.
    try {
      const file = path.join(cwd, MANIFEST_RELATIVE);
      require('../plugin-resources').assertNoLinks(cwd, file);
      if (fs.statSync(file).mtimeMs >= scanned.turnSince) return scanned;
      const manifest = readManifest(cwd);
      if (!manifest || manifest.invalid || manifest.runtime || manifest.processFiles?.length ||
          manifest.deliverables.some(item => item?.files?.length || item?.replaces?.length || item?.primary === false || item?.role))
        return scanned;
      if ([...linked].every(target => scanned.delivery.items.some(item => path.resolve(item.path) === target))) return scanned;
    } catch (_) { return scanned; }
  }
  const { portablePath, excludedName } = require('./portable-workspace');
  const { assertNoLinks } = require('../plugin-resources');
  const items = [], requestCaptures = selection.requestsCaptures(request);
  for (const file of scanned.files) {
    if (!file.changedInTurn || !file.path || !file.relative || file.processEvidence ||
        isProcess(file) && !(requestCaptures && kindOf(file.relative) === 'image') || !kindOf(file.relative) ||
        !linked.has(path.resolve(file.path))) continue;
    try {
      portablePath(file.relative);
      if (file.relative.split('/').some(part => part.startsWith('.') || excludedName(part))) continue;
      const root = fs.realpathSync(cwd), target = path.join(root, file.relative);
      assertNoLinks(root, target);
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(file.path) !== target ||
          stat.size !== file.size || Math.round(stat.mtimeMs) !== file.at) continue;
      items.push(publicFile(file, { primary: true }, cwd));
      linked.delete(path.resolve(file.path));
    } catch (_) { /* A stale or non-portable link is not an output receipt. */ }
  }
  if (!items.length) return scanned;
  return { ...scanned, delivery: { schemaVersion: 1, source: 'conversation', presentation: 'artifacts',
    items, warnings: linked.size ? ['部分交付链接未匹配本轮工作区文件，请核对后重新交付'] : [],
    workspaceFileCount: scanned.files.length, omittedCount: scanned.files.length - items.length } };
}

function instructions() {
  return [
    '[SoduWork 交付清单协议]',
    '说明、问答、开发和审查以答复、实际改动及验证结果收尾。需要交付文件时，在最终答复中用 Markdown 链接逐一指向本轮完成的成品，例如 [打开网页](dist/index.html)。',
    '使用工作区相对路径。多个文件组成一个交付包时，保留真实依赖结构并链接入口；独立成品分别给出链接。涉及服务时必须实际启动、验证接口并给出实际运行地址。',
    '不要在用户工程中创建会话清单、进度文件或验证目录。验证结果保留在工具回执和答复中；只有用户需要截图等文件时才保存到交付位置。',
    '已存在的工程交付清单仍可读取，保留用户定义的文件、替代关系、网络依赖与导出规则。',
  ].join('\n');
}

module.exports = {
  SCHEMA_VERSION,
  MANIFEST_RELATIVE,
  classify,
  infer,
  readManifest,
  instructions,
  fromReply,
  _inside: inside,
  _isProcess: isProcess,
  _kindOf: kindOf,
  _artifactId: artifactId,
};
