'use strict';

/* Deterministic delivery gates. Model review can add gaps, but it cannot
   override a failed gate from this module. */
const fs = require('fs');
const path = require('path');
const deliveryContract = require('./delivery-contract');

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_SITE_FILES = 120;
const TEXT_EXT = new Set(['.html', '.htm', '.js', '.mjs', '.cjs', '.css']);
const ARTIFACT_WORK = new Set([
  'document', 'presentation', 'spreadsheet', 'website', 'interactive',
]);
const EXPECTED_KINDS = Object.freeze({
  document: ['document', 'pdf'],
  presentation: ['presentation', 'pdf'],
  spreadsheet: ['spreadsheet'],
  website: ['website'],
  interactive: ['website', 'archive'],
});

const clean = (value, limit) =>
  String(value == null ? '' : value).trim().slice(0, limit);

function check(key, label, pass, reason, action, evidence) {
  return {
    key,
    label,
    pass: Boolean(pass),
    status: pass ? 'passed' : 'failed',
    reason: pass ? '' : clean(reason, 600),
    action: pass ? '' : clean(action, 600),
    evidence: (Array.isArray(evidence) ? evidence : evidence ? [evidence] : [])
      .map((item) => clean(item, 500)).filter(Boolean).slice(0, 8),
  };
}

function statFile(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat : null;
  } catch (_) {
    return null;
  }
}

function head(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const size = fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, size);
  } finally {
    fs.closeSync(fd);
  }
}

function artifactProbe(item) {
  const file = item && item.path;
  const stat = file && statFile(file);
  if (!stat) return { pass: false, reason: '\u4ea4\u4ed8\u6587\u4ef6\u4e0d\u5b58\u5728\uff1a' + clean(item && item.relative, 260) };
  if (stat.size <= 0) return { pass: false, reason: '\u4ea4\u4ed8\u6587\u4ef6\u662f\u7a7a\u7684\uff1a' + clean(item && item.relative, 260) };
  const ext = path.extname(file).toLowerCase();
  let magic;
  try { magic = head(file, 128); } catch (error) {
    return { pass: false, reason: '\u4ea4\u4ed8\u6587\u4ef6\u65e0\u6cd5\u8bfb\u53d6\uff1a' + clean(error.message, 300) };
  }
  // Protected files cannot be validated by regenerating them: the endpoint
  // protection rewrites new files too. Never decrypt, waive, or disable protection.
  if (magic.subarray(0, 8).equals(Buffer.from('e0a891e7d8f205ac', 'hex')) &&
      magic.includes(Buffer.from('Esafenet', 'ascii'))) {
    return {
      pass: false, protected: true,
      reason: '交付文件受到终端文档保护（Esafenet），当前验收进程无法读取原始格式：' + item.relative,
    };
  }
  if (['.docx', '.xlsx', '.pptx', '.zip'].includes(ext) &&
      !(magic[0] === 0x50 && magic[1] === 0x4b)) {
    return { pass: false, reason: '\u6587\u4ef6\u6269\u5c55\u540d\u4e0e ZIP/Office \u771f\u5b9e\u683c\u5f0f\u4e0d\u7b26\uff1a' + item.relative };
  }
  if (ext === '.pdf' && magic.subarray(0, 5).toString('ascii') !== '%PDF-') {
    return { pass: false, reason: 'PDF \u6587\u4ef6\u7b7e\u540d\u65e0\u6548\uff1a' + item.relative };
  }
  if (ext === '.png' &&
      !magic.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { pass: false, reason: 'PNG \u6587\u4ef6\u7b7e\u540d\u65e0\u6548\uff1a' + item.relative };
  }
  return {
    pass: true,
    evidence: item.relative + ' (' + stat.size + ' bytes)',
  };
}

function allowedExternal(manifest) {
  const runtime = manifest && manifest.runtime;
  const rows = runtime && runtime.networkPolicy === 'online' &&
    Array.isArray(runtime.externalDependencies)
    ? runtime.externalDependencies : [];
  return rows.map((item) => clean(
    typeof item === 'string' ? item : item && (item.url || item.host),
    500,
  )).filter(Boolean);
}

function isAllowedExternal(value, allowed) {
  try {
    const url = new URL(value);
    return allowed.some((entry) => {
      if (entry === url.hostname || entry === url.host) return true;
      return value.startsWith(entry);
    });
  } catch (_) {
    return false;
  }
}

function runtimeRefs(file, source) {
  const refs = [];
  const ext = path.extname(file).toLowerCase();
  const push = (value, type) => {
    const ref = clean(value, 1200);
    if (ref) refs.push({ value: ref, type });
  };
  if (ext === '.html' || ext === '.htm') {
    const tag = /<(script|link|img|source|video|audio|iframe)\b[^>]*?\b(src|href)\s*=\s*(["'])(.*?)\3/gi;
    let match = tag.exec(source);
    while (match) {
      push(match[4], match[1].toLowerCase());
      match = tag.exec(source);
    }
  }
  if (ext === '.css') {
    const css = /(?:url|@import)\s*\(\s*(["']?)(.*?)\1\s*\)|@import\s+(["'])(.*?)\3/gi;
    let match = css.exec(source);
    while (match) {
      push(match[2] || match[4], 'style');
      match = css.exec(source);
    }
  }
  if (['.html', '.htm', '.js', '.mjs', '.cjs'].includes(ext)) {
    const moduleRef = /(?:from\s*|import\s*\(\s*)(["'])(.*?)\1/gi;
    let match = moduleRef.exec(source);
    while (match) {
      push(match[2], 'module');
      match = moduleRef.exec(source);
    }
    const network = /(?:fetch|new\s+Worker|new\s+SharedWorker|new\s+WebSocket)\s*\(\s*(["'])(.*?)\1/gi;
    match = network.exec(source);
    while (match) {
      push(match[2], /^fetch\b/i.test(match[0]) ? 'network' : 'worker');
      match = network.exec(source);
    }
  }
  return refs;
}

function skipReference(value) {
  return !value || /^(?:#|data:|blob:|mailto:|tel:|javascript:|about:)/i.test(value);
}

function isExternal(value) {
  return /^(?:https?:)?\/\//i.test(value) || /^wss?:\/\//i.test(value);
}

function localTarget(siteRoot, owner, value) {
  const raw = value.split('#')[0].split('?')[0];
  if (!raw || raw.includes('$' + '{') || raw.includes('{{')) return '';
  if (raw.startsWith('/')) return path.resolve(siteRoot, raw.replace(/^\/+/, ''));
  if (!raw.startsWith('.') && !raw.includes('/') &&
      !path.extname(raw) && !raw.includes('\\')) {
    return '';
  }
  return path.resolve(path.dirname(owner), raw);
}

function declaredLocalEndpoint(value, allowed) {
  // Only explicit same-origin route declarations, with segment boundaries.
  // "/api/v1" never authorizes "/api/v10" or protocol-relative remote hosts.
  if (!value.startsWith('/') || value.startsWith('//')) return false;
  const target = value.split(/[?#]/)[0];
  if (target.split('/').some(segment => ['.', '..'].includes(segment) || /%/i.test(segment))) return false;
  return allowed.some(entry => {
    if (!entry.startsWith('/') || entry.startsWith('//')) return false;
    const route = entry.replace(/\/$/, '');
    return route && (target === route || target.startsWith(route + '/'));
  });
}

function websiteProbe(cwd, item, manifest, evidence) {
  const entry = item && item.path;
  if (!entry || !statFile(entry)) {
    return { pass: false, gaps: ['\u7f51\u7ad9\u5165\u53e3\u6587\u4ef6\u4e0d\u5b58\u5728'], evidence: [] };
  }
  if (!['.html', '.htm'].includes(path.extname(entry).toLowerCase())) {
    return { pass: false, gaps: ['\u7f51\u7ad9\u4ea4\u4ed8\u7269\u5fc5\u987b\u662f\u53ef\u6253\u5f00\u7684 HTML \u5165\u53e3'], evidence: [] };
  }
  const siteRoot = path.dirname(entry);
  const queue = [entry];
  const visited = new Set();
  const missing = new Set();
  const escaped = new Set();
  const external = new Set();
  const declared = allowedExternal(manifest);
  const proof = [];
  while (queue.length && visited.size < MAX_SITE_FILES) {
    const file = queue.shift();
    const resolved = path.resolve(file);
    if (visited.has(resolved)) continue;
    visited.add(resolved);
    const stat = statFile(resolved);
    if (!stat) {
      missing.add(path.relative(cwd, resolved).replace(/\\/g, '/'));
      continue;
    }
    if (!TEXT_EXT.has(path.extname(resolved).toLowerCase()) ||
        stat.size > MAX_TEXT_BYTES) continue;
    let source = '';
    try { source = fs.readFileSync(resolved, 'utf8'); } catch (_) { continue; }
    runtimeRefs(resolved, source).forEach((ref) => {
      if (skipReference(ref.value)) return;
      if (isExternal(ref.value)) {
        if (!isAllowedExternal(ref.value, declared)) external.add(ref.value);
        return;
      }
      if (ref.type === 'network' && declaredLocalEndpoint(ref.value, declared)) {
        if (evidence && evidence.launch) proof.push('已声明并有运行探针：' + ref.value);
        else missing.add('运行时接口缺少成功探针：' + ref.value);
        return;
      }
      const target = localTarget(siteRoot, resolved, ref.value);
      if (!target) return;
      const packageRel = path.relative(siteRoot, target);
      if (packageRel.startsWith('..') || path.isAbsolute(packageRel)) {
        escaped.add(ref.value);
        return;
      }
      if (!statFile(target)) {
        missing.add(path.relative(cwd, target).replace(/\\/g, '/'));
        return;
      }
      if (TEXT_EXT.has(path.extname(target).toLowerCase())) queue.push(target);
    });
  }
  proof.push('\u7f51\u7ad9\u5165\u53e3\uff1a' + path.relative(cwd, entry).replace(/\\/g, '/'));
  proof.push('\u5df2\u68c0\u67e5\u8fd0\u884c\u8d44\u6e90\uff1a' + visited.size + ' \u4e2a\u6587\u4ef6');
  const gaps = [];
  if (missing.size) gaps.push('\u5b58\u5728\u7f3a\u5931\u7684\u672c\u5730\u8d44\u6e90\uff1a' + [...missing].slice(0, 8).join('\u3001'));
  if (escaped.size) gaps.push('\u8fd0\u884c\u8d44\u6e90\u9003\u51fa\u4ea4\u4ed8\u76ee\u5f55\uff1a' + [...escaped].slice(0, 8).join('\u3001'));
  if (external.size) {
    gaps.push('\u5b58\u5728\u672a\u6253\u5305\u4e14\u672a\u58f0\u660e\u7684\u5916\u90e8\u8fd0\u884c\u4f9d\u8d56\uff1a' +
      [...external].slice(0, 6).join('\u3001'));
  }
  return { pass: gaps.length === 0, gaps, evidence: proof };
}

function meaningfulFiles(snapshot) {
  const rows = Array.isArray(snapshot && snapshot.files) ? snapshot.files : [];
  return rows.filter((file) =>
    Number(file && file.size || 0) > 0 &&
    !deliveryContract._isProcess(file));
}

function verify(options) {
  const opts = options || {};
  const cwd = path.resolve(opts.cwd || '.');
  const profile = opts.profile || { kind: 'general' };
  const spec = opts.spec || {};
  const evidence = opts.evidence || {};
  const snapshot = opts.outputSnapshot || { files: [] };
  const classified = snapshot.delivery ||
    deliveryContract.classify(cwd, snapshot.files || []);
  const manifest = deliveryContract.readManifest(cwd);
  const strict = profile.kind === 'engineering' || profile.kind === 'interactive';
  const complete = Boolean(profile.complete || profile.kind === 'interactive' ||
    spec.complete || ['website', 'interactive'].includes(spec.workKind));
  const workKinds = Array.isArray(spec.workKinds) && spec.workKinds.length
    ? spec.workKinds : [spec.workKind];
  const expectedGroups = workKinds.map((kind) => EXPECTED_KINDS[kind])
    .filter((group) => Array.isArray(group) && group.length);
  const requiresDelivery = expectedGroups.length > 0 || ARTIFACT_WORK.has(spec.workKind);
  const meaningful = meaningfulFiles(snapshot);
  const checks = [];

  checks.push(check(
    'mutation',
    '\u771f\u5b9e\u6539\u52a8',
    !strict || Boolean(evidence.mutation),
    '\u6ca1\u6709\u68c0\u6d4b\u5230\u6210\u529f\u7684\u6587\u4ef6\u6539\u52a8',
    '\u5728\u771f\u5b9e\u5de5\u4f5c\u76ee\u5f55\u4e2d\u5b8c\u6210\u5b9e\u73b0',
    meaningful.map((item) => item.relative).slice(0, 4),
  ));
  checks.push(check(
    'verification',
    '\u53ef\u91cd\u653e\u9a8c\u8bc1',
    !strict || Boolean(evidence.verification),
    '\u6ca1\u6709\u6210\u529f\u7684\u6784\u5efa\u3001\u6d4b\u8bd5\u6216\u7b49\u4ef7\u9a8c\u8bc1',
    '\u8fd0\u884c\u4e0e\u672c\u4ea4\u4ed8\u76f4\u63a5\u76f8\u5173\u7684\u9a8c\u8bc1\u547d\u4ee4',
  ));
  const failureDetails = (Array.isArray(evidence.unresolvedFailures) ? evidence.unresolvedFailures : [])
    .map(item => '[' + clean(item.key || item.name, 40) + '] ' +
      clean(item.command, 300) + (item.reason ? ' — ' + clean(item.reason, 240) : '')).slice(0, 4);
  checks.push(check(
    'execution_errors',
    '\u65e0\u672a\u89e3\u51b3\u6267\u884c\u9519\u8bef',
    Number(evidence.failures || 0) === 0,
    '\u4ecd\u6709 ' + Number(evidence.failures || 0) + ' \u7c7b\u5931\u8d25\u6ca1\u6709\u88ab\u540c\u7c7b\u6210\u529f\u91cd\u8dd1\u8986\u76d6',
    '\u4fee\u590d\u540e\u91cd\u8dd1\u539f\u5931\u8d25\u68c0\u67e5' +
      (failureDetails.length ? '：\n' + failureDetails.join('\n') : ''),
  ));
  checks.push(check(
    'launch',
    '\u771f\u5b9e\u542f\u52a8\u4e0e\u5065\u5eb7\u63a2\u9488',
    !profile.requiresLaunch || Boolean(evidence.launch),
    '\u5b8c\u6574\u5e94\u7528\u6ca1\u6709\u771f\u5b9e\u542f\u52a8\u6216\u5065\u5eb7\u8bf7\u6c42\u8bc1\u636e',
    '\u542f\u52a8\u5e94\u7528\u5e76\u5bf9\u5b9e\u9645\u5730\u5740\u6267\u884c\u5065\u5eb7\u63a2\u9488',
  ));
  checks.push(check(
    'visual',
    '\u754c\u9762\u4e0e\u5173\u952e\u65c5\u7a0b\u5b9e\u67e5',
    !profile.visible || Boolean(evidence.visual),
    '\u6709\u754c\u9762\u7684\u4ea4\u4ed8\u6ca1\u6709\u771f\u5b9e\u754c\u9762\u6216\u4ea4\u4e92\u5b9e\u67e5',
    '\u7528\u6d4f\u89c8\u5668\u8d70\u901a\u4e3b\u8def\u5f84\u5e76\u4fdd\u7559\u7ed3\u679c',
  ));

  if (requiresDelivery) {
    const manifestPass = Boolean(manifest && !manifest.invalid &&
      classified.source === 'manifest');
    checks.push(check(
      'delivery_manifest',
      '\u53ef\u6838\u9a8c\u4ea4\u4ed8\u6e05\u5355',
      manifestPass,
      manifest && manifest.invalid ? manifest.reason : '\u7f3a\u5c11 .soduwork/delivery.json',
      '\u521b\u5efa\u4ea4\u4ed8\u6e05\u5355\uff0c\u53ea\u767b\u8bb0\u53ef\u76f4\u63a5\u4f7f\u7528\u7684\u6700\u7ec8\u6210\u679c',
    ));
    checks.push(check(
      'deliverables',
      '\u6700\u7ec8\u6210\u679c\u5b58\u5728',
      Boolean(classified.items && classified.items.length) &&
        !(classified.warnings || []).length,
      (classified.warnings || []).join('\uff1b') || '\u4ea4\u4ed8\u6e05\u5355\u6ca1\u6709\u6709\u6548\u6210\u679c',
      '\u4fee\u6b63\u4ea4\u4ed8\u8def\u5f84\u5e76\u786e\u4fdd\u6587\u4ef6\u5b58\u5728',
    ));
    if (expectedGroups.length) {
      const actualKinds = (classified.items || []).map((item) => item.kind);
      const missingGroups = expectedGroups.filter((group) =>
        !actualKinds.some((kind) => group.includes(kind)));
      checks.push(check(
        'delivery_type',
        '\u4ea4\u4ed8\u7269\u7c7b\u578b\u4e0e\u76ee\u6807\u4e00\u81f4',
        missingGroups.length === 0,
        '\u7f3a\u5c11 ' + missingGroups.map((group) => group.join('/')).join('\u3001') +
          '\uff0c\u5b9e\u9645\u4e3a ' + (actualKinds.join('/') || '\u65e0'),
        '\u751f\u6210\u5e76\u767b\u8bb0\u4e0e\u76ee\u6807\u5339\u914d\u7684\u6700\u7ec8\u6210\u679c',
      ));
    }
  }

  const artifactResults = (classified.items || []).map((item) => ({
    item,
    result: artifactProbe(item),
  }));
  const broken = artifactResults.filter((row) => !row.result.pass);
  const protectedArtifacts = broken.filter((row) => row.result.protected);
  if (classified.items && classified.items.length) {
    checks.push({ ...check(
      'artifact_integrity',
      '\u4ea4\u4ed8\u7269\u683c\u5f0f\u4e0e\u5185\u5bb9\u6709\u6548',
      broken.length === 0,
      broken.map((row) => row.result.reason).join('\uff1b'),
      protectedArtifacts.length
        ? '请使用企业允许的查看器核验，或由管理员提供合规的文档读取能力，再继续验收；不要反复重做文件或关闭安全保护'
        : '\u91cd\u65b0\u751f\u6210\u771f\u5b9e\u53ef\u6253\u5f00\u7684\u6210\u679c\u6587\u4ef6',
      artifactResults.map((row) => row.result.evidence).filter(Boolean),
    ), retryable: protectedArtifacts.length === 0 });
  }

  (classified.items || []).filter((item) => item.kind === 'website')
    .forEach((item, index) => {
      const site = websiteProbe(cwd, item, manifest && !manifest.invalid ? manifest : null, evidence);
      checks.push(check(
        'website_package_' + (index + 1),
        '\u7f51\u7ad9\u8fd0\u884c\u8d44\u6e90\u5b8c\u6574',
        site.pass,
        site.gaps.join('\uff1b'),
        '\u5c06\u8fd0\u884c\u4f9d\u8d56\u6253\u5305\u5230\u4ea4\u4ed8\u76ee\u5f55\uff0c\u6216\u5728\u6e05\u5355\u4e2d\u660e\u786e\u58f0\u660e\u5916\u90e8\u4f9d\u8d56',
        site.evidence,
      ));
    });

  const gaps = checks.filter((item) => !item.pass).map((item) => ({
    check: item.key,
    reason: item.reason,
    action: item.action,
  }));
  return {
    pass: gaps.length === 0,
    retryable: !checks.some(item => !item.pass && item.retryable === false),
    summary: gaps.length
      ? '\u786e\u5b9a\u6027\u4ea4\u4ed8\u9a8c\u6536\u672a\u901a\u8fc7'
      : '\u786e\u5b9a\u6027\u4ea4\u4ed8\u9a8c\u6536\u5df2\u901a\u8fc7',
    checks,
    gaps,
    delivery: {
      source: classified.source || '',
      items: (classified.items || []).map((item) => ({
        relative: item.relative,
        kind: item.kind,
        title: item.title,
        size: item.size,
      })),
      warnings: classified.warnings || [],
    },
  };
}

module.exports = {
  verify,
  artifactProbe,
  websiteProbe,
  _runtimeRefs: runtimeRefs,
  _meaningfulFiles: meaningfulFiles,
};
