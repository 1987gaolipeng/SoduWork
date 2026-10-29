/*
 * Local Browser/Computer/Office capabilities depend on device probes, authorization, and
 * session selection. Enterprise Skill availability must not silently disable local
 * capabilities when Hub is temporarily unreachable.
 */
(function (global) {
  'use strict';

  const ICONS = {
    browser: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4a13 13 0 0 1 0 16M12 4a13 13 0 0 0 0 16"/></svg>',
    computer: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="12" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    office: '<svg viewBox="0 0 24 24"><path d="M7 3h8l4 4v14H7zM15 3v5h4M3 7h4v10H3z"/></svg>',
  };

  function summary(items, selected, loading) {
    const enabled = items.filter((item) => item.selectable && selected.has(item.id)).length;
    const available = items.filter((item) => item.selectable).length;
    return loading ? '检查中' : (enabled ? enabled + ' 项已启用' : (available ? '未启用' : '不可用'));
  }

  function render(list, items, selected, loading, escapeHtml) {
    if (!list) return;
    if (loading && !items.length) {
      list.innerHTML = '<span class="cp-capwait">正在检查这台电脑…</span>';
      return;
    }
    if (!items.length) {
      list.innerHTML = '<button type="button" class="cp-cap-retry" data-capability-retry>重新检查基础能力</button>';
      return;
    }
    list.innerHTML = items.map((item) => {
      const on = selected.has(item.id) && item.selectable;
      const blocked = !item.selectable;
      const status = blocked ? (item.reason || '不可用') :
        (on ? '已开启' : (item.grantRequired ? '需要本机授权' : '未开启'));
      const detail = item.detail || item.description ||
        (blocked ? '这台设备暂时不能使用' : '本次会话可随时开启或关闭');
      return '<button class="cp-cap' + (on ? ' on' : '') + (blocked ? ' blocked' : '') +
        '" data-capability="' + escapeHtml(item.id) + '" aria-pressed="' + (on ? 'true' : 'false') +
        '" aria-disabled="' + (blocked ? 'true' : 'false') + '" title="' +
        escapeHtml((item.description || '') + (status ? ' · ' + status : '')) + '">' +
        (ICONS[item.id] || '') + "<span class=\"cp-cap-copy\"><b>" + escapeHtml(item.label) +
        '</b><small>' + escapeHtml(detail) + '</small></span><i class="cp-cap-state">' +
        escapeHtml(status) + '</i><span class="cp-cap-switch" aria-hidden="true"><span></span></span></button>';
    }).join('');
  }

  async function toggle(options) {
    const opts = options || {};
    const item = (opts.items || []).find((row) => row.id === opts.id);
    const say = typeof opts.say === 'function' ? opts.say : () => {};
    if (!item || !item.selectable) {
      say((item && item.reason) || '这项能力现在不可用');
      return false;
    }
    const turningOn = !opts.selected.has(item.id);
    if (turningOn && item.grantRequired) {
      if (typeof opts.grant !== 'function') {
        say('当前客户端无法完成本机授权，请升级后重试');
        return false;
      }
      let result = null;
      try { result = await opts.grant(item.id, true); }
      catch (error) { say('本机授权没有完成，请重试'); return false; }
      if (!result || !result.ok) {
        if (!(result && result.canceled)) say((result && result.error) || '本机授权没有完成');
        return false;
      }
      item.deviceGranted = true;
      item.grantRequired = false;
    }
    if (turningOn) opts.selected.add(item.id);
    else opts.selected.delete(item.id);
    if (item.id === 'computer' && opts.selected.has(item.id)) {
      say('本次对话已允许操作桌面；明确要求登录时可代填凭据，删除、支付和发送等高风险动作仍严格守界');
    }
    return true;
  }

  global.ComposeCapabilities = { summary, render, toggle };
})(window);
