/* Share a traceable project execution baseline across requirement details, agent execution, and human review. */
(function () {
  'use strict';

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function tone(value) {
    return ({ ready: 'ready', partial: 'partial', failed: 'failed', pending: 'pending',
      available: 'pending' })[
      String(value || '')] || 'pending';
  }

  function shortCommit(value) {
    return String(value || '').slice(0, 8);
  }

  function sourceKind(value) {
    return ({
      'agent-rules': '工程规则', 'project-context': '项目约定',
      'project-memory': '项目记忆', 'readme': '工程说明',
      'conventions': '协作规范', 'contributing': '协作规范',
      'manifest': '工程清单', 'architecture': '架构资料',
      'development': '开发说明', 'memory': '项目记忆',
    })[String(value || '')] || '工程资料';
  }

  function sourceRows(rows) {
    return (rows || []).slice(0, 8).map((item) => {
      const path = typeof item === 'string' ? item : item.path;
      const kind = typeof item === 'string' ? '' : item.kind;
      return '<li><span>' + esc(path || '工程资料') + '</span>' +
        (kind ? '<small>' + esc(sourceKind(kind)) + '</small>' : '') + '</li>';
    }).join('');
  }

  function html(context) {
    const row = context || {};
    if (!row.visible) return '';
    const identity = [row.repoName || row.projectName, row.branch,
      shortCommit(row.baselineCommit) ? '@' + shortCommit(row.baselineCommit) : ''].filter(Boolean);
    const counts = [];
    if (Number(row.sourceCount || 0)) counts.push(Number(row.sourceCount) + ' 份工程资料');
    if (Number(row.memoryCount || 0)) counts.push(Number(row.memoryCount) + ' 条已验收经验');
    const latest = row.latestMemory || {};
    const hasDetail = (row.sources || []).length || latest.summary || row.error ||
      (row.commands || []).length;
    return '<details class="tpc is-' + tone(row.state) + '"' +
      (hasDetail ? '' : ' data-empty="true"') + '><summary>' +
      '<i class="tpc-state" aria-hidden="true"></i><span class="tpc-title">' +
      '<small data-i18n="eyebrow.project_context">PROJECT CONTEXT</small><b>项目上下文</b></span>' +
      '<span class="tpc-identity" title="' + esc(identity.join(' · ')) + '">' +
      esc(identity.join(' · ') || '已绑定当前需求工程') + '</span>' +
      '<span class="tpc-count">' + esc(counts.join(' · ') || row.stateLabel || '执行时准备') + '</span>' +
      '<em>' + esc(row.stateLabel || '执行时准备') + '</em>' +
      (hasDetail ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4"/></svg>' : '') +
      '</summary>' + (hasDetail ? '<div class="tpc-body">' +
        '<section><span>本次执行基线</span><b>' + esc(row.summary || '已读取当前工作树与工程约定') + '</b>' +
        (row.error ? '<p class="is-warning">' + esc(row.error) + '</p>' : '') +
        (row.dirty ? '<p class="is-warning">执行基线包含尚未提交的工作树改动</p>' : '') +
        ((row.commands || []).length ? '<p>可用验证：' + esc((row.commands || []).slice(0, 4).join(' · ')) + '</p>' : '') +
        '</section><section><span>资料来源</span>' +
        ((row.sources || []).length ? '<ul>' + sourceRows(row.sources) + '</ul>' :
          '<p>本次未发现可公开展示的工程资料。</p>') + '</section>' +
        (latest.summary ? "<section class=\"tpc-memory\"><span>最近已验收经验</span><b" + (latest.title ? ' data-user-content' : '') + '>' +
          esc(latest.title || '上一次需求沉淀') + '</b><p>' + esc(latest.summary) + '</p>' +
          (latest.commit ? '<small>提交 ' + esc(shortCommit(latest.commit)) + '</small>' : '') +
          '</section>' : '') + '</div>' : '') + '</details>';
  }

  window.TaskProjectContextView = { html };
})();
