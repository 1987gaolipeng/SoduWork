'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const delivery = require('../main/conversation/delivery-contract.js');
const harness = require('../main/conversation/goal-harness.js');

function file(root, relative, size, at) {
  return {
    path: path.join(root, relative),
    relative: relative.replace(/\\/g, '/'),
    name: path.basename(relative),
    size: size || 10,
    at: at || 1,
  };
}

test('fallback delivery keeps final documents and one website entry, not project internals', () => {
  const root = path.join(os.tmpdir(), 'soduwork-delivery-contract');
  const files = [
    file(root, 'src/app.js', 20, 4),
    file(root, 'site/styles.css', 20, 4),
    file(root, 'site/about.html', 20, 3),
    file(root, 'site/index.html', 20, 2),
    file(root, 'package.json', 20, 5),
    file(root, 'code-review.json', 20, 6),
    file(root, 'test-screenshot.png', 20, 7),
    file(root, '04-command-output.png', 20, 7),
    file(root, 'final-report.docx', 20, 8),
    file(root, 'launch-demo.mp4', 20, 9),
  ];
  const result = delivery.infer(files);
  assert.deepEqual(result.items.map((item) => item.kind).sort(), ['document', 'video', 'website']);
  assert.equal(result.items.find((item) => item.kind === 'website').relative, 'site/index.html');
  assert.match(result.items.find((item) => item.kind === 'website').artifactId, /^art_[a-f0-9]{24}$/);
  assert.deepEqual(result.items.find((item) => item.kind === 'website').actions,
    ['preview', 'open', 'reveal']);
  assert.deepEqual(result.items.find((item) => item.kind === 'video').actions,
    ['preview', 'open', 'reveal']);
  assert.equal(result.items.some((item) => item.name === 'package.json'), false);
  assert.equal(result.items.some((item) => item.name === '04-command-output.png'), false);
});

test('a website changed in the active turn wins over a stale built website', () => {
  const root = path.join(os.tmpdir(), 'soduwork-delivery-current-turn');
  const stale = { ...file(root, 'old-site/dist/index.html', 20, 20), changedInTurn: false };
  const current = { ...file(root, 'new-site/index.html', 20, 10), changedInTurn: true };
  const result = delivery.infer([stale, current]);
  assert.equal(result.items.find((item) => item.kind === 'website').relative,
    'new-site/index.html');
});

test('fallback recognizes Chinese result names and excludes process evidence', () => {
  const root = path.join(os.tmpdir(), 'soduwork-delivery-chinese');
  const result = delivery.infer([
    file(root, '\u6700\u7ec8\u4ea7\u54c1\u65b9\u6848.md', 20, 9),
    file(root, '\u4ea7\u54c1\u65b9\u6848\u8349\u7a3f.md', 20, 8),
    file(root, '\u9a8c\u6536\u6d4b\u8bd5\u622a\u56fe.png', 20, 7),
  ]);
  assert.deepEqual(result.items.map((item) => item.name),
    ['\u6700\u7ec8\u4ea7\u54c1\u65b9\u6848.md']);
});

test('explicit manifest is authoritative and rejects workspace escapes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-manifest-'));
  try {
    fs.mkdirSync(path.join(root, '.soduwork'), { recursive: true });
    fs.writeFileSync(path.join(root, 'deck.pptx'), 'ppt');
    fs.writeFileSync(path.join(root, '.soduwork', 'delivery.json'), JSON.stringify({
      schemaVersion: 1,
      summary: 'Ready',
      deliverables: [
        { path: 'deck.pptx', kind: 'presentation', title: 'Quarterly deck' },
        { path: '../secret.txt', kind: 'file', title: 'No' },
      ],
    }));
    const result = delivery.classify(root, [file(root, 'deck.pptx', 3, 2)]);
    assert.equal(result.source, 'manifest');
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].title, 'Quarterly deck');
    assert.equal(result.warnings.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('generic manifest kind keeps the real known document format', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-manifest-kind-'));
  try {
    fs.mkdirSync(path.join(root, '.soduwork'), { recursive: true });
    fs.writeFileSync(path.join(root, 'proof.md'), 'SODUWORK_FINAL_GATE_OK');
    fs.writeFileSync(path.join(root, '.soduwork', 'delivery.json'), JSON.stringify({
      schemaVersion: 1,
      deliverables: [{ path: 'proof.md', kind: 'file', title: 'proof.md' }],
    }));
    const result = delivery.classify(root, [file(root, 'proof.md', 18, 2)]);
    assert.equal(result.items[0].kind, 'document');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('goal harness persists phase progress and acceptance criteria', () => {
  const initial = harness.compile({
    goal: 'Build a complete website',
    acceptance: 'Loads; keyboard works',
  });
  assert.equal(initial.workKind, 'website');
  assert.deepEqual(initial.criteria, ['Loads', 'keyboard works']);
  const verified = harness.advance(initial, 'verify', 'running', 'checking');
  assert.deepEqual(verified.phases.map((item) => item.state),
    ['completed', 'completed', 'completed', 'running', 'pending']);
  const restored = harness.fromEntries([
    { type: 'custom', customType: harness.ENTRY_TYPE, data: verified },
  ]);
  assert.equal(restored.phase, 'verify');
});

test('engineering work defaults to a summary while explicit standalone results remain available', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-code-result-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    const files = ['index.html', 'README.md', 'docs/changes.md', 'src/app.js'].map(name => file(root, name));
    assert.deepEqual(delivery.classify(root, files).items, []);
    fs.mkdirSync(path.join(root, '.soduwork'));
    fs.writeFileSync(path.join(root, 'report.md'), '# Analysis');
    fs.writeFileSync(path.join(root, '.soduwork/delivery.json'), JSON.stringify({schemaVersion: 1, deliverables: [{path:'report.md'}]}));
    assert.equal(delivery.classify(root, [...files, file(root,'report.md')]).items[0].name, 'report.md');
    fs.writeFileSync(path.join(root, '.soduwork/delivery.json'), JSON.stringify({schemaVersion:1,presentation:'summary',summary:'Fixed and verified',deliverables:[]}));
    const summary = delivery.classify(root, [...files, file(root,'report.md')]);
    assert.equal(summary.presentation, 'summary');
    assert.equal(summary.summary, 'Fixed and verified');
    assert.deepEqual(summary.items, []);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('single standalone HTML and ordinary documents do not require a manifest', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-final-file-'));
  try {
    const result=delivery.classify(root,[file(root,'demo.html'),file(root,'proposal.md')]);
    assert.deepEqual(result.items.map(f=>f.kind).sort(),['document','website']);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('website images require delivery intent; standalone image results remain deliverables',()=>{
  const root=path.join(os.tmpdir(),'delivery-images');
  const page=file(root,'index.html'),image=file(root,'final-hero.png');
  assert.deepEqual(delivery.infer([page,image]).items.map(row=>row.name),['index.html']);
  assert.deepEqual(delivery.infer([image]).items.map(row=>row.name),['final-hero.png']);
});
