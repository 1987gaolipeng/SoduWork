'use strict';

function create({ state, queue, runtime, emit, poll, drain, timeoutMs }) {
  return require('../pi-session/queue-immediate').create({ queue, drain, timeoutMs,
    changed: () => emit('queue-changed'),
    settled: () => !queue.active() && !state.stopPending && !state.turnSubmissionPending &&
      ['idle', 'aborted'].includes(state.status),
    unavailable() {
      const active = queue.active();
      if (state.disposed) return '会话已关闭';
      if (active && (active.options.taskId || active.options.controlled || active.options.goalMode) || state.goalVisible)
        return '当前任务正在执行，请等待任务结束后再引导';
      if (state.accessChangePending) return '正在切换权限，请稍后重试';
      if (state.cancelRequested || state.stopPending) return '正在停止当前回复，请稍候';
      if (state.preparingPlugins || state.turnSubmissionPending || state.started && !state.dispatchReady)
        return '消息正在准备发送，请稍后重试';
      if (!active && ['streaming', 'queued', 'waiting-user'].includes(state.status))
        return '当前回复正在恢复或等待处理，请处理后再引导';
      return '';
    },
    async interrupt(active, valid) {
      if (!state.started || !active && ['idle', 'aborted'].includes(state.status)) return;
      const stopToken = {};
      state.stopPending = stopToken;
      try {
        const reply = await runtime.rpc('job.stop', { ref: state.runnerRef }, 15000);
        const data = reply?.data || {};
        if (!reply || reply.ok === false || data.ok === false) throw Error(data.error || reply?.error || 'Stop unconfirmed');
        // A stop RPC acknowledges the request, not process exit. Keep the
        // normal paginated stream alive: only its terminal record settles the
        // active turn and permits job.comment with full attachment/config data.
        if (valid() && !state.disposed) {
          clearTimeout(state.timer);
          // A prior transport failure can settle the local queue while the
          // remote process remains unknown. Retry must obtain a real terminal
          // snapshot before the shared controller can release another turn.
          if (!active) await poll();
          else state.timer = setTimeout(poll, 0);
        }
      } finally {
        // The guide may time out before its RPC settles. Release only this
        // request's stop ownership, even after expiry; a newer/manual stop
        // must keep its own pending state and must not be cleared here.
        if (state.stopPending === stopToken) {
          state.stopPending = false;
          if (!state.disposed) emit('queue-changed');
        }
      }
    },
  });
}
module.exports = { create };
