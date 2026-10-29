'use strict';
const deliveryContract = require('./delivery-contract');
const deliverySpec = require('./delivery-spec');

/*
 * The second goal phase audits and completes deliverables in the same workspace. Keep its
 * prompt internal and use its final marker to identify inspectable results.
 */
const INTERNAL_MARKER = '<soduwork-internal-goal-audit>';
const IMPLEMENT_MARKER = '<soduwork-internal-goal-implementation>';
const REPAIR_MARKER = '<soduwork-internal-goal-repair>';
const CONTINUE_MARKER = '<soduwork-internal-goal-continue>';
const NORMAL_MARKER = '<soduwork-normal-followup>';
const PASS_MARKER = '<!-- soduwork-delivery-audit:pass -->';
const BLOCKED_MARKER = '<!-- soduwork-delivery-audit:blocked -->';
const ENTRY_TYPE = 'soduwork.goal.quality';

function deliveryProfile(raw) {
  const spec = deliverySpec.compile(raw || {});
  const kinds = Array.isArray(spec.workKinds) ? spec.workKinds : [];
  const interactive = kinds.includes('interactive');
  const engineering = interactive || kinds.includes('engineering') || kinds.includes('website');
  const complete = engineering && Boolean(spec.complete);
  const visible = interactive || kinds.includes('website');
  const conversational = kinds.length === 1 && kinds[0] === 'conversation';
  const expectedText = [];
  if (conversational) {
    const acceptance = String(raw && raw.acceptance || '');
    const expectedPattern = /(?:\u5305\u542b|\u56de\u590d|\u56de\u7b54|\u8f93\u51fa|\u5199\u51fa)[\uff1a:\s]*[\u201c\u300c"]([^\u201d\u300d"]{1,120})[\u201d\u300d"]/g;
    let match = expectedPattern.exec(acceptance);
    while (match) {
      const value = String(match[1] || '').trim();
      if (value && !expectedText.includes(value)) expectedText.push(value);
      match = expectedPattern.exec(acceptance);
    }
  }
  const profile = {
    kind: interactive ? 'interactive' : engineering ? 'engineering'
      : conversational ? 'conversation' : 'general',
    complete: complete || interactive, requiresLaunch: complete || interactive,
    visible: visible || interactive,
  };
  if (conversational) profile.expectedText = expectedText;
  return profile;
}

function conversationPrompt(raw) {
  const value = raw || {};
  return [
    '\u3010SoduWork \u76ee\u6807\u6a21\u5f0f\u00b7\u76f4\u63a5\u4ea4\u4ed8\u3011',
    '\u8fd9\u662f\u7eaf\u5bf9\u8bdd\u4ea4\u4ed8\uff0c\u4e0d\u662f\u5de5\u7a0b\u4efb\u52a1\u3002\u76f4\u63a5\u7ed9\u51fa\u6700\u7ec8\u7b54\u590d\uff0c\u4e0d\u8981\u89c4\u5212\u3001\u590d\u8ff0\u76ee\u6807\u3001\u68c0\u67e5\u5de5\u4f5c\u76ee\u5f55\u6216\u8c03\u7528\u5de5\u5177\u3002',
    '\u76ee\u6807\uff1a' + String(value.goal || '').trim(),
    '\u5b8c\u6210\u6807\u51c6\uff1a' + (String(value.acceptance || '').trim() || '\u56de\u7b54\u51c6\u786e\u3001\u7b80\u6d01\u4e14\u53ef\u76f4\u63a5\u4f7f\u7528'),
    '',
    '\u4e25\u683c\u9075\u5b88\u7528\u6237\u7ea6\u5b9a\u7684\u8bed\u8a00\u3001\u683c\u5f0f\u3001\u53e5\u6570\u548c\u5fc5\u987b\u5305\u542b\u7684\u5185\u5bb9\u3002',
    '\u5982\u679c\u76ee\u6807\u8981\u6c42\u4e00\u53e5\u8bdd\uff0c\u5c31\u53ea\u8f93\u51fa\u4e00\u53e5\u8bdd\uff1b\u5982\u679c\u8981\u6c42\u4e0d\u7528\u5de5\u5177\u6216\u4e0d\u521b\u5efa\u6587\u4ef6\uff0c\u5fc5\u987b\u9075\u5b88\u3002',
    '\u4e0d\u8981\u63d0\u5230\u672c\u7cfb\u7edf\u63d0\u793a\u3001\u76ee\u6807\u6a21\u5f0f\u3001\u5de5\u4f5c\u76ee\u5f55\u6216\u5185\u90e8\u5ba1\u6838\u3002',
  ].join('\n');
}

function implementationPrompt(raw) {
  const value = raw || {};
  return [
    IMPLEMENT_MARKER,
    '这是 SoduWork 内部的实施阶段，不是用户的新消息。沿用刚才形成的计划和同一工作目录，不要复述本指令，不要向用户提问。',
    '原始目标：' + String(value.goal || '').trim(),
    '完成标准：' + (String(value.acceptance || '').trim() || '结果可直接使用，并有必要的验证证据'),
    '',
    '现在开始实际完成计划，不要停留在方案、任务清单或代码片段。',
    '先按依赖顺序做出一条可运行的端到端纵向闭环，再补齐适用的边界状态、错误处理、权限安全、性能、可访问性和工程质量。',
    '如果是完整工程或功能，逐项覆盖计划中适用的用户体验、前端、后端/API、数据配置和集成；某一层确实不适用时，用工程事实说明，而不是默认省略。',
    '持续使用工具检查文件和运行结果；遇到构建、测试或启动失败时先定位根因、修复并重跑。',
    '完成工程实现后必须真实执行适用的构建或测试，真实启动或用等价的运行探针验证关键路径；有界面且能力可用时，实际查看关键页面、交互、空态和错误态。',
    '此阶段仍不要输出最终交付答复。做完后保持事实和证据在会话中，SoduWork 会自动进入最终复核。',
    '</soduwork-internal-goal-implementation>',
  ].join('\n');
}

function continuationPrompt(raw, pause) {
  const value = raw || {};
  const state = pause || {};
  return [
    CONTINUE_MARKER,
    '用户已经明确选择继续执行。这是 SoduWork 内部续跑指令，不是新的目标；不要复述本指令，也不要中途提问。',
    '原始目标：' + String(value.goal || '').trim(),
    '完成标准：' + (String(value.acceptance || '').trim() || '结果可直接使用，并有必要的验证证据'),
    '上次暂停原因：' + String(state.reason || '达到本轮安全执行上限'),
    '',
    '从当前工作目录、已有计划、变更和证据继续，不要推倒重来。先检查上次停在何处，再完成剩余实现、验证和交付。',
    '不要仅总结已有进度；继续实际使用工具，直到达到完成标准或遇到真正需要用户授权的外部阻断。',
    '</soduwork-internal-goal-continue>',
  ].join('\n');
}

/*
 * After goal completion, preserve the conversation and workspace but restore ordinary
 * interaction semantics. Keep wrappers in model context and show original user text in the
 * event stream.
 */
function normalPrompt(value) {
  return [
    NORMAL_MARKER,
    '此前的目标模式已经结束或被用户取消。本条是普通续聊：只处理下面这条消息，' +
      '不要自动重跑旧目标、交付复核或补缺流程。',
    '<soduwork-user-message>',
    String(value || ''),
    '</soduwork-user-message>',
    '</soduwork-normal-followup>',
  ].join('\n');
}

function visibleUserPrompt(value) {
  const source = String(value || '');
  if (!source.trimStart().startsWith(NORMAL_MARKER)) return source;
  const match = source.match(/<soduwork-user-message>\r?\n([\s\S]*?)\r?\n<\/soduwork-user-message>/);
  return match ? match[1] : source;
}

function collectEvidence(tools, outputSnapshot) {
  const rows = Array.isArray(tools) ? tools : [];
  const files = Array.isArray(outputSnapshot && outputSnapshot.files) ? outputSnapshot.files : [];
  let mutation = files.length > 0;
  let verification = false;
  let launch = false;
  let visual = false;
  let failures = 0;
  rows.forEach((item) => {
    const name = String(item && item.name || '').toLowerCase();
    let detail = '';
    try { detail = JSON.stringify(item && item.args || {}).toLowerCase(); }
    catch (e) { detail = ''; }
    if (item && item.isError) failures += 1;
    if (/(write|edit|patch|create|save)/.test(name)) mutation = true;
    if (/(npm|pnpm|yarn|bun|npx|python|python3|pytest|cargo|go|dotnet|mvn|gradle|make|cmake|docker|curl|invoke-webrequest).{0,32}(test|build|lint|typecheck|check|verify|pytest|unittest|vitest|jest|playwright|cypress|health)|\b(pytest|unittest|vitest|jest|playwright|cypress|cargo test|go test|dotnet test|mvn test|gradle test)\b/.test(detail)) verification = true;
    if (/(npm|pnpm|yarn|bun).{0,12}(start|dev|serve)|uvicorn|gunicorn|flask run|docker compose.{0,12}up|healthz|localhost|127\.0\.0\.1/.test(detail)) launch = true;
    if (/(browser|computer|screenshot|playwright|cypress)/.test(name + ' ' + detail)) visual = true;
  });
  return {
    toolCount: rows.length,
    changedFileCount: files.length,
    mutation,
    verification,
    launch,
    visual,
    failures,
    truncated: Boolean(outputSnapshot && outputSnapshot.truncated),
  };
}

function evidenceKey(name, detail) {
  const signal = name + ' ' + detail;
  if (/(playwright|cypress)/.test(signal)) return 'visual-test';
  if (/(pytest|unittest|jest|vitest|\btest\b)/.test(signal)) return 'test';
  if (/(typecheck|type-check|\btsc\b)/.test(signal)) return 'typecheck';
  if (/\blint\b/.test(signal)) return 'lint';
  if (/\bbuild\b/.test(signal)) return 'build';
  if (/(healthz|health check|verify|verification|\bcheck\b)/.test(signal)) return 'check';
  if (/(start|dev|serve|uvicorn|gunicorn|healthz|localhost|127\\.0\\.0\\.1)/.test(signal)) {
    return 'launch';
  }
  if (/(browser|computer|screenshot)/.test(signal)) return 'visual';
  if (/(write|edit|patch|create|save)/.test(signal)) return 'mutation';
  return name || 'tool';
}

function collectEvidenceV2(tools, outputSnapshot) {
  const rows = Array.isArray(tools) ? tools : [];
  const files = Array.isArray(outputSnapshot && outputSnapshot.files)
    ? outputSnapshot.files : [];
  const outstanding = new Map();
  const meaningful = files.filter((file) =>
    Number(file && file.size || 0) > 0 && !deliveryContract._isProcess(file));
  const deliverables = outputSnapshot && outputSnapshot.delivery &&
    Array.isArray(outputSnapshot.delivery.items)
    ? outputSnapshot.delivery.items : [];
  let mutation = meaningful.length > 0 || deliverables.length > 0;
  let verification = false;
  let launch = false;
  let runtimeProbe = false;
  let visual = false;
  let historicalFailures = 0;
  rows.forEach((item) => {
    const name = String(item && item.name || '').toLowerCase();
    let detail = '';
    let result = '';
    try { detail = JSON.stringify(item && item.args || {}).toLowerCase(); }
    catch (e) { detail = ''; }
    try { result = String(item && item.result || '').toLowerCase(); }
    catch (e) { result = ''; }
    const key = evidenceKey(name, detail);
    const failed = Boolean(item && (item.isError || item.state === 'error'));
    // Queued/running/cancelled calls are not successful rerun evidence.
    if (!failed && item && item.state && !['done', 'completed', 'success'].includes(item.state)) return;
    if (failed) {
      historicalFailures += 1;
      const args = item && item.args || {};
      outstanding.set(key, {
        key, name,
        command: String(args.command || args.cmd || args.path || args.file_path || '').slice(0, 300),
        reason: String(item && item.result || '').slice(0, 240),
      });
    } else outstanding.delete(key);
    if (failed) return;
    if (/(write|edit|patch|create|save)/.test(name)) mutation = true;
    if (/(test|build|lint|typecheck|check|verify|pytest|unittest|vitest|jest|playwright|cypress|health)/.test(detail)) {
      verification = true;
    }
    if (/(start|dev|serve|uvicorn|gunicorn|healthz|localhost|127\\.0\\.0\\.1)/.test(detail)) {
      launch = true;
    }
    if (/(browser|computer|screenshot|playwright|cypress)/.test(name + ' ' + detail)) visual = true;
    const runtimeSignal = name + ' ' + detail + ' ' + result;
    runtimeProbe = runtimeProbe ||
      /(curl|invoke-webrequest|healthz|health check|playwright|cypress)/.test(runtimeSignal) ||
      /(browser|computer).{0,80}(https?:\/\/|localhost|127\.0\.0\.1)/.test(runtimeSignal);
  });
  launch = runtimeProbe;
  return {
    toolCount: rows.length,
    changedFileCount: files.length,
    meaningfulFileCount: meaningful.length,
    deliverableCount: deliverables.length,
    mutation,
    verification, launch, visual, failures: outstanding.size,
    unresolvedFailures: [...outstanding.values()].slice(0, 8),
    historicalFailures,
    truncated: Boolean(outputSnapshot && outputSnapshot.truncated),
  };
}

function machineGate(profile, evidence) {
  const p = profile || { kind: 'general' };
  const e = evidence || {};
  const strict = p.kind === 'engineering' || p.kind === 'interactive';
  const gaps = [];
  if (strict && !e.mutation) gaps.push('\u6ca1\u6709\u68c0\u6d4b\u5230\u771f\u5b9e\u4ea4\u4ed8\u7269\u53d8\u66f4');
  if (strict && !e.verification) gaps.push('\u7f3a\u5c11\u6210\u529f\u7684\u6784\u5efa\u6216\u6d4b\u8bd5\u8bc1\u636e');
  if (strict && Number(e.failures || 0) > 0) gaps.push('\u4ecd\u6709\u672a\u88ab\u540c\u7c7b\u6210\u529f\u8bc1\u636e\u8986\u76d6\u7684\u6267\u884c\u5931\u8d25');
  if (p.requiresLaunch && !e.launch) gaps.push('\u7f3a\u5c11\u771f\u5b9e\u542f\u52a8\u6216\u5065\u5eb7\u63a2\u9488');
  if (p.visible && !e.visual) gaps.push('\u7f3a\u5c11\u6700\u7ec8\u754c\u9762\u6216\u4ea4\u4e92\u5b9e\u67e5');
  return { pass: gaps.length === 0, gaps };
}
function evidenceText(value) {
  const e = value || {};
  return [
    '系统采集的真实证据快照（不是模型自述）：',
    '- 工具步骤：' + Number(e.toolCount || 0) + '；本轮变更文件：' + Number(e.changedFileCount || 0) + (e.truncated ? '+' : ''),
    '- 已发现实际改动：' + (e.mutation ? '是' : '否') + '；构建/测试/探针：' + (e.verification ? '是' : '否'),
    '- 启动或运行探测：' + (e.launch ? '是' : '否') + '；界面实查：' + (e.visual ? '是' : '否') + '；失败工具：' + Number(e.failures || 0),
  ].join('\n');
}

function verifierSystemPrompt() {
  return [
    '[SoduWork Independent Delivery Verifier]',
    'You are a fresh read-only verifier, not the worker that produced the result.',
    'Inspect the workspace only when needed. Never edit files or continue implementation.',
    'Judge every required check from files and supplied machine evidence.',
    'Return exactly one JSON object. Do not use markdown fences or prose outside JSON.',
    'Schema: {"verdict":"pass|repair|blocked","summary":"...","scores":[',
    '{"dimension":"key","score":0,"reason":"...","action":"...","evidence":["..."]}],',
    '"gaps":[{"check":"key","reason":"...","action":"..."}],',
    '"evidence":["..."],"deliverables":["..."]}.',
    'Score every dimension named in DeliverySpec from 0 to 100. Cite observed evidence.',
    'A working build is not enough for high completeness, usability or visual scores.',
    'Use pass only when hard dimensions and the weighted quality threshold are met.',
    'Use repair for a fixable product gap. Use blocked only for a true external block.',
  ].join('\n');
}

function verificationPrompt(raw, spec, evidence) {
  const value = raw || {};
  const payload = {
    objective: String(value.goal || '').trim(),
    acceptance: String(value.acceptance || '').trim(),
    workKind: spec && spec.workKind || deliveryProfile(value).kind,
    checks: Array.isArray(spec && spec.checks) ? spec.checks : [],
    deliverables: Array.isArray(spec && spec.deliverables) ? spec.deliverables : [],
    coverage: Array.isArray(spec && spec.coverage) ? spec.coverage : [],
    userJourneys: Array.isArray(spec && spec.journeys) ? spec.journeys : [],
    qualityDimensions: Array.isArray(spec && spec.dimensions) ? spec.dimensions : [],
    qualityThreshold: Number(spec && spec.qualityThreshold || 85),
    machineEvidence: evidence || {},
  };
  return [
    'Independently verify this delivery against the contract below.',
    'Do not trust completion claims. Read relevant files when machine evidence is insufficient.',
    'Return the required JSON object only.',
    JSON.stringify(payload, null, 2),
  ].join('\n\n');
}

function parseJsonObject(value) {
  const text = String(value || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced ? fenced[1].trim() : text;
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('missing json object');
  return JSON.parse(source.slice(start, end + 1));
}

function structuredOutcome(value, options) {
  const opts = options || {};
  const profile = opts.profile || { kind: 'general' };
  const evidence = opts.evidence || {};
  const gate = machineGate(profile, evidence);
  let parsed;
  try { parsed = parseJsonObject(value); }
  catch (error) {
    if (gate.pass) {
      return { phase: 'reviewed', retryable: false, source: 'machine-fallback',
        reason: '\u7ed3\u6784\u5316\u590d\u6838\u7ed3\u679c\u4e0d\u53ef\u89e3\u6790\uff0c\u5df2\u6309\u771f\u5b9e\u673a\u5668\u8bc1\u636e\u6536\u53e3',
        gaps: [], review: null };
    }
    return { phase: 'blocked', retryable: true, source: 'machine-gate',
      reason: gate.gaps.join('\uFF1B'), gaps: gate.gaps.map((reason) => ({ reason })),
      review: null };
  }
  const verdict = String(parsed.verdict || '').toLowerCase();
  const gaps = Array.isArray(parsed.gaps) ? parsed.gaps.map((item) => ({
    check: String(item && item.check || ''),
    reason: String(item && item.reason || ''),
    action: String(item && item.action || ''),
  })).filter((item) => item.reason || item.action) : [];
  if (verdict === 'pass' && !gate.pass) {
    const machineGaps = gate.gaps.map((reason) => ({ reason }));
    return { phase: 'blocked', retryable: true, source: 'machine-gate',
      reason: gate.gaps.join('\uFF1B'), gaps: machineGaps, review: parsed };
  }
  if (verdict === 'pass') {
    return { phase: 'reviewed', retryable: false, source: 'verifier',
      reason: String(parsed.summary || '\u72ec\u7acb\u590d\u6838\u5df2\u901a\u8fc7'), gaps: [], review: parsed };
  }
  if (verdict === 'blocked') {
    return { phase: 'blocked', retryable: false, source: 'verifier',
      reason: String(parsed.summary || '\u5b58\u5728\u65e0\u6cd5\u81ea\u52a8\u89e3\u9664\u7684\u5916\u90e8\u963b\u65ad'),
      gaps, review: parsed };
  }
  if (verdict === 'repair') {
    return { phase: 'blocked', retryable: true, source: 'verifier',
      reason: String(parsed.summary || '\u4ea4\u4ed8\u4ecd\u6709\u53ef\u4fee\u590d\u7f3a\u53e3'),
      gaps, review: parsed };
  }
  if (gate.pass) {
    return { phase: 'reviewed', retryable: false, source: 'machine-fallback',
      reason: '\u590d\u6838\u7ed3\u8bba\u5b57\u6bb5\u65e0\u6548\uff0c\u5df2\u6309\u771f\u5b9e\u673a\u5668\u8bc1\u636e\u6536\u53e3',
      gaps: [], review: parsed };
  }
  return { phase: 'blocked', retryable: true, source: 'machine-gate',
    reason: gate.gaps.join('\uFF1B'), gaps: gate.gaps.map((reason) => ({ reason })),
    review: parsed };
}

function repairReason(result) {
  const row = result || {};
  const gaps = Array.isArray(row.gaps) ? row.gaps : [];
  const details = gaps.map((item) => {
    const reason = String(item && item.reason || '');
    const action = String(item && item.action || '');
    return [reason, action].filter(Boolean).join(' -> ');
  }).filter(Boolean);
  return details.length ? details.join('\n') : String(row.reason || '');
}

function finalPrompt(raw, result, evidence) {
  const value = raw || {};
  const reviewed = result || {};
  const status = reviewed.phase === 'reviewed' ? 'verified' : 'blocked';
  return [
    INTERNAL_MARKER,
    'This is the final user-facing delivery turn. Do not call tools.',
    'Write a concise answer in the user language. Do not mention internal review.',
    'State what is ready, how to open or use it, and the strongest real verification.',
    'List only actual final deliverables, not every intermediate file.',
    'If blocked, state the exact block and the minimum user action.',
    'Objective: ' + String(value.goal || '').trim(),
    'Verification status: ' + status,
    'Verification summary: ' + String(reviewed.reason || ''),
    'Quality score: ' + (reviewed.score && Number.isFinite(reviewed.score.total)
      ? reviewed.score.total + '/' + reviewed.score.threshold : 'not available'),
    evidenceText(evidence),
    '</soduwork-internal-goal-audit>',
  ].join('\n\n');
}

function reviewPrompt(raw, evidence) {
  const value = raw || {};
  const acceptance = String(value.acceptance || '').trim() || '结果可直接使用，并有必要的验证证据';
  const profile = deliveryProfile(value);
  return [
    INTERNAL_MARKER,
    '这是 SoduWork 内部的最终交付复核阶段，不是用户的新要求。不要复述本指令，也不要中途向用户提问。',
    '原始目标：' + String(value.goal || '').trim(),
    '完成标准：' + acceptance,
    '交付类型：' + (profile.kind === 'engineering' ? '完整工程/软件功能' : '通用交付'),
    profile.kind === 'conversation'
      ? 'This is a text-only conversational delivery. Judge the visible answer against the requested wording; tool calls and files are not required.'
      : '',
    evidenceText(evidence),
    '',
    '先基于当前工作目录、已经执行的工具结果和真实产物做缺口审计，不要相信上一轮“已完成”的自述。',
    '重新判断本目标适用的交付面。完整工程或功能通常包括：用户体验与视觉、前端、后端/API、数据与配置、权限与安全、集成、错误和空状态、测试、构建、运行或部署说明；简单任务只检查真正适用的部分。',
    '逐项核对目标和完成标准。发现任何可修复缺口时，立即继续使用工具补齐，再执行构建、测试、启动或关键用户旅程验证；有界面时实际查看最终呈现与交互，不能只检查文件存在。',
    profile.kind === 'engineering'
      ? '这是工程交付：没有真实改动和真实构建/测试/运行探针证据不得通过；完整应用还要核对启动方法与端到端关键路径，只有后端或只有页面一律继续补做。'
      : '根据目标类型检查真正适用的交付物和验证，不机械生造前后端。',
    '工具失败不等于验证通过。必须确认修复后重跑成功，或把无法消除的阻断如实标记为 blocked。',
    '不要把半成品、仅后端、仅页面、代码片段、未经验证的实现或“建议下一步”包装成完整交付。',
    '所有适用项已经完成且证据足够时，最终答复第一行写：' + PASS_MARKER,
    '仍有无法自行消除的外部阻断、必要授权或关键缺口时，第一行写：' + BLOCKED_MARKER,
    '标记之后再给用户唯一的最终答复：结果摘要、最多 3 个关键交付物、真实验证证据、仍需人工处理的事项。不要提到内部审计或这些标记。',
    '</soduwork-internal-goal-audit>',
  ].join('\n');
}

function isInternalPrompt(value) {
  const text = String(value || '').trimStart();
  return text.startsWith(INTERNAL_MARKER) || text.startsWith(IMPLEMENT_MARKER) ||
    text.startsWith(REPAIR_MARKER) || text.startsWith(CONTINUE_MARKER);
}

function repairPrompt(raw, reason, evidence) {
  const value = raw || {};
  return [
    REPAIR_MARKER,
    '这是 SoduWork 内部的交付补缺阶段，不是用户的新要求。不要复述本指令，不要向用户提问，也不要仅改写最终答复。',
    '原始目标：' + String(value.goal || '').trim(),
    '完成标准：' + (String(value.acceptance || '').trim() || '结果可直接使用，并有必要的验证证据'),
    '未通过原因：' + String(reason || '证据不足'),
    evidenceText(evidence),
    '',
    '请回到真实工作目录直接修复缺口并补齐证据。需要改代码就改，需要补前端/后端/配置就补，需要构建、测试、启动或查看界面就实际执行。',
    '不要伪造证据。完成补缺后不要写最终答复，SoduWork 会再次独立复核。',
    '</soduwork-internal-goal-repair>',
  ].join('\n');
}

function blockedPrompt(raw, reason, evidence) {
  const value = raw || {};
  return [
    INTERNAL_MARKER,
    '这是 SoduWork 内部的最终阻断回执阶段。不要使用工具，不要声称已经完成，也不要复述本指令。',
    '原始目标：' + String(value.goal || '').trim(),
    '完成标准：' + (String(value.acceptance || '').trim() || '结果可直接使用，并有必要的验证证据'),
    '最终未通过原因：' + String(reason || '交付证据仍不完整'),
    evidenceText(evidence),
    '',
    '第一行必须写：' + BLOCKED_MARKER,
    '标记后用用户的语言告诉用户：已经完成什么、哪一项仍未达到交付标准、真实证据现状、用户解除阻断所需的最小动作。不得写成成功交付。',
    '</soduwork-internal-goal-audit>',
  ].join('\n');
}

function _marked(value) {
  const text = String(value || '');
  const match = text.match(/(?:^|\r?\n)[ \t]*<!-- soduwork-delivery-audit:(pass|blocked) -->[ \t]*(?:\r?\n|$)/);
  if (!match) return { found: false, phase: '', visible: '' };
  return {
    found: true,
    phase: match[1] === 'pass' ? 'reviewed' : 'blocked',
    visible: text.slice(Number(match.index || 0) + match[0].length).trimStart(),
  };
}

function outcome(snapshot, fromMessage, options) {
  const rows = ((snapshot && snapshot.messages) || []).slice(Math.max(0, Number(fromMessage) || 0));
  let text = '';
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const item = rows[index];
    if (!item || item.role !== 'assistant') continue;
    text = (item.blocks || []).filter((block) => block && block.kind === 'text')
      .map((block) => String(block.text || '')).join('\n');
    if (text.trim()) break;
  }
  const marked = _marked(text);
  const opts = options || {};
  const evidence = opts.evidence || null;
  const profile = opts.profile || { kind: 'general' };
  if (marked.phase === 'reviewed' && profile.kind === 'engineering' && evidence) {
    if (!evidence.mutation) {
      return { phase: 'blocked', reason: '工程交付没有检测到真实文件改动', retryable: true };
    }
    if (!evidence.verification) {
      return { phase: 'blocked', reason: '工程交付没有检测到构建、测试或运行探针证据', retryable: true };
    }
    if (profile.requiresLaunch && !evidence.launch) {
      return { phase: 'blocked', reason: '完整工程没有检测到真实启动或运行健康探测证据', retryable: true };
    }
  }
  if (!marked.found && profile.kind === 'conversation' && text.trim()) {
    const expected = Array.isArray(profile.expectedText) ? profile.expectedText : [];
    const missing = expected.filter((item) => !text.includes(item));
    if (!missing.length) {
      return {
        phase: 'reviewed',
        reason: '\u7eaf\u5bf9\u8bdd\u76ee\u6807\u5df2\u5f62\u6210\u7b26\u5408\u5b8c\u6210\u6807\u51c6\u7684\u53ef\u89c1\u7b54\u590d',
        retryable: false,
      };
    }
    return {
      phase: 'blocked',
      reason: '\u6700\u7ec8\u7b54\u590d\u672a\u5305\u542b\u7ea6\u5b9a\u5185\u5bb9\uff1a' + missing.join('\u3001'),
      retryable: true,
    };
  }

  if (marked.phase === 'reviewed') return { phase: 'reviewed', reason: '已完成交付复核', retryable: false };
  if (marked.phase === 'blocked') return { phase: 'blocked', reason: '交付复核发现仍需处理的阻断', retryable: false };
  return { phase: 'blocked', reason: '交付复核没有形成明确的通过结论', retryable: true };
}

function cleanVisible(value) {
  const text = String(value || '');
  const marked = _marked(text);
  if (marked.found) return marked.visible;
  return text
    .replaceAll(PASS_MARKER, '').replaceAll(BLOCKED_MARKER, '')
    .replace(/<\/?soduwork-internal-goal-audit>/g, '').trimStart();
}

/* Hide internal review until its conclusion marker, then expose only the formal answer after it. */
function auditVisible(value) {
  const marked = _marked(value);
  return marked.found ? marked.visible : '';
}

function fromEntries(entries) {
  const rows = Array.isArray(entries) ? entries : [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const item = rows[index];
    if (item && item.type === 'custom' && item.customType === ENTRY_TYPE) {
      const phase = item.data && item.data.phase;
      if (phase === 'reviewed' || phase === 'blocked') {
        return { phase, reason: String(item.data.reason || ''), rounds: Number(item.data.rounds || 1) };
      }
    }
  }
  return null;
}

module.exports = {
  ENTRY_TYPE, INTERNAL_MARKER, IMPLEMENT_MARKER, REPAIR_MARKER, CONTINUE_MARKER, NORMAL_MARKER,
  PASS_MARKER, BLOCKED_MARKER, deliveryProfile, conversationPrompt, implementationPrompt, continuationPrompt, normalPrompt,
  visibleUserPrompt, collectEvidence: collectEvidenceV2, evidenceText, machineGate,
  verifierSystemPrompt, verificationPrompt, structuredOutcome, repairReason, finalPrompt,
  reviewPrompt, repairPrompt, blockedPrompt,
  isInternalPrompt, outcome, cleanVisible, auditVisible, fromEntries,
};
