'use strict';

const RESUME_PROMPT = [
  '继续完成当前会话中已经确认的原目标。',
  '先读取现有工作区和会话进度，只补齐尚未完成或未通过验证的部分；',
  '沿用当前底座的原生规划与执行能力，不重新开始，也不要向用户复述这条内部指令。',
].join('');

function createRunnerGoalControls(options) {
  const {
    state, turnQueue, snapshot, requestStop, emit, settle, continueTurn,
  } = options;

  function clearTimer() {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  }

  return {
    pauseGoal() {
      if (!state.goalVisible) return { ok: false, reason: '当前没有正在运行的目标' };
      if (state.goalPaused) return { ok: true, snapshot: snapshot() };
      state.goalPaused = true;
      state.goalLimit = {
        kind: 'user',
        reason: '已暂停当前执行，已有进度、上下文和工作区均已保留',
        used: state.step,
        limit: state.maxSteps,
        unit: '个执行步骤',
      };
      state.cancelRequested = true;
      clearTimer();
      requestStop();
      state.status = 'idle';
      state.statusText = state.goalLimit.reason;
      emit('goal-paused');
      settle({ ok: true, paused: true, snapshot: snapshot() });
      return { ok: true, snapshot: snapshot() };
    },

    continueGoal() {
      if (!state.goalVisible) return { ok: false, reason: '当前没有可继续的目标' };
      if (!state.goalPaused) return { ok: false, reason: '当前目标没有暂停' };
      if (state.stopPending || state.pendingPermissions?.length || state.status === 'streaming' || state.status === 'queued' || turnQueue.size()) {
        return { ok: false, reason: '当前还有消息正在执行或排队' };
      }
      turnQueue.resume();
      state.cancelRequested = false;
      state.goalPaused = false;
      state.goalLimit = null;
      const completion = continueTurn(RESUME_PROMPT, [], {
        recordUser: false,
        promptText: RESUME_PROMPT,
      });
      return { ok: true, accepted: true, completion };
    },

    disableGoal() {
      if (!state.goalVisible) return { ok: true, snapshot: snapshot() };
      state.goalVisible = false;
      state.intent = '';
      state.goalPaused = false;
      state.goalLimit = null;
      if (state.pendingPermissions?.length || state.status === 'streaming' || state.status === 'queued') {
        state.cancelRequested = true;
        clearTimer();
        requestStop();
        state.status = 'aborted';
        state.statusText = '已关闭目标模式并停止当前执行';
        settle({ ok: true, cancelled: true, snapshot: snapshot() });
      } else {
        state.statusText = '';
      }
      emit('goal-disabled');
      return { ok: true, snapshot: snapshot() };
    },
  };
}

module.exports = { RESUME_PROMPT, createRunnerGoalControls };
