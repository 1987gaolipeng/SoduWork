'use strict';

const assert = require('node:assert/strict');
const finalizer = require('./goal-finalizer');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write('  PASS  ' + name + '\n');
}

const snapshot = {
  files: [
    { path: 'C:/Users/admin/private/report.docx', relative: '交付/report.docx',
      name: 'report.docx', size: 1200 },
    { path: 'C:/Users/admin/private/debug.log', relative: 'debug.log',
      name: 'debug.log', size: 40 },
  ],
  delivery: {
    items: [{ path: 'C:/Users/admin/private/report.docx', relative: '交付/report.docx',
      name: 'report.docx', title: '正式报告', kind: 'document', summary: '可直接提交' }],
  },
};
const reviewed = {
  phase: 'reviewed',
  reason: '全部验收通过',
  deterministic: { checks: [{ label: '文件校验', reason: '格式有效' }] },
};
const evidence = {
  changedFileCount: 2, deliverableCount: 1, verification: true,
  launch: false, visual: false, failures: 0,
};

check('干净上下文只保留相对成果，不携带本机路径和命令历史', () => {
  const value = finalizer.prompt(
    { goal: '整理月报', acceptance: 'Word 可打开' }, reviewed, evidence, snapshot);
  assert.match(value, /交付\/report\.docx/);
  assert.doesNotMatch(value, /C:\/Users|private|调用 bash|system_warning/);
});

check('结构化结果只允许引用真实交付物', () => {
  const outputs = finalizer.outputItems(snapshot);
  const row = finalizer.normalize({
    title: '月报已完成',
    summary: '月报已经完成交付。',
    deliverables: [
      { name: '月报', path: '交付/report.docx', note: '点击打开' },
      { name: '伪造文件', path: 'secret.txt' },
    ],
    verification: ['Word 文件格式已校验'],
    limitations: [],
  }, outputs);
  assert.deepEqual(row.deliverables.map((item) => item.path), ['交付/report.docx']);
  assert.match(finalizer.render(row), /交付\/report\.docx/);
});

check('质量门禁拒绝内部提示、工具旁白、绝对路径和重复段落', () => {
  const raw = JSON.stringify({
    title: '完成',
    summary: '我调用 bash 查看文件。system_warning C:/Users/admin/x',
    deliverables: [],
    verification: ['同一段验证已经完成而且可以交付。', '同一段验证已经完成而且可以交付。'],
    limitations: [],
  });
  const row = finalizer.normalize(raw, []);
  const gate = finalizer.qualityGate(raw, row, 'completed');
  assert.equal(gate.ok, false);
  assert.match(gate.reasons.join('；'), /内部协议|工具过程|绝对路径|重复/);
  assert.ok(gate.reasons.includes('包含本机绝对路径'));
});

check('确定性回执只依据真实证据，不伪造产物', () => {
  const row = finalizer.fallback(
    { goal: '整理月报', acceptance: 'Word 可打开' }, reviewed, evidence, snapshot);
  assert.equal(row.deliverables.length, 1);
  assert.equal(row.deliverables[0].path, '交付/report.docx');
  assert.match(row.verification.join('；'), /构建或测试|文件校验/);
  assert.doesNotMatch(finalizer.render(row), /C:\/Users/);
});

check('最终回执可从自定义事件恢复', () => {
  const structured = finalizer.fallback(
    { goal: '整理月报' }, reviewed, evidence, snapshot);
  const restored = finalizer.fromEntries([{
    type: 'custom', customType: finalizer.ENTRY_TYPE,
    data: { structured, rendered: finalizer.render(structured), source: 'model' },
  }]);
  assert.equal(restored.source, 'model');
  assert.match(restored.rendered, /整理月报已完成/);
});

check('阻断结果必须说明真实限制，确定性回执不会伪装成功', () => {
  const blocked = { phase: 'blocked', reason: '缺少用户授权，无法进入目标系统', gaps: [] };
  const row = finalizer.fallback({ goal: '提交审批' }, blocked, {}, { delivery: { items: [] } });
  assert.match(row.title, /暂未完成/);
  assert.match(row.limitations.join('；'), /缺少用户授权/);
  const invalid = {
    title: '提交审批暂未完成', summary: '当前无法完成提交。',
    deliverables: [], verification: ['已确认系统需要授权'], limitations: [],
  };
  assert.equal(finalizer.qualityGate(JSON.stringify(invalid), invalid, 'blocked').ok, false);
});

check('不适用的启动与界面检查不能被包装成已执行证据', () => {
  const textOnlyReview = {
    phase: 'reviewed', reason: '文本内容已核验',
    deterministic: { checks: [
      { key: 'verification', label: '可重放验证', pass: true, evidence: [] },
      { key: 'execution_errors', label: '无未解决执行错误', pass: true, evidence: [] },
      { key: 'launch', label: '真实启动与健康探针', pass: true, evidence: [] },
      { key: 'visual', label: '界面与关键旅程实查', pass: true, evidence: [] },
      { key: 'artifact_integrity', label: '交付物格式与内容有效', pass: true,
        evidence: ['deliverable.txt (18 bytes)'] },
    ] },
    review: { evidence: ['已完成真实启动与健康探针', '已完成界面与关键旅程实查'] },
  };
  const textEvidence = {
    changedFileCount: 1, deliverableCount: 1, verification: false,
    launch: false, visual: false, failures: 0,
  };
  const textSnapshot = { delivery: { items: [
    { relative: 'deliverable.txt', name: 'deliverable.txt', kind: 'file' },
  ] } };
  const facts = finalizer.context(
    { goal: '创建文本交付物' }, textOnlyReview, textEvidence, textSnapshot);
  assert.deepEqual(facts.verification.checks,
    ['交付物格式与内容有效：deliverable.txt (18 bytes)']);
  const row = finalizer.fallback(
    { goal: '创建文本交付物' }, textOnlyReview, textEvidence, textSnapshot);
  const rendered = finalizer.render(row);
  assert.doesNotMatch(rendered, /真实启动|健康探针|关键旅程|界面.*实查|可重放验证/);
  assert.match(rendered, /deliverable\.txt \(18 bytes\)/);
});

check('最终回执与真实运行和界面证据必须双向一致', () => {
  const facts = finalizer.context({ goal: '运行验证' }, reviewed,
    { verification: true, launch: true, visual: false }, snapshot);
  const contradicted = {
    title: '运行验证已完成', summary: '已经完成交付。', deliverables: [],
    verification: ['未做构建、运行时探测、启动或界面检查'], limitations: [],
  };
  const falseClaim = {
    title: '运行验证已完成', summary: '已经完成交付。', deliverables: [],
    verification: ['已完成关键界面实查'], limitations: [],
  };
  assert.match(finalizer.qualityGate(JSON.stringify(contradicted), contradicted,
    'completed', facts).reasons.join('；'), /运行探针陈述.*矛盾/);
  assert.match(finalizer.qualityGate(JSON.stringify(falseClaim), falseClaim,
    'completed', facts).reasons.join('；'), /不存在的界面实查/);
});

process.stdout.write('\n  ' + passed + ' 项全过\n');
