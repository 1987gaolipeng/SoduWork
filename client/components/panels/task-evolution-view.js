/*
 * Share feedback and controlled improvement across task surfaces. Accepting a suggestion
 * records a decision; applying it requires a new immutable plugin version with preflight
 * checks and approval.
 */
(function () {
  'use strict';

  const OUTCOME = { achieved: '达到预期', partial: '部分达到', missed: '没有达到' };
  const STATE = {
    not_ready: '等待交付', awaiting_evaluation: '等待评价', awaiting_decision: '等待决定',
    evaluated: '已沉淀', adopted: '已采纳', applied: '已进入新版本',
  };
  const PROPOSAL_STATE = {
    pending: '待审议', accepted: '已采纳', rejected: '未采纳', applied: '已应用',
  };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function evaluationHtml(item) {
    if (!item) return '';
    const facts = [item.summary, item.workedWell, item.improvement, item.reusableLesson].filter(Boolean);
    return '<article class="tev-evaluation"><header><div><span>本次评价</span><b>' +
      esc(OUTCOME[item.outcome] || item.outcome) + '</b></div><em>' + esc(item.score || '—') + ' / 5</em></header>' +
      (facts.length ? '<ul>' + facts.map((text, index) => '<li><i></i><span>' +
        esc(text) + '</span>' + (index === 3 ? '<small>可复用经验</small>' : '') + '</li>').join('') + '</ul>' :
        '<p>已记录结果判断；还可以补充做得好的地方和下次改进点。</p>') +
      '<footer>' + esc([item.evaluatorName, item.revision > 1 ? '第 ' + item.revision + ' 版' : ''].filter(Boolean).join(' · ')) +
      '</footer></article>';
  }

  function proposalHtml(item, evolution) {
    if (!item) return '';
    const canReview = !!((evolution.access || {}).canReview) && item.state === 'pending';
    let next = '这条建议保留在需求审计中。';
    if (item.state === 'pending') next = '需要人决定是否进入企业改进队列。';
    if (item.state === 'accepted') next = '等待插件工坊形成并预检新版本；当前流程不会改变。';
    if (item.state === 'applied') next = '已关联通过审查的新版本，完整来源仍可追溯。';
    return '<article class="tev-proposal is-' + esc(item.state) + '"><header><div><span>' +
      esc(item.targetKind === 'workflow' ? '工作流改进建议' : '复用经验建议') + "</span><b" + (item.title ? ' data-user-content' : '') + '>' +
      esc(item.title || '改进建议') + '</b></div><em>' + esc(PROPOSAL_STATE[item.state] || item.state) +
      '</em></header><dl><div><dt>为什么</dt><dd>' + esc(item.problem || '来自本次需求评价') +
      '</dd></div><div><dt>建议怎么改</dt><dd>' + esc(item.proposal || '待补充') + '</dd></div></dl>' +
      '<p class="tev-next">' + esc(next) + '</p>' +
      (canReview ? '<div class="tev-decisions"><button class="is-primary" data-tev-decision="accepted">采纳为改进项</button>' +
        '<button data-tev-reject-open>不采纳</button></div><form class="tev-reject" data-tev-reject-form hidden>' +
        '<input maxlength="500" placeholder="说明原因（可选）"><button type="submit">确认不采纳</button>' +
        '<button type="button" data-tev-reject-cancel>取消</button></form>' : '') + '</article>';
  }

  function formHtml(item) {
    item = item || {};
    const selected = item.outcome || 'achieved';
    return '<form class="tev-form" data-tev-form hidden><fieldset><legend>这次结果怎么样</legend><div class="tev-outcomes">' +
      Object.keys(OUTCOME).map((key) => '<label><input type="radio" name="outcome" value="' + key + '"' +
        (key === selected ? ' checked' : '') + '><span>' + OUTCOME[key] + '</span></label>').join('') +
      '</div></fieldset><label class="tev-field"><span>一句话复盘</span><textarea name="summary" maxlength="2000" rows="2" ' +
      'placeholder="结果是否符合预期？最重要的原因是什么？">' + esc(item.summary || '') + '</textarea></label>' +
      '<details class="tev-more"><summary>补充更具体的经验 <span>可选</span></summary><div>' +
      '<label class="tev-field"><span>做得好的</span><textarea name="workedWell" maxlength="4000" rows="2">' +
      esc(item.workedWell || '') + '</textarea></label><label class="tev-field"><span>下次改进</span>' +
      '<textarea name="improvement" maxlength="4000" rows="2">' + esc(item.improvement || '') + '</textarea></label>' +
      '<label class="tev-field"><span>可复用经验</span><textarea name="reusableLesson" maxlength="4000" rows="2">' +
      esc(item.reusableLesson || '') + '</textarea></label></div></details>' +
      '<label class="tev-check"><input type="checkbox" name="createProposal" checked><span>把这次经验整理成一条可审议的改进建议</span></label>' +
      '<p class="tev-form-error" data-tev-error role="alert"></p><footer><button type="submit" class="is-primary">保存评价</button>' +
      '<button type="button" data-tev-cancel>取消</button></footer></form>';
  }

  function html(trace, opts) {
    const evolution = (trace || {}).evolution;
    if (!evolution) return '';
    const evaluation = evolution.myEvaluation || evolution.evaluation;
    const access = evolution.access || {};
    const open = evolution.state === 'awaiting_decision' || (opts || {}).focusEvolution;
    let title = '需求完成后，评价会沉淀成可复用经验';
    let detail = '这里记录真实结果，不让流程因为一次反馈就自行漂移。';
    if (evolution.state === 'awaiting_evaluation') {
      title = '交付已经结束，花半分钟留下结论';
      detail = '先评价结果，再决定是否形成企业改进建议。';
    } else if (evolution.state === 'awaiting_decision') {
      title = '评价已记录，还有一条改进建议等你决定';
      detail = '采纳只进入改进队列，不会修改当前工作流。';
    } else if (evaluation) {
      title = '这次交付已经留下可追溯经验';
      detail = '评价、建议和人的决定都与原需求证据绑定。';
    }
    return '<details class="tev-shell" data-tfd-open="evolution"' + (open ? ' open' : '') + '><summary><span><i></i><span>' +
      '<b>评价与沉淀</b><small>' + esc(STATE[evolution.state] || evolution.state) + '</small></span></span>' +
      '<svg viewBox="0 0 24 24"><path d="m8 10 4 4 4-4"/></svg></summary><div class="tev-body"><header><div><b>' +
      esc(title) + '</b><p>' + esc(detail) + '</p></div>' +
      (evolution.available && access.canEvaluate ? '<button data-tev-start>' + (evolution.myEvaluation ? '更新评价' : '写评价') + '</button>' : '') +
      '</header>' + evaluationHtml(evaluation) + proposalHtml(evolution.proposal, evolution) +
      formHtml(evolution.myEvaluation) + '<div class="tev-guard"><i>i</i><span>' + esc(evolution.guardrail || '') +
      '</span></div></div></details>';
  }

  function message(error, fallback) {
    return typeof _humanErr === 'function' ? _humanErr(error, fallback) : fallback;
  }

  function bind(root, context) {
    const shell = root.querySelector('.tev-shell');
    if (!shell || shell.dataset.bound) return;
    shell.dataset.bound = '1';
    const trace = context.trace || {};
    const taskId = String(((trace.task || {}).id) || ((trace.card || {}).taskId) || '');
    const start = shell.querySelector('[data-tev-start]');
    const form = shell.querySelector('[data-tev-form]');
    if (start && form) start.addEventListener('click', () => {
      form.hidden = false; start.hidden = true;
      const field = form.querySelector('textarea'); if (field) field.focus();
    });
    const cancel = shell.querySelector('[data-tev-cancel]');
    if (cancel && form) cancel.addEventListener('click', () => {
      form.hidden = true;
      if (start) { start.hidden = false; start.focus(); }
    });
    if (form) form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      const errorBox = form.querySelector('[data-tev-error]');
      const data = new FormData(form); const outcome = String(data.get('outcome') || 'achieved');
      button.disabled = true; button.textContent = '正在保存…'; errorBox.textContent = '';
      try {
        await SoduWorkAPI.saveTaskEvaluation(taskId, {
          outcome, score: { achieved: 5, partial: 3, missed: 1 }[outcome],
          summary: data.get('summary') || '', workedWell: data.get('workedWell') || '',
          improvement: data.get('improvement') || '', reusableLesson: data.get('reusableLesson') || '',
          createProposal: data.get('createProposal') === 'on',
        });
        if (typeof petSay === 'function') petSay('评价已记录，经验留在这条需求里了');
        await context.refresh(); if (typeof context.changed === 'function') context.changed(taskId);
      } catch (error) {
        button.disabled = false; button.textContent = '保存评价';
        errorBox.textContent = message(error, '评价暂时没能保存');
      }
    });
    const rejectOpen = shell.querySelector('[data-tev-reject-open]');
    const rejectForm = shell.querySelector('[data-tev-reject-form]');
    if (rejectOpen && rejectForm) rejectOpen.addEventListener('click', () => { rejectForm.hidden = false; rejectOpen.hidden = true; rejectForm.querySelector('input').focus(); });
    const rejectCancel = shell.querySelector('[data-tev-reject-cancel]');
    if (rejectCancel && rejectForm) rejectCancel.addEventListener('click', () => { rejectForm.hidden = true; if (rejectOpen) rejectOpen.hidden = false; });
    async function decide(button, decision, note) {
      const proposal = (trace.evolution || {}).proposal || {};
      const label = button.textContent; button.disabled = true; button.textContent = '正在处理…';
      try {
        await SoduWorkAPI.decideTaskEvolution(taskId, proposal.id, decision, note || '');
        if (typeof petSay === 'function') petSay(decision === 'accepted' ? '已进入受控改进队列' : '已记录不采纳');
        await context.refresh(); if (typeof context.changed === 'function') context.changed(taskId);
      } catch (error) {
        button.disabled = false; button.textContent = label;
        if (typeof petSay === 'function') petSay(message(error, '这条建议暂时没能处理'));
      }
    }
    shell.querySelectorAll('[data-tev-decision]').forEach((button) => button.addEventListener('click', () =>
      decide(button, button.getAttribute('data-tev-decision') || '', '')));
    if (rejectForm) rejectForm.addEventListener('submit', (event) => {
      event.preventDefault(); decide(rejectForm.querySelector('button[type="submit"]'), 'rejected', rejectForm.querySelector('input').value);
    });
  }

  window.TaskEvolutionView = { html, bind };
})();
