/* Shared enterprise plugin dependency state and recovery copy. */
(function (global) {
  'use strict';

  function state(item) {
    item = item || {};
    const policy = item.marketPolicy || {};
    const dependency = item.dependencyReadiness || {};
    const missingMcp = Array.isArray(dependency.missingMcp) ?
      dependency.missingMcp.filter(Boolean) : [];
    const taskOnly = policy.installation === 'not_available';
    const runtimeBlocked = !item.personal && missingMcp.length > 0;
    return {
      policy, missingMcp, taskOnly, runtimeBlocked,
      installBlocked: runtimeBlocked && policy.authentication === 'on_install',
      defaultDisabled: item.installationState === 'default_disabled',
    };
  }

  function installClass(item, readiness) {
    if (readiness.taskOnly) return item.installationState || 'task_only';
    if (readiness.defaultDisabled) return 'default_disabled';
    if (readiness.runtimeBlocked) return item.installed ? 'degraded' : 'blocked';
    return item.installationState || 'available';
  }

  function installLabel(item, readiness) {
    if (readiness.taskOnly) return '需求专用';
    if (readiness.defaultDisabled) return '默认已停用';
    if (readiness.runtimeBlocked) return item.installed ? '连接待恢复' : '等待连接';
    if (item.updateAvailable) return '有更新';
    if (readiness.policy.installation === 'installed_by_default') {
      return item.installed ? '企业默认' :
        item.installationState === 'default_blocked' ? '等待连接' : '默认已停用';
    }
    return item.installed ? '已安装' : '可安装';
  }

  function quickUse(item, readiness, escape) {
    if (!item.personal && item.permissions?.canUse === false) return '<p class="cap-governance-note"><b>当前未获使用权限。</b>编辑改进权限单独配置；需要使用时请联系管理员。</p>';
    const missingMcp = Array.isArray(readiness && readiness.missingMcp) ?
      readiness.missingMcp.filter(Boolean) : [];
    if (readiness.taskOnly) {
      return '<p class="cap-governance-note"><b>受控需求专用</b>管理员没有开放个人对话安装；请从需求或自动化按企业绑定使用。</p>';
    }
    if (readiness.runtimeBlocked) {
      return '<p class="cap-governance-note"><b>等待企业连接</b>连接恢复后才会开放真实调用；SoduWork 不会用提示词模拟外部系统结果。</p>';
    }
    if (item.personal) {
      if (missingMcp.length) {
        return '<p class="cap-governance-note"><b>/ 个人试用需要连接</b>首次使用前，请在连接管理中配置并测试：' +
          escape(missingMcp.join('、')) + '。连接未就绪时不会用提示词假装调用成功。</p>';
      }
      return '<p class="cap-governance-note"><b>/ 个人试用</b>在“新建”或任意对话中输入 /' +
        escape(item.name) + '，即可让本轮采用该插件的方法和质量标准；上传企业并审核发布后，才会开放需求与自动化入口。</p>';
    }
    if (!readiness.taskOnly) {
      return '<p class="cap-governance-note"><b>/ 快速使用</b>在“新建”或任意对话中输入 /' +
        escape(item.name) + '，即可让本轮采用该插件的方法和质量标准；完整审批与发布仍从需求启动。</p>';
    }
    return '<p class="cap-governance-note"><b>从项目需求使用</b>该插件绑定多个项目，需要先明确项目，避免把上下文带到错误工程。</p>';
  }

  function installNote(item, readiness) {
    if (!item.personal && item.permissions?.canUse === false) return '';
    if (readiness.taskOnly) return '<p class="cap-governance-note"><b>不进入个人工具箱。</b>这不会影响已经配置的需求与自动化流程。</p>';
    if (readiness.runtimeBlocked) {
      return '<p class="cap-governance-note"><b>' +
        (readiness.installBlocked ? '安装前必须恢复连接。' : '可以先安装，调用前必须恢复连接。') +
        '</b>管理员在管理端配置并启用企业连接器后，目录会自动恢复可用状态。</p>';
    }
    if (!item.personal && (!item.installed || item.updateAvailable)) {
      return '<p class="cap-governance-note"><b>' +
        (item.updateAvailable ? '有新版本可升级，已获准的旧版本可以继续使用。' : '先安装再使用。') +
        '</b>安装只影响你的日常对话工具箱，不会改变企业需求与自动化绑定。</p>';
    }
    return '';
  }

  function blocker(readiness, escape) {
    if (!readiness.runtimeBlocked) return '';
    return '<section class="cap-dependency-blocker"><b>企业连接未就绪</b><span>缺少：' +
      readiness.missingMcp.map(escape).join('、') +
      '</span><small>请管理员配置并启用这些连接；插件不会降级为提示词假装成功。</small></section>';
  }

  function adminRequest(item, readiness) {
    return '请在 SoduWork 管理端为插件「' + item.name +
      '」配置并启用以下企业连接器：\n- ' + readiness.missingMcp.join('\n- ');
  }

  global.SoduWorkPluginDependencies = {
    state, installClass, installLabel, quickUse, installNote, blocker, adminRequest,
  };
})(window);
