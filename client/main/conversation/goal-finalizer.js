'use strict';

/* A goal's worker transcript is evidence, not presentation context. */
const path = require('path');

const ENTRY_TYPE = 'soduwork.goal.final';
const SCHEMA_VERSION = 1;
const MAX_TEXT = 6000;
const MAX_ITEMS = 8;
const INTERNAL_PATTERN = /system_warning|soduwork-internal|soduwork-delivery-audit|<\|?DSML|ignore\s+(?:the\s+)?(?:unrelated\s+)?system|忽略(?:无关)?\s*system_warning/i;
const PROCESS_PATTERN = /(?:我|现在|接下来|随后|先)(?:会|将|正在|来)?(?:调用|使用|运行)\s*(?:bash|shell|终端|命令)|(?:我|现在|接下来|随后|先)(?:会|将|正在|来)?(?:查看|读取|检查)\s*(?:文件|目录|源码)|\b(?:i\s+(?:will|am going to)|let me)\s+(?:call|run|use|inspect|read|check)\s+(?:bash|shell|the file|the directory)/i;
const WINDOWS_PATH = /\b[A-Za-z]:[\\/](?:[^\s'"<>|]+[\\/]?){1,}/g;
const UNIX_PATH = /(^|[\s'(])\/(?:home|root|Users|tmp|var|opt|etc)\/(?:[^\s'"<>|]+\/?)+/gm;

function text(value, limit = 1200) {
  return String(value == null ? '' : value).replace(/\r/g, '').trim().slice(0, limit);
}

function safeText(value, limit) {
  return text(value, limit)
    .replace(WINDOWS_PATH, '[本机路径]')
    .replace(UNIX_PATH, '$1[本机路径]')
    .replace(/<\/?soduwork-[^>]+>/gi, '')
    .replace(/<!--\s*soduwork-[\s\S]*?-->/gi, '')
    .trim();
}

function relative(value) {
  const raw = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (!raw || /^[A-Za-z]:\//.test(raw) || raw.startsWith('/') || raw.split('/').includes('..')) return '';
  return raw.slice(0, 300);
}

function outputItems(snapshot) {
  const source = snapshot && snapshot.delivery && Array.isArray(snapshot.delivery.items)
    ? snapshot.delivery.items : (snapshot && Array.isArray(snapshot.files) ? snapshot.files : []);
  const seen = new Set();
  return source.map((item) => {
    const rel = relative(item && (item.relative || item.rel || item.name));
    if (!rel || seen.has(rel.toLowerCase())) return null;
    seen.add(rel.toLowerCase());
    return {
      name: safeText(item && (item.title || item.name || path.basename(rel)), 160) || path.basename(rel),
      path: rel,
      kind: safeText(item && item.kind, 40) || 'file',
      note: safeText(item && (item.summary || item.note), 240),
      preview: Boolean(item && item.preview),
    };
  }).filter(Boolean).slice(0, MAX_ITEMS);
}

function evidenceAllowed(item, facts) {
  const key = String(item && (item.key || item.check) || '').toLowerCase();
  if (key === 'verification') return Boolean(facts && facts.verification);
  if (key === 'launch') return Boolean(facts && facts.launch);
  if (key === 'visual') return Boolean(facts && facts.visual);
  if (key === 'execution_errors') return false;
  return Array.isArray(item && item.evidence) && item.evidence.some(Boolean);
}

function modelEvidenceAllowed(value, facts) {
  const row = safeText(value, 240);
  if (!row) return false;
  if (/(?:真实启动|健康探针|运行探针|health\s*(?:check|probe)|runtime\s*probe)/i.test(row) &&
      !Boolean(facts && facts.launch)) return false;
  if (/(?:界面.*实查|关键旅程|交互实查|截图|visual\s*check|screenshot)/i.test(row) &&
      !Boolean(facts && facts.visual)) return false;
  if (/(?:可重放验证|构建|测试|build|test)/i.test(row) &&
      !Boolean(facts && facts.verification)) return false;
  return true;
}

function directEvidence(item) {
  const label = safeText(item && (item.label || item.check || item.name), 100);
  const proof = (Array.isArray(item && item.evidence) ? item.evidence : [])
    .map((value) => safeText(value, 160)).filter(Boolean).slice(0, 3);
  return [label, proof.join('；')].filter(Boolean).join('：');
}

function reviewChecks(reviewed, facts) {
  const direct = reviewed && reviewed.deterministic && Array.isArray(reviewed.deterministic.checks)
    ? reviewed.deterministic.checks : [];
  const model = reviewed && reviewed.review && Array.isArray(reviewed.review.evidence)
    ? reviewed.review.evidence : [];
  const verified = direct.filter((item) => item && item.pass === true && evidenceAllowed(item, facts))
    .map(directEvidence).filter(Boolean);
  const reviewedEvidence = model.map((item) => {
    if (typeof item === 'string') return safeText(item, 240);
    const label = safeText(item && (item.label || item.check || item.name), 100);
    const proof = safeText(item && (item.evidence || item.reason || item.summary), 180);
    return [label, proof].filter(Boolean).join('：');
  }).filter((item) => modelEvidenceAllowed(item, facts));
  return [...new Set([...verified, ...reviewedEvidence])].slice(0, MAX_ITEMS);
}

function limitations(reviewed) {
  const gaps = reviewed && Array.isArray(reviewed.gaps) ? reviewed.gaps : [];
  const rows = gaps.map((item) => {
    const reason = safeText(item && (item.reason || item.check), 240);
    const action = safeText(item && item.action, 180);
    return [reason, action].filter(Boolean).join('；');
  }).filter(Boolean);
  if (!rows.length && reviewed && reviewed.phase !== 'reviewed') {
    const reason = safeText(reviewed.reason, 320);
    if (reason) rows.push(reason);
  }
  return rows.slice(0, MAX_ITEMS);
}

function context(raw, reviewed, evidence, outputSnapshot) {
  const value = raw || {};
  const result = reviewed || {};
  const facts = evidence || {};
  return {
    objective: safeText(value.goal || value.objective, 1200),
    acceptance: safeText(value.acceptance, 1200),
    status: result.phase === 'reviewed' ? 'completed' : 'blocked',
    reviewSummary: safeText(result.reason, 500),
    score: result.score && Number.isFinite(Number(result.score.total)) ? {
      total: Number(result.score.total), threshold: Number(result.score.threshold || 0),
    } : null,
    deliverables: outputItems(outputSnapshot),
    verification: {
      changedFiles: Number(facts.changedFileCount || 0),
      deliverables: Number(facts.deliverableCount || 0),
      buildOrTest: Boolean(facts.verification),
      runtimeProbe: Boolean(facts.launch),
      visualCheck: Boolean(facts.visual),
      unresolvedFailures: Number(facts.failures || 0),
      checks: reviewChecks(result, facts),
    },
    limitations: limitations(result),
  };
}

function systemPrompt() {
  return [
    '[SoduWork Delivery Presenter]',
    'You receive a clean delivery fact sheet, never the worker transcript.',
    'Do not use tools. Do not infer work, files, tests or limitations that are absent.',
    'Write in the user language and return exactly one JSON object with no markdown fence.',
    'Schema: {"title":"...","summary":"...","deliverables":[{"name":"...","path":"...","note":"..."}],"verification":["..."],"limitations":["..."]}.',
    'Keep it concise. Mention result and real verification, not commands or internal process.',
    'Paths must be relative deliverable paths from the fact sheet. Never emit an absolute path.',
  ].join('\n');
}

function prompt(raw, reviewed, evidence, outputSnapshot, retry) {
  const prefix = retry
    ? 'The previous answer failed the presentation quality gate. Rebuild it from the unchanged facts only.'
    : 'Prepare the single final user-facing delivery response from these facts.';
  return [prefix, 'Return the required JSON object only.', JSON.stringify(
    context(raw, reviewed, evidence, outputSnapshot), null, 2)].join('\n\n');
}

function parse(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const source = String(value || '').trim();
  const fenced = source.match(/~~~(?:json)?\s*([\s\S]*?)~~~/i) ||
    source.match(/\x60\x60\x60(?:json)?\s*([\s\S]*?)\x60\x60\x60/i);
  const candidate = fenced ? fenced[1].trim() : source;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('final answer is not a JSON object');
  return JSON.parse(candidate.slice(start, end + 1));
}

function strings(value, limit = MAX_ITEMS) {
  return (Array.isArray(value) ? value : []).map((item) => safeText(item, 360))
    .filter(Boolean).slice(0, limit);
}

function normalize(value, allowedOutputs) {
  const row = parse(value);
  const allowed = new Map((allowedOutputs || []).map((item) => [item.path.toLowerCase(), item]));
  const deliverables = (Array.isArray(row.deliverables) ? row.deliverables : []).map((item) => {
    const rel = relative(item && item.path);
    const known = allowed.get(rel.toLowerCase());
    if (!rel || !known) return null;
    return {
      name: safeText(item && item.name, 160) || known.name,
      path: known.path,
      note: safeText(item && item.note, 280) || known.note,
    };
  }).filter(Boolean).slice(0, MAX_ITEMS);
  return {
    schemaVersion: SCHEMA_VERSION,
    title: safeText(row.title, 180),
    summary: safeText(row.summary, 1000),
    deliverables,
    verification: strings(row.verification),
    limitations: strings(row.limitations),
  };
}

function duplicateReason(value) {
  const parts = String(value || '').split(/\n{2,}|(?<=[。！？.!?])\s+/)
    .map((item) => item.replace(/\s+/g, ' ').trim().toLowerCase())
    .filter((item) => item.length >= 18);
  const counts = new Map();
  for (const item of parts) {
    const count = Number(counts.get(item) || 0) + 1;
    counts.set(item, count);
    if (count >= 2) return '包含重复段落';
  }
  return '';
}

function hasAbsolutePath(value) {
  WINDOWS_PATH.lastIndex = 0;
  UNIX_PATH.lastIndex = 0;
  const source = String(value || '');
  const found = WINDOWS_PATH.test(source) || UNIX_PATH.test(source);
  WINDOWS_PATH.lastIndex = 0;
  UNIX_PATH.lastIndex = 0;
  return found;
}

function evidenceConsistency(normalized, facts) {
  if (!facts || !facts.verification) return [];
  const source = (normalized && Array.isArray(normalized.verification)
    ? normalized.verification : []).join('\n');
  const actual = facts.verification;
  const reasons = [];
  const launch = /(?:真实启动|运行时?(?:探测|验证)|健康探针|health\s*(?:check|probe)|runtime\s*probe)/i;
  const visual = /(?:界面|交互|关键旅程|浏览器|截图|visual\s*check|screenshot)/i;
  const positive = /(?:已完成|已通过|验证通过|探测成功|检查完成|实查完成)/i;
  const negative = /(?:未做|未执行|未完成|没有进行|尚未进行)/i;
  const lines = source.split(/\n+/).map((item) => item.trim()).filter(Boolean);
  lines.forEach((line) => {
    if (launch.test(line)) {
      if (actual.runtimeProbe && negative.test(line)) reasons.push('运行探针陈述与真实证据矛盾');
      if (!actual.runtimeProbe && positive.test(line) && !negative.test(line)) {
        reasons.push('声称执行了不存在的运行探针');
      }
    }
    if (visual.test(line)) {
      if (actual.visualCheck && negative.test(line)) reasons.push('界面实查陈述与真实证据矛盾');
      if (!actual.visualCheck && positive.test(line) && !negative.test(line)) {
        reasons.push('声称执行了不存在的界面实查');
      }
    }
  });
  return [...new Set(reasons)];
}

function qualityGate(raw, normalized, status, facts) {
  const source = typeof raw === 'string' ? raw : JSON.stringify(raw || {});
  const joined = JSON.stringify(normalized || {});
  const reasons = [];
  if (INTERNAL_PATTERN.test(source) || INTERNAL_PATTERN.test(joined)) reasons.push('包含内部协议或系统警告');
  if (PROCESS_PATTERN.test(source) || PROCESS_PATTERN.test(joined)) reasons.push('包含工具过程旁白');
  if (hasAbsolutePath(source) || hasAbsolutePath(joined)) reasons.push('包含本机绝对路径');
  const duplicate = duplicateReason((normalized && normalized.summary || '') + '\n\n' +
    (normalized && normalized.verification || []).join('\n\n'));
  if (duplicate) reasons.push(duplicate);
  if (!normalized || !normalized.title || !normalized.summary) reasons.push('缺少结果标题或摘要');
  if (!normalized || !Array.isArray(normalized.verification) || !normalized.verification.length) {
    reasons.push('缺少真实验证结论');
  }
  if (status === 'blocked' && normalized &&
      (!Array.isArray(normalized.limitations) || !normalized.limitations.length)) {
    reasons.push('阻断结果缺少真实限制');
  }
  if (status === 'completed' && normalized && !normalized.deliverables.length &&
      !/(完成|交付|结果|ready|complete|delivered)/i.test(normalized.summary)) {
    reasons.push('只有过程，没有明确结果');
  }
  if (joined.length > MAX_TEXT) reasons.push('最终回复长度异常');
  reasons.push(...evidenceConsistency(normalized, facts));
  return { ok: reasons.length === 0, reasons };
}

function verificationFallback(facts) {
  const evidence = facts.verification || {};
  const rows = [];
  if (evidence.buildOrTest) rows.push('已完成适用的构建或测试验证');
  if (evidence.runtimeProbe) rows.push('已完成真实启动或运行健康探测');
  if (evidence.visualCheck) rows.push('已完成关键界面与交互实查');
  (evidence.checks || []).forEach((item) => rows.push(item));
  if (!rows.length) {
    rows.push(facts.status === 'completed'
      ? '已依据当前工作区与交付证据完成复核'
      : '当前证据尚不足以确认完整交付');
  }
  return [...new Set(rows)].slice(0, MAX_ITEMS);
}

function fallback(raw, reviewed, evidence, outputSnapshot) {
  const facts = context(raw, reviewed, evidence, outputSnapshot);
  const objective = facts.objective.replace(/[。！？.!?]+$/g, '').slice(0, 70) || '本次工作';
  const completed = facts.status === 'completed';
  return {
    schemaVersion: SCHEMA_VERSION,
    title: completed ? objective + '已完成' : objective + '暂未完成',
    summary: completed
      ? '已完成目标要求，并依据真实产物和验证证据完成交付复核。'
      : '已保留当前成果，但仍有未达到完成标准的事项，暂不作为成功交付。',
    deliverables: facts.deliverables.map((item) => ({
      name: item.name, path: item.path, note: item.note,
    })),
    verification: verificationFallback(facts),
    limitations: facts.limitations,
  };
}

function render(value) {
  const row = value || {};
  const lines = ['## ' + safeText(row.title, 180), '', safeText(row.summary, 1000)];
  if (row.deliverables && row.deliverables.length) {
    lines.push('', '### 成果');
    row.deliverables.forEach((item) => {
      lines.push('- ' + (item.path || item.name) + (item.note ? ' — ' + item.note : ''));
    });
  }
  if (row.verification && row.verification.length) {
    lines.push('', '### 验证');
    row.verification.forEach((item) => lines.push('- ' + item));
  }
  if (row.limitations && row.limitations.length) {
    lines.push('', '### 仍需注意');
    row.limitations.forEach((item) => lines.push('- ' + item));
  }
  return lines.join('\n').trim();
}

function fromEntries(entries) {
  const rows = Array.isArray(entries) ? entries : [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const item = rows[index];
    if (!item || item.type !== 'custom' || item.customType !== ENTRY_TYPE) continue;
    const data = item.data || {};
    const structured = data.structured && typeof data.structured === 'object'
      ? data.structured : null;
    const rendered = safeText(data.rendered || (structured && render(structured)), MAX_TEXT);
    if (structured && rendered) {
      return { structured, rendered, source: String(data.source || 'stored') };
    }
  }
  return null;
}

module.exports = {
  ENTRY_TYPE, SCHEMA_VERSION, systemPrompt, prompt, context, outputItems,
  parse, normalize, qualityGate, fallback, render, fromEntries,
};
