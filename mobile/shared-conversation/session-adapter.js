(function (global) {
  'use strict';
  const bridge = global.SoduWorkMobileBridge, projection = global.SoduWorkMobileSnapshot;
  const handles = new Map(), observers = new Set();
  let draftTarget = null, draftTargetExplicit = false;
  let identity = '', catalog = null, stopped = false, catalogVersion = 0, catalogJob = null, modelJob = null;
  const unavailable = reason => ({ok: false, reason});
  const handleOf = ref => {const handle = handles.get(ref); if (!handle) throw Error('对话已关闭，请重新打开'); return handle;};
  const emit = (handle, kind = 'snapshot') => {
    const snapshot = projection.project(handle);
    global.document?.documentElement?.setAttribute('data-remote-status', handle.status);
    global.document?.documentElement?.setAttribute('data-conversation-restoring', handle.restoring ? (handle.error ? 'retrying' : 'loading') : 'false');
    global.document?.documentElement?.setAttribute('data-conversation-workflow', String(Boolean(handle.workflow)));
    for (const fn of observers) {try {fn({ref: handle.ref, kind, snapshot});} catch (_) {global.petSay?.('对话显示暂未更新，请重新打开此会话');}}
  };
  function resources() {
    if (catalogJob) return catalogJob;
    const version = ++catalogVersion;
    catalogJob = (async () => {
      const value = await bridge.call('catalog');
      if (stopped) throw Error('对话已关闭');
      if (version === catalogVersion) {
        catalog = value;
        for (const handle of handles.values()) {
          selection.refreshCatalog(handle, value);
          emit(handle);
        }
      }
      return value;
    })().finally(() => {catalogJob = null;});
    return catalogJob;
  }
  async function initialSnapshot(handle) {
    let timer;
    try {
      await Promise.race([poll(handle), new Promise(resolve => {
        timer = setTimeout(resolve, 1200);
      })]);
    } finally {clearTimeout(timer);}
  }
  function runtimes(value) {
    const seen = new Set();
    return [...(value.targets?.targets || [])].sort((a, b) => Number(b.runnerKind === 'work-computer') - Number(a.runnerKind === 'work-computer'))
      .filter(row => row.type === 'agent' && row.remote === true && row.online === true && row.agentId && !seen.has(row.agentId) && seen.add(row.agentId))
      .map(row => ({id: row.agentId, displayName: global.AgentBrand?.LABELS[row.agentId] || row.name || row.agentId, modelMode: row.modelMode || (row.modelPick ? 'company' : 'account'),
        accessControl: {supported: false}, remote: true}));
  }
  async function poll(handle) {
    if (handle.loading || handle.closed || !handle.taskId || stopped) return;
    handle.loading = true;
    try {
      if (handle.restorePending) {
        try {await workflow.restore(handle);}
        catch (error) {
          if (![403, 404].includes(error.status)) throw error;
          global.petSay?.('当前服务无法读取完整工作流状态，以下仅展示可访问的会话记录');
        }
        if (handle.closed || stopped) return;
        handle.restorePending = false;
        // restore already contains the authoritative workflow snapshot; do not
        // immediately block on an identical second workflow request.
        if (handle.workflow) {
          handle.error = ''; handle.restoring = false;
          emit(handle);
          return;
        }
      }
      if (handle.workflow) {
        const was = handle.status;
        await workflow.poll(handle);
        if (handle.closed || stopped) return;
        handle.error = ''; handle.restoring = false;
        emit(handle, projection.terminal(handle.status) && !projection.terminal(was) ? 'settled' : 'snapshot');
        return;
      }
      const page = await bridge.call('poll', {taskId: handle.taskId, ref: handle.runtimeRef, since: handle.since});
      if (handle.closed || stopped) return;
      if (!page.ok) throw Error(page.error || '执行状态暂不可用');
      if (page.ref) handle.runtimeRef = page.ref;
      handle.mobileAcceptance = page.mobileAcceptance;
      // Old services omit canSend. Absence must not clear a confirmed denial.
      if (typeof page.canSend === 'boolean') {
        handle.canSend = page.canSend;
        handle.readOnlyReason = page.canSend && !handle.personal ? '' : page.readOnlyReason;
      }
      if (page.resetItems === true && handle.personal) handle.events.clear();
      if (handle.personal) {
        handle.personalRelay = page.personalRelay;
        handle.personalDevice = page.personalDevice;
      } else selection.poll(handle, page);
      for (const item of page.items || []) {
        if (!Number.isSafeInteger(item.seq) || item.seq < 0) throw Error('执行记录序号无效');
        handle.events.set(item.seq, item);
        if (handle.acceptedSend && item.seq > handle.acceptedSend.after && item.kind === 'user' &&
            String(item.full || item.text || '') === handle.acceptedSend.text) {
          handle.localTimes.set(item.seq, handle.acceptedSend.sentAt); handle.acceptedSend = null;
        }
      }
      const previousCursor = handle.since;
      handle.since = Math.max(handle.since, Number(page.last) || 0);
      handle.historyPending = Number(page.seq) > handle.since && handle.since > previousCursor;
      const was = handle.status;
      handle.round = page.round ?? handle.round ?? 0;
      handle.runtimeError = typeof page.error === 'string' ? page.error : '';
      handle.liveError = typeof page.liveError === 'string' ? page.liveError : '';
      handle.canStop = page.canStop !== false;
      handle.startedAt = page.startedAt || handle.startedAt || '';
      handle.finishedAt = page.finishedAt || '';
      handle.status = page.status || handle.status; handle.error = ''; handle.restoring = false;
      emit(handle, projection.terminal(handle.status) && !projection.terminal(was) ? 'settled' : 'snapshot');
    } catch (error) {
      if (!handle.closed && !stopped) {handle.error = error.message; emit(handle);}
    } finally {
      handle.loading = false;
      if (!handle.closed && !stopped) handle.timer = setTimeout(() => {void poll(handle);}, handle.error ? 5000 : handle.historyPending ? 25 : projection.terminal(handle.status) ? 10000 : 1200);
    }
  }
  const workflow = global.SoduWorkMobileWorkflow.create({bridge, handleOf});
  const selection = global.SoduWorkMobileSelection.create({bridge, handleOf, resources, emit, terminal: projection.terminal});
  const session = {
    async runtimes() {
      const data = await resources(), availableRuntimes = runtimes(data);
      return {ok: !data.targets?.error, reason: data.targets?.error || '', runtimes: availableRuntimes, availableRuntimes};
    },
    async runtimeModels() {
      // The PC account-model directory is an IPC capability, not a Hub catalog.
      throw Error('当前服务尚未提供目标执行机的账号模型目录，请使用已授权的企业模型或在电脑端配置');
    },
    async capabilities() {
      const data = await bridge.call('skills');
      return {ok: true, skills: data.skills || data.items || []};
    },
    async open(options = {}) {
      if (!options.chatId && global.SoduWorkMobileDefaultRuntimePending) return unavailable('正在读取执行底座，请稍后再发送；输入内容会保留');
      const data = options.chatId ? (catalog || {}) : (catalog || await resources()), choices = runtimes(data);
      const selected = options.chatId ? {id: '', displayName: '远程执行'} :
        choices.find(row => row.id === options.adapterId) || (!options.adapterId ? choices[0] : null);
      if (!selected) return unavailable('当前没有可用的执行底座，请在云端环境中核对');
      const initialTarget = options.chatId ? null :
        (draftTarget || global.SoduWorkMobileSelection.defaultPersonalTarget(data, selected.id));
      const ref = 'mobile-view:' + crypto.randomUUID();
      // A view binding is not a new remote task. Only send() dispatches work.
      const handle = {ref, sessionId: options.chatId || ref, taskId: options.chatId || '', runtimeRef: '', since: 0,
        events: new Map(), localTimes: new Map(), status: options.chatId ? 'queued' : 'idle', adapterId: selected.id,
        displayName: selected.displayName, personal: global.SoduWorkMobilePersonalConversation === true, selectionCatalog: catalog, cloud: options.cloud === true,
        workflowKnown: options.workflowKnown === true, workflowExpected: options.workflow === true,
        selectionCatalog: catalog, model: {name: options.modelName || '', label: options.modelLabel || options.modelName || ''}};
      if (!handle.taskId && initialTarget) {
        handle.targetRunnerId = initialTarget.runnerId;
        handle.targetRunnerKind = initialTarget.runnerKind;
        handle.targetRunnerName = initialTarget.name;
        handle.targetExplicit = Boolean(draftTarget && draftTargetExplicit);
      }
      handles.set(ref, handle);
      if (handle.taskId) {
        handle.restoring = true;
        // Direct cloud conversations are not workflow records.  Avoid a
        // workflow restore request that returns 404 and then falsely tells the
        // user that the service lost workflow state.
        handle.restorePending = !handle.personal && !(handle.cloud && handle.workflowKnown && !handle.workflowExpected);
        await initialSnapshot(handle);
        if (handle.closed || stopped) return unavailable('对话已关闭');
        emit(handle);
      }
      // Keep the view and its retry timer when a history request is temporarily offline.
      return {ok: true, ref, sessionId: handle.sessionId, title: options.chatTitle || '', adapterId: handle.adapterId,
        displayName: handle.displayName, workspaceName: '远程工作区', snapshot: projection.project(handle)};
    },
    async snapshot(ref) {return {ok: true, snapshot: projection.project(handleOf(ref))};},
    async reconnect(ref) {
      const handle = handleOf(ref);
      if (handle.closed || stopped) return unavailable('会话已关闭，请重新打开');
      if (!handle.taskId) return unavailable('此对话尚未发送');
      if (handle.loading) return unavailable('正在读取会话记录，请稍后重试');
      // Reconnection only reads the existing execution. It must never replay
      // a user message, create a task, or discard this view's pending draft.
      clearTimeout(handle.timer);
      await poll(handle);
      if (handle.closed || stopped) return unavailable('会话已关闭，请重新打开');
      return handle.error || handle.liveError
        ? unavailable(handle.error || handle.liveError)
        : {ok: true, snapshot: projection.project(handle)};
    },
    onEvent(fn) {observers.add(fn); return () => observers.delete(fn);},
    async send(ref, text, attachments, options = {}) {
      const handle = handleOf(ref);
      if (handle.restoring) return unavailable('正在恢复会话记录，请稍后再发送；输入内容会保留');
      if (handle.canSend === false) return unavailable(handle.readOnlyReason || '当前设备仅可查看此会话，请在原设备继续或新建云会话。');
      if (handle.personal && (attachments.length || (options.plugins || []).length || (options.skills || []).length)) return unavailable('此聊天沿用电脑已有的文件与能力；请在电脑添加新材料或调整插件。');
      if ((options.plugins || []).some(row => String(row.pluginId || '').startsWith('desktop:'))) {
        if (handle.taskId || handle.targetRunnerKind !== 'work-computer') return unavailable('请在新对话中选择本人电脑和对应插件；草稿已保留');
        if (options.plugins.length !== 1 || handle.adapterId !== 'pi') return unavailable('请使用 Pi，并为本轮选择一个本机插件');
        if (attachments.length || (options.skills || []).length) return unavailable('本轮插件沿用电脑能力，请先移除额外附件或技能再发送；草稿已保留');
        const fingerprint = JSON.stringify([text, options.plugins, handle.targetRunnerId, handle.model, options.skills || [], attachments]);
        if (handle.pending && handle.pending.fingerprint !== fingerprint) return unavailable('上一笔发送尚未确认，请保留原内容核对');
        handle.pending ||= {fingerprint, messageId: crypto.randomUUID()};
        try {
          const result = await bridge.call('desktopPluginSend', {text, plugins: options.plugins,
            targetRunnerId: handle.targetRunnerId, targetRunnerKind: handle.targetRunnerKind,
            agentId: handle.adapterId, model: handle.model?.name || '',
            files: attachments.map(file => ({name: file.name})), skills: options.skills || [], messageId: handle.pending.messageId});
          if (result?.ok !== true || !result.conversationId) throw Error('会话回执尚未确认，请重试原内容');
          handle.pending = null;
          // Let the existing composer consume its send receipt before opening the synchronized PC conversation.
          setTimeout(() => { if (!handle.closed && !stopped) void bridge.call('desktopPluginCreated', {conversationId: result.conversationId})
            .catch(error => global.petSay?.('工作已接收，请在历史中打开会话：' + error.message)); }, 0);
          return {ok: true};
        } catch (error) {
          if (error.status > 0 && error.status < 500 && error.status !== 408) handle.pending = null;
          return unavailable(error.message);
        }
      }
      if ((options.plugins || []).length) {
        if (handle.targetRunnerId && handle.targetExplicit) return unavailable('此插件按已批准的工作流绑定执行，不能覆盖为所选电脑。请新建工作流对话；本机插件请从本人 PC 原会话继续。');
        const result = await workflow.start(handle, text, options.plugins, {...options, files: attachments});
        if (result.ok !== true) return result;
        // An explicitly selected workflow retains its approved execution binding.
        handle.targetRunnerId = ''; handle.targetRunnerKind = ''; handle.targetRunnerName = '';
        void bridge.call('created', {taskId: handle.taskId}).catch(() => global.petSay?.('工作已提交，请在历史中核对'));
        clearTimeout(handle.timer); await poll(handle);
        emit(handle, projection.terminal(handle.status) ? 'settled' : 'snapshot');
        return {ok: true, workflowRun: {id: handle.workflow.runId, taskId: handle.taskId}, snapshot: projection.project(handle)};
      }
      if (handle.workflow) return unavailable('此会话记录工作流执行；新需求请新建对话，现有流程和成果会保留');
      if (!handle.taskId && !handle.targetRunnerId) return unavailable('我的电脑暂不可用，请连接本人电脑，或手动选择云端执行');
      if (handle.taskId && (handle.error || handle.liveError)) return unavailable('执行环境尚未恢复连接，请稍后再发送；已有记录已保留');
      if (handle.taskId && (options.skills || []).length) return unavailable('本会话沿用已授权技能；更换技能请新建会话');
      if (handle.taskId && attachments.reduce((sum, file) => sum + (file.data?.length || 0), 0) > 16 * 1024 * 1024) return unavailable('每轮追加文件合计不能超过 16MB');
      if (handle.taskId && handle.status !== 'idle' && !projection.terminal(handle.status)) return unavailable('当前工作仍在执行，请等待本轮完成后补充');
      let files;
      try {
        files = attachments.map(file => {
          if (file.path || !(file.data instanceof Uint8Array)) throw Error('请重新选择此材料，手机端需要文件原件');
          let binary = ''; for (let i = 0; i < file.data.length; i += 0x8000) binary += String.fromCharCode(...file.data.subarray(i, i + 0x8000));
          return {name: file.name, data: btoa(binary), contentType: file.mimeType || file.type || 'application/octet-stream'};
        });
      } catch (error) { return unavailable(error.message); }
      // Equal names and sizes do not imply equal bytes during a receipt retry.
      const fingerprint = JSON.stringify([text, files, options.skills || [], selection.sendArgs(handle)]);
      if (handle.pending && handle.pending.fingerprint !== fingerprint) return unavailable('上一笔发送尚未确认，请先核对或重试原内容，避免重复执行');
      const requestedMessageId = String(options.submissionId || '').trim();
      const messageId = handle.pending?.messageId ||
        (/^[A-Za-z0-9._:-]{1,80}$/.test(requestedMessageId) ? requestedMessageId : crypto.randomUUID());
      handle.pending = {fingerprint, messageId};
      const submittedText = !handle.taskId && global.SoduWorkMobilePluginAuthoring
        ? [global.SoduWorkPluginAuthoringContract, text].filter(Boolean).join('\n\n') : text;
      try {
        const result = await bridge.call(handle.taskId ? 'say' : 'send', {taskId: handle.taskId, text: submittedText,
          // Preserve the user's message separately from execution-only instructions.
          ...(submittedText !== text ? {userText: text} : {}),
          model: handle.model?.name || '', agentId: handle.adapterId, skills: options.skills || [],
          ...selection.sendArgs(handle), files, messageId});
        if (handle.closed || stopped) return unavailable('会话已切换，请在历史中核对本次发送');
        if (!result || result.ok === false) {
          if (result?.delivery === 'rejected') handle.pending = null;
          return unavailable(result?.error || result?.reason || '发送未被接受');
        }
        if (!handle.taskId) {
          if (!result.taskId) throw Error('服务没有返回任务回执，请核对后重试');
          handle.taskId = result.taskId;
          // Keep the UI view id stable; taskId is a separate server authority.
          void bridge.call('created', {taskId: handle.taskId}).catch(() => global.petSay?.('工作已提交，请在历史中核对'));
        }
        const currentInput = global.document?.querySelector('#nchatInput');
        if (currentInput) void bridge.call('draft', {text: currentInput.value}).catch(() => {});
        selection.accepted(handle, result);
        handle.deliveryTurn = null; handle.delivery = null;
        handle.pending = null;
        handle.sentAt = options.sentAt || Date.now();
        handle.acceptedSend = {text, sentAt: handle.sentAt, after: handle.since};
        handle.status = 'queued'; handle.error = ''; handle.runtimeError = ''; handle.finishedAt = '';
        clearTimeout(handle.timer); void poll(handle);
        return {ok: true};
      } catch (error) {
        if (handle.closed || stopped) return unavailable('会话已切换，请在历史中核对本次发送');
        if (error.status > 0 && error.status < 500 && error.status !== 408) handle.pending = null;
        if ((error.status === 409 && error.message === '请先确认会话已由当前账号的云端接管') ||
            (error.status === 403 && error.message?.startsWith('当前设备仅可查看此会话'))) {
          handle.canSend = false;
          handle.readOnlyReason = '当前设备仅可查看此会话，暂不能继续发送。请在创建会话的设备继续，或新建云会话。已有记录和成果仍可查看，未发送内容可复制保留。';
          emit(handle);
          return unavailable(handle.readOnlyReason);
        }
        return unavailable(error.message);
      }
    },
    async cancel(ref) {
      const handle = handleOf(ref);
      if (handle.restoring) {global.petSay?.('正在核对执行状态，请稍后再停止'); return;}
      if (!handle.workflow && (handle.canStop === false || handle.liveError || handle.error)) {global.petSay?.('执行环境暂不可达，尚未确认停止；请恢复连接后重试'); return;}
      try {if (handle.workflow) await workflow.cancel(handle); else await bridge.call('stop', {taskId: handle.taskId}); clearTimeout(handle.timer); void poll(handle);}
      catch (error) {global.petSay?.(error.message);}
    },
    async outputs(ref) {
      const handle = handleOf(ref);
      if (!handle.taskId || handle.personal) return {ok: true, files: [], artifacts: []};
      try {
        // A completed remote turn can precede Runner file settlement. Recover
        // through the existing delivery endpoint, once per turn and view.
        if (!handle.workflow && ['done', 'completed'].includes(handle.status)) {
          const turn = String(handle.round || 0) + ':' + handle.runtimeRef;
          if (handle.deliveryTurn !== turn) {
            handle.deliveryTurn = turn;
            handle.deliveryJob = (async () => {
              let delivery = await api.getTaskDelivery(handle.taskId);
              if (handle.closed || stopped) throw Error('对话已关闭');
              if (delivery?.retryable && ['pending', 'failed'].includes(delivery.state)) {
                delivery = await api.syncTaskDelivery(handle.taskId);
              }
              if (handle.closed || stopped) throw Error('对话已关闭');
              handle.delivery = delivery;
              global.SoduWorkMobileOutputs.deliveryChanged?.(ref);
              // A completed turn can precede its final artifact receipt. Read it
              // again at bounded intervals; do not dispatch the work or repeatedly
              // trigger collection while the Runner is still settling files.
              const refreshReceipt = attempt => {
                clearTimeout(handle.deliveryTimer);
                if (delivery?.state !== 'pending' || !delivery.retryable || attempt >= 2) return;
                handle.deliveryTimer = setTimeout(async () => {
                  if (handle.closed || stopped || handle.deliveryTurn !== turn ||
                      !['done', 'completed'].includes(handle.status)) return;
                  try {
                    const next = await api.getTaskDelivery(handle.taskId);
                    if (handle.closed || stopped || handle.deliveryTurn !== turn) return;
                    const changed = JSON.stringify(next) !== JSON.stringify(handle.delivery);
                    handle.delivery = delivery = next;
                    global.SoduWorkMobileOutputs.deliveryChanged?.(ref);
                    if (changed) emit(handle, 'delivery-sync');
                    refreshReceipt(attempt + 1);
                  } catch (error) {
                    if (handle.closed || stopped || handle.deliveryTurn !== turn) return;
                    handle.delivery = {state: 'failed', retryable: true, error: error.message};
                    global.SoduWorkMobileOutputs.deliveryChanged?.(ref);
                    emit(handle, 'delivery-sync');
                  }
                }, attempt === 0 ? 1000 : 3000);
              };
              refreshReceipt(0);
            })();
          }
          try { await handle.deliveryJob; } catch (error) {
            handle.delivery = {state: 'failed', retryable: true, error: error.message};
            global.SoduWorkMobileOutputs.deliveryChanged?.(ref);
            throw error;
          }
        }
        const rows = await bridge.call('artifacts', {taskId: handle.taskId});
        const files = await global.SoduWorkMobileOutputs.normalize(handle.taskId, rows);
        if (handle.closed || stopped) throw Error('对话已关闭');
        handle.outputs = files;
        handle.shareOutputs = global.SoduWorkMobileOutputs.shareIndex(files, handle.delivery, handle.runtimeRef);
        return {ok: true, files, artifacts: files, shareArtifacts: handle.shareOutputs};
      } catch (error) {
        global.petSay?.('成果暂时无法读取：' + error.message);
        throw error;
      }
    },
    async personalRecover(ref, resolve) {
      const handle = handleOf(ref);
      if (!handle.personal) return unavailable('此聊天不支持这个操作');
      await bridge.call(resolve ? 'personalResolve' : 'personalRetry', {taskId: handle.taskId, checkedOnSourcePC: resolve === true});
      clearTimeout(handle.timer); await poll(handle);
      return {ok: true};
    },
    deliveryState(ref) { return handles.get(ref)?.delivery; },
    async deliveryAction(ref, action) {
      const handle = handleOf(ref);
      if (!handle.taskId || handle.workflow) throw Error('此会话没有网页成果包');
      let result = await api.getTaskDelivery(handle.taskId);
      if (action === 'sync' || (!result.delivery && result.retryable)) result = await api.syncTaskDelivery(handle.taskId);
      if (handle.closed || stopped) throw Error('对话已关闭');
      if (action === 'sync') {
        handle.delivery = result; handle.deliveryTurn = String(handle.round || 0) + ':' + handle.runtimeRef;
        handle.deliveryJob = Promise.resolve();
        global.SoduWorkMobileOutputs.deliveryChanged?.(ref);
        const outputs = await session.outputs(ref); emit(handle, 'delivery-sync'); return outputs;
      }
      const delivery = result.delivery;
      if (!delivery?.id) throw Error(result.error || '成果正在收集，请稍后重新打开');
      const args = {taskId: handle.taskId, deliveryId: delivery.id};
        if (action === 'saveLibrary') return bridge.call('saveDelivery', args);
      if (action === 'draft') {
        if (!projection.terminal(handle.status) && handle.status !== 'idle') throw Error('插件还在制作中，请等本轮完成后确认');
        return bridge.call('pluginDeliveryDraft', args);
      }
      if (action === 'preview' && /\.html?$/i.test(delivery.entryPath || '')) {
        const bundle = await bridge.call('previewDelivery', args);
        if (handle.closed || stopped) throw Error('对话已关闭');
        return global.SoduWorkMobileDeliveryPreview.open({...bundle, onDownload: () => {
          handleOf(ref); return bridge.call('openDelivery', args);
        }});
      }
      return bridge.call(action === 'preview' ? 'previewDeliveryFile' : 'openDelivery', args);
    },
    async processFiles(ref) {
      const handle = handleOf(ref);
      if (!handle.taskId || handle.personal) return [];
      const rows = await bridge.call('artifacts', {taskId: handle.taskId});
      const files = await global.SoduWorkMobileOutputs.normalize(handle.taskId, rows);
      if (handle.closed || stopped) throw Error('对话已关闭');
      handle.processOutputs = files;
      return files;
    },
    async pluginDraft(ref, id) {
      const handle = handleOf(ref);
      if (!projection.terminal(handle.status) && handle.status !== 'idle') return unavailable('插件还在制作中，请等本轮完成后确认');
      const index = await session.outputs(ref);
      const file = index.files.find(row => row.artifactId === id);
      if (!file?.mobileAttachmentId || !/^soduwork-plugin-draft\.json$/i.test(file.name || '')) return unavailable('这份草稿不属于当前会话成果');
      return bridge.call('pluginDraft', {taskId: handle.taskId, attachmentId: file.mobileAttachmentId});
    },
    async artifactAction(ref, id, action) {
      const handle = handleOf(ref);
      const file = [...(handle.outputs || []), ...(handle.processOutputs || []), ...(handle.shareOutputs || [])].find(row => row.artifactId === id);
      if (!file) return unavailable('成果已变化，请重新打开会话');
      if (file.deliveryId) {
        if (action !== 'share') return unavailable('完整成果包请使用下载或分享');
        return bridge.call('shareDelivery', {taskId: handle.taskId, deliveryId: file.deliveryId});
      }
      if (action === 'share-related') {
        if (handle.workflow) return unavailable('工作流成果请按附件分享');
        const result = await api.getTaskDelivery(handle.taskId);
        if (handle.closed || stopped) throw Error('对话已关闭');
        const delivery = result?.delivery;
        if (result?.state !== 'synced' || !delivery?.id) throw Error(result?.error || '成果尚未同步，请先同步完整成果后分享');
        if (delivery.kind !== 'bundle') return unavailable('此成果为单文件，可直接分享原件');
        const entryName = String(delivery.entryPath || '').split('/').pop();
        if (file.sourceRef !== handle.runtimeRef || entryName !== file.name) {
          return unavailable('历史网页仅提供这份原件，完整成果请打开对应轮次');
        }
        return bridge.call('shareDelivery', {taskId: handle.taskId, deliveryId: delivery.id});
      }
      if (action === 'open' && !handle.workflow && /\.html?$/i.test(file.name || file.relative || '')) {
        const delivery = handle.delivery?.state === 'synced' && handle.delivery.delivery;
        const target = file.relative || file.name;
        // Historical HTML remains its original authorized attachment. A matching
        // basename alone must never open the newest turn's unrelated website.
        if (file.sourceRef && file.sourceRef === handle.runtimeRef && delivery?.entryPath === target) {
          return session.deliveryAction(ref, 'preview');
        }
      }
      return bridge.call('artifactAction', {taskId: handle.taskId,
        attachmentId: file.mobileAttachmentId, action});
    },
    async history() {await bridge.call('refresh'); return {ok: true, history: []};},
    release(ref) {const handle = handles.get(ref); if (handle) {handle.closed = true; global.SoduWorkMobileToolViewer?.close?.(); global.SoduWorkMobileDeliveryPreview?.close?.(); clearTimeout(handle.timer); handles.delete(ref);} return {ok: true};},
    conversationRuntimes: ref => handleOf(ref).personal ? Promise.resolve(unavailable('此聊天沿用电脑的底座和模型。')) : selection.conversationRuntimes(ref),
    selectAgent: (ref, id) => handleOf(ref).personal ? Promise.resolve(unavailable('请在电脑切换此聊天的底座。')) : selection.selectAgent(ref, id),
    selectModel: (ref, id) => handleOf(ref).personal ? Promise.resolve(unavailable('请在电脑切换此聊天的模型。')) : selection.selectModel(ref, id),
    async openWorkdir() {global.petSay?.('手机暂不支持浏览执行目录，请在 PC 查看'); return unavailable('手机暂不支持浏览执行目录，请在 PC 查看');},
    async openSessionWorkdir() {return unavailable('手机暂不支持浏览执行目录，请在 PC 查看');},
    async saveAttachment(file) {return file;},
    async pickShareFolder() {return unavailable('手机请使用添加文件，文件夹可在电脑端打包后添加');},
    pathForFile: () => '',
  };
  const api = {
    conversationSession: session,
    getTaskDelivery: async taskId => {
      if ([...handles.values()].some(handle => handle.taskId === taskId && handle.workflow)) throw Error('工作流成果请从附件查看');
      const result = await bridge.call('delivery', {taskId});
      global.SoduWorkMobileOutputs.remember(taskId, result);
      return result;
    },
    syncTaskDelivery: async taskId => {
      const result = await bridge.call('syncDelivery', {taskId});
      global.SoduWorkMobileOutputs.remember(taskId, result);
      return result;
    },
    taskStorageKey: name => 'mobile-shared:' + identity + ':' + name,
    myModels: () => {
      if (modelJob) return modelJob;
      // Do not wait for device enrollment/runtime probes to populate a model menu.
      modelJob = bridge.call('models').then(models => {
        if (stopped) throw Error('对话已关闭');
        if (models?.error) throw Error(models.error);
        return models;
      }).finally(() => {modelJob = null;});
      return modelJob;
    },
    pluginCatalog: async () => {
      const ref = global.NativeChat?.sessionInfo?.().ref;
      const handle = handles.get(ref);
      if (handle?.personal) return {items: []};
      if (!catalog) await resources();
      const target = handle ? global.SoduWorkMobileSession.executionTarget(ref) :
        (draftTarget || global.SoduWorkMobileSelection.defaultPersonalTarget(catalog, runtimes(catalog || {})[0]?.id));
      const native = !handle?.taskId && target?.runnerKind === 'work-computer';
      const payload = await bridge.call('plugins', native ? {targetRunnerId: target.runnerId, targetRunnerKind: target.runnerKind} : {});
      if (native) {
        const current = handle ? global.SoduWorkMobileSession.executionTarget(ref) : draftTarget;
        if (stopped || handle?.closed || (current && current.runnerId !== target.runnerId)) throw Error('执行电脑已切换，请重新打开插件列表');
        return payload;
      }
      return workflow.catalog(payload);
    },
    listTeammates: () => bridge.call('mates'),
    listAttachments: taskId => bridge.call('artifacts', {taskId}),
    draftMateMessage: body => bridge.call('draftMate', body),
    sendMateMessage: (recipientId, text, output = {}) => bridge.call('sendMate', {
      recipientId, text, messageId: output.messageId,
      conversationId: handles.get(output.conversationId)?.taskId || '', files: output.files || [],
    }),
    accessPreferences: {get: async () => ({mode: 'standard'})},
    async openExternal(url) {if (/^https?:\/\//.test(url)) await bridge.call('external', {url});},
  };
  global.soduWorkAPI = api; global.SoduWorkAPI = api;
  global.SoduWorkMobileSession = {
    directory: resources,
    selectTarget: selection.selectTarget,
    setDraftTarget(value) { draftTarget = value ? Object.freeze({...value}) : null; draftTargetExplicit = Boolean(value); },
    draftTarget: () => draftTarget,
    ensureDraftTarget(agentId) {
      if (!draftTarget) draftTarget = global.SoduWorkMobileSelection.defaultPersonalTarget(catalog, agentId);
      return draftTarget;
    },
    executionTarget(ref) {
      const h = handles.get(ref);
      if (!h) return null;
      if (h.personal) return {runnerKind: 'work-computer', name: h.personalDevice || '原会话所在电脑', locked: true};
      const id = h.runnerId || h.targetRunnerId;
      const row = (catalog?.targets?.targets || []).find(item => item.runnerId === id);
      return id ? {runnerId: id, runnerKind: row?.runnerKind || h.targetRunnerKind || '',
        name: row?.runnerName || row?.machineLabel || h.targetRunnerName || id, locked: Boolean(h.taskId)} : null;
    },
    taskId: ref => handles.get(ref)?.taskId || '',
    peekDirectory: () => catalog,
    availableRuntimes: () => runtimes(catalog || {}),
    initialize(value) {
      if (identity !== value) {draftTarget = null; draftTargetExplicit = false;}
      identity = value;
    },
    dispose() {stopped = true; for (const ref of handles.keys()) session.release(ref); observers.clear(); catalog = null;},
  };
})(window);
