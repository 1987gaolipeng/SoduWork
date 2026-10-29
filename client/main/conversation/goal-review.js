'use strict';

/* Independent model review may add semantic and quality gaps. It can never
   waive a deterministic failure and malformed output can never become pass. */
const verifier = require('./goal-verifier');
const crypto = require('crypto');

function parse(value) {
  const text = String(value || '').trim();
  const fenced = text.match(/\x60\x60\x60(?:json)?\s*([\s\S]*?)\x60\x60\x60/i);
  const source = fenced ? fenced[1].trim() : text;
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('missing json object');
  return JSON.parse(source.slice(start, end + 1));
}

function normalizeGaps(rows) {
  return (Array.isArray(rows) ? rows : []).map((item) => ({
    check: String(item && (item.check || item.key) || ''),
    reason: String(item && item.reason || item || ''),
    action: String(item && item.action || ''),
  })).filter((item) => item.reason || item.action);
}

function scoreRows(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).map(([dimension, item]) =>
    typeof item === 'number' ? { dimension, score: item }
      : { ...(item || {}), dimension: item && item.dimension || dimension });
}

function scorecard(reviewed, spec) {
  const dimensions = Array.isArray(spec && spec.dimensions) ? spec.dimensions : [];
  if (!dimensions.length) return null;
  const supplied = new Map(scoreRows(reviewed && reviewed.scores).map((item) => [
    String(item && (item.dimension || item.key) || '').toLowerCase(), item || {},
  ]));
  const normalized = [];
  const missing = [];
  dimensions.forEach((dimension) => {
    const key = String(dimension.key || '').toLowerCase();
    const item = supplied.get(key);
    const value = Number(item && item.score);
    if (!item || !Number.isFinite(value)) {
      missing.push(key);
      return;
    }
    normalized.push({
      key,
      label: String(dimension.label || key),
      score: Math.max(0, Math.min(100, Math.round(value))),
      threshold: Number(dimension.threshold || 0),
      weight: Number(dimension.weight || 0),
      hard: Boolean(dimension.hard),
      reason: String(item.reason || ''),
      action: String(item.action || ''),
      evidence: Array.isArray(item.evidence) ? item.evidence.map(String).slice(0, 8) : [],
    });
  });
  if (missing.length) return { valid: false, missing, dimensions: normalized };
  const weight = normalized.reduce((sum, item) => sum + item.weight, 0) || 1;
  const total = Math.round(normalized.reduce((sum, item) =>
    sum + item.score * item.weight, 0) / weight);
  const threshold = Number(spec.qualityThreshold || 85);
  const gaps = normalized.filter((item) => item.hard && item.score < item.threshold)
    .map((item) => ({
      check: 'quality:' + item.key,
      reason: item.label + ' ' + item.score + ' \u5206\uff0c\u4f4e\u4e8e\u95e8\u69db ' + item.threshold + ' \u5206' +
        (item.reason ? '\uff1a' + item.reason : ''),
      action: item.action || ('\u9488\u5bf9' + item.label + '\u7684\u6700\u5927\u7f3a\u53e3\u505a\u4e00\u6b21\u53ef\u9a8c\u8bc1\u4fee\u8ba2'),
    }));
  if (total < threshold && !gaps.length) {
    const weakest = normalized.slice().sort((a, b) => a.score - b.score)[0];
    gaps.push({
      check: 'quality:' + (weakest && weakest.key || 'overall'),
      reason: '\u7efc\u5408\u8d28\u91cf ' + total + ' \u5206\uff0c\u4f4e\u4e8e\u4ea4\u4ed8\u95e8\u69db ' + threshold + ' \u5206' +
        (weakest && weakest.reason ? '\uff1a' + weakest.reason : ''),
      action: weakest && weakest.action || '\u4f18\u5148\u6539\u5584\u5f53\u524d\u6700\u4f4e\u5206\u7684\u8d28\u91cf\u7ef4\u5ea6',
    });
  }
  return { valid: true, total, threshold, pass: gaps.length === 0, dimensions: normalized, gaps };
}

function machine(options) {
  return verifier.verify(options || {});
}

function outcome(value, options) {
  const opts = options || {};
  const deterministic = opts.deterministic || { pass: false, gaps: [{
    check: 'deterministic_verifier',
    reason: '\u7f3a\u5c11\u786e\u5b9a\u6027\u9a8c\u6536\u7ed3\u679c',
    action: '\u91cd\u65b0\u6267\u884c SoduWork \u9a8c\u6536\u5668',
  }] };
  const machineGaps = normalizeGaps(deterministic.gaps);
  if (!deterministic.pass) {
    return {
      phase: 'blocked', retryable: deterministic.retryable !== false, source: 'deterministic-verifier',
      reason: machineGaps.map((item) => item.reason).join('\uff1b') ||
        deterministic.summary || '\u786e\u5b9a\u6027\u9a8c\u6536\u672a\u901a\u8fc7',
      gaps: machineGaps, review: null, score: null, deterministic,
    };
  }

  let reviewed;
  try {
    reviewed = parse(value);
  } catch (error) {
    return {
      phase: 'blocked', retryable: true, source: 'verifier-protocol',
      reason: '\u72ec\u7acb\u590d\u6838\u6ca1\u6709\u8fd4\u56de\u53ef\u89e3\u6790\u7684\u7ed3\u6784\u5316\u7ed3\u8bba',
      gaps: [{
        check: 'verifier_protocol', reason: String(error && error.message || error),
        action: '\u91cd\u8bd5\u72ec\u7acb\u590d\u6838\uff0c\u4e0d\u80fd\u6309\u673a\u5668\u5173\u952e\u8bcd\u76f4\u63a5\u901a\u8fc7',
      }],
      review: null, score: null, deterministic,
    };
  }

  const verdict = String(reviewed.verdict || '').toLowerCase();
  const gaps = normalizeGaps(reviewed.gaps);
  const score = scorecard(reviewed, opts.spec);
  if (score && !score.valid && verdict !== 'blocked') {
    return {
      phase: 'blocked', retryable: true, source: 'verifier-protocol',
      reason: '\u72ec\u7acb\u590d\u6838\u7f3a\u5c11\u5b8c\u6574\u8d28\u91cf\u8bc4\u5206\uff1a' + score.missing.join(', '),
      gaps: [{
        check: 'verifier_scores', reason: '\u672a\u8bc4\u5206\u7ef4\u5ea6\uff1a' + score.missing.join(', '),
        action: '\u6309 DeliverySpec \u9010\u9879\u8bc4\u5206\u540e\u91cd\u65b0\u8fd4\u56de\u7ed3\u8bba',
      }],
      score, review: reviewed, deterministic,
    };
  }
  const effectiveVerdict = verdict === 'pass' && score && !score.pass ? 'repair' : verdict;
  const allGaps = normalizeGaps([...gaps, ...((score && score.valid && score.gaps) || [])]);
  if (effectiveVerdict === 'pass') {
    return {
      phase: 'reviewed', retryable: false, source: 'independent-verifier',
      reason: String(reviewed.summary || '\u72ec\u7acb\u590d\u6838\u5df2\u901a\u8fc7'),
      gaps: [], score, review: reviewed, deterministic,
    };
  }
  if (effectiveVerdict === 'blocked') {
    return {
      phase: 'blocked', retryable: false, source: 'independent-verifier',
      reason: String(reviewed.summary || '\u5b58\u5728\u65e0\u6cd5\u81ea\u52a8\u89e3\u9664\u7684\u5916\u90e8\u963b\u65ad'),
      gaps: allGaps, score, review: reviewed, deterministic,
    };
  }
  if (effectiveVerdict === 'repair') {
    return {
      phase: 'blocked', retryable: true, source: 'independent-verifier',
      reason: String(reviewed.summary || (score && !score.pass
        ? '\u4ea4\u4ed8\u8d28\u91cf\u8bc4\u5206\u672a\u8fbe\u5230\u95e8\u69db'
        : '\u4ea4\u4ed8\u4ecd\u6709\u53ef\u4fee\u590d\u7f3a\u53e3')),
      gaps: allGaps, score, review: reviewed, deterministic,
    };
  }
  return {
    phase: 'blocked', retryable: true, source: 'verifier-protocol',
    reason: '\u72ec\u7acb\u590d\u6838\u8fd4\u56de\u4e86\u65e0\u6548 verdict',
    gaps: [{
      check: 'verifier_protocol', reason: 'verdict=' + String(reviewed.verdict || ''),
      action: '\u91cd\u8bd5\u72ec\u7acb\u590d\u6838',
    }],
    review: reviewed, score, deterministic,
  };
}

function fingerprint(result) {
  const gaps = normalizeGaps(result && result.gaps)
    .map((item) => JSON.stringify([item.check, item.reason, item.action]))
    .sort();
  // The count can stay the same while a different command is now failing.
  // Include the concrete repair target and do not truncate later gaps.
  return crypto.createHash('sha256').update(JSON.stringify(gaps)).digest('hex');
}

module.exports = { machine, outcome, fingerprint, _parse: parse, _scorecard: scorecard };
