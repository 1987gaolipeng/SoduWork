(function (global) {
  'use strict';
  const deliveries = new Map();
  let decorated = null;
  const session = () => global.soduWorkAPI.conversationSession;
  const active = () => global.NativeChat?.sessionInfo?.()?.ref;
  const desktopDecorate = global.ChatDeliveries?.decorate;
  if (desktopDecorate) global.ChatDeliveries.decorate = (root, files, ref, snapshot = {}) => {
    desktopDecorate(root, files, ref, snapshot.workflowTaskId
      ? {...snapshot, cloudHandoff: {taskId: snapshot.workflowTaskId}} : snapshot);
    if (!snapshot.workflowTaskId) root.querySelectorAll('[data-delivery]').forEach(card => {
      const message = card.closest?.('.nmsg.ai');
      if (!message || message.dataset.deliveryCurrent === 'false' ||
          (message.dataset.outputTask && message.dataset.outputTask !== snapshot.cloudHandoff?.taskId)) return;
      const continuation = card.querySelector('[data-delivery-continue]');
      if (continuation) { continuation.textContent = '继续完善'; continuation.setAttribute('aria-label', '继续完善'); continuation.title = '在当前会话继续完善成果'; }
      if (card.querySelector('[data-mobile-delivery-actions]')) return;
      const actions = document.createElement('div'); actions.dataset.mobileDeliveryActions = '';
      const add = (action, label) => {
        const button = document.createElement('button'); button.type = 'button';
        button.dataset.mobileDeliveryAction = action;
        if (action === 'preview') button.dataset.mobileDeliveryPreview = '';
        button.textContent = label; actions.append(button);
      };
      const delivery = session().deliveryState(ref);
      if (delivery?.state === 'synced' && delivery.delivery?.id) add('preview', /\.html?$/i.test(delivery.delivery.entryPath || '') ? '预览网页' : '预览成果');
      add('download', '下载完整成果'); add('saveLibrary', '保存到资料库'); card.append(actions);
      const status = card.querySelector('[data-delivery-status]');
      if (status) status.textContent = '在手机查看或下载成果';
    });
    renderDeliveryStatus(root, files, ref, snapshot);
    root.querySelectorAll('[data-open-app]').forEach(open => {
      if (open.parentElement?.querySelector('[data-mobile-save-artifact]')) return;
      const button = document.createElement('button'); button.type = 'button';
      button.dataset.mobileSaveArtifact = open.dataset.openApp; button.textContent = '保存到资料库';
      open.after(button);
    });

  };
  const hasPluginDraft = delivery => Array.isArray(delivery?.files) &&
    delivery.files.filter(row => /(?:^|\/)soduwork-plugin-draft\.json$/i.test(row.path || '')).length === 1;
  function renderDeliveryStatus(root, files, ref, snapshot) {
    root.querySelectorAll('[data-mobile-delivery-status]').forEach(node => node.remove());
    if (snapshot.execution?.running || (snapshot.status && !['idle', 'completed', 'done'].includes(snapshot.status))) return;
    const state = session().deliveryState(ref);
    if (snapshot.workflowTaskId || !state) return;
    if (!['pending', 'failed', 'synced', 'incomplete', 'removed'].includes(state.state)) return;
    const taskId = snapshot.cloudHandoff?.taskId;
    const message = [...root.querySelectorAll('.nmsg.ai')].filter(node =>
      node.dataset.deliveryFinal !== 'false' && node.dataset.deliveryCurrent !== 'false' &&
      (!node.dataset.outputTask || node.dataset.outputTask === taskId)).at(-1);
    if (!message) return;
    const existing = message.querySelector('[data-delivery]');
    if (existing) {
      const actions = existing.querySelector('[data-mobile-delivery-actions]');
      if (state.state === 'synced' && state.delivery?.id && actions &&
          !actions.querySelector('[data-mobile-delivery-preview]')) {
        // A receipt can become available without changing the attachment index.
        const button = document.createElement('button'); button.type = 'button';
        button.dataset.mobileDeliveryAction = 'preview'; button.dataset.mobileDeliveryPreview = '';
        button.textContent = /\.html?$/i.test(state.delivery.entryPath || '') ? '预览网页' : '预览成果'; actions.append(button);
      }
      if (state.state === 'synced' && hasPluginDraft(state.delivery) && actions &&
          !actions.querySelector('[data-mobile-plugin-draft]')) {
        const button = document.createElement('button'); button.type = 'button';
        button.dataset.mobileDeliveryAction = 'draft'; button.dataset.mobilePluginDraft = '';
        button.textContent = '检查插件草稿'; actions.append(button);
      }
      return;
    }
    const card = document.createElement('section');
    card.className = 'ndelivery mobile-delivery'; card.dataset.mobileDeliveryStatus = '';
    const title = document.createElement('h3'); title.textContent = '交付成果';
    const label = document.createElement('p'); label.setAttribute('role', 'status');
    const delivery = state.state === 'synced' && state.delivery;
    label.dataset.mobileDeliveryCopy = '';
    title.dataset.mobileDeliveryCopy = '';
    label.textContent = delivery?.id ? '成果已收集，可查看或下载。'
      : state.state === 'pending'
        ? '执行已结束，但服务端尚未确认成果已收集完成，暂时无法预览或下载。'
        : state.state === 'incomplete' ? '本轮未完成，过程记录已保留。'
        : state.state === 'removed' ? '成果已移除，暂时无法下载。'
        : '成果尚未收集完成，请查看错误详情。';
    card.append(title, label);
    // Display receipt metadata, never a task prompt masquerading as a file name.
    const filename = delivery?.id && (delivery.filename || delivery.entryPath);
    if (typeof filename === 'string' && filename.trim()) {
      const file = document.createElement('p'); file.dataset.mobileDeliveryFile = '';
      file.setAttribute('translate', 'no'); file.textContent = filename; card.append(file);
    }
    if (!delivery?.id && state.error) {
      const details = document.createElement('details'); details.dataset.mobileDeliveryError = '';
      const summary = document.createElement('summary'); summary.dataset.mobileDeliveryCopy = '';
      summary.textContent = '查看错误详情';
      const error = document.createElement('p'); error.setAttribute('translate', 'no');
      error.textContent = String(state.error); details.append(summary, error); card.append(details);
    }
    const actions = document.createElement('div'); actions.dataset.mobileDeliveryActions = '';
    const add = (action, text) => {
      const button = document.createElement('button'); button.type = 'button';
      button.dataset.mobileDeliveryAction = action; button.dataset.mobileDeliveryCopy = '';
      if (action === 'preview') button.dataset.mobileDeliveryPreview = '';
      if (action === 'draft') button.dataset.mobilePluginDraft = '';
      button.textContent = text; actions.append(button);
    };
    if (delivery?.id) {
      add('preview', /\.html?$/i.test(delivery.entryPath || '') ? '预览网页' : '预览成果');
      add('download', '下载完整成果');
      add('saveLibrary', '保存到资料库');
      if (hasPluginDraft(delivery)) add('draft', '检查插件草稿');
    } else if (state.retryable === true) add('sync', '重新收集成果');
    card.append(actions); message.append(card);
  }
  // PC receives local files plus task attachments. Mobile already projects the
  // current task's authorized attachments into artifacts, so do not add them a
  // second time in the PC share card. Other linked tasks retain their index.
  const desktopMention = global.ChatMateMention?.create;
  if (desktopMention) global.ChatMateMention.create = options => desktopMention({
    ...options,
    context: () => {
      const context = options.context?.();
      if (!context) return context;
      const taskId = global.SoduWorkMobileSession.taskId(context.ref);
      return {...context, taskIds: (context.taskIds || []).filter(id => id !== taskId),
        api: {...context.api, outputs: async ref => {
          const index = await context.api.outputs(ref);
          return {...index, artifacts: index.shareArtifacts || index.artifacts || []};
        }},
      };
    },
  });
  const desktopDecorateOutputs = global.ChatOutputLinks.decorate;
  if (desktopDecorateOutputs) global.ChatOutputLinks.decorate = (html, files, ref, snapshot = {}, previousRoot) => {
    decorated = {files, ref, snapshot};
    const result = desktopDecorateOutputs(html, files, ref, snapshot, previousRoot);
    // PC may return early for an empty index and builds cards in a detached div.
    // Wait for its DOM patch, then update only the actual active mobile list.
    Promise.resolve().then(() => global.SoduWorkMobileOutputs.deliveryChanged(ref));
    return result;
  };
  const desktopLoad = global.ChatOutputLinks.load;
  const mobileFiles = files => [...new Map(files.map(file => {
    if (!file.taskId || !file.attachmentId) return [file.artifactId || file.path, file];
    const result = {...file, mobileAttachmentId: file.attachmentId, remoteMaterialized: true};
    if (/^soduwork-plugin-draft\.json$/i.test(result.name || '')) {
      result.pluginDraft = true;
      result.pluginName = '插件草稿';
      // Attachment identity stays authoritative; never infer identity from a display name.
      result.pluginIdentity = result.artifactId;
      result.mobileTaskId = result.taskId;
      delete result.taskId;
    }
    delete result.attachmentId;
    return [result.artifactId, result];
  })).values()];
  // The desktop loader also merges task IDs discovered in messages. Normalize
  // that merged index at the host boundary so all reads use mobile file access.
  global.ChatOutputLinks.load = async (...args) => mobileFiles(await desktopLoad(...args));
  global.SoduWorkMobileOutputs = {
    deliveryChanged(ref) {
      // An unchanged (often empty) file list does not repaint the PC transcript.
      // Update this mobile status surface independently of artifact identity.
      const root = document.getElementById?.('nchatList');
      if (decorated?.ref === ref && root?.isConnected && active() === ref) {
        root.querySelectorAll('[data-install-plugin-draft]').forEach(button => {
          button.textContent = '检查草稿';
          const hint = button.closest?.('.nplugin-draft')?.querySelector('.nplugin-draft-copy span');
          if (hint) hint.textContent = '检查和编辑后提交企业审核，尚未安装';
        });
        renderDeliveryStatus(root, decorated.files, ref, decorated.snapshot);
      }
    },
    shareIndex(files, result, runtimeRef) {
      const delivery = result?.state === 'synced' && result.delivery;
      if (!runtimeRef || delivery?.kind !== 'bundle' || !delivery.id || !Array.isArray(delivery.files)) return files;
      // Only collapse exact authorized manifest matches; basename/size alone
      // across other turns cannot identify a file as a member of this bundle.
      const members = files.filter(file => file.sourceRef === runtimeRef &&
        delivery.files.some(row => row.path === file.relative && row.size === file.size) &&
        files.filter(other => other.sourceRef === runtimeRef && other.relative === file.relative).length === 1);
      if (!members.some(file => file.relative === delivery.entryPath)) return files;
      const bundled = new Set(members);
      return [{artifactId: 'mobile-delivery:' + delivery.id, deliveryId: delivery.id,
        name: delivery.filename, relative: delivery.filename, size: delivery.size,
        at: Number(delivery.createdAt) || Date.parse(delivery.createdAt || '') || 0, kind: 'delivery-bundle'},
        ...files.filter(file => !bundled.has(file))];
    },
    async normalize(taskId, rows) {
      // Reuse desktop classification, stable IDs and evidence filtering.
      // Fetch before entering load(): errors must not become an empty index.
      const files = await desktopLoad(
        {outputs: async () => ({ok: true, files: []})}, '', [taskId], [],
        {listAttachments: async () => rows});
      return mobileFiles(files);
    },
    remember(taskId, result) {
      if (result?.delivery?.id) deliveries.set(result.delivery.id, taskId);
    },
  };
  global.LibraryDelivery = {
    async open(id) {
      const taskId = deliveries.get(id);
      if (!taskId) throw Error('成果已变化，请重新打开会话');
      return global.SoduWorkMobileBridge.call('openDelivery', {taskId, deliveryId: id});
    },
  };
  global.openConversationPluginDraft = async (ref, target, button) => {
    if (button?.disabled) return;
    if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
    try {
      const result = await session().pluginDraft(ref, target);
      if (result?.ok === false) throw Error(result.reason || '草稿未能打开');
      if (result?.ok === true) global.petSay?.(result.message || '插件草稿已保存');
    } catch (error) { global.petSay?.(error.message || '草稿未能打开，请重试'); }
    finally { if (button) { button.disabled = false; button.removeAttribute('aria-busy'); } }
  };
  // Keep the shared card and message markup; replace only desktop file actions.
  document.addEventListener('click', async event => {
    const button = event.target.closest?.('[data-open-app],[data-mobile-save-artifact],[data-delivery-open],[data-delivery-archive],[data-delivery-retry],[data-mobile-delivery-action]');
    if (!button || button.disabled) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const ref = active(); if (!ref) return;
    button.disabled = true; button.setAttribute('aria-busy', 'true');
    try {
      const result = button.dataset.mobileDeliveryAction
        ? await session().deliveryAction(ref, button.dataset.mobileDeliveryAction)
        : button.hasAttribute('data-mobile-save-artifact')
        ? await session().artifactAction(ref, button.dataset.mobileSaveArtifact, 'saveLibrary')
        : button.hasAttribute('data-open-app')
        ? await session().artifactAction(ref, button.dataset.openApp, 'open')
        : await session().deliveryAction(ref, button.hasAttribute('data-delivery-retry') ? 'sync' : button.hasAttribute('data-delivery-open') ? 'preview' : 'download');
      if (result?.ok === false) throw Error(result.reason || '成果未能打开');
    } catch (error) { global.petSay?.(error.message || '成果未能打开，请重试'); }
    finally { button.disabled = false; button.removeAttribute('aria-busy'); }
  }, true);
})(window);
