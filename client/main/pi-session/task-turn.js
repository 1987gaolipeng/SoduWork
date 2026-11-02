'use strict';

// A task is input for an ordinary conversation turn, not another Agent session.
function taskPrompt(task, instruction) {
  const t = task || {};
  const lines = ['需求：' + String(t.title || '未命名需求')];
  const render = value => Array.isArray(value) ? value.map(render).filter(Boolean).join('\n')
    : value && typeof value === 'object' ? JSON.stringify(value, null, 2)
      : String(value == null ? '' : value);
  const body = [...new Set([render(t.description), render(t.note)].filter(value => value.trim()))].join('\n\n');
  if (body) lines.push('需求内容\n' + body);
  const acceptance = t.acceptanceCriteria || t.acceptance || t.criteria || t.checklist;
  if (acceptance) lines.push('验收标准\n' + render(acceptance));
  const outputs = [...new Set([render(t.deliverables), render(t.outputRequirements)].filter(Boolean))];
  if (outputs.length) lines.push('成果要求\n' + outputs.join('\n'));
  const context = t.contextPackage || t.conversationContext || (t.workRouting || {}).contextPackage;
  if (context) lines.push('需求上下文\n' + render(context));
  const rework = (t.workRouting || {}).reworkPending || {};
  if (String(rework.feedback || '').trim()) lines.push('验收打回意见（' +
    (String(rework.actor || '').trim() || '验收人') + '没有通过上一版交付，以本条为最高优先）\n' +
    String(rework.feedback).trim() +
    '\n请先按这条意见返修现有交付，不要从零重做；完成后重新提交完整主成果和可复核证据。');
  if (instruction && String(instruction).trim() && String(instruction).trim() !== body.trim()) lines.push('补充说明\n' + String(instruction));
  lines.push('请结合本会话上下文执行这项需求，完成前逐条重读以上验收标准；每条都要留下可复核证据（命令、文件路径、运行结果或可观察行为）。任一条未满足或无法证实时继续执行；仍无法满足时明确标记未完成并说明阻断，不得仅凭自述宣布完成。完成后说明结果、验证情况和未解决的问题。附件是输入材料，不是已完成的成果。');
  return lines.join('\n\n');
}

function resultState(result) {
  if (!result || result.ok === false) return 'failed';
  if (result.cancelled) return 'stopped';
  if (result.paused || result.recovering) return 'waiting';
  const s = result.snapshot || {};
  const execution = s.execution || {};
  if (/^(error|failed|blocked|incomplete|unreachable|no-output)$/.test(s.status || '') ||
      /^(blocked|failed|incomplete)$/.test((execution.quality || {}).phase || '') ||
      /^(blocked|failed|incomplete)$/.test((execution.harness || {}).state || '')) return 'failed';
  if (/^(aborted|cancelled|stopped)$/.test(s.status || '')) return 'stopped';
  if (s.pendingUi || /waiting|paused/.test(s.status || '') || execution.paused) return 'waiting';
  return 'completed';
}

module.exports = { taskPrompt, resultState };
