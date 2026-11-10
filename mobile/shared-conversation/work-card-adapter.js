/* PC form controllers, real Hub writes, and explicitly device-local draft storage. */
(function (global) {
  'use strict';
  const bridge = global.SoduWorkMobileBridge, api = global.soduWorkAPI;
  // PC's clock matcher otherwise reads the weekday and adjacent digits as one
  // hour with a weekday prefix. Normalize only the timing parser's copy, never the draft,
  // model input, saved note, or non-time numbers in the work description.
  const pcInfer = global.ScheduleTiming?.infer;
  if (pcInfer) global.ScheduleTiming.infer = function (text, ...args) {
    const timingText = String(text || '').replace(/((?:每周|周)[一二三四五六日天])(?=\d{1,2}\s*[:：点时])/g, '$1 ');
    return pcInfer.call(this, timingText, ...args);
  };
  const supported = id => ['work.requirement.create', 'work.automation.create'].includes(id);
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  let ready = null, storageKey = '', historyKey = '', historySignature = '', records = [], active = null, disposed = false;
  let saving = false, readyResolve, readyReject, formObserver = null;
  const initialized = new Promise((resolve, reject) => {readyResolve = resolve; readyReject = reject;});
  // A rejected initialization is reported by the entry page; avoid an orphan rejection.
  initialized.catch(() => {});
  const originalCall = bridge.call.bind(bridge);
  let requestedDraftStatus = '';
  function reportDraftStatus() {
    if (disposed || !ready) return;
    const status = {
      dirty: records.some(record => !record.dismissed && record.snapshot?.phase !== 'succeeded'),
      busy: records.some(record => record.snapshot?.phase === 'submitting'),
    };
    const signature = JSON.stringify(status);
    if (signature === requestedDraftStatus) return;
    requestedDraftStatus = signature;
    const failed = error => {
      if (requestedDraftStatus === signature) requestedDraftStatus = '';
      if (!disposed) report(Error('未能同步工作草稿保护状态，请暂时不要新建对话：' + String(error?.message || error)));
    };
    try {
      // Post immediately, before a create request; awaiting a prior status
      // acknowledgement could delay the native busy guard until after saving.
      Promise.resolve(originalCall('workCardDraft', status)).then(result => {
        if (result?.ok === false) throw Error(result.message || '状态未被接受');
      }).catch(failed);
    } catch (error) {failed(error);}
  }
  bridge.call = function (method, args) {
    const result = originalCall(method, args);
    if (method === 'ready') Promise.resolve(result).then(initialize, readyReject);
    return result;
  };
  function initialize(info) {
    if (disposed || ready) return;
    ready = info;
    const identity = String(info.identity || info.scope || '');
    if (!identity) {readyReject(Error('账号尚未就绪，请重新打开对话')); return;}
    storageKey = 'soduwork-mobile-work-cards:' + JSON.stringify([identity, String(info.taskId || 'new')]);
    historyKey = 'soduwork-mobile-work-history:' + identity;
    try {
      // Migrate the current view before clearing it; completed receipts remain discoverable.
      const previous = JSON.parse(sessionStorage.getItem(storageKey) || '[]');
      if (Array.isArray(previous) && previous.length) saveHistory(previous);
      if (info.clearNewDraft && !info.taskId) sessionStorage.removeItem(storageKey);
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || '[]');
      if (Array.isArray(saved)) records = saved.filter(row => row && supported(row.actionId) &&
        typeof row.id === 'string' && typeof row.text === 'string').slice(-20);
    } catch (_) {global.petSay?.('本机草稿无法读取，请重新描述工作要求');}
    // A completed receipt is history, not the default content of a fresh home view.
    // Keep unfinished drafts and explicit history navigation intact.
    if (!info.taskId && !info.workCardHistoryId) records = records.filter(row => row.snapshot?.phase !== 'succeeded');
    if (info.workCardHistoryId) {
      try {records = readHistory().filter(row => row.id === info.workCardHistoryId);}
      catch (_) {global.petSay?.('本机工作记录无法读取，请在需求池或自动化中核对已保存内容');}
    }
    publishHistory();
    readyResolve(info);
    reportDraftStatus();
  }
  function check(record) {
    if (disposed || !ready || !record || !records.includes(record)) throw Error('工作卡片已关闭，请重新打开');
  }
  function readHistory() {
    const rows = JSON.parse(localStorage.getItem(historyKey) || '[]');
    if (!Array.isArray(rows)) throw Error('工作记录格式不正确');
    return rows.filter(row => row && supported(row.actionId) && typeof row.id === 'string' && typeof row.text === 'string');
  }
  function publishHistory() {
    if (!ready || disposed) return;
    try {
      const entries = readHistory().slice().reverse().map(row => ({id: row.id,
        title: String(row.snapshot?.receipt?.title || row.snapshot?.draft?.title || row.snapshot?.proposal?.title || row.text).slice(0, 200),
        taskId: row.taskId || '', updatedAt: Number(row.updatedAt || 0), saved: row.snapshot?.phase === 'succeeded'}));
      const signature = JSON.stringify(entries);
      if (signature === historySignature) return;
      historySignature = signature;
      Promise.resolve(originalCall('workCardHistory', {entries})).catch(error => {
        historySignature = ''; report(error);
      });
    } catch (error) {report(error);}
  }
  function saveHistory(rows) {
    const merged = new Map(readHistory().map(row => [row.id, row]));
    for (const row of rows) {
      if (row && supported(row.actionId) && typeof row.id === 'string' && typeof row.text === 'string') merged.set(row.id, row);
    }
    const saved = [...merged.values()].sort((a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0)).slice(-50);
    localStorage.setItem(historyKey, JSON.stringify(saved));
  }
  function persist() {
    if (!storageKey || disposed) throw Error('本机草稿尚未就绪');
    sessionStorage.setItem(storageKey, JSON.stringify(records));
    saveHistory(records);
    publishHistory();
  }
  function update(record, snapshot) {
    if (!snapshot || disposed || !records.includes(record)) return;
    const files = snapshot.files || [];
    if (record.missingFiles) record.missingFiles = record.missingFiles.filter(wanted => !files.some(file => file.name === wanted.name && Number(file.size || 0) === wanted.size));
    record.files = files.map(file => ({name: String(file.name || file.filename || ''), size: Number(file.size || 0)}));
    record.snapshot = clone({...snapshot, files: undefined});
    record.updatedAt = Date.now();
    reportDraftStatus();
    try {persist(); record.storageError = '';}
    catch (_) {record.storageError = '本机草稿无法保存，请释放浏览器存储后再确认'; global.petSay?.(record.storageError);}
  }
  function capture() {
    if (!active) return;
    const value = active.actionId === 'work.automation.create'
      ? global.WorkAutomationSheet.capture() : global.WorkEntrySheet.capture();
    if (value) update(active, value);
  }
  function container() {
    const scroll = document.getElementById('nchatScroll');
    if (!scroll) throw Error('对话还没有打开，请稍后重试');
    let node = document.getElementById('mobileWorkCards');
    if (!node) {
      node = document.createElement('section'); node.id = 'mobileWorkCards';
      node.setAttribute('aria-label', '工作确认卡');
      scroll.appendChild(node);
    }
    return node;
  }
  function slot(record) {
    const parent = container();
    let node = [...parent.children].find(child => child.dataset.cardId === record.id);
    if (!node) {
      node = document.createElement('section'); node.className = 'mobile-work-card';
      node.dataset.cardId = record.id; parent.appendChild(node);
    }
    return node;
  }
  function idleCard(record) {
    const node = slot(record); node.replaceChildren();
    const snapshot = record.snapshot || {}, receipt = snapshot.receipt || {};
    const id = receipt.id || snapshot.createdId;
    const saved = snapshot.phase === 'succeeded' && Boolean(id);
    const automation = record.actionId === 'work.automation.create';
    const type = automation ? '自动化' : '需求';
    const draft = snapshot.draft || snapshot.proposal || {};
    const element = (tag, className, text) => {
      const value = document.createElement(tag); value.className = className;
      if (text !== undefined) value.textContent = String(text);
      return value;
    };
    const card = element('article', 'mobile-work-receipt');
    const heading = element('div', 'mobile-work-receipt-heading');
    heading.append(element('span', 'mobile-work-type', type),
      element('span', 'mobile-work-status', saved ? '已创建' : '本机草稿'));
    const title = element('h3', 'mobile-work-title', receipt.title || draft.title || `新的${type}`);
    const description = element('p', 'mobile-work-summary', saved
      ? '已保存到工作空间。打开详情查看最新状态与后续操作。'
      : '尚未提交。继续编辑并确认后，才会保存到工作空间。');
    const facts = element('div', 'mobile-work-facts');
    // Receipt fields describe creation, not a fresh query of the live plan.
    if (saved && automation) {
      const every = {daily: '每天', weekly: '每周', hourly: '每小时', once: '单次'}[receipt.every];
      const hour = Number(receipt.atHour), minute = Number(receipt.atMinute);
      if (every) {
        const clock = receipt.atHour != null && receipt.atMinute != null &&
          Number.isInteger(hour) && hour >= 0 && hour < 24 && Number.isInteger(minute) && minute >= 0 && minute < 60
          ? ` ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` : '';
        const weekday = {1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '日'}[receipt.weekday] || '';
        const timing = receipt.every === 'daily' ? `${every}${clock}`
          : receipt.every === 'weekly' ? `${every}${weekday}${clock}`
          : receipt.every === 'hourly' && receipt.atMinute != null && Number.isInteger(minute) && minute >= 0 && minute < 60
          ? `${every}第 ${minute} 分钟` : every;
        facts.append(element('span', '', timing));
      }
      if (receipt.timeZone) facts.append(element('span', '', receipt.timeZone));
      if (receipt.enabled === false) facts.append(element('span', '', '创建时已暂停'));
    } else if (saved) {
      const priority = {low: '低优先级', normal: '普通优先级', high: '高优先级', urgent: '紧急'}[receipt.priority];
      if (priority) facts.append(element('span', '', priority));
      if (receipt.assigneeName) facts.append(element('span', '', `负责人：${receipt.assigneeName}`));
      if (Array.isArray(receipt.attachments) && receipt.attachments.length) {
        facts.append(element('span', '', `${receipt.attachments.length} 份材料`));
      }
    }
    facts.hidden = facts.children.length === 0;
    const original = element('details', 'mobile-work-original');
    original.append(element('summary', '', '查看原始描述'),
      element('p', 'mobile-work-prompt', record.text));
    const feedback = element('p', 'mobile-work-feedback');
    feedback.setAttribute('role', 'status'); feedback.hidden = true;
    const detail = element('button', 'mobile-work-primary', saved
      ? (automation ? '查看已创建的自动化' : '查看已创建的需求') : '继续编辑本机草稿');
    detail.type = 'button';
    detail.onclick = async () => {
      detail.disabled = true; feedback.hidden = true;
      try {
        await (saved ? request(record, automation ? 'openAutomation' : 'openRequirement', {id}) : mount(record, true));
      } catch (error) {
        feedback.textContent = String(error?.message || error);
        feedback.hidden = false;
      } finally {detail.disabled = false;}
    };
    card.append(heading, title, description, facts, original, feedback, detail);
    node.append(card);
  }
  function report(error) {global.petSay?.(String(error?.message || error));}
  async function request(record, operation, args = {}) {
    check(record);
    const value = await originalCall('workForm', {...args, operation, cardId: record.id});
    check(record);
    if (value?.ok === false) throw Error(value.message || value.reason || value.error || '服务未接受此操作');
    return value;
  }
  function current() {check(active); return active;}
  api.parseTaskText = async (text, model, attachments, options = {}) => {
    const record = current();
    try {
      return await request(record, record.actionId === 'work.automation.create' ? 'parseAutomation' : 'parseRequirement',
        {text, model: model || '', instruction: options.instruction || text,
          candidates: options.candidates || {}, attachments: attachments || []});
    } catch (error) {return {_parseError: error.message};}
  };
  api.taskExecutionOptions = args => request(current(), 'executionOptions', args);
  api.preflightSchedule = body => request(current(), 'preflightAutomation', {body});
  api.createSchedule = async body => {
    const record = current();
    const result = await request(record, 'createAutomation', {body});
    if (!result?.id) throw Error('服务未返回自动化编号，请在列表核对，勿重复创建');
    return result;
  };
  const created = new Set();
  async function createRequirement(record, body) {
    const result = await request(record, 'createRequirement', {body});
    const task = result?.task || result;
    if (!task?.id || task.id !== (body.id || body.taskId)) throw Error('需求回执编号不一致，请在需求池核对');
    created.add(record.id + ':' + task.id);
    return result;
  }
  // PC ComposeDraft uses a single pending task row; this adapter never calls save()
  // or treats that row as a saved task. Only the authenticated Host receipt does.
  global.tasks = [];
  global.uid = () => crypto.randomUUID();
  global.Store = {
    async persistTask(id) {
      const record = current(), body = global.tasks.find(row => row.id === id);
      if (!body) throw Error('需求草稿不存在，请重新打开');
      await createRequirement(record, clone(body));
      return true;
    },
  };
  api.createAssignedTask = async body => {
    const result = await createRequirement(current(), body);
    return result.task ? result : {ok: true, task: result};
  };
  api.uploadAttachment = async (id, file) => {
    const record = current();
    if (!created.has(record.id + ':' + id)) {
      await request(record, 'resumeRequirement', {id});
      created.add(record.id + ':' + id);
    }
    let payload;
    if (file.sourceTaskId && (file.attachmentId || file.mobileAttachmentId)) {
      payload = {sourceTaskId: file.sourceTaskId, attachmentId: file.attachmentId || file.mobileAttachmentId};
    } else {
      const bytes = file.data instanceof Uint8Array ? file.data
        : typeof file.arrayBuffer === 'function' ? new Uint8Array(await file.arrayBuffer()) : null;
      if (!bytes) throw Error('材料原件不可用，请重新选择文件后再保存需求');
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      payload = {name: String(file.name || ''), data: btoa(binary)};
    }
    return request(record, 'uploadRequirementAttachment', {id, file: payload});
  };
  global.openDetailEntry = id => {void request(current(), 'openRequirement', {id}).catch(report);};
  global.openSchedulesEntry = options => {void request(current(), 'openAutomation', {id: options?.scheduleId || ''}).catch(report);};
  // The current execution directory is authoritative; no synthetic methods are added.
  global._schmLoad = async () => {
    const data = await request(current(), 'executionOptions');
    return data.methods || data.personalPlugins || [];
  };
  async function mount(record, restore = false, options = {}) {
    check(record);
    if (saving) throw Error('上一张工作卡正在保存，请等待回执');
    if (active && active !== record) {capture(); global.WorkEntrySheet.close(false, true); idleCard(active);}
    formObserver?.disconnect(); formObserver = null;
    active = record; record.closed = false;
    const host = slot(record); host.replaceChildren();
    const hint = document.createElement('p'); hint.className = 'mobile-work-local';
    hint.textContent = '工作卡保留在侧栏的本机工作记录中；确认后保存到工作空间。' +
      (record.actionId === 'work.automation.create' ? '新计划先保存为暂停状态，可在详情中启用。' : ''); host.appendChild(hint);
    const form = document.createElement('div'); form.className = 'mobile-work-form'; host.appendChild(form);
    const model = () => global.NativeChat?.sessionInfo?.()?.model || record.model || '';
    const originalFiles = options.files || [];
    const missing = restore ? [...(record.missingFiles || []), ...(record.files || [])] : [];
    if (missing.length) record.missingFiles = missing;
    const seed = {
      text: record.text, parseText: record.parseText, instruction: record.text, model,
      host: form, cardId: record.id, saveOnly: true, triageStage: 'intake',
      source: '移动对话', bindingContext: record.bindingContext || {},
      conversationContext: {...record.conversationContext, files: options.conversationContext?.files || []},
      attachmentContext: record.attachmentContext || [], proposal: record.actionId === 'work.automation.create' ? {enabled: false} : undefined,
      bridge: {model, atts: () => originalFiles},
      onCardState: snapshot => {saving = snapshot?.phase === 'submitting'; update(record, snapshot);},
      onBeforeSubmit: async snapshot => {
        check(record);
        if ((record.missingFiles || missing).some(wanted => !(snapshot?.files || []).some(file => file.name === wanted.name && Number(file.size || 0) === wanted.size))) {
          throw Error('草稿中的附件需要重新添加原件，内容齐全后才能保存');
        }
        update(record, snapshot);
        if (record.storageError) throw Error(record.storageError);
        persist();
      },
      onCardClose: snapshot => {
        if (disposed || active !== record) return;
        if (snapshot) update(record, snapshot); else capture();
        // Cancel the active action while retaining the local draft for an
        // explicit resume. A newer, different composer selection is preserved.
        global.SoduWorkMobileComposerActions?.clear?.(record.actionId);
        record.closed = true; active = null;
        formObserver?.disconnect(); formObserver = null;
        try {persist();} catch (error) {report(error);}
        idleCard(record); reportDraftStatus();
      },
      onCreated: () => {
        capture();
        global.SoduWorkMobileComposerActions?.clear?.(record.actionId);
        if (record.actionId === 'work.automation.create') hint.textContent = '自动化已保存为暂停状态，请在详情中检查后启用。';
      },
    };
    if (restore && record.snapshot) seed.cardState = {...clone(record.snapshot), files: []};
    if (record.actionId === 'work.automation.create') {
      // The mobile Host intentionally creates paused schedules. The visible
      // confirmation must show that same value, never silently discard a toggle.
      formObserver = new MutationObserver(() => {
        for (const input of form.querySelectorAll('input[name="enabled"]')) {input.checked = false; input.disabled = true;}
        for (const button of form.querySelectorAll('[data-waz-save]')) {
          if (button.textContent === '创建自动化') button.textContent = '保存为暂停计划';
        }
      });
      formObserver.observe(form, {childList: true, subtree: true});
      await global.WorkAutomationSheet.open(seed);
    }
    else await global.WorkEntrySheet.openTask(seed);
    if (missing.length) {
      const notice = document.createElement('p'); notice.className = 'mobile-work-attachment-warning';
      notice.textContent = '请重新添加草稿中的材料：' + missing.map(file => file.name).join('、');
      host.insertBefore(notice, form);
    }
    host.scrollIntoView?.({block: 'nearest'});
    return {ok: true, draft: true};
  }
  async function open(command, options = {}) {
    await initialized;
    const text = String(command.text || '').trim();
    if (!supported(command.id)) throw Error('此动作不是工作确认表单');
    if (!text && !options.conversationContext?.text) throw Error('请先描述要创建的工作内容');
    if (active?.actionId === command.id && !['succeeded', 'submitting'].includes(active.snapshot?.phase)) {
      const controller = command.id === 'work.automation.create' ? global.WorkAutomationSheet : global.WorkEntrySheet;
      if (controller.active()) {
        const ok = await controller.refine(command.parseText || text, {instruction: text, model: options.model || active.model || '',
          conversationContext: options.conversationContext, attachmentContext: options.attachmentContext || []});
        if (!ok) throw Error('草稿未更新，请检查提示后重试');
        capture(); return {ok: true, draft: true};
      }
    }
    capture();
    const info = global.NativeChat?.sessionInfo?.() || {};
    const record = {id: 'mobile-card-' + crypto.randomUUID(), actionId: command.id, text, taskId: String(ready.taskId || ''),
      parseText: String(command.parseText || text), model: typeof options.model === 'function' ? options.model() : options.model || info.model || '',
      bindingContext: clone(options.bindingContext || {}), attachmentContext: clone(options.attachmentContext || []),
      conversationContext: options.conversationContext ? {...clone({...options.conversationContext, files: undefined})} : null,
      snapshot: null, files: [], updatedAt: Date.now()};
    records.push(record);
    reportDraftStatus();
    if (records.length > 20) records = records.slice(-20);
    persist();
    return mount(record, false, options);
  }
  let restored = false;
  const observer = new MutationObserver(() => {
    if (disposed || restored || !ready || document.documentElement.dataset.conversationReady !== 'true') return;
    restored = true;
    reportDraftStatus();
    for (const record of records) idleCard(record);
    const last = records.at(-1);
    if (last && !last.closed && last.snapshot?.phase !== 'succeeded') void mount(last, true).catch(report);
  });
  observer.observe(document.documentElement, {attributes: true, attributeFilter: ['data-conversation-ready']});
  global.addEventListener('pagehide', () => {capture(); disposed = true; saving = false; observer.disconnect(); formObserver?.disconnect();}, {once: true});
  global.SoduWorkMobileWorkCards = {open, supported, capture};
})(window);
