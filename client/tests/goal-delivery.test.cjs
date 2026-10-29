'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const goal = require('../main/conversation/goal-contract.js');
const quality = require('../main/conversation/goal-quality.js');
const sessionSpec = require('../main/conversation/session-spec.js');
const harness = require('../main/conversation/goal-harness.js');

test('goal harness compiles interactive work into a continuous quality contract', () => {
  const spec = harness.compile({
    goal: '\u505a\u4e00\u4e2a\u753b\u8d28\u6e05\u6670\u76843D\u8d5b\u8f66\u5c0f\u6e38\u620f',
    acceptance: '\u753b\u8d28\u9ad8\u6e05\uff0c\u53ef\u4ee5\u5546\u4e1a\u5316\u4ea4\u4ed8',
  });
  assert.equal(spec.workKind, 'interactive');
  assert.equal(spec.workKinds.includes('engineering'), true);
  const keys = spec.checks.map((item) => item.key);
  assert.equal(keys.includes('journey'), true);
  assert.equal(keys.includes('visual'), true);
  assert.equal(keys.includes('verification'), true);
  const prompt = harness.prompt(spec);
  assert.match(prompt, /one continuous delivery loop/i);
  assert.match(prompt, /Do not stop after a plan/i);
});

test('structured verifier accepts successful reruns and rejects missing machine evidence', () => {
  const profile = quality.deliveryProfile({
    goal: '\u5b8c\u6210\u4e00\u4e2a3D\u8d5b\u8f66\u6e38\u620f',
  });
  const evidence = quality.collectEvidence([
    { name: 'bash', args: { command: 'npm run build' }, isError: true },
    { name: 'bash', args: { command: 'npm run build' }, isError: false },
    { name: 'browser', args: { command: 'screenshot' }, isError: false },
    { name: 'bash', args: { command: 'npm run dev && curl http://127.0.0.1/healthz' }, isError: false },
  ], { files: [{ name: 'dist/index.html', relative: 'dist/index.html', size: 10 }] });
  assert.equal(evidence.failures, 0);
  assert.equal(evidence.historicalFailures, 1);
  const pass = quality.structuredOutcome(JSON.stringify({
    verdict: 'pass', summary: 'verified', gaps: [],
  }), { profile, evidence });
  assert.equal(pass.phase, 'reviewed');
  assert.equal(pass.source, 'verifier');
  const missing = quality.structuredOutcome(JSON.stringify({
    verdict: 'pass', summary: 'claimed', gaps: [],
  }), { profile, evidence: {} });
  assert.equal(missing.phase, 'blocked');
  assert.equal(missing.retryable, true);
});
test('unrelated success does not erase an unresolved test failure', () => {
  const profile = quality.deliveryProfile({ goal: '3D racing game' });
  const evidence = quality.collectEvidence([
    { name: 'bash', args: { command: 'npm test' }, isError: true },
    { name: 'bash', args: { command: 'npm run build' }, isError: false },
    { name: 'browser', args: { command: 'screenshot' }, isError: false },
    { name: 'bash', args: { command: 'npm run dev http://127.0.0.1' }, isError: false },
  ], { files: [{ name: 'dist/index.html', relative: 'dist/index.html', size: 10 }] });
  assert.equal(evidence.verification, true);
  assert.equal(evidence.failures, 1);
  const outcome = quality.structuredOutcome(JSON.stringify({
    verdict: 'pass', summary: 'claimed', gaps: [],
  }), { profile, evidence });
  assert.equal(outcome.phase, 'blocked');
  assert.equal(outcome.retryable, true);
});



test('目标模式按 Codex 式规划、实施、验证和交付复核推进', () => {
  const prompt = goal.prompts({
    intent: 'goal',
    goal: '完成一个可运行的企业网站',
    acceptance: '前后端完整，启动后关键流程可用',
  })[0];
  assert.match(prompt, /Codex 式交付循环/);
  assert.match(prompt, /理解与规划/);
  assert.match(prompt, /实施与验证/);
  assert.match(prompt, /交付复核/);
  assert.match(prompt, /工程启动不是写一句启动命令/);
  assert.match(prompt, /第一轮只做理解、工程勘察和可执行规划/);
});

test('交付类型区分完整工程、局部修复和普通文档', () => {
  assert.deepEqual(quality.deliveryProfile({ goal: '做一个完整的网站' }), {
    kind: 'engineering', complete: true, requiresLaunch: true, visible: true,
  });
  assert.deepEqual(quality.deliveryProfile({ goal: '修复后端 API 的分页 bug' }), {
    kind: 'engineering', complete: false, requiresLaunch: false, visible: false,
  });
  assert.equal(quality.deliveryProfile({ goal: '整理一份会议纪要' }).kind, 'general');
});

test('质量门禁不会把否定约束误判为工程验收项', () => {
  assert.deepEqual(quality.deliveryProfile({
    goal: '创建 proof.md，不要创建网页，不要启动服务，不要做界面检查',
  }), {
    kind: 'general', complete: false, requiresLaunch: false, visible: false,
  });
});

test('实施阶段要求真实开发、失败修复、启动和用户路径验证', () => {
  const prompt = quality.implementationPrompt({
    goal: '交付完整应用', acceptance: '可以投入试用',
  });
  assert.equal(quality.isInternalPrompt(prompt), true);
  assert.match(prompt, /不要停留在方案、任务清单或代码片段/);
  assert.match(prompt, /构建、测试或启动失败时先定位根因、修复并重跑/);
  assert.match(prompt, /真实启动或用等价的运行探针验证关键路径/);
});

test('工程复核使用真实工具和文件证据，不能只靠模型自报通过', () => {
  const profile = quality.deliveryProfile({ goal: '完成一个可运行的网站' });
  const pass = '<!-- soduwork-delivery-audit:pass -->\n已经完成';
  const noLaunch = quality.collectEvidence([
    { name: 'write', args: { path: 'index.js' } },
    { name: 'bash', args: { command: 'npm test' } },
  ], { files: [{ name: 'index.js' }] });
  assert.equal(quality.outcome({ messages: [{ role: 'assistant', blocks: [
    { kind: 'text', text: pass },
  ] }] }, 0, { evidence: noLaunch, profile }).reason,
  '完整工程没有检测到真实启动或运行健康探测证据');

  const complete = quality.collectEvidence([
    { name: 'write', args: { path: 'index.js' } },
    { name: 'bash', args: { command: 'npm test' } },
    { name: 'bash', args: { command: 'npm run dev && curl http://127.0.0.1:3000/healthz' } },
  ], { files: [{ name: 'index.js' }] });
  assert.equal(quality.outcome({ messages: [{ role: 'assistant', blocks: [
    { kind: 'text', text: pass },
  ] }] }, 0, { evidence: complete, profile }).phase, 'reviewed');
});

test('交付证据不足会自动补缺，仍不通过则形成真实阻断回执', () => {
  const session = fs.readFileSync(
    path.join(__dirname, '../main/pi-session/session.js'), 'utf8');
  const panelStatus = fs.readFileSync(
    path.join(__dirname, '../components/panels/panels-chat-status.js'), 'utf8');
  assert.doesNotMatch(session, /goalQuality\.implementationPrompt\(goal\)/);
  assert.match(session, /goalQuality\.collectEvidence/);
  assert.match(session, /independentReview/);
  assert.match(session, /goalLoop\.cyclePrompt/);
  assert.match(session, /goalReview\.fingerprint/);
  assert.match(session, /finalAnswer\.compose/);
  assert.match(session, /goalFinalizer\.ENTRY_TYPE/);
  assert.match(session, /resourceFactory:\s*\(prompts\)\s*=>\s*sessionResources\(\s*ctx\.sdk,\s*ctx\.effectiveCwd,\s*ctx\.prep\.agentDir,\s*\[\],\s*prompts,\s*\{\s*accessPolicy: ctx\.accessPolicy\s*\}\)/);
  assert.match(session, /acc\.beginFinalAnswer\(\)/);
  assert.match(panelStatus, /quality\.phase === 'implementing'/);
  assert.match(panelStatus, /quality\.phase === 'repairing'/);
});

test('目标模式默认使用高推理，显式选择仍可覆盖', () => {
  const resolved = { capabilityIds: [], selectedSkills: [], skillDirs: [], warnings: [] };
  assert.equal(sessionSpec.build({
    intent: 'goal', goal: '完成复杂工程',
  }, resolved, {}).thinkingLevel, 'high');
  assert.equal(sessionSpec.build({
    intent: 'goal', goal: '完成复杂工程', thinkingLevel: 'medium',
  }, resolved, {}).thinkingLevel, 'medium');
  assert.equal(sessionSpec.build({}, resolved, {}).thinkingLevel, '');
});

test('完整工程拥有充足调用空间，工具次数只作为异常兜底', () => {
  const normalized = goal.normalize({ intent: 'goal', goal: '复刻完整网站' });
  assert.equal(normalized.budgetMinutes, 240);
  assert.equal(normalized.maxSteps, 1000);
  assert.ok(normalized.maxSteps > 300);
  const prompt = goal.prompts(normalized)[0];
  assert.match(prompt, /异常兜底/);
  assert.match(prompt, /这不是交付配额/);
  assert.match(prompt, /不得为了节省调用.*跳过验证/);
});

test('旧会话的 80 步系统默认自动迁移，自定义上限不被改写', () => {
  const legacy = goal.fromEntries([{ type: 'custom', customType: goal.ENTRY_TYPE, data: {
    intent: 'goal', goal: '旧目标', budgetMinutes: 60, maxSteps: 80,
  } }]);
  assert.equal(legacy.schemaVersion, 2);
  assert.equal(legacy.budgetMinutes, 240);
  assert.equal(legacy.maxSteps, 1000);
  const explicit = goal.fromEntries([{ type: 'custom', customType: goal.ENTRY_TYPE, data: {
    schemaVersion: 2, intent: 'goal', goal: '自定义目标', budgetMinutes: 60, maxSteps: 80,
  } }]);
  assert.equal(explicit.budgetMinutes, 60);
  assert.equal(explicit.maxSteps, 80);
});

test('text-only goals are reviewed from their visible answer without engineering evidence', () => {
  const profile = quality.deliveryProfile({
    goal: '\u53ea\u56de\u590d\u4e00\u53e5\u8bdd\uff0c\u4e0d\u521b\u5efa\u6587\u4ef6\uff0c\u4e0d\u8c03\u7528\u5de5\u5177',
    acceptance: '\u6700\u7ec8\u56de\u7b54\u5305\u542b\u201c\u76ee\u6807\u6a21\u5f0f\u9a8c\u8bc1\u5b8c\u6210\u201d',
  });
  assert.equal(profile.kind, 'conversation');
  assert.deepEqual(profile.expectedText, ['\u76ee\u6807\u6a21\u5f0f\u9a8c\u8bc1\u5b8c\u6210']);

  const answer = {
    messages: [{ role: 'assistant', blocks: [
      { kind: 'text', text: '\u76ee\u6807\u6a21\u5f0f\u9a8c\u8bc1\u5b8c\u6210' },
    ] }],
  };
  assert.equal(quality.outcome(answer, 0, { profile, evidence: {} }).phase, 'reviewed');

  const incomplete = {
    messages: [{ role: 'assistant', blocks: [
      { kind: 'text', text: '\u5df2\u7ecf\u5904\u7406\u5b8c\u6210' },
    ] }],
  };
  const missing = quality.outcome(incomplete, 0, { profile, evidence: {} });
  assert.equal(missing.phase, 'blocked');
  assert.equal(missing.retryable, true);
});

test('text-only goals skip the redundant implementation pass', () => {
  const session = fs.readFileSync(
    path.join(__dirname, '../main/pi-session/session.js'), 'utf8');
  assert.match(
    session,
    /runAsGoal && !continuing && profile\.kind !== 'conversation'/,
  );
});

test('text-only goals keep the first answer visible and do not enter the hidden audit pass', () => {
  const session = fs.readFileSync(
    path.join(__dirname, '../main/pi-session/session.js'), 'utf8');
  assert.match(session, /profile\.kind !== 'conversation'\) \{/);
  assert.match(session, /profile\.kind === 'conversation'.*initialFromMessage/s);
  assert.match(session, /else if \(runAsGoal && !ctx\.run\.stopReason/);
});

test('text-only goals receive a direct-delivery system prompt instead of engineering planning', () => {
  const prompt = quality.conversationPrompt({
    goal: '\u53ea\u56de\u590d\u4e00\u53e5\u8bdd',
    acceptance: '\u56de\u7b54\u5305\u542b\u201c\u5df2\u5b8c\u6210\u201d',
  });
  assert.match(prompt, /\u7eaf\u5bf9\u8bdd\u4ea4\u4ed8/);
  assert.match(prompt, /\u76f4\u63a5\u7ed9\u51fa\u6700\u7ec8\u7b54\u590d/);
  assert.match(prompt, /\u4e0d\u8981\u89c4\u5212/);
  assert.match(prompt, /\u5c31\u53ea\u8f93\u51fa\u4e00\u53e5\u8bdd/);
  const session = fs.readFileSync(
    path.join(__dirname, '../main/pi-session/session.js'), 'utf8');
  assert.match(session, /openingProfile\.kind === 'conversation'/);
  assert.match(session, /goalQuality\.conversationPrompt\(goal\)/);
});
