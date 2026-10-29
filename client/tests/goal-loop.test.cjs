'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const os = require('node:os');
const path = require('node:path');
const loop = require('../main/conversation/goal-loop.js');
const verifier = require('../main/conversation/goal-verifier.js');
const review = require('../main/conversation/goal-review.js');
const quality = require('../main/conversation/goal-quality.js');
const delivery = require('../main/conversation/delivery-contract.js');

function event(type, payload, id) {
  return loop.event(type, payload || {}, id || type, 1000);
}

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function snapshot(root, relatives) {
  const files = relatives.map((relative) => {
    const target = path.join(root, relative);
    const stat = fs.statSync(target);
    return {
      path: target,
      relative: relative.replace(/\\/g, '/'),
      name: path.basename(relative),
      size: stat.size,
      at: Math.round(stat.mtimeMs),
    };
  });
  return { files, truncated: false, delivery: delivery.classify(root, files) };
}

function completeWebsite(root) {
  write(root, 'site/index.html', [
    '<!doctype html><html><head>',
    '<link rel="stylesheet" href="./styles.css">',
    '</head><body><main id="app">Ready</main>',
    '<script type="module" src="./app.js"></script>',
    '</body></html>',
  ].join(''));
  write(root, 'site/styles.css', 'body{font-family:sans-serif}');
  write(root, 'site/app.js', 'document.querySelector("#app").dataset.ready="1";');
  write(root, '.soduwork/delivery.json', JSON.stringify({
    schemaVersion: 1,
    summary: 'ready',
    runtime: { networkPolicy: 'offline', externalDependencies: [] },
    deliverables: [{
      path: 'site/index.html', kind: 'website', title: 'Website', primary: true,
    }],
  }));
}

function websiteOptions(root) {
  return {
    cwd: root,
    profile: quality.deliveryProfile({ goal: '\u505a\u4e00\u4e2a\u5b8c\u6574\u7684\u7f51\u7ad9' }),
    spec: loop.compile({ goal: '\u505a\u4e00\u4e2a\u5b8c\u6574\u7684\u7f51\u7ad9' }),
    evidence: {
      mutation: true, verification: true, launch: true, visual: true, failures: 0,
    },
    outputSnapshot: snapshot(root, [
      'site/index.html', 'site/styles.css', 'site/app.js',
    ]),
  };
}

test('native loop checkpoints are idempotent and survive pause/resume', () => {
  let state = loop.compile({
    goal: 'Build a complete website',
    acceptance: 'Loads; keyboard works',
  });
  state = loop.reduce(state, event('run.started', { reason: 'inspect' }, 'e1'));
  state = loop.reduce(state, event('plan.ready', { reason: 'ledger' }, 'e2'));
  state = loop.reduce(state, event('action.started', { reason: 'act', toolCount: 7 }, 'e3'));
  assert.equal(state.iteration, 1);
  assert.equal(state.progress.at(-1).toolCount, 7);
  const revision = state.revision;
  state = loop.reduce(state, event('action.started', { reason: 'duplicate' }, 'e3'));
  assert.equal(state.revision, revision);
  assert.equal(state.iteration, 1);

  state = loop.reduce(state, event('run.paused', {
    kind: 'steps', reason: 'limit', used: 1000, limit: 1000, unit: 'steps',
  }, 'e4'));
  const restored = loop.fromEntries([
    { type: 'custom', customType: loop.ENTRY_TYPE, data: state },
  ]);
  assert.equal(restored.state, 'paused');
  assert.deepEqual(restored.pause, {
    kind: 'steps', reason: 'limit', used: 1000, limit: 1000, unit: 'steps',
  });
  const resumed = loop.reduce(restored, event('run.resumed', { reason: 'go' }, 'e5'));
  assert.equal(resumed.state, 'running');
  assert.equal(resumed.node, 'act');
  assert.equal(resumed.pause, null);
});

test('native loop replans repeated failures and records a verified terminal state', () => {
  let state = loop.compile({ goal: 'Build a complete website' });
  state = loop.reduce(state, event('action.started', {}, 'a1'));
  state = loop.reduce(state, event('verification.failed', {
    reason: 'missing asset', decision: 'retry',
    checks: [{ key: 'build', pass: false, reason: 'missing asset' }],
  }, 'a2'));
  assert.equal(state.state, 'retrying');
  assert.equal(state.decision, 'retry');
  state = loop.reduce(state, event('replan.requested', { reason: 'change path' }, 'a3'));
  assert.equal(state.node, 'plan');
  assert.equal(state.decision, 'replan');
  state = loop.reduce(state, event('verification.passed', {
    checks: [{ key: 'build', pass: true, evidence: ['npm test'] }],
  }, 'a4'));
  state = loop.reduce(state, event('run.completed', { reason: 'verified' }, 'a5'));
  assert.equal(state.state, 'completed');
  assert.equal(state.tasks.every((item) => !item.required || item.status === 'completed'), true);
  assert.equal(state.progress.at(-1).type, 'run.completed');
});

test('autonomous repair prompt is an internal control message, not a user turn', () => {
  const prompt = loop.cyclePrompt(loop.compile({ goal: 'Build a complete website' }), {
    reason: 'missing interaction', gaps: [{ check: 'journey', reason: 'button is inert' }],
  });
  assert.equal(loop.isInternalPrompt(prompt), true);
  assert.equal(loop.isInternalPrompt('Please explain <soduwork-internal-loop-cycle>'), false);
  assert.equal(loop.isInternalPrompt('<soduwork-internal-loop-cycle>partial'), false);
  assert.match(prompt, /It is not a new user request/);
});

test('a self-contained declared website passes deterministic delivery gates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-loop-site-'));
  try {
    completeWebsite(root);
    const result = verifier.verify(websiteOptions(root));
    assert.equal(result.pass, true, JSON.stringify(result.gaps));
    assert.equal(result.delivery.source, 'manifest');
    assert.deepEqual(result.delivery.items.map((item) => item.kind), ['website']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an undeclared CDN runtime dependency cannot masquerade as a complete website', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-loop-cdn-'));
  try {
    completeWebsite(root);
    write(root, 'site/app.js',
      'import * as THREE from "https://cdn.jsdelivr.net/npm/three/build/three.module.js";');
    const result = verifier.verify(websiteOptions(root));
    assert.equal(result.pass, false);
    const row = result.checks.find((item) => item.key === 'website_package_1');
    assert.equal(row.pass, false);
    assert.match(row.reason, /cdn\.jsdelivr\.net/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a missing local runtime asset fails even when the model claims completion', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-loop-missing-'));
  try {
    completeWebsite(root);
    write(root, 'site/index.html',
      '<!doctype html><script type="module" src="./missing.js"></script>');
    const deterministic = verifier.verify(websiteOptions(root));
    const outcome = review.outcome(JSON.stringify({
      verdict: 'pass', summary: 'looks good', gaps: [],
    }), { deterministic });
    assert.equal(deterministic.pass, false);
    assert.equal(outcome.phase, 'blocked');
    assert.equal(outcome.source, 'deterministic-verifier');
    assert.match(outcome.reason, /missing\.js/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('artifact goals require the right declared result type and real file format', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-loop-deck-'));
  try {
    write(root, 'deck.pptx', 'this is not an office file');
    write(root, '.soduwork/delivery.json', JSON.stringify({
      schemaVersion: 1,
      deliverables: [{ path: 'deck.pptx', kind: 'presentation', title: 'Deck' }],
    }));
    const outputSnapshot = snapshot(root, ['deck.pptx']);
    const result = verifier.verify({
      cwd: root,
      profile: quality.deliveryProfile({ goal: '\u5236\u4f5c\u4e00\u4efd PPT' }),
      spec: loop.compile({ goal: '\u5236\u4f5c\u4e00\u4efd PPT' }),
      evidence: { failures: 0 },
      outputSnapshot,
    });
    assert.equal(result.pass, false);
    assert.equal(result.checks.find((item) => item.key === 'delivery_type').pass, true);
    assert.equal(result.checks.find((item) => item.key === 'artifact_integrity').pass, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('invalid verifier output is never downgraded to a machine pass', () => {
  const deterministic = { pass: true, checks: [], gaps: [], summary: 'ok' };
  const malformed = review.outcome('I think it is complete', { deterministic });
  assert.equal(malformed.phase, 'blocked');
  assert.equal(malformed.source, 'verifier-protocol');
  assert.equal(malformed.retryable, true);
  const valid = review.outcome(JSON.stringify({
    verdict: 'pass', summary: 'verified', gaps: [],
  }), { deterministic });
  assert.equal(valid.phase, 'reviewed');
});

test('loop runtime adds no third-party framework dependency', () => {
  const root = path.join(__dirname, '../main/conversation');
  const source = ['goal-loop.js', 'goal-verifier.js', 'goal-review.js']
    .map((name) => fs.readFileSync(path.join(root, name), 'utf8')).join('\n');
  assert.doesNotMatch(source, /require\(['"](?:@?langgraph|autogen|openhands|magentic)/i);
});

test('resuming a terminal loop cannot inject the opening harness again', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../main/pi-session/session.js'), 'utf8');
  assert.match(source, /restoredLoop = goalLoop\.fromEntries\(entries, goal\)/);
  assert.match(source,
    /restoredLoop && \['completed', 'blocked'\]\.includes\(restoredLoop\.state\)/);
  assert.match(source,
    /restoredLoop \|\| goalLoop\.fromEntries\(piSession\.sessionManager\.getEntries\(\), goal\)/);
});
