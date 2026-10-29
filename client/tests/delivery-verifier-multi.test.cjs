'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const harness = require('../main/conversation/goal-harness.js');
const quality = require('../main/conversation/goal-quality.js');
const verifier = require('../main/conversation/goal-verifier.js');
const delivery = require('../main/conversation/delivery-contract.js');

function file(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  const stat = fs.statSync(target);
  return { path: target, relative: relative.replace(/\\/g, '/'), name: path.basename(target), size: stat.size, at: stat.mtimeMs };
}

test('a pure repository delivery is verified from code and runtime evidence without a fake archive', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-repository-'));
  try {
    const changed = file(root, 'src/server.js', 'module.exports = { healthy: true };');
    const goal = { goal: '\u5b8c\u6574\u4fee\u590d\u670d\u52a1\u7aef\u5de5\u7a0b\u5e76\u4ea4\u4ed8\u4ee3\u7801' };
    const spec = harness.compile(goal);
    const snapshot = { files: [changed], truncated: false,
      delivery: delivery.classify(root, [changed]) };
    const result = verifier.verify({
      cwd: root, spec, profile: quality.deliveryProfile(goal), snapshot,
      outputSnapshot: snapshot,
      evidence: { mutation: true, verification: true, launch: true, visual: false, failures: 0 },
    });
    assert.equal(result.pass, true, JSON.stringify(result.gaps));
    assert.equal(result.checks.some((item) => item.key === 'delivery_manifest'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a multi-artifact request requires every user-consumable result type', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-multi-artifact-'));
  try {
    const html = file(root, 'site/index.html', '<!doctype html><main>ready</main>');
    file(root, '.soduwork/delivery.json', JSON.stringify({
      schemaVersion: 1,
      deliverables: [{ path: 'site/index.html', kind: 'website', title: 'Site' }],
    }));
    const goal = { goal: '\u5236\u4f5c\u4e00\u4efd Word \u4ea7\u54c1\u8bf4\u660e\u548c\u4e00\u4e2a\u5b98\u7f51' };
    const spec = harness.compile(goal);
    const snapshot = { files: [html], truncated: false,
      delivery: delivery.classify(root, [html]) };
    const result = verifier.verify({
      cwd: root, spec, profile: quality.deliveryProfile(goal), outputSnapshot: snapshot,
      evidence: { mutation: true, verification: true, launch: false, visual: true, failures: 0 },
    });
    assert.equal(result.pass, false);
    const type = result.checks.find((item) => item.key === 'delivery_type');
    assert.equal(type.pass, false);
    assert.match(type.reason, /document/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
