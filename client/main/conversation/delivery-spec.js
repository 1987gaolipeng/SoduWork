'use strict';

/*
 * SoduWork's outer delivery contract.
 *
 * Pi owns the inner think/tool/observe loop. This module does not imitate an
 * agent framework; it gives that loop a concrete definition of done and gives
 * SoduWork a stable, serializable contract for verification and repair.
 */
const SCHEMA_VERSION = 1;
const QUALITY_THRESHOLD = 85;

const KIND_ORDER = Object.freeze([
  'interactive', 'presentation', 'spreadsheet', 'document', 'website',
  'engineering', 'research', 'general',
]);

const clean = (value, limit) => String(value == null ? '' : value)
  .replace(/\r\n?/g, '\n').trim().slice(0, limit);

function unique(rows, limit) {
  return [...new Set((rows || []).map((item) => clean(item, 500)).filter(Boolean))]
    .slice(0, limit || 40);
}

function splitCriteria(value) {
  return unique(String(value || '').split(/\r?\n|[;\uFF1B]/).map((item) =>
    item.replace(/^\s*(?:[-*]|\d+[.)\u3001])\s*/, '').trim()), 20);
}

function actionableSource(value) {
  return String(value || '')
    // Negative constraints describe what must not be delivered. Leaving their
    // classifier nouns in negated requests must not accidentally select a web project.
    // Keep positive clauses, including reminders phrased as do not forget an action.
    .replace(/(?:不要|无需|无须|不需要|不必|禁止|不得|请勿|避免)(?!忘记|遗漏|漏掉|忽略)[^，,。；;\n]{0,100}/gi, ' ')
    .replace(/(?:不做|不创建|不生成|不制作|不实现|不启动|不运行|不检查|不验证|不用|不包含|不提供|不输出|不交付|不使用|不调用|不安装|不构建|不开发|不打开|不浏览|不访问)[^，,。；;\n]{0,100}/gi, ' ')
    .replace(/\b(?:do\s+not|don't|must\s+not|should\s+not|no\s+need\s+to|without)(?!\s+(?:forget|omitting))[^,.；;\n]{0,160}/gi, ' ')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

function sourceOf(raw) {
  return [raw && raw.goal, raw && raw.acceptance]
    .filter(Boolean).map(actionableSource).filter(Boolean).join(' ');
}

function detectKinds(raw) {
  const source = sourceOf(raw);
  const conversational = !/(\u521b\u5efa|\u751f\u6210|\u5236\u4f5c|\u5bfc\u51fa|\u5199\u5165|\u4fee\u6539|\u5f00\u53d1|\u5b9e\u73b0|\u4fee\u590d|build|create|write|implement|fix)/i.test(source) &&
    /(?:\u53ea|\u76f4\u63a5)?(?:\u56de\u590d|\u56de\u7b54|\u89e3\u91ca|\u7ffb\u8bd1|\u6da6\u8272|\u6539\u5199|\u603b\u7ed3)|\b(reply|answer|explain|translate|rewrite|summarize)\b/i.test(source);
  if (conversational) return ['conversation'];

  const rows = [];
  const add = (kind, pattern) => { if (pattern.test(source)) rows.push(kind); };
  add('interactive', /(\u6e38\u620f|\u5c0f\u6e38\u620f|\u8d5b\u8f66|\u4eff\u771f|game|racing|simulation|webgl)/i);
  add('presentation', /(pptx?|\u6f14\u793a\u6587\u7a3f|\u6c47\u62a5\u6750\u6599|\u5e7b\u706f\u7247|slide deck)/i);
  add('spreadsheet', /(xlsx?|excel|\u8868\u683c|\u6e05\u5355|\u6570\u636e\u5206\u6790|workbook)/i);
  add('document', /(docx?|word|markdown|\.(?:md|txt|rtf)\b|\u6587\u6863|\u62a5\u544a|\u65b9\u6848|\u7eaa\u8981|proposal|report)/i);
  add('website', /(\u7f51\u7ad9|\u7f51\u9875|\u524d\u7aef|\u9875\u9762|\u754c\u9762|html|website|web\s*app|frontend|ui|ux)/i);
  add('engineering', /(\u4ee3\u7801|\u5de5\u7a0b|\u7cfb\u7edf|\u5e94\u7528|\u8f6f\u4ef6|\u63a5\u53e3|api|\u540e\u7aef|\u4fee\u590d|bug|\u7f3a\u9677|\u5f00\u53d1|\u5b9e\u73b0|\u91cd\u6784|code|repository|backend|service)/i);
  add('research', /(\u7814\u7a76|\u8c03\u7814|\u5206\u6790|research|investigation|benchmark)/i);
  if (rows.includes('interactive') && !rows.includes('engineering')) rows.push('engineering');
  if (!rows.length) rows.push('general');
  return KIND_ORDER.filter((kind) => rows.includes(kind));
}

function isComplete(raw) {
  return /(\u5b8c\u6574|\u5168\u65b0|\u4ece\s*0|\u4ece\u96f6|\u4e00\u6574\u5957|\u7aef\u5230\u7aef|\u53ef\u8fd0\u884c|\u4e0a\u7ebf|\u90e8\u7f72|\u4ea4\u4ed8|production|complete|full|end[- ]to[- ]end|ship)/i
    .test(sourceOf(raw));
}

function primaryKind(kinds) {
  return KIND_ORDER.find((kind) => (kinds || []).includes(kind)) || 'general';
}

function inferredDeliverables(kinds) {
  const rows = [];
  const add = (id, kind, title, role, proof) => rows.push({ id, kind, title, role, proof });
  if (kinds.includes('interactive')) add('interactive-product', 'website', '\u53ef\u73a9\u4ea4\u4e92\u6210\u54c1', 'primary', '\u53ef\u6253\u5f00\u7684\u5165\u53e3\u548c\u771f\u5b9e\u64cd\u4f5c\u9a8c\u8bc1');
  if (kinds.includes('website') && !kinds.includes('interactive')) add('web-product', 'website', '\u53ef\u9884\u89c8\u7684\u7f51\u7ad9\u6216\u754c\u9762', 'primary', '\u53ef\u6253\u5f00\u5165\u53e3\u3001\u5b8c\u6574\u8d44\u6e90\u4e0e\u5173\u952e\u7528\u6237\u8def\u5f84');
  if (kinds.includes('presentation')) add('presentation', 'presentation', '\u53ef\u6f14\u793a\u7684\u5e7b\u706f\u7247', 'primary', '\u771f\u5b9e PPTX/PDF \u53ca\u89c6\u89c9\u5b9e\u67e5');
  if (kinds.includes('spreadsheet')) add('workbook', 'spreadsheet', '\u53ef\u7f16\u8f91\u7684\u8868\u683c\u6210\u679c', 'primary', '\u771f\u5b9e XLSX \u3001\u516c\u5f0f\u4e0e\u6570\u636e\u68c0\u67e5');
  if (kinds.includes('document')) add('document', 'document', '\u53ef\u9605\u8bfb\u4e0e\u4fee\u8ba2\u7684\u6587\u6863', 'primary', '\u771f\u5b9e Markdown/DOCX/PDF \u53ca\u5185\u5bb9\u68c0\u67e5');
  if (kinds.includes('research') && !rows.length) add('research-result', 'document', '\u53ef\u6eaf\u6e90\u7684\u7814\u7a76\u7ed3\u679c', 'primary', '\u7ed3\u8bba\u3001\u6765\u6e90\u3001\u9650\u5236\u4e0e\u53ef\u6267\u884c\u5efa\u8bae');
  if (kinds.includes('engineering')) add('repository-change', 'repository', '\u53ef\u5408\u5e76\u7684\u5de5\u7a0b\u53d8\u66f4', rows.length ? 'supporting' : 'primary', '\u4ee3\u7801\u53d8\u66f4\u3001\u6d4b\u8bd5\u3001\u6784\u5efa\u6216\u8fd0\u884c\u8bc1\u636e');
  if (!rows.length) add('usable-result', 'result', '\u53ef\u76f4\u63a5\u4f7f\u7528\u7684\u7ed3\u679c', 'primary', '\u4e0e\u76ee\u6807\u76f4\u63a5\u5bf9\u5e94\u7684\u771f\u5b9e\u6210\u679c');
  return rows.slice(0, 8);
}

function inferredCoverage(kinds, complete) {
  const rows = ['goal-and-constraints', 'primary-deliverable', 'verification', 'delivery-notes'];
  if (kinds.some((kind) => ['website', 'interactive'].includes(kind))) rows.push('user-experience', 'visual-design', 'responsive-and-accessible');
  if (kinds.includes('engineering')) rows.push('architecture-fit', 'failure-handling', 'maintainability');
  if (complete && kinds.includes('engineering')) rows.push('frontend-decision', 'backend-api-decision', 'data-and-config-decision', 'integration-decision', 'runbook');
  return unique(rows, 20);
}

function inferredJourneys(kinds) {
  const rows = [];
  if (kinds.some((kind) => ['website', 'interactive'].includes(kind))) {
    rows.push('\u7528\u6237\u80fd\u6253\u5f00\u4e3b\u5165\u53e3\u5e76\u7406\u89e3\u5982\u4f55\u5f00\u59cb');
    rows.push('\u7528\u6237\u80fd\u5b8c\u6210\u6838\u5fc3\u4efb\u52a1\uff0c\u6bcf\u4e2a\u64cd\u4f5c\u90fd\u6709\u6e05\u6670\u53cd\u9988');
    rows.push('\u7a7a\u6570\u636e\u3001\u9519\u8bef\u3001\u7b49\u5f85\u4e0e\u5c0f\u5c4f\u72b6\u6001\u4ecd\u53ef\u7406\u89e3\u548c\u6062\u590d');
  }
  if (kinds.includes('engineering')) {
    rows.push('\u5f00\u53d1\u8005\u80fd\u6309\u73b0\u6709\u5de5\u7a0b\u7ea6\u5b9a\u6784\u5efa\u3001\u6d4b\u8bd5\u5e76\u8fd0\u884c\u53d8\u66f4');
    rows.push('\u56de\u5f52\u548c\u5931\u8d25\u8def\u5f84\u6709\u660e\u786e\u7684\u81ea\u52a8\u5316\u9a8c\u8bc1');
  }
  if (kinds.some((kind) => ['document', 'presentation', 'spreadsheet'].includes(kind))) {
    rows.push('\u6536\u4ef6\u4eba\u80fd\u76f4\u63a5\u6253\u5f00\u3001\u9605\u8bfb\u6216\u7f16\u8f91\u6210\u679c\uff0c\u65e0\u7f3a\u9875\u3001\u4e71\u7801\u6216\u5047\u683c\u5f0f');
  }
  return unique(rows.length ? rows : ['\u7528\u6237\u80fd\u76f4\u63a5\u83b7\u53d6\u5e76\u4f7f\u7528\u6700\u7ec8\u7ed3\u679c'], 12);
}

function qualityDimensions(kinds) {
  const visible = kinds.some((kind) => ['website', 'interactive', 'presentation', 'document', 'spreadsheet'].includes(kind));
  const engineering = kinds.includes('engineering') || kinds.includes('interactive');
  const rows = [
    { key: 'completeness', label: '\u5b8c\u6574\u6027', weight: 25, threshold: 90, hard: true },
    { key: 'correctness', label: '\u6b63\u786e\u6027', weight: 25, threshold: 90, hard: true },
    { key: 'usability', label: '\u53ef\u7528\u6027', weight: visible ? 15 : 25, threshold: 85, hard: true },
  ];
  if (visible) rows.push({ key: 'visual', label: '\u89c6\u89c9\u4e0e\u4ea4\u4e92', weight: 15, threshold: 85, hard: true });
  rows.push({ key: 'robustness', label: '\u5065\u58ee\u6027', weight: 10, threshold: 80, hard: engineering || visible });
  rows.push({ key: 'maintainability', label: '\u5de5\u7a0b\u8d28\u91cf', weight: engineering ? 10 : 0, threshold: 80, hard: false });
  return rows.filter((item) => item.weight > 0);
}

function inferredChecks(kinds, criteria) {
  const rows = [];
  const put = (key, category, label, evidence, priority) => rows.push({
    key, category, label, evidence, priority: Number(priority || 50), required: true,
  });
  put('usable', 'delivery', '\u6700\u7ec8\u7ed3\u679c\u53ef\u76f4\u63a5\u4f7f\u7528', '\u771f\u5b9e\u4ea4\u4ed8\u7269\u6216\u53ef\u89c1\u7ed3\u679c', 100);
  if (kinds.includes('engineering')) {
    put('behavior', 'correctness', '\u9700\u6c42\u884c\u4e3a\u4e0e\u8fb9\u754c\u5b8c\u6574', '\u81ea\u52a8\u5316\u6d4b\u8bd5\u6216\u771f\u5b9e\u64cd\u4f5c', 95);
    put('verification', 'correctness', '\u6784\u5efa\u3001\u6d4b\u8bd5\u548c\u68c0\u67e5\u901a\u8fc7', '\u53ef\u91cd\u653e\u7684\u6210\u529f\u8bb0\u5f55', 95);
    put('integration', 'robustness', '\u542f\u52a8\u6216\u96c6\u6210\u8def\u5f84\u53ef\u7528', '\u8fd0\u884c\u63a2\u9488\u6216\u96c6\u6210\u6d4b\u8bd5', 90);
  }
  if (kinds.some((kind) => ['website', 'interactive'].includes(kind))) {
    put('journey', 'usability', '\u4e3b\u8981\u7528\u6237\u65c5\u7a0b\u5b8c\u6574', '\u5173\u952e\u9875\u9762\u4e0e\u4ea4\u4e92\u5b9e\u67e5', 95);
    put('visual', 'visual', '\u89c6\u89c9\u3001\u54cd\u5e94\u5f0f\u548c\u53ef\u8bbf\u95ee\u6027\u8fbe\u6807', '\u591a\u5c3a\u5bf8\u6700\u7ec8\u754c\u9762\u5b9e\u67e5', 80);
    put('states', 'robustness', '\u52a0\u8f7d\u3001\u7a7a\u548c\u9519\u8bef\u72b6\u6001\u5b8c\u6574', '\u5f02\u5e38\u8def\u5f84\u68c0\u67e5', 80);
  }
  if (!kinds.includes('engineering')) put('verified', 'correctness', '\u5b8c\u6210\u5fc5\u8981\u9a8c\u8bc1', '\u53ef\u6838\u5bf9\u7684\u771f\u5b9e\u8bc1\u636e', 90);
  (criteria || []).forEach((label, index) => put(
    'acceptance_' + (index + 1), 'acceptance', label,
    '\u4e0e\u7528\u6237\u5b8c\u6210\u6807\u51c6\u76f4\u63a5\u5bf9\u5e94\u7684\u8bc1\u636e', 100 - index,
  ));
  return rows.slice(0, 40);
}

function compile(raw) {
  const value = raw || {};
  const kinds = detectKinds(value);
  const criteria = splitCriteria(value.acceptance);
  if (!criteria.length) criteria.push('\u7ed3\u679c\u53ef\u76f4\u63a5\u4f7f\u7528', '\u6709\u53ef\u6838\u5bf9\u7684\u9a8c\u8bc1\u8bc1\u636e');
  const complete = isComplete(value);
  return {
    schemaVersion: SCHEMA_VERSION,
    objective: clean(value.goal, 4000),
    acceptance: criteria,
    workKinds: kinds,
    primaryKind: primaryKind(kinds),
    complete,
    deliverables: inferredDeliverables(kinds),
    coverage: inferredCoverage(kinds, complete),
    journeys: inferredJourneys(kinds),
    dimensions: qualityDimensions(kinds),
    checks: inferredChecks(kinds, criteria),
    qualityThreshold: QUALITY_THRESHOLD,
  };
}

function executionPrompt(raw) {
  const spec = raw && Array.isArray(raw.workKinds) ? raw : compile(raw || {});
  const lines = (rows, render) => rows.map((item, index) => `${index + 1}. ${render(item)}`).join('\n');
  return [
    '[SoduWork DeliverySpec v1]',
    'Objective: ' + spec.objective,
    'Deliverables:\n' + lines(spec.deliverables, (item) => `${item.title} [${item.role}] - proof: ${item.proof}`),
    'Critical user journeys:\n' + lines(spec.journeys, (item) => item),
    'Required coverage decisions:\n' + lines(spec.coverage, (item) => item),
    'Acceptance gates:\n' + lines(spec.checks, (item) => `[${item.key}] ${item.label} - proof: ${item.evidence}`),
    'Execution contract:',
    '- Inspect the real workspace first, state a concise plan, then continue straight into implementation in this same turn.',
    '- Run one continuous delivery loop using your native tool loop. Build the smallest end-to-end usable slice first, then close applicable quality gaps.',
    '- Do not stop after a plan, code snippet, backend-only layer, or unverified claim. Mark a coverage layer not applicable only from workspace facts.',
    '- Run real build/test/start/user-journey checks. When the product has a UI, inspect it and save up to 6 representative final screenshots under .soduwork/evidence/.',
    '- Keep narration short and business-facing: one sentence at phase changes, never a transcript of commands, file reads, or internal implementation detail.',
    '- Finish only after the deliverables and evidence are real. SoduWork will independently score the result and may return one focused gap.',
  ].join('\n\n');
}

module.exports = {
  SCHEMA_VERSION, QUALITY_THRESHOLD, compile, executionPrompt,
  detectKinds, primaryKind, splitCriteria, inferredChecks,
};
