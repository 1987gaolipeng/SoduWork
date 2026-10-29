(function (global) {
  'use strict';

  const LABELS = {
    editOnly: ['仅可编辑', '你可以编辑新版本或通过对话改进，当前未获使用权限。', 'neutral', '编辑改进'],
    permissionDenied: ['无使用权限', '管理员已收回使用权限，请联系管理员调整授权。', 'warning', '查看详情'],
    ready: ['可使用', '已满足使用条件，可以从对话或任务中调用。', 'success', '立即使用'],
    enable: ['已停用', '插件已安装，但当前没有加入你的对话工具箱。', 'neutral', '启用'],
    install: ['待安装', '企业已发布这个版本，安装后才会进入你的个人对话工具箱。', 'info', '安装并试用'],
    upgrade: ['有更新', '发现新版本；可继续使用已获准的旧版本，确认变化后再升级。', 'info', '查看并升级'],
    setup: ['待完成设置', '还缺少使用前必填的配置，完成后才能稳定调用。', 'warning', '完成设置'],
    connect: ['连接待恢复', '插件依赖的企业连接尚未就绪，恢复后才开放真实调用。', 'warning', '查看连接'],
    taskOnly: ['任务专用', '该插件只允许在已绑定的任务或自动化中使用。', 'neutral', '查看使用方式'],
    blocked: ['暂不可用', '当前版本有阻断项，先处理阻断项再使用。', 'danger', '查看阻断项'],
    rejected: ['需要修改', '企业审核已退回；改进个人版本后可以重新提交。', 'danger', '打开并改进'],
    revoked: ['已撤销', '这个版本已被企业撤销，不能继续安装或调用。', 'danger', '查看详情'],
    pending: ['审核中', '版本已经提交，等待企业完成发布审核。', 'warning', '查看发布进度'],
  };

  function text(value) { return String(value == null ? '' : value).trim(); }
  function list(value) { return Array.isArray(value) ? value.filter(Boolean) : []; }

  function resolve(item, readiness) {
    const row = item || {};
    const dependency = readiness || row.dependencyReadiness || {};
    const missingMcp = list(dependency.missingMcp);
    const policy = row.marketPolicy || {};
    const review = text(row.reviewDecision).toLowerCase();
    const trust = text(row.trustState).toLowerCase();
    let code = 'ready';
    let blockers = [];

    if (row.personal) {
      code = row.enabled === false ? 'enable' : row.setupState === 'needs_setup' ? 'setup' : 'ready';
    } else if (row.permissions?.canUse === false) {
      code = row.permissions.canEdit ? 'editOnly' : 'permissionDenied';
    } else if (review === 'revoke' || trust === 'revoked') {
      code = 'revoked';
    } else if (review === 'reject') {
      code = 'rejected';
    } else if (row.catalogReady === false && (row.trustState || row.reviewDecision)) {
      code = 'pending';
    } else if (policy.installation === 'not_available' || row.installationState === 'task_only') {
      code = 'taskOnly';
    } else if (row.updateAvailable) {
      code = 'upgrade';
    } else if (!row.installed) {
      if (missingMcp.length && dependency.installBlocked) code = 'connect';
      else code = 'install';
    } else if (row.setupState && row.setupState !== 'ready') {
      code = 'setup';
    } else if (missingMcp.length) {
      code = 'connect';
    } else if (row.installationState === 'default_disabled' || row.enabled === false) {
      code = 'enable';
    }

    if (missingMcp.length) blockers = blockers.concat(missingMcp.map(name => '缺少连接：' + name));
    list(row.installationBlockers).forEach(value => {
      const entry = text(value);
      if (entry && blockers.indexOf(entry) < 0) blockers.push(entry);
    });
    const descriptor = LABELS[code] || LABELS.blocked;
    const progress = code === 'ready' || code === 'enable' ? 4 :
      code === 'install' || code === 'connect' ? 3 :
        code === 'upgrade' || code === 'setup' ? 4 :
          code === 'taskOnly' ? 4 : 2;
    return {
      code,
      label: descriptor[0],
      summary: descriptor[1],
      tone: descriptor[2],
      nextAction: code === 'ready' ? 'use' : code,
      nextLabel: descriptor[3],
      blockers,
      progress,
      total: 4,
      actionable: code !== 'revoked' && code !== 'pending' && code !== 'taskOnly',
      blocking: ['connect', 'blocked', 'rejected', 'revoked', 'pending', 'editOnly', 'permissionDenied'].indexOf(code) >= 0,
    };
  }

  function html(item, readiness, escape) {
    const state = resolve(item, readiness);
    const safe = typeof escape === 'function' ? escape : text;
    const blockers = state.blockers && state.blockers.length
      ? '<span class="cap-plugin-lifecycle-blockers">' + safe(state.blockers.slice(0, 2).join(' · ')) + '</span>' : '';
    return '<section class="cap-plugin-lifecycle is-' + safe(state.tone) + '" data-lifecycle="' +
      safe(state.code) + '"><div class="cap-plugin-lifecycle-mark"><i></i></div><div class="cap-plugin-lifecycle-copy"><small>当前状态</small><b>' +
      safe(state.label) + '</b><p>' + safe(state.summary) + '</p>' + blockers +
      '</div><div class="cap-plugin-lifecycle-next"><small>下一步</small><b>' +
      safe(state.nextLabel) + '</b></div></section>';
  }
  function normalizeProgress(item) {
    const row = item || {};
    const state = resolve(row);
    if (row.personal) return { done: state.code === 'ready' ? 2 : 1, total: 2, label: state.label };
    return { done: state.progress, total: state.total, label: state.label };
  }

  global.SoduWorkPluginLifecycle = { resolve, html, normalizeProgress };
})(window);
