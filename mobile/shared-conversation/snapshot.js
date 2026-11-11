(function (global) {
  'use strict';
  const terminal = value => /^(completed|done|failed|stopped|cancelled|canceled|error)$/.test(value || '');
  // Hub execution_sessions treats timezone-free database timestamps as UTC.
  function utc(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[T ]/.test(value) && !/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
      ? value.replace(' ', 'T') + 'Z' : value;
  }
  function epoch(value) {
    const parsed = Date.parse(utc(value));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  function project(handle) {
    if (handle.workflow) return global.SoduWorkMobileWorkflow.project(handle);
    const state = {messages: [], tools: [], adapterId: handle.adapterId};
    const runner = global.SoduWorkRunnerMessages.create(state);
    let usage = null, turnStarted = 0, lastEvent = 0;
    for (const raw of [...handle.events.values()].sort((a, b) => a.seq - b.seq)) {
      const item = {...raw, at: utc(raw.at)};
      const text = String(item.full || item.text || '');
      lastEvent = Math.max(lastEvent, epoch(item.at));
      if (item.kind === 'user') {
        runner.finish(item.at);
        turnStarted = epoch(item.at); usage = null;
        state.messages.push({role: 'user', text, done: true, blocks: [], sentAt: handle.localTimes?.get(item.seq) || Date.parse(item.at) || 0,
          attachments: item.attachments || [], taskOutputKey: 'remote:' + handle.taskId + ':' + item.seq});
      } else if (runner.apply(item, text)) {
        if (item.kind === 'usage') usage = item.usage || usage;
      } else if (item.kind === 'say') {
        state.messages.push({role: 'assistant', blocks: [{kind: 'text', text, done: true}], done: true,
          completedAt: Date.parse(item.at) || 0, sourceAgent: {agentId: handle.adapterId}});
      } else if (item.kind === 'do') {
        // Same Runner contract as PC: do starts a tool; out is its receipt,
        // never assistant prose. Keep preparations and concurrent call IDs.
        const preparing = runner.takePreparation(item);
        state.tools.push({id: preparing?.id || 'runner-' + item.seq,
          callId: String(item.callId || ''), name: item.tool || 'command',
          toolKind: String(item.toolKind || '').slice(0, 40),
          args: runner.argumentsOf(item, text), partial: '', result: '',
          isError: false, state: 'running', after: Math.max(0, state.messages.length - 1),
          startedAt: epoch(item.at), lastProgressAt: epoch(item.at),
          sourceAgent: {agentId: handle.adapterId}});
      } else if (item.kind === 'out') {
        runner.takePreparation(item);
        const current = [...state.tools].reverse().find(tool => tool.state === 'running' &&
          (!item.callId || tool.callId === String(item.callId)));
        const cancelled = item.state === 'cancelled' && item.cancelReason === 'access-change' && item.isError === false;
        const isError = !cancelled && (typeof item.isError === 'boolean' ? item.isError : /error|stderr|错误/i.test(item.tool || ''));
        const receipt = {result: text, isError, state: cancelled ? 'cancelled' : isError ? 'error' : 'done',
          ...(cancelled ? {cancelReason: 'access-change'} : {}),
          lastProgressAt: epoch(item.at), endedAt: epoch(item.at)};
        if (current) Object.assign(current, receipt);
        else if (text) state.tools.push({id: 'runner-' + item.seq,
          callId: String(item.callId || ''), name: item.tool || (isError ? 'error' : 'output'),
          args: {}, partial: '', after: Math.max(0, state.messages.length - 1),
          startedAt: epoch(item.at), sourceAgent: {agentId: handle.adapterId}, ...receipt});
      }
    }
    const settled = terminal(handle.status);
    const ended = epoch(handle.finishedAt) || (settled ? lastEvent : 0);
    if (settled) {
      runner.finish(ended ? new Date(ended).toISOString() : undefined);
      // A terminal session must not leave a permanent tool spinner. As on PC,
      // stop the visual activity without inventing a missing tool receipt.
      for (const tool of state.tools) if (tool.state === 'running') tool.state = 'done';
    }
    const failed = /^(failed|error)$/.test(handle.status || '');
    const stopped = /^(stopped|cancelled|canceled)$/.test(handle.status || '');
    const offline = handle.error || (!settled ? handle.liveError : '') || '';
    const reason = failed ? (handle.runtimeError || '本轮执行失败，已有记录已保留。请检查执行环境后重试。')
      : stopped ? (handle.runtimeError || '本轮已停止，已有内容已保留。') : '';
    const busy = !handle.restoring && !offline && !settled && !['idle', ''].includes(handle.status);
    const started = turnStarted || epoch(handle.startedAt);
    // Never let an old completed turn accumulate elapsed time while reopening.
    const until = ended || (busy ? Date.now() : lastEvent);
    const elapsedMs = started && until >= started ? until - started : 0;
    return {messages: state.messages.map(message => ({...message, taskId: handle.taskId || ''})), tools: state.tools, usage, model: handle.model,
      modelSelection: {name: handle.model?.name || '', model: handle.model, effective: handle.pendingExecutionSelection ? 'next-turn' : ''},
      adapterId: handle.adapterId, displayName: handle.displayName,
      status: offline ? 'unreachable' : handle.restoring ? 'loading' : failed ? 'no-output' : busy ? 'streaming' : 'idle',
      statusText: offline ? '连接暂时中断，正在重新连接；已有记录已保留。' : handle.restoring ? '正在读取会话记录…' : reason,
      restoring: Boolean(handle.restoring),
      mobileAcceptance: handle.mobileAcceptance,
      mobileAccess: {canSend: handle.canSend, reason: handle.readOnlyReason || '', personal: handle.personal === true, relay: handle.personalRelay},
      execution: {configured: false, visible: false, running: busy, stopped: failed || stopped, reason,
        elapsedMs, terminalAt: settled ? ended : 0, queue: []},
      // Do not advertise controls the remote transport cannot honour.
      accessControl: {supported: false},
      cloudHandoff: handle.taskId && !handle.personal ? {phase: 'committed', taskId: handle.taskId} : undefined,
      remote: true};
  }
  global.SoduWorkMobileSnapshot = {project, terminal};
})(window);
