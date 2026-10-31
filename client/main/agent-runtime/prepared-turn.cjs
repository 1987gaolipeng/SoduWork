'use strict';
// Share plugin, skill, and on-demand connector preparation with Runner; credentials live only for the executing turn.
async function send(context) {
  const { state, opts, next, skillTurn, pluginTurn, emit, invalidateObservation,
    redactors, appendUser, dispatch, continueTurn, conversationPrompt, skillRows, TURN_SKILLS } = context;
  const cancelled = () => Boolean(state.disposed || state.cancelRequested || state.goalPaused || next.stopRequested);
  invalidateObservation();
  state.preparingPlugins = true;
  state.status = 'streaming';
  state.statusText = next.options.skills?.length ? '正在加载所选技能…'
    : pluginTurn.requestedIds(next.options).length ? '正在加载所选插件…' : '正在检查连接器…';
  emit('changed');
  const selectedSkills = await skillTurn.prepareRunner(opts, next.options);
  // Use current turn permissions over the opening snapshot so a read-only revision cannot issue connector tickets.
  const accessPolicy = state.nextAccessPolicy || state.accessPolicy || opts.accessPolicy;
  const current = { ...opts, accessPolicy, readOnly: accessPolicy ? accessPolicy.mode === 'readonly' : opts.readOnly };
  const prepared = selectedSkills.ok ? await pluginTurn.prepare(current, next.options, cancelled, {
    allowUnavailableApp: !next.options.taskId && !current.taskRef && current.intent !== 'goal' &&
      !state.goalEnabled && !state.goalVisible && !next.options.goalMode && !next.attachments?.length,
  })
    : { ...selectedSkills, cleanup() {} };
  state.preparingPlugins = false;
  try {
    if (cancelled()) {
      state.status = 'aborted'; state.statusText = '已停止';
      return { ok: true, cancelled: true };
    }
    if (!prepared.ok) {
      if (prepared.failureKind === 'skill-selection') context.onSkillFailure(prepared);
      state.status = 'unreachable'; state.statusText = prepared.reason;
      state.completion = { reason: 'error', error: prepared.reason };
      emit('changed');
      return { ok: false, reason: prepared.reason, failureKind: prepared.failureKind,
        retrySafe: prepared.retrySafe !== false,
        ...(prepared.pluginAuthorization ? { pluginAuthorization: prepared.pluginAuthorization } : {}) };
    }
    if (prepared.hasSecrets) redactors.add(prepared.redact);
    let materialUnderstanding = { eligible: false, prompt: '' };
    if (next.attachments?.length) {
      try {
        materialUnderstanding = await require('../conversation/conversation-input-preparation.cjs').prepare({
          text: Object.prototype.hasOwnProperty.call(next.options.inputPreparation || {}, 'userText')
            ? next.options.inputPreparation.userText : next.text,
          files: next.attachments, plugins: prepared.badges,
          fallback: Boolean(next.options.inputPreparation?.fallback), signal: next.signal,
        });
      } catch (error) {
        materialUnderstanding = { eligible: true, status: 'error', prompt: '本轮附件理解准备失败：' + String(error?.message || error) +
          '\n请不要假设附件内容已经读取；如需继续，请先说明处理目标或重新提供材料。' };
      }
    }
    const materialPrompt = materialUnderstanding.eligible ? materialUnderstanding.prompt : '';
    const options = { ...next.options, plugins: prepared.badges,
      [TURN_SKILLS]: skillTurn.runnerRows(skillRows(state.selectedSkills), selectedSkills),
      [pluginTurn.RESOURCE_BUNDLES]: prepared.resourceBundles,
      promptText: prepared.augment([materialPrompt, next.options.promptText || conversationPrompt(next.text, current),
        selectedSkills.prompt].filter(Boolean).join('\n\n')) };
    appendUser(next.text, next.attachments, prepared.badges, next.options.sentAt, next.options.submissionId);
    emit('turn-dequeued', { queueId: next.id, taskId: next.options.taskId || '' });
    return await (state.started ? continueTurn(next.text, next.attachments, options)
      : dispatch(next.text, next.attachments, options));
  } finally { prepared.cleanup(); }
}
module.exports = { send };
