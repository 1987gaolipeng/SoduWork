/* Compact execution rail for the AI task workspace.
   It deliberately omits the six-phase methodology, historical sessions and
   audit timeline: the task page owns those; this rail answers only now/route/evidence/delivery. */
(function () {
  'use strict';

  const LIVE = new Set(['queued', 'dispatching', 'running', 'waiting', 'waiting_human', 'waiting_external']);
  const DONE = new Set(['done', 'succeeded', 'complete', 'completed', 'approved', 'passed', 'deployed']);
  const BAD = new Set(['failed', 'blocked', 'rejected', 'cancelled', 'canceled', 'rework']);
  const STATE = {
    queued: '\u6392\u961f\u4e2d', dispatching: '\u6b63\u5728\u6d3e\u53d1', running: '\u8fdb\u884c\u4e2d',
    waiting: '\u7b49\u5f85\u4e2d', waiting_human: '\u7b49\u5f85\u4eba\u5de5', waiting_external: '\u7b49\u5f85\u5916\u90e8\u7ed3\u679c',
    done: '\u5df2\u5b8c\u6210', succeeded: '\u5df2\u5b8c\u6210', complete: '\u5df2\u5b8c\u6210', completed: '\u5df2\u5b8c\u6210',
    approved: '\u5df2\u901a\u8fc7', passed: '\u5df2\u901a\u8fc7', deployed: '\u5df2\u53d1\u5e03',
    failed: '\u5931\u8d25', blocked: '\u5df2\u963b\u585e', rejected: '\u5df2\u9000\u56de', rework: '\u9700\u8fd4\u5de5',
    planned: '\u672a\u5f00\u59cb', pending: '\u672a\u5f00\u59cb', cancelled: '\u5df2\u53d6\u6d88', canceled: '\u5df2\u53d6\u6d88',
  };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
  }

  function stateText(value) {
    const key = String(value || 'planned');
    return STATE[key] || key;
  }

  function tone(value) {
    const key = String(value || 'planned');
    if (DONE.has(key)) return 'done';
    if (BAD.has(key)) return 'bad';
    if (LIVE.has(key)) return key === 'waiting_human' ? 'human' : 'live';
    return 'idle';
  }

  function latestRun(trace) {
    const rows = Array.isArray(trace && trace.runs) ? trace.runs : [];
    return rows.find((run) => LIVE.has(String(run && run.state || ''))) || rows[0] || null;
  }

  function stages(trace) {
    const publicRows = Array.isArray(trace && trace.stages) ? trace.stages : [];
    if (publicRows.length) return publicRows;
    const run = latestRun(trace);
    const rows = Array.isArray(run && run.nodes) ? run.nodes : [];
    const latest = new Map();
    rows.forEach((node) => latest.set(String(node && (node.key || node.id) || ''), node));
    return [...latest.values()];
  }

  function selectedStage(trace, opts, rows) {
    const wanted = String(opts && opts.selectedStageId || (trace.summary || {}).currentStageId || '');
    return rows.find((row) => String(row.id || row.key || '') === wanted) ||
      rows.find((row) => LIVE.has(String(row.state || ''))) ||
      rows.slice().reverse().find((row) => DONE.has(String(row.state || '')) || BAD.has(String(row.state || ''))) ||
      rows[0] || null;
  }

  function progressHtml(trace, rows) {
    const summary = trace.summary || {};
    const lifecycle = (summary.lifecycle || {}).progress;
    const total = lifecycle ? Number(lifecycle.total) : Math.max(Number(summary.totalStages || 0), rows.length);
    const done = Math.max(0, Math.min(total, lifecycle ? Number(lifecycle.done) :
      Number(summary.completedStages ?? rows.filter((row) => DONE.has(String(row.state || ''))).length)));
    if (!total) return '';
    const pct = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
    return '<div class="trv-progress" aria-label="' + esc(done + '/' + total) + '">' +
      '<span>' + (lifecycle ? '已完成 ' : '') + '<b>' + done + '</b><small>/ ' + total + (lifecycle ? ' ' + esc(lifecycle.unit || '阶段') : '') +
      '</small></span><i><em style="width:' + pct + '%"></em></i></div>';
  }

  function actorText(stage, trace) {
    const actor = stage && stage.actor || {};
    const executor = stage && stage.executor || (trace.card || {}).executor || {};
    return [...new Set([actor.name, actor.label, executor.assignee, executor.host]
      .map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 3).join(' \u00b7 ');
  }

  function routeHtml(rows, selected) {
    if (!rows.length) return '<div class="trv-route-empty">\u6267\u884c\u8def\u7ebf\u6b63\u5728\u51c6\u5907</div>';
    const selectedId = String(selected && (selected.id || selected.key) || '');
    return '<nav class="trv-route" aria-label="\u5b9e\u9645\u6267\u884c\u5173\u5361"><ol>' + rows.map((stage, index) => {
      const id = String(stage.id || stage.key || '');
      const state = String(stage.state || 'planned');
      const active = id === selectedId;
      return '<li class="is-' + tone(state) + (active ? ' is-selected' : '') + '"><button type="button" data-tfd-stage="' +
        esc(id) + '"' + (active ? ' aria-current="step"' : '') + '><i>' +
        (DONE.has(state) ? '<svg viewBox="0 0 24 24"><path d="m5 13 4 4 10-10"/></svg>' : index + 1) +
        '</i><span><b>' + esc(stage.name || stage.key || ('\u9636\u6bb5 ' + (index + 1))) + '</b><small>' +
        esc(stateText(state)) + '</small></span></button></li>';
    }).join('') + '</ol></nav>';
  }

  function itemUrl(item) {
    const direct = String(item && (item.url || item.href) || '').trim();
    if (direct) return direct;
    try {
      return window.SoduWorkAPI && typeof SoduWorkAPI.attachmentUrl === 'function' ? SoduWorkAPI.attachmentUrl(item) : '';
    } catch (_) { return ''; }
  }

  function evidenceHtml(stage) {
    const rows = Array.isArray(stage && stage.evidence) ? stage.evidence.slice(0, 8) : [];
    if (!rows.length) return '<p class="trv-empty">\u8fd9\u4e00\u9636\u6bb5\u8fd8\u6ca1\u6709\u751f\u6210\u53ef\u9a8c\u8bc1\u8bc1\u636e\u3002</p>';
    return '<ul class="trv-evidence">' + rows.map((item) => {
      const url = itemUrl(item);
      const producer = item.producer && (item.producer.name || item.producer.label);
      const content = '<span><b>' + esc(item.title || item.name || '\u6267\u884c\u8bc1\u636e') + '</b>' +
        '<small>' + esc([item.summary, producer].filter(Boolean).join(' \u00b7 ')) + '</small></span>';
      return '<li>' + (item.isImage && url ? '<a href="' + esc(url) + '" target="_blank" rel="noreferrer"><img src="' +
        esc(url) + '" loading="lazy" decoding="async" alt="">' + content + '</a>' : url ? '<a href="' + esc(url) +
        '" target="_blank" rel="noreferrer"><i aria-hidden="true"></i>' + content + '</a>' :
        '<div><i aria-hidden="true"></i>' + content + '</div>') + '</li>';
    }).join('') + '</ul>';
  }

  function factsHtml(stage) {
    const rows = [];
    const decisions = Array.isArray(stage && stage.decisions) ? stage.decisions : [];
    const deployments = Array.isArray(stage && stage.deployments) ? stage.deployments : [];
    const outputs = Array.isArray(stage && stage.outputs) ? stage.outputs : [];
    if (decisions.length) rows.push(['\u4eba\u5de5\u51b3\u5b9a', decisions.map((item) => stateText(item.status)).join(' \u00b7 ')]);
    if (deployments.length) rows.push(['\u73af\u5883\u8fd0\u884c', deployments.map((item) =>
      [item.environmentName, stateText(item.state)].filter(Boolean).join(' \u00b7 ')).join(' / ')]);
    if (outputs.length) rows.push(['\u56fa\u5b9a\u4ea4\u4ed8', outputs.map((item) =>
      item.name || item.kind || ('v' + Number(item.seq || 1))).join(' \u00b7 ')]);
    if (!rows.length) return '';
    return '<dl class="trv-facts">' + rows.map((row) => '<div><dt>' + esc(row[0]) + '</dt><dd>' + esc(row[1]) +
      '</dd></div>').join('') + '</dl>';
  }

  function detailHtml(stage, trace) {
    if (!stage) return '<section class="trv-detail"><p class="trv-empty">\u9700\u6c42\u5df2\u8bb0\u5f55\uff0c\u6b63\u5728\u7b49\u5f85\u7b2c\u4e00\u4e2a\u6267\u884c\u9636\u6bb5\u3002</p></section>';
    const state = String(stage.state || 'planned');
    const actor = actorText(stage, trace);
    const error = stage.error && (stage.error.message || stage.error.detail || stage.error);
    return '<section class="trv-detail"><header><div><span data-i18n="eyebrow.stage_detail">STAGE DETAIL</span><h4>' +
      esc(stage.name || stage.key || '\u5f53\u524d\u9636\u6bb5') + '</h4></div><em class="is-' + tone(state) + '">' +
      esc(stateText(state)) + '</em></header>' + (actor ? '<p class="trv-actor">' + esc(actor) + '</p>' : '') +
      (error ? '<p class="trv-error">' + esc(String(error).slice(0, 300)) + '</p>' : '') +
      factsHtml(stage) + '<div class="trv-evidence-head"><b>\u9636\u6bb5\u8bc1\u636e</b><span>' +
      Number((stage.evidence || []).length) + ' \u9879</span></div>' + evidenceHtml(stage) + '</section>';
  }

  function deliveryHtml(trace) {
    const delivery = trace.delivery || (trace.card || {}).delivery || {};
    if (!delivery.schemaVersion && !delivery.state) return '';
    const manifest = delivery.manifest || {};
    const files = [...(manifest.primary || []), ...(manifest.supporting || [])].slice(0, 4);
    const blocker = (delivery.blockers || [])[0] || null;
    const state = String(delivery.state || 'pending');
    let title = '\u4ea4\u4ed8\u4e8b\u5b9e\u6b63\u5728\u5f62\u6210';
    if (delivery.complete) title = '\u4ea4\u4ed8\u5df2\u7ecf\u95ed\u73af';
    else if (delivery.canComplete) title = '\u4ea4\u4ed8\u6761\u4ef6\u5df2\u6ee1\u8db3';
    else if (blocker && blocker.title) title = blocker.title;
    return '<section class="trv-delivery is-' + tone(state) + '"><header><span data-i18n="eyebrow.delivery">DELIVERY</span><em>' +
      esc(stateText(state)) + '</em></header><h4>' + esc(title) + '</h4>' +
      (blocker && blocker.detail ? '<p>' + esc(blocker.detail) + '</p>' : '') +
      (files.length ? '<div class="trv-files">' + files.map((item) => {
        const url = itemUrl(item);
        return url ? '<a href="' + esc(url) + '" target="_blank" rel="noreferrer">' + esc(item.name || '\u4ea4\u4ed8\u6587\u4ef6') +
          '</a>' : "<span" + (item.name ? ' data-user-content' : '') + '>' + esc(item.name || '\u4ea4\u4ed8\u6587\u4ef6') + '</span>';
      }).join('') + '</div>' : '') + ((files.length && String((delivery.artifact || {}).kind) !== 'code') ?
        '<button type="button" data-tfd-action="download">\u4e0b\u8f7d\u5f53\u524d\u6210\u679c</button>' : '') + '</section>';
  }

  function html(trace, opts) {
    if (!trace) return '<div class="trv-shell"><p class="trv-empty">\u6267\u884c\u8fdb\u5ea6\u6682\u65f6\u6ca1\u6709\u52a0\u8f7d\u6210\u529f\u3002</p></div>';
    const rows = stages(trace);
    const selected = selectedStage(trace, opts || {}, rows);
    const summary = trace.summary || {};
    const lifecycle = summary.lifecycle || {};
    const currentState = String(lifecycle.state || summary.currentState || (selected || {}).state || (trace.card || {}).stage && (trace.card || {}).stage.state || 'planned');
    const currentTitle = lifecycle.title || summary.currentStageName || (selected && (selected.name || selected.key)) || '\u7b49\u5f85\u5f00\u59cb';
    const nextAction = lifecycle.nextAction ?? summary.nextAction;
    return '<div class="trv-shell"><section class="trv-now is-' + tone(currentState) + '"><header><span>NOW</span><em>' +
      esc(stateText(currentState)) + '</em></header><h3>' + esc(currentTitle) + '</h3>' +
      (nextAction ? '<p><span>\u4e0b\u4e00\u6b65</span>' + esc(nextAction) + '</p>' : '') +
      progressHtml(trace, rows) + '</section><div class="trv-label"><b>\u5b9e\u9645\u6267\u884c\u8def\u7ebf</b><small>\u70b9\u51fb\u9636\u6bb5\u67e5\u770b\u8bc1\u636e</small></div>' +
      routeHtml(rows, selected) + detailHtml(selected, trace) + deliveryHtml(trace) + '</div>';
  }

  window.TaskTraceRailView = { html };
})();
