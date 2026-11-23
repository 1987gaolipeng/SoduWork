'use strict';

const RESUME_PROMPT = [
  '继续完成当前会话中已经确认的原目标。',
  '先读取现有工作区和会话进度，只补齐尚未完成或未通过验证的部分；',
  '沿用当前底座的原生规划与执行能力，不重新开始，也不要向用户复述这条内部指令。',
].join('');

function continuationBlocked(state, turnQueue) {
  return Boolean(state.disposed || state.recoveryRequired || state.goalStopAwaitingTerminal || state.pendingTaskGoalControl ||
    state.turnSubmissionPending || state.pluginGenerationPreparing || state.pluginGenerationActive ||
    state.preparingPlugins || state.accessChangePending || state.accessRestorePending ||
    state.queueImmediate?.blocked() || state.stopPending || state.manualStopRequested ||
    state.pendingPermissions?.length || state.status === 'streaming' || state.status === 'queued' ||
    turnQueue.active?.() || state.started && !state.terminalConfirmed);
}

function createRunnerGoalControls(options) {
  const {
    state, turnQueue, snapshot, requestStop, emit, settle, continueTurn, drainTurns, hasPausedPreparation,
  } = options;

  function clearTimer() {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  }

  return {
    pauseGoal() {
      if (!state.goalVisible) return { ok: false, reason: '当前没有正在运行的目标' };
      if (state.goalPaused) {
        if (state.pendingTaskGoalControl === 'pause') requestStop('pause');
        return { ok: true, snapshot: snapshot() };
      }
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
      requestStop('pause');
      state.status = 'idle';
      state.statusText = state.goalLimit.reason;
      emit('goal-paused');
      settle({ ok: true, paused: true, snapshot: snapshot() });
      return { ok: true, snapshot: snapshot() };
    },

    continueGoal() {
      if (!state.goalVisible) return { ok: false, reason: '当前没有可继续的目标' };
      if (!state.goalPaused) return { ok: false, reason: '当前目标没有暂停' };
      if (continuationBlocked(state, turnQueue)) {
        return { ok: false, reason: '当前还有消息正在执行或排队' };
      }
      if (state.goalLimit?.canContinue === false) return { ok: false, reason: state.goalLimit.reason };
      const queued = turnQueue.find?.(turnQueue.view?.()[0]?.id);
      if (queued?.options.controlled) return { ok: false, reason: '请先关闭当前目标，再执行排队任务' };
      turnQueue.resume();
      state.cancelRequested = false;
      state.goalPaused = false;
      state.goalLimit = null;
      if (queued && !hasPausedPreparation?.()) {
        queued.options = { ...queued.options, taskGoalControl: 'continue' };
        drainTurns();
        return { ok: true, accepted: true, completion: queued.completion };
      }
      const completion = continueTurn(RESUME_PROMPT, [], {
        recordUser: false,
        promptText: RESUME_PROMPT,
        taskGoalControl: 'continue',
      });
      return { ok: true, accepted: true, completion };
    },

    disableGoal() {
      if (!state.goalVisible) {
        if (state.pendingTaskGoalControl === 'disable') requestStop('disable');
        return { ok: true, snapshot: snapshot() };
      }
      state.goalVisible = false;
      state.intent = '';
      state.goalPaused = false;
      state.goalLimit = null;
      state.taskGoalContract = null;
      if (state.taskGoal) state.taskGoal = { ...state.taskGoal, status: 'disabled', reason: '' };
      // Even an idle native session retains its goal contract. Disable it in
      // the same stop transaction, without starting a model turn.
      requestStop('disable');
      if (state.pluginGenerationPreparing || state.pendingPermissions?.length || state.status === 'streaming' || state.status === 'queued') {
        state.cancelRequested = true;
        clearTimer();
        state.status = 'aborted';
        state.statusText = '已关闭目标模式并停止当前执行';
        settle({ ok: true, cancelled: true, snapshot: snapshot() });
      } else {
        state.statusText = '';
      }
      if (!state.started) {
        turnQueue.stopActive();
        state.cancelRequested = false;
        queueMicrotask(drainTurns);
      }
      emit('goal-disabled');
      return { ok: true, snapshot: snapshot() };
    },
  };
}

module.exports = { RESUME_PROMPT, createRunnerGoalControls, continuationBlocked };
