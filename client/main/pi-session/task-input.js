'use strict';
const { taskPrompt } = require('./task-turn');
const { MAX_BYTES, MAX_FILES } = require('./attachments');
const { fetchWithDeviceAuthRetry } = require('../device-auth-request');

async function request(identity, route, body) {
  const response = await fetchWithDeviceAuthRetry(identity, String(identity.hub).replace(/\/+$/, '') + '/api/v1' + route, {
    method: body ? 'POST' : 'GET', redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000),
  });
  let data = {};
  try { data = await response.json(); }
  catch (_) { data = {}; }
  require('../requirement-diagnostics.cjs').http(identity, route, body, data, response.status);
  if (!response.ok || data.ok === false) {
    const status = Number(response.status) || 0;
    const error = new Error(typeof data.detail === 'string' ? data.detail
      : typeof data.detail?.message === 'string' ? data.detail.message
      : status === 401 ? '登录已过期，请重新连接 SoduWork 服务后继续'
      : status === 403 ? '当前连接没有执行此操作的权限'
      : '需求服务暂不可用，请稍后重试');
    error.status = status;
    error.code = typeof data.code === 'string' ? data.code : status === 401 ? 'AUTH_REQUIRED' : status === 403 ? 'PERMISSION_REQUIRED' : 'REQUEST_FAILED';
    error.authRequired = status === 401 || error.code === 'AUTH_REQUIRED';
    error.permissionRequired = status === 403 || error.code === 'PERMISSION_REQUIRED';
    error.retryable = error.authRequired || error.permissionRequired ? false : status === 0 || status >= 500 || status === 429;
    throw error;
  }
  return data;
}
function attachmentUrl(identity, file) {
  const base = new URL(String(identity.hub).replace(/\/+$/, '') + '/');
  const url = new URL(String(file.url || ''), base);
  const expected = '/api/v1/attachments/' + encodeURIComponent(file.id);
  // The authenticated list mints a short-lived, single-attachment ticket.
  // Accept only that resource on this Hub; never forward auth to a supplied host.
  if (url.origin !== base.origin || url.pathname !== expected ||
      !url.searchParams.get('ticket')) throw new Error('需求附件访问地址无效，请刷新需求后重试');
  return base.origin + expected + '?ticket=' + encodeURIComponent(url.searchParams.get('ticket'));
}
function attachmentRound(file) {
  const meta = file && (file.evidenceMeta || file.evidence_meta || {});
  const value = meta.round ?? file?.round;
  const round = Number(value);
  return Number.isFinite(round) && round > 0 ? round : 0;
}

function attachmentBatch(file) {
  const meta = file && (file.evidenceMeta || file.evidence_meta || {});
  return String(file?.sourceRef || file?.source_ref || meta.identifier ||
    meta.conversationId || meta.conversation_id || 'legacy').trim() || 'legacy';
}

function attachmentStamp(file, index) {
  const raw = file?.createdAt ?? file?.created_at ?? file?.updatedAt ?? file?.at ?? '';
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : index;
}

/* A rework session must read the result it is correcting, not every historical
   copy attached to the requirement. A sourceRef/identifier identifies a
   delivery batch; round identifies a revision within that batch. Legacy rows
   with neither marker stay eligible because there is no safe way to infer a
   newer batch from them. */
function latestDeliveryAttachments(rows) {
  const delivery = (Array.isArray(rows) ? rows : [])
    .filter(file => String(file?.role || '') !== 'rework_input');
  const hasVersion = delivery.some(file => attachmentRound(file) > 0 || attachmentBatch(file) !== 'legacy');
  if (!hasVersion) return delivery;
  const isRequirementInput = file => attachmentRound(file) === 0 &&
    attachmentBatch(file) === 'legacy' && String(file?.role || '') === 'input';
  const batches = new Map();
  delivery.forEach((file, index) => {
    // Later requirement uploads remain context, but cannot select a delivery batch.
    if (isRequirementInput(file)) return;
    const key = attachmentBatch(file);
    const previous = batches.get(key) || {key, stamp: -1, index: -1, round: 0};
    previous.stamp = Math.max(previous.stamp, attachmentStamp(file, index));
    previous.index = Math.max(previous.index, index);
    previous.round = Math.max(previous.round, attachmentRound(file));
    batches.set(key, previous);
  });
  const latest = [...batches.values()].sort((a, b) => a.stamp - b.stamp || a.index - b.index).at(-1);
  if (!latest) return delivery;
  return delivery.filter(file => {
    const round = attachmentRound(file), batch = attachmentBatch(file);
    /* Human supplied requirement material has no delivery batch. Keep it as
       context for a correction, while old unversioned outputs must not leak
       into a versioned rework session. */
    return isRequirementInput(file) || (batch === latest.key && (round === latest.round || round === 0));
  });
}

async function loadTaskAttachments(identity, route, selection) {
  const options = Array.isArray(selection) ? {selectedIds: selection} : (selection || {});
  const manifest = options.inputManifest;
  const changed = name => new Error('需求附件' + (name ? '「' + String(name).slice(0, 200) + '」' : '') +
    '自预览后已变化，请重新预览后再派发');
  if (manifest) {
    const preview = await request(identity, route + '/ai-preview', {inputManifest: manifest});
    if (!require('node:util').isDeepStrictEqual(manifest, preview.carried?.inputManifest)) throw changed();
  }
  const selectedIds = Array.isArray(options.selectedIds) ? options.selectedIds : null;
  const listed = await request(identity, route + '/attachments');
  const available = Array.isArray(listed) ? listed : listed.attachments || [];
  const scoped = options.latestDelivery ? latestDeliveryAttachments(available) : available;
  const files = manifest ? manifest.map(entry => scoped.find(file => file.id === entry.id))
    : selectedIds ? scoped.filter(file => selectedIds.includes(file.id)) : scoped;
  const missing = manifest && files.findIndex(file => !file);
  if (manifest && missing >= 0) throw changed(manifest[missing].name);
  if (Array.isArray(selectedIds) && selectedIds.some(id => !files.some(file => file.id === id)))
    throw Error('本次验收材料已变化或不可读，请刷新需求后重新分析');
  if (files.length > MAX_FILES) throw new Error('需求附件超过本轮可接收的数量，请先调整附件');
  const attachments = [];
  let bytes = 0;
  for (const file of files) {
    const response = await fetch(attachmentUrl(identity, file), {
      redirect: 'error', signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      if (manifest) throw changed(file.filename || file.name);
      throw new Error('需求附件未能读取，请重试；本次没有开始执行');
    }
    const reader = response.body.getReader(), chunks = [];
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_BYTES) throw new Error('需求附件总大小超过 256 MB');
        chunks.push(Buffer.from(part.value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    const name = file.filename || file.name, data = Buffer.concat(chunks);
    if (manifest) {
      const expected = manifest[attachments.length];
      if (name !== expected.name || data.byteLength !== expected.size ||
          require('node:crypto').createHash('sha256').update(data).digest('hex') !== expected.sha256) throw changed(expected.name);
    }
    attachments.push({ name, data,
      mimeType: file.contentType || file.content_type || file.mimeType || '',
      attachmentId: String(file.id || file.attachmentId || ''), role: String(file.role || ''),
      evidenceMeta: file.evidenceMeta || {}, sourceRef: String(file.sourceRef || '') });
  }
  return attachments;
}
async function prepare(identity, taskId, conversationId, turnId, instruction, requested = {}, runtime) {
  if (!identity || !identity.hub) throw new Error('请先连接 SoduWork 服务');
  const route = '/tasks/' + encodeURIComponent(taskId);
  const task = await request(identity, route);
  require('../requirement-diagnostics.cjs').record('native.prepared', {
    ...require('../../core/requirement-diagnostics').task(task),taskId,conversationId,turnId,
    selectedMode:requested.submissionMode,hubKey:identity.hub});
  // Review analysis reads requirement context and attachments without execution or plugin-run receipts.
  // Allow reviewer follow-ups without accidentally starting the requirement.
  if (requested.acceptanceOnly === true) {
    const acceptance = await require('./acceptance-turn').prepare({ identity, taskId, turnId, instruction,
      requested, runtime, request });
    const bundle = acceptance.deliveryBundle;
    const extraIds = [...new Set([...acceptance.referenceAttachmentIds, ...acceptance.optionalAttachmentIds])];
    if (bundle && extraIds.length + 1 > MAX_FILES)
      throw new Error('需求附件超过本轮可接收的数量，请先调整附件');
    const attachments = bundle
      ? [await require('./acceptance-bundle').load(identity, route, bundle)]
      : await loadTaskAttachments(identity, route, acceptance.attachmentIds);
    if (bundle && extraIds.length)
      attachments.push(...await loadTaskAttachments(identity, route, extraIds));
    if (attachments.reduce((size, file) => size + file.data.byteLength, 0) > MAX_BYTES)
      throw new Error('需求附件总大小超过 256 MB');
    return { ...acceptance, attachments };
  }
  const controlled = require('./controlled-task-turn');
  if (requested.followUp === true && ['done', 'cancel'].includes(task.status)) {
    const error = new Error('需求已经结束'); error.code = 'TASK_FINISHED'; throw error;
  }
  let spec = controlled.executionSpec(task, requested);
  const reuse = requested.reuseConversation === true;
  const reworkSession = requested.reworkSession === true;
  const explicitNative = requested.executionChoice === 'native';
  const submissionMode = ['auto', 'manual'].includes(String(requested.submissionMode || ''))
    ? String(requested.submissionMode) : '';
  const dispatchInstructions = require('./dispatch-instructions.cjs').submitted(requested);
  const captureModelSource = (retry = false, queuedModel) => {
    if (spec.mode !== 'native') return { source: 'managed', name: '' };
    const handle = runtime?.handle, selection = handle?.snapshot?.()?.modelSelection;
    const explicitModel = retry ? (typeof queuedModel === 'string' ? queuedModel.trim() : '')
      : String(spec.model || '').trim();
    const name = retry && typeof queuedModel === 'string' ? queuedModel.trim()
      : explicitModel || String(selection?.name || '').trim();
    const image = require('../../core/model-choice').imageChoice(name);
    const reference = image?.name || name;
    if (!reference.startsWith('local:')) return { source: 'managed', name };
    const agent = String(handle?.adapterId || '');
    const managed = require('../agent-runtime/runtime-catalog').runtime(agent)?.modelMode === 'managed';
    // A fresh task may apply its explicit model only when its queued turn
    // starts. Resolve that selection locally instead of trusting a raw source
    // flag or requiring the previous active model to have changed already.
    const local = managed && (explicitModel || selection?.model?.localOnly === true && selection.name === name) &&
      !(selection?.name === name && (selection.model?.unavailable || selection.model?.historicalLocal)) &&
      (!image || agent === 'pi') && require('../local-model-store.cjs').resolve(reference);
    if (!local?.localOnly) throw Error('本轮本地模型无法确认或已删除，请重新选择可用模型');
    return { source: 'device', name, agentId: 'local:' + agent };
  };
  let capturedModel = captureModelSource();

  // Attach task receipts to the prepare -> start -> collect -> complete lifecycle so outputs from
  // follow-up turns flow back to the task. Otherwise a later correction, such as changing the output
  // format to Markdown, can leave its files in the workspace without registering task deliverables.
  const followUp = reuse && !explicitNative && requested.followUp === true;
  const runnerContinuation = reuse && !explicitNative && (followUp || reworkSession) &&
    spec.mode === 'dispatch' && (/^runner:/.test(spec.agentId) ||
      task.workRouting?.conversationTurn?.executor === 'dispatch');
  const assertNativeChoice = current => {
    const routing = current?.workRouting || {}, context = routing.executionContext || {};
    if (routing.selectedStrategy !== 'direct' || routing.workflowBindingId || routing.selectedWorkflowBindingId ||
      context.strategy !== 'direct' || context.agent?.id !== spec.agentId || context.runner?.mode !== 'local' ||
      (capturedModel.source === 'device'
        ? context.modelSource !== 'device' || Boolean(context.model)
        : String(context.model || '') !== spec.model))
      throw new Error('服务端未确认本次执行选择或安排已变化，请刷新后重新选择；旧服务端需更新后再改选');
  };
  const verifyReuse = async (refresh = false, quick = false) => {
    if (!runtime?.handle || runtime.handle.sessionId !== conversationId)
      throw new Error('无法确认原会话，请重新打开后再安排需求');
    if (runtime.identityOf) identity = await runtime.identityOf();
    const context = require('../conversation/requirement-context');
    context.assertOwner(runtime.app, runtime.handle, identity);
    if (quick) return;
    const fresh = refresh ? await request(identity, route) : task;
    const receipt = fresh.workRouting?.conversationTurn || {};
    // Recover only this send's persisted queue entry after an uncertain prepare response; unrelated execution is not a retry.
    const sameQueued = !refresh && fresh.status === 'todo' && !fresh.archivedAt &&
      fresh.requirementStage !== 'reviewing' && !['intake', 'clarifying'].includes(fresh.triageStage) &&
      receipt.state === 'queued' && receipt.executor === 'native' &&
      receipt.conversationId === conversationId && receipt.turnId === turnId;
    // After queuing, use Hub's saved selection instead of reapplying stale override markers over concurrent changes.
    const savedNative = explicitNative && (refresh || sameQueued);
    if (savedNative) assertNativeChoice(fresh);
    const checked = savedNative ? { ...requested, executionChoice: undefined } : requested;
    await context.validate({ ...runtime, identity }, fresh, checked,
      controlled.executionSpec(fresh, checked), route => request(identity, route));
  };
  if (reuse || explicitNative) {
    await verifyReuse(false, followUp || runnerContinuation);
    if (runnerContinuation) {
      // Keep the original executor and workspace. A local transcript is not a
      // native workspace copy of the Runner files shown in that transcript.
      const page = await request(identity, route + '/ai-session?since=1000000000');
      if (!page.ref || page.canSend === false) throw Error(page.readOnlyReason || '原执行会话不可继续，请刷新需求后重试');
      spec = { ...spec, continuationRef: String(page.ref) };
    } else spec = { ...spec, mode: 'native' };
  }
  // When manually restarting rejected work, include the review feedback in the new turn.
  // Preserve the original feedback rather than relying on a short generic rework request.
  // This gives the executor the actual requested corrections from task details.
  const rework = (followUp || reworkSession) ? ((task.workRouting || {}).reworkPending || {}) : {};
  const reworkFeedback = String(rework.feedback || '').trim();
  const text = (followUp || reworkSession) ? (String(instruction || '') + (reworkFeedback ?
    ('\n\n【验收打回意见 · ' + (String(rework.actor || '').trim() || '验收人') + '】' + reworkFeedback +
     '\n（验收人已退回上一版交付，本轮请按此意见返修现有交付并重新完整提交，不要从零重做。）') : '')) :
    taskPrompt(task, instruction);
  if (!followUp && text.length > 50000) throw new Error('需求文字超过 50000 字符，请把长材料作为附件后重试；内容没有被截断或执行');
  let attachments = followUp || runnerContinuation ? [] : await loadTaskAttachments(identity, route,
    requested.inputManifest ? {inputManifest: requested.inputManifest} : reworkSession ? {latestDelivery: true} : undefined);
  const scope = { conversationId, turnId };
  const nativeReceiptScope = () => capturedModel.source === 'device'
    ? { ...scope, modelSource: 'device', modelAgentId: capturedModel.agentId } : scope;
  // Freeze receipt ownership while preparation still has an authenticated account.
  // Queue admission is not execution; only the runtime start acknowledgement records it.
  const startReceipt = spec.mode === 'native' ? runtime?.startReceipts?.forTask(identity, taskId) : null;
  // An omitted choice on an existing task preserves its saved policy. A new
  // native default may infer submission only after Hub validates real outputs.
  const routing = task.workRouting || {};
  const inferSubmission = spec.mode === 'native' && !submissionMode &&
    !['manual', 'auto'].includes(dispatchInstructions?.submissionMode) &&
    (Object.hasOwn(requested, 'submissionMode') && requested.submissionMode === '' ||
      dispatchInstructions?.submissionMode === 'default' ||
      !requested.followUp && !routing.executionSubmissionChoice && !routing.executionSubmissionMode);
  let executionStarted = false, startAcknowledged = false;
  // A turn can outlive the 30-minute device session token (long AI runs), so
  // every receipt call re-resolves the identity first; a renewal failure keeps
  // the last known identity rather than sending a doomed stale token.
  const freshIdentity = async () => {
    if (runtime?.identityOf) {
      try { identity = await runtime.identityOf(); } catch (_) { /* keep last identity */ }
    }
    return identity;
  };
  const transition = action => freshIdentity()
    .then(id => request(id, route + '/conversation-turn', { action, ...scope, executor: spec.mode,
      ...(capturedModel.source === 'device' ? { modelSource: 'device', agentId: capturedModel.agentId } : {}),
      ...(action === 'prepare' && dispatchInstructions ? {dispatchInstructions} : {}),
      ...(action === 'prepare' && inferSubmission ? {submissionChoice: 'infer'} : {}),
      ...(spec.continuationRef ? { continuationRef: spec.continuationRef } : {}),
      ...(submissionMode ? { submissionMode } : {}),
      ...(explicitNative && action === 'prepare' ? { executionChoice: 'native',
        agentId: spec.agentId, model: capturedModel.source === 'device' ? '' : spec.model } : {}) }));
  // Freeze bytes before the terminal receipt. The existing durable transport
  // queue retries uploads without re-executing the model or rereading files.
  let settlementFailed = false, capturedSettlement = null, settledResult = null;
  const captureIssue = code => ({action: code === 'capture_failed' ? 'fail' : 'wait', deliveryIssue: {code,
    reason: code === 'capture_pending' ? '执行已结束，正在收集交付文件；如收集中断，请检查工作区和交付清单后重新交付。' : '交付文件收集失败，尚未提交验收；请检查工作区文件和交付清单，修复后重新交付。'}});
  const persistCaptured = async () => {
    const result = await startReceipt.finish(nativeReceiptScope(), capturedSettlement.body,
      {started: executionStarted && !startAcknowledged, delivery: capturedSettlement.delivery});
    settlementFailed = false;
    // Waiting is resumable. Once its receipt is durably accepted, a later
    // completion must collect the resumed output instead of replaying wait.
    if (capturedSettlement.body.action === 'wait') capturedSettlement = null;
    else settledResult = result;
    return result;
  };
  const deliverThen = async (action, outcome) => {
    // Controlled executors publish their own artifacts. Scanning this handle's
    // unrelated local cwd can neither collect nor replace those remote results.
    if (spec.mode !== 'native') return transition(action);
    if (settledResult) return settledResult;
    // A transport persistence failure is not a model failure. Retry exactly
    // the frozen completion, including when the turn queue reports failed.
    if (capturedSettlement && startReceipt) return persistCaptured();
    if (settlementFailed) {
      return startReceipt ? startReceipt.finish(nativeReceiptScope(), captureIssue('capture_failed'),
        {started:executionStarted && !startAcknowledged}) : transition('fail');
    }
    try {
      // A crash during asynchronous capture leaves a durable, scoped waiting
      // receipt. Restart only reports this interruption; it never rescans a
      // changed workspace or reruns the completed model.
      if (startReceipt && action === 'complete') await startReceipt.finish(nativeReceiptScope(),
        captureIssue('capture_pending'), {started:executionStarted && !startAcknowledged});
      const contract = (receipt.task?.workRouting || task.workRouting || {}).outputContract || {};
      // A kind or prose requirement alone does not require local files. Only
      // explicit file entries authorize treating an empty inventory as failure.
      const requiresFiles = !['repository-change', 'production-release'].includes(contract.kind) &&
        !String(receipt.task?.artifactUrl || task.artifactUrl || '').trim() &&
        [contract.deliverables, contract.expectedArtifacts, contract.outputs].some(rows =>
          Array.isArray(rows) && rows.some(row => row && typeof row === 'object' &&
            (typeof row.path === 'string' && row.path.trim() || typeof row.entry === 'string' && row.entry.trim())));
      const delivery = await require('./task-delivery.cjs').capture(runtime?.handle, outcome, {taskId,...scope}, {requiresFiles});
      require('../requirement-diagnostics.cjs').record('native.capture', {taskId,...scope,outcome,
        fileCount:delivery?.files?.length || 0});
      capturedSettlement = {body: {action, ...(submissionMode ? {submissionMode} : {})}, delivery};
      return startReceipt
        ? await persistCaptured()
        : (delivery && await require('./task-delivery.cjs').send(await freshIdentity(), route, scope, delivery),
          await transition(action));
    } catch (error) {
      settlementFailed = true;
      require('../requirement-diagnostics.cjs').record('native.capture', {taskId,...scope,ok:false,errorKey:String(error.message || error)});
      throw error;
    }
  };
  const previous = task.workRouting?.conversationTurn;
  // A resumed rework may retain its first-send flag if the client lost the acknowledgement.
  const recoverable = (followUp || reuse && reworkSession && !explicitNative) && previous?.executor === 'native' &&
    previous.conversationId === conversationId && previous.turnId &&
    ['queued', 'running', 'waiting'].includes(previous.state);
  const recoveryToken = recoverable ? await runtime?.handle?.claimInterruptedTask?.(taskId) : null;
  const releaseRecovery = typeof recoveryToken === 'string' && recoveryToken
    ? () => runtime.handle.releaseInterruptedTask(taskId, recoveryToken) : null;
  if (releaseRecovery) scope.turnId = previous.turnId;
  const receipt = releaseRecovery ? { turn: previous, task } : await transition('prepare');
  if (!releaseRecovery && receipt.turn.state !== 'queued') throw new Error('这项需求已经执行，请刷新后查看结果');
  const requireSubmissionAck = inferSubmission &&
    (Object.hasOwn(requested, 'submissionMode') || dispatchInstructions?.submissionMode === 'default');
  if (!releaseRecovery && requireSubmissionAck && receipt.task?.workRouting?.executionSubmissionChoice !== 'infer') {
    await transition('cancel').catch(() => {});
    throw Error('服务端未确认本次提交方式，请更新 Hub 并刷新需求后重新安排执行。');
  }
  if (explicitNative) {
    try { assertNativeChoice(receipt.task); }
    catch (error) { await transition('cancel').catch(() => {}); throw error; }
  }
  return {
    text, attachments, task: receipt.task || task,
    executor: spec.mode,
    ...(spec.mode === 'native' && !reuse ? { modelName: capturedModel.source === 'device'
      ? capturedModel.name : String(spec.model || '') } : {}),
    controlled: spec.mode === 'native' ? null : controlled.create({ task: receipt.task || task, spec, scope,
      request: async (route, body) => request(await freshIdentity(), route, body) }),
    ...(startReceipt ? { onStarted: async () => {
      executionStarted = true;
      const recorded = await startReceipt(nativeReceiptScope());
      startAcknowledged = recorded.pending === false;
      return recorded;
    } } : {}),
    beforeTurn: async () => {
      // Queued work must not execute with stale account/project/repository data.
      try {
        if (!releaseRecovery && (reuse || explicitNative)) await verifyReuse(true, followUp || runnerContinuation);
        if (releaseRecovery) {
          const current = await request(await freshIdentity(), route);
          const turn = current.workRouting?.conversationTurn;
          if (turn?.conversationId !== scope.conversationId || turn?.turnId !== scope.turnId ||
              turn?.executor !== 'native' || !['queued', 'running', 'waiting'].includes(turn?.state) ||
              ['done', 'cancel'].includes(current.status)) throw Error('需求执行状态已变化，请重新打开需求后继续');
          // Runtime interruption proof cannot preserve permissions that changed
          // while the client was offline or waiting to resume this requirement.
          await require('../conversation/requirement-context').validate({ ...runtime, identity }, current,
            requested, controlled.executionSpec(current, requested), route => request(identity, route));
          if (turn.state !== 'queued') return { task: current, turn };
        }
        return await transition('start');
      } catch (error) {
        if (releaseRecovery) await Promise.resolve().then(releaseRecovery).catch(() => {});
        throw error;
      }
    },
    beforeRetry: async turn => {
      // Mint a fresh receipt attempt, but retain this conversation's context.
      // Queue admission freezes a model independently of later picker changes.
      const nextModel = captureModelSource(true, turn?.modelName);
      const next = { conversationId: scope.conversationId, turnId: 'recovery-' + require('node:crypto').randomUUID() };
      const receipt = await request(await freshIdentity(), route + '/conversation-turn',
        { action: 'prepare', ...next, executor: spec.mode,
          ...(nextModel.source === 'device' ? { modelSource: 'device', agentId: nextModel.agentId } : {}),
          ...(dispatchInstructions ? {dispatchInstructions} : {}),
          ...(inferSubmission ? {submissionChoice: 'infer'} : {}),
          ...(spec.continuationRef ? { continuationRef: spec.continuationRef } : {}),
          ...(submissionMode ? { submissionMode } : {}) });
      if (receipt.turn.state !== 'queued') throw new Error('需求状态已变化，请刷新后查看结果');
      scope.turnId = next.turnId;
      capturedModel = nextModel;
      settlementFailed = false;
      capturedSettlement = null;
      settledResult = null;
      executionStarted = false;
      startAcknowledged = false;
    },
    afterTurn: status => {
      require('../requirement-diagnostics.cjs').record('native.terminal', {taskId,...scope,outcome:status});
      const action = { completed: 'complete', failed: 'fail', waiting: 'wait', stopped: 'cancel' }[status] || 'fail';
      return deliverThen(action, status === 'completed' ? 'completed' : 'incomplete');
    },
  };
}
module.exports = { prepare, request, attachmentUrl, latestDeliveryAttachments };
