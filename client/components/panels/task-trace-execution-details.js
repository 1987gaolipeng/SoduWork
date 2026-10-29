(function () {
  'use strict';

  function shortId(value, size) {
    const text = String(value || '');
    const limit = Number(size || 12);
    return text.length > limit ? text.slice(0, limit) + '…' : text;
  }

  function recentEvents(items) {
    const out = [];
    let previous = '';
    (items || []).forEach((item) => {
      const text = String((item || {}).text || '').trim();
      if (!text) return;
      const fingerprint = [item.kind || '', item.tool || '', text].join('|');
      if (fingerprint === previous) return;
      previous = fingerprint;
      out.push(item);
    });
    return out.slice(-8);
  }




  function sessionDigest(events) {
    const rows = events || [];
    const lastOf = (kinds) => rows.slice().reverse()
      .find((event) => kinds.includes(String((event || {}).kind || '')));
    return {
      step: lastOf(['step']),
      update: lastOf(['say', 'out', 'error']),
      total: rows.length,
    };
  }

  function sessionHtml(item, h) {
    const identity = item.identity || {};
    const execution = item.executionContext || {};
    const location = execution.location || {};
    const events = recentEvents(item.items || []);
    const status = String(item.status || '');
    const agent = identity.agentName || item.assignee || item.engine || item.ref || 'AI 执行器';
    const cli = identity.agentCli || item.engine || item.cli || '';
    const cliVersion = identity.agentVersion || '';
    const model = identity.model || item.model || '';
    const sessionId = identity.agentSessionId || '';
    const runnerVersion = identity.runnerVersion || '';
    const selectionReason = [identity.selectionReason, location.label]
      .filter((value, index, values) => value && values.indexOf(value) === index)
      .join(' 路 ');
    return '<article class="tfd-session is-' + h.tone(status) + '"><header><i></i><div><b>' +
      h.esc(agent) + '</b><span>' +
      h.esc([identity.host || item.host, cli && (cli + (cliVersion ? ' ' + cliVersion : '')), model]
        .filter(Boolean).join(' · ')) +
      '</span></div><em>' + h.esc(h.stateText(status || 'running')) + '</em></header>' +
      '<div class="tfd-session-facts">' +
        (item.startedAt ? '<span>开始 ' + h.esc(h.dateText(item.startedAt)) + '</span>' : '') +
        /*
         * Keep running-duration markup stable when task facts have not changed; embedding
         * Date.now() would repeatedly rebuild the trace and its controls.
         */
        (item.startedAt ? '<span>用时 ' + h.esc(item.finishedAt
          ? h.duration(new Date(item.startedAt).getTime(), new Date(item.finishedAt).getTime())
          : '进行中') + '</span>' : '') +
        (events.length ? '<span>' + events.length + ' 条最近进展' +
          (events[events.length - 1].at ? ' · 更新于 ' + h.esc(h.dateText(events[events.length - 1].at)) : '') +
          '</span>' : '') +
        (runnerVersion ? '<span>Runner ' + h.esc(runnerVersion) + '</span>' : '') +
        (selectionReason ? '<span class="tfd-route-reason" title="' + h.esc(selectionReason) +
          '">调度 · ' + h.esc(selectionReason) + '</span>' : '') +
        (sessionId ? '<button data-tfd-copy="' + h.esc(sessionId) +
          '" title="复制 Agent CLI 会话号">会话 ' + h.esc(shortId(sessionId, 16)) + '</button>' : '') +
        (item.workDir ? '<button data-tfd-copy="' + h.esc(item.workDir) +
          '" title="复制工作目录">' + h.esc(item.workDir) + '</button>' : '') +
      '</div>' + (h.errorText(item.error) ? '<p class="tfd-error">' + h.esc(h.errorText(item.error)) + '</p>' : '') +
      digestHtml(item, events, status, h) + '</article>';
  }

  function digestHtml(item, events, status, h) {
    const digest = sessionDigest(events);
    digest.total = (item.items || []).length || digest.total;
    if (!digest.step && !digest.update) {
      return '<p class="tfd-muted">会话已记录，暂时还没有可展示的结构化步骤。</p>';
    }
    const live = h.live.has(status);
    const line = (label, event, limit) => event ? '<li class="' +
      (String(event.kind || '') === 'error' ? 'is-bad' : '') + '"><span>' + h.esc(label) + '</span><b>' +
      h.esc(String(event.text || '').slice(0, limit)) + '</b><small>' + h.esc(h.dateText(event.at)) +
      '</small></li>' : '';
    return '<ol class="tfd-session-digest">' +
      line(live ? '正在做' : '停在', digest.step, 120) +
      line(digest.update && String(digest.update.kind) === 'error' ? '异常' : '最新进展', digest.update, 200) +
      '</ol>' + (digest.total > 2 ? '<p class="tfd-session-more">共 ' + digest.total +
        ' 条过程记录，完整对话在' + (h.liveAside ? '右侧实时会话' : '实时控制台') + '里看。</p>' : '');
  }

  function deploymentHtml(item, h) {
    const result = item.result || {};
    const verification = item.verification || {};
    const checks = verification.checks || result.checks || [];
    const verificationText = {
      passed: '验证通过', failed: '验证失败', running: '验证中', pending: '等待验证',
      incomplete: '证据不完整', not_configured: '未配置上线验证', not_run: '尚未执行验证',
    }[verification.state] || '尚未验证';
    const rollback = item.rollback || result.rollback || {};
    const evidenceBy = item.runnerId ? ('Runner ' + shortId(item.runnerId, 14)) :
      (item.provider || item.channel || '发布适配器');
    const facts = [item.channel || item.targetName || item.provider,
      item.commit && ('版本 ' + String(item.commit).slice(0, 12)), result.version,
      result.deployStatus || result.stage].filter(Boolean);
    return '<article class="tfd-deployment is-' + h.tone(item.state) + '"><header><i></i><div><b>' +
      h.esc(item.environmentName || item.environmentTier || '环境发布') + '</b><span>' +
      h.esc(facts.join(' · ')) + '</span></div><em>' + h.esc(h.stateText(item.state)) + '</em></header>' +
      (h.errorText(item.error) ? '<p class="tfd-error">' + h.esc(h.errorText(item.error)) + '</p>' : '') +
      '<section class="tfd-deploy-proof is-' + h.esc(verification.state || 'empty') +
      '"><header><div><b>上线后验证</b><span>' + h.esc(verificationText) + ' · 取证 ' +
      h.esc(evidenceBy) + '</span></div><em>' +
      (Number(verification.planned || checks.length) ? Number(verification.completed || checks.length) + ' / ' +
        Number(verification.planned || checks.length) : '0 项') + '</em></header>' +
      (checks.length ? '<ol>' + checks.map((check) => '<li class="' + (check.ok ? 'is-ok' : 'is-bad') +
        '"><i></i><div><b>' + h.esc(check.name || '上线检查') + '</b><span>' +
        h.esc(check.detail || '') + '</span></div><em>' + (check.ok ? '通过' : '未通过') + '</em></li>').join('') +
        '</ol>' : '<p>' + h.esc(verification.state === 'not_configured' ?
          '这次发布没有配置健康检查或业务断言，不能视为已经完成上线验证。' :
          '验证结果会在发布后自动回传，不需要手动刷新。') + '</p>') +
      (Object.keys(rollback).length ? '<div class="tfd-rollback is-' + (rollback.ok ? 'ok' : 'bad') +
        '"><b>自动回滚 ' + (rollback.ok ? '成功' : '失败') + '</b><span>' +
        h.esc(rollback.detail || '') + '</span></div>' : '') + '</section>' +
      (item.log ? '<details data-tfd-open="deploy-log:' + h.esc(item.id || '') +
        '"><summary>查看发布日志</summary><pre>' + h.esc(item.log) + '</pre></details>' : '') + '</article>';
  }

  function handoffHtml(item, h) {
    const input = (item && item.input) || {};
    const snapshot = input.contextSnapshot || {};
    const resolved = input.resolvedInputs || {};
    const references = Array.isArray(snapshot.references) ? snapshot.references : [];
    const seen = new Set();
    const rows = references.map((reference) => {
      const key = String(reference.key || reference.outputKey || '上游输入');
      seen.add(key);
      return { key, reference, value: resolved[key] || {} };
    });
    Object.keys(resolved).forEach((key) => {
      if (!seen.has(key)) rows.push({ key, reference: {}, value: resolved[key] || {} });
    });
    if (!rows.length) {
      (snapshot.dependencyKeys || []).slice(0, 12).forEach((key) => rows.push({
        key: String(key), reference: { fromNode: key }, value: {}, legacy: true,
      }));
    }
    if (!rows.length || snapshot.mode === 'none') return '';
    const checksum = String(snapshot.checksum || '');
    const meta = [rows.length + ' 项', snapshot.mode === 'legacy' ? '兼容交接' : '按声明交接',
      snapshot.truncated ? '已压缩' : '', checksum ? '指纹 ' + shortId(checksum, 12) : ''].filter(Boolean);
    return '<section class="tfd-handoff"><header><div><small data-i18n="eyebrow.upstream_handoff">UPSTREAM HANDOFF</small>' +
      '<b>上游交接</b></div><span>' + h.esc(meta.join(' · ')) + '</span></header><ol>' +
      rows.slice(0, 12).map((row) => {
        const reference = row.reference || {};
        const value = row.value || {};
        const available = !(value && (value.available === false || value.available === 0 ||
          ['false', '0', 'no', 'offline', 'unavailable'].includes(String(value.available == null ? '' : value.available).trim().toLowerCase())));
        const source = value.sourceNode || reference.fromNode || '上游节点';
        const output = value.outputKey || reference.outputKey || '';
        const label = value.label || row.key;
        const kind = value.kind || (row.legacy ? '历史结果' : '结构化输入');
        return '<li class="' + (available ? 'is-ready' : 'is-missing') + '"><i></i><div><b>' +
          h.esc(label) + '</b><span>' + h.esc([source, output].filter(Boolean).join(' → ')) +
          '</span></div><em>' + h.esc(available ? kind : '未取得') + '</em></li>';
      }).join('') + '</ol></section>';
  }

  function failureHtml(item, h) {
    const diagnosis = item.diagnosis || {};
    const fallback = h.errorText(item.error);
    if (!diagnosis.title && !diagnosis.action) {
      return fallback ? '<p class="tfd-error">' + h.esc(fallback).slice(0, 800) + '</p>' : '';
    }
    const detail = String(diagnosis.detail || fallback || '').slice(0, 1200);
    return '<section class="tfd-diagnosis is-' + h.esc(diagnosis.kind || 'execution') + '">' +
      '<i></i><div><b>' + h.esc(diagnosis.title || '当前关卡需要处理') + '</b>' +
      (detail ? '<span>' + h.esc(detail) + '</span>' : '') +
      (diagnosis.action ? '<p>' + h.esc(diagnosis.action) + '</p>' : '') + '</div><em>' +
      (diagnosis.retryable ? '修复后可重试' : '需要人工处理') + '</em></section>';
  }

  /*
   * Confirmation controls receive dependencies through parameters or shared globals; the
   * caller supplies esc.
   */

  function confirmHandoff(root, state) {
    if (root.querySelector('.tfd-confirm')) return;
    const row = document.createElement('div');
    row.className = 'tfd-confirm';
    row.innerHTML = '<div><b>结束自动化，转人工收尾？</b><span>工作流和 AI 会话都会停止；已经完成的代码、证据和发布记录全部保留。</span></div>' +
      '<input data-tfd-handoff-note maxlength="500" placeholder="补充原因（可选，会写入需求结论）">' +
      '<div><button data-tfd-handoff="no">继续执行</button><button class="danger" data-tfd-handoff="yes">确定转人工</button></div>';
    root.querySelector('.tfd-hero').appendChild(row);
    row.querySelector('[data-tfd-handoff="no"]').addEventListener('click', () => row.remove());
    const yes = row.querySelector('[data-tfd-handoff="yes"]');
    yes.addEventListener('click', async () => {
      if (yes.disabled) return;
      yes.disabled = true; yes.textContent = '正在收尾…';
      try {
        const taskId = ((state.trace.task || {}).id) || ((state.trace.card || {}).taskId) || state.opts.taskId;
        const note = row.querySelector('[data-tfd-handoff-note]').value.trim();
        await SoduWorkAPI.handoffAutomationTask(taskId, note, 'done');
        if (typeof petSay === 'function') petSay('已转人工收尾，已有代码和证据都保留着');
        await state.refresh(true);
      } catch (error) {
        yes.disabled = false; yes.textContent = '确定转人工';
        if (typeof petSay === 'function') petSay(typeof _humanErr === 'function' ? _humanErr(error, '这条需求暂时没能收尾') : '这条需求暂时没能收尾');
      }
    });
  }





  async function confirmRetryAgent(root, state, node, runId, mode, esc) {
    if (root.querySelector('.tfd-confirm')) return;
    const redispatch = mode === 'redispatch';
    const row = document.createElement('div');
    row.className = 'tfd-confirm';
    row.innerHTML = '<div><b>' + (redispatch ? '重新派发「' : '换一个执行底座重跑「') +
      esc(node.name || node.key || '这一关') + '」</b>' +
      '<span>正在查在线底座…</span></div>' +
      '<div><button data-tfd-agent="no">先不动</button></div>';
    root.querySelector('.tfd-hero').appendChild(row);
    row.querySelector('[data-tfd-agent="no"]').addEventListener('click', () => row.remove());
    let substrates = [];
    try {
      const options = await SoduWorkAPI.taskExecutionOptions({});
      substrates = (options && options.substrates) || [];
    } catch (error) { /* Treat an unavailable runtime list as empty. */ }
    if (!row.isConnected) return;
    const usable = substrates.filter((item) => !(item && (item.available === false || item.available === 0 ||
      ['false', '0', 'no', 'offline', 'unavailable'].includes(String(item.available == null ? '' : item.available).trim().toLowerCase()))));
    if (!usable.length) {
      const hint = row.querySelector('span');
      if (hint) hint.textContent = '当前没有其它可用的在线底座；等 Runner 上线后再试。';
      return;
    }
    const current = String(((node.executor || {}).resolved || {}).agentKind ||
      ((node.executor || {}).requested || {}).agentKind || '');
    row.querySelector('span').textContent = redispatch
      ? '会先叫停当前执行，再按你选的底座重新派；已通过的关卡和证据全部保留。'
      : '只换这一关的执行底座；已通过的关卡和证据全部保留。';
    const picker = document.createElement('select');
    picker.setAttribute('data-tfd-agent-pick', '');
    /* Retry excludes the failed runtime; redispatch permits the same runtime on another machine. */
    picker.innerHTML = usable.map((item) => '<option value="' + esc(item.key) + '"' +
      (!redispatch && item.key === current ? ' disabled' : '') + '>' + esc(item.name || item.key) +
      (item.onlineSeats ? '（' + item.onlineSeats + ' 个在线席位）' : '') +
      (item.key === current ? ' · 当前底座' : '') + '</option>').join('');
    const first = usable.find((item) => item.key !== current) || usable[0];
    picker.value = first.key;
    row.insertBefore(picker, row.lastElementChild);
    const go = document.createElement('button');
    go.className = 'primary';
    go.textContent = redispatch ? '叫停并重派' : '用它重跑';
    row.lastElementChild.appendChild(go);
    go.addEventListener('click', async () => {
      if (go.disabled) return;
      go.disabled = true; go.textContent = '正在重新派发…';
      try {
        if (redispatch) await SoduWorkAPI.redispatchTaskPluginGate(runId, node.key || '', { agentKind: picker.value });
        else await SoduWorkAPI.retryTaskPluginGate(runId, node.key || '', { agentKind: picker.value });
        if (typeof petSay === 'function') petSay(redispatch ? '已重新派发这一关' : '已换底座重跑这一关');
        await state.refresh(true);
      } catch (error) {
        go.disabled = false; go.textContent = redispatch ? '叫停并重派' : '用它重跑';
        if (typeof petSay === 'function') petSay(typeof _humanErr === 'function'
          ? _humanErr(error, '这一关暂时没能重新派发') : '这一关暂时没能重新派发');
      }
    });
  }

  async function copyText(value) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try { await navigator.clipboard.writeText(value); return true; } catch (_) { /* file:// fallback */ }
    }
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;left:-10000px;top:-10000px;opacity:0';
    document.body.appendChild(area);
    area.focus(); area.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch (_) { copied = false; }
    area.remove();
    return copied;
  }

  window.TaskTraceExecutionDetails = Object.freeze({
    sessionHtml, deploymentHtml, handoffHtml, failureHtml,
    confirmHandoff, confirmRetryAgent, copyText,
  });
})();
