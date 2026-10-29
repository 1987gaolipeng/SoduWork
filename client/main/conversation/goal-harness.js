'use strict';
const deliverySpec = require('./delivery-spec');
const delivery = require('./delivery-contract');
const ENTRY_TYPE = 'soduwork.goal.harness';
const SCHEMA_VERSION = 3;
const PHASES = Object.freeze([
  ['understand', '\u7406\u89e3\u76ee\u6807'],
  ['plan', '\u5f62\u6210\u8ba1\u5212'],
  ['execute', '\u5b8c\u6210\u5de5\u4f5c'],
  ['verify', '\u9a8c\u8bc1\u7ed3\u679c'],
  ['deliver', '\u6574\u7406\u4ea4\u4ed8'],
]);

function splitCriteria(value) {
  return deliverySpec.splitCriteria(value);
}
function workKind(raw) {
  const kinds = deliverySpec.detectKinds(raw || {});
  return deliverySpec.primaryKind(kinds);
}

function inferredChecks(kind) {
  const rows = [];
  const put = (key, category, label, evidence) => {
    rows.push({ key, category, label, evidence, required: true });
  };
  put('usable', 'delivery',
    '\u7ed3\u679c\u53ef\u76f4\u63a5\u4f7f\u7528',
    '\u771f\u5b9e\u4ea4\u4ed8\u7269\u6216\u53ef\u89c1\u7ed3\u679c');
  if (kind === 'interactive') {
    put('journey', 'experience', '\u6838\u5fc3\u6e38\u73a9\u6d41\u7a0b\u53ef\u73a9',
      '\u771f\u5b9e\u64cd\u4f5c\u8def\u5f84');
    put('visual', 'experience', '\u89c6\u89c9\u548c\u4ea4\u4e92\u8fbe\u5230\u4ea4\u4ed8\u54c1\u8d28',
      '\u5173\u952e\u753b\u9762\u5b9e\u67e5');
    put('mechanics', 'behavior', '\u64cd\u63a7\u3001\u53cd\u9988\u548c\u7269\u7406\u903b\u8f91\u81ea\u6d3d',
      '\u8fde\u7eed\u64cd\u4f5c\u9a8c\u8bc1');
    put('build', 'engineering', '\u53ef\u6784\u5efa\u4e14\u53ef\u542f\u52a8',
      '\u6784\u5efa\u548c\u8fd0\u884c\u63a2\u9488');
    put('quality', 'engineering', '\u6027\u80fd\u3001\u9002\u914d\u548c\u5f02\u5e38\u72b6\u6001\u53ef\u63a5\u53d7',
      '\u591a\u5c3a\u5bf8\u4e0e\u8fb9\u754c\u68c0\u67e5');
  } else if (kind === 'website') {
    put('journey', 'experience', '\u4e3b\u8981\u7528\u6237\u65c5\u7a0b\u5b8c\u6574',
      '\u5173\u952e\u9875\u9762\u4e0e\u4ea4\u4e92\u5b9e\u67e5');
    put('visual', 'experience', '\u89c6\u89c9\u3001\u54cd\u5e94\u5f0f\u548c\u53ef\u8bbf\u95ee\u6027\u8fbe\u6807',
      '\u591a\u5c3a\u5bf8\u9875\u9762\u68c0\u67e5');
    put('states', 'behavior', '\u52a0\u8f7d\u3001\u7a7a\u548c\u9519\u8bef\u72b6\u6001\u5b8c\u6574',
      '\u5f02\u5e38\u8def\u5f84\u68c0\u67e5');
    put('build', 'engineering', '\u53ef\u6784\u5efa\u3001\u53ef\u542f\u52a8\u4e14\u8d44\u6e90\u5b8c\u6574',
      '\u751f\u4ea7\u6784\u5efa\u4e0e\u8fd0\u884c\u63a2\u9488');
  } else if (kind === 'engineering') {
    put('behavior', 'behavior', '\u9700\u6c42\u884c\u4e3a\u548c\u8fb9\u754c\u5b8c\u6574',
      '\u81ea\u52a8\u5316\u6d4b\u8bd5\u6216\u771f\u5b9e\u64cd\u4f5c');
    put('verification', 'engineering', '\u6784\u5efa\u3001\u6d4b\u8bd5\u548c\u68c0\u67e5\u901a\u8fc7',
      '\u53ef\u91cd\u653e\u7684\u547d\u4ee4\u7ed3\u679c');
    put('integration', 'engineering', '\u542f\u52a8\u6216\u96c6\u6210\u8def\u5f84\u53ef\u7528',
      '\u8fd0\u884c\u63a2\u9488\u6216\u96c6\u6210\u6d4b\u8bd5');
    put('safety', 'engineering', '\u9519\u8bef\u5904\u7406\u548c\u5b89\u5168\u65e0\u660e\u663e\u7f3a\u53e3',
      '\u5931\u8d25\u8def\u5f84\u68c0\u67e5');
  } else {
    put('verified', 'verification', '\u5b8c\u6210\u5fc5\u8981\u9a8c\u8bc1',
      '\u53ef\u6838\u5bf9\u7684\u771f\u5b9e\u8bc1\u636e');
  }
  return rows;
}
function compile(raw) {
  const spec = deliverySpec.compile(raw || {});
  return {
    ...spec,
    schemaVersion: SCHEMA_VERSION,
    workKind: spec.primaryKind,
    criteria: spec.acceptance,
    phase: 'understand', state: 'running',
    reason: '', attempts: 0, updatedAt: Date.now(),
    phases: PHASES.map(([key, label], index) => ({
      key, label, state: index === 0 ? 'running' : 'pending',
    })),
  };
}
function normalize(value, fallback) {
  const source = value && typeof value === 'object' ? { ...(fallback || {}), ...value } : (fallback || {});
  const base = Number(source.schemaVersion) === SCHEMA_VERSION ? source : compile({
    goal: source.objective || source.goal,
    acceptance: Array.isArray(source.criteria) ? source.criteria.join('\n') : source.acceptance,
  });
  const phase = PHASES.some(([key]) => key === base.phase) ? base.phase : 'understand';
  const active = PHASES.findIndex(([key]) => key === phase);
  return {
    ...base, schemaVersion: SCHEMA_VERSION, phase,
    criteria: Array.isArray(base.criteria) ? base.criteria.slice(0, 20) : [],
    workKinds: Array.isArray(base.workKinds) ? base.workKinds.slice(0, 8)
      : deliverySpec.detectKinds({ goal: base.objective }),
    deliverables: Array.isArray(base.deliverables) ? base.deliverables.slice(0, 8) : [],
    coverage: Array.isArray(base.coverage) ? base.coverage.slice(0, 20) : [],
    journeys: Array.isArray(base.journeys) ? base.journeys.slice(0, 12) : [],
    dimensions: Array.isArray(base.dimensions) ? base.dimensions.slice(0, 10) : [],
    checks: Array.isArray(base.checks) ? base.checks.slice(0, 40)
      : deliverySpec.inferredChecks(base.workKinds || [base.workKind], base.criteria),
    phases: PHASES.map(([key, label], index) => {
      let state = index < active ? 'completed' : index === active ? 'running' : 'pending';
      if (base.state === 'completed') state = 'completed';
      else if (index === active && ['blocked', 'paused'].includes(base.state)) state = base.state;
      return { key, label, state };
    }),
  };
}
function advance(current, phase, state, reason) {
  const base = normalize(current);
  const next = PHASES.some(([key]) => key === phase) ? phase : base.phase;
  const active = PHASES.findIndex(([key]) => key === next);
  const finalState = state || 'running';
  return {
    ...base, phase: next, state: finalState, reason: String(reason || '').slice(0, 800),
    attempts: Number(base.attempts || 0) + (finalState === 'repairing' ? 1 : 0),
    updatedAt: Date.now(),
    phases: PHASES.map(([key, label], index) => ({
      key, label, state: finalState === 'completed' ? 'completed'
        : index < active ? 'completed' : index > active ? 'pending'
          : ['blocked', 'paused'].includes(finalState) ? finalState : 'running',
    })),
  };
}
function fromEntries(entries, fallback) {
  const rows = Array.isArray(entries) ? entries : [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const item = rows[index];
    if (item && item.type === 'custom' && item.customType === ENTRY_TYPE) return normalize(item.data, fallback);
  }
  return compile(fallback || {});
}
function prompt(raw) {
  const spec = compile(raw || {});
  return deliverySpec.executionPrompt(spec) + '\n\n' + delivery.instructions();
}
function view(value) {
  const row = normalize(value);
  return { schemaVersion: row.schemaVersion, phase: row.phase, state: row.state,
    reason: row.reason, attempts: row.attempts, workKind: row.workKind,
    workKinds: row.workKinds, complete: row.complete,
    criteria: row.criteria, checks: row.checks, deliverables: row.deliverables,
    coverage: row.coverage, journeys: row.journeys, dimensions: row.dimensions,
    qualityThreshold: row.qualityThreshold,
    phases: row.phases, updatedAt: row.updatedAt };
}
module.exports = { ENTRY_TYPE, SCHEMA_VERSION, PHASES, compile, normalize, advance,
  fromEntries, prompt, view, _splitCriteria: splitCriteria, _workKind: workKind, inferredChecks };
