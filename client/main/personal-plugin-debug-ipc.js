'use strict';
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const context = require('./personal-plugin-context.cjs');
const core = require('./personal-plugin-debug');
const personal = require('./personal-plugins');
function install({ app, ipcMain, session, identityOf, skillDirs, deviceGrants, managedInputsRoot,
  assertOwner = () => {}, createExecutor = options => require('./personal-plugin-debug-runner').create(options) }) {
  const controllers = new Map(), pending = new Map();
  const root = path.join(app.getPath('userData'), 'plugin-debug-runs');
  const journal = handle => core.store(root, handle.sessionId);
  const ownerOf = identity => require('./platform-connections/runtime.cjs').connectionScope(identity);
  async function checkedIdentity(handle, record) {
    const identity = await identityOf(app);
    assertOwner(identity, handle);
    const owner = ownerOf(identity);
    if (record && record.owner !== owner) throw new Error('此协作记录属于另一个账号或服务，请切回原账号与服务');
    return { identity, owner };
  }
  const receipt = (handle, owner, requestId) => core.store(path.join(root, 'requests'), owner + ':' + handle.sessionId + ':' + requestId);
  function persist(handle, record) {
    core.store(path.join(root, 'archive'), record.id).write(record);
    journal(handle).write(record);
    receipt(handle, record.owner, record.requestId).write({ runId: record.id });
  }
  function owned(event, ref) {
    const handle = session.get(String(ref || ''));
    if (!handle || !handle.attachedWindow || handle.attachedWindow.isDestroyed() ||
        handle.attachedWindow.webContents.id !== event.sender.id) {
      throw new Error('请在当前打开的对话中操作插件调试');
    }
    return handle;
  }
  async function stageInputs(handle, record, rawFiles) {
    const seen = new Set();
    const uniqueFiles = rawFiles.filter(item => {
      const key = item.path || item.name + ':' + item.size;
      if (seen.has(key)) return false; seen.add(key); return true;
    });
    const inputDir = path.join(handle.cwd, '.soduwork-debug-inputs', record.id);
    const staged = await require('./pi-session/attachments').stage(handle.cwd, uniqueFiles, { stagingDir: inputDir });
    if (staged.warnings.length) throw new Error(staged.warnings.join('；'));
    return staged.files.map(item => {
      if (item.kind === 'dir') throw new Error('本机工作流调试请附加具体文件，不接受整个文件夹');
      const source = require('./personal-plugin-debug-runner').safeFile(handle.cwd, path.relative(handle.cwd, item.path));
      const data = fs.readFileSync(source);
      if (data.length > 24 * 1024 * 1024) throw new Error('调试附件暂不支持超过 24MB 的单个文件');
      return { name: item.name, path: path.relative(handle.cwd, source).replace(/\\/g, '/'),
        type: item.mimeType, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
    });
  }
  async function captureContext(handle, record) {
    if (record.contextFrozen || !Object.hasOwn(record, 'contextBase')) return;
    const live = record.includeContext ? (handle.snapshot() || {}) : {};
    const snapshot = context.conversation({
      messages: live.messages || [], tools: live.tools || [],
    });
    record.prompt = context.prompt(record.contextBase, snapshot);
    const contract = require('./pi-session/attachment-contract');
    const historyFiles = snapshot.messages.filter(message => message.role === 'user')
      .flatMap(message => message.attachments || []).map(item => {
        const reference = contract.previewPath(item.previewRef);
        let source = '';
        try { if (reference) source = fs.realpathSync(path.isAbsolute(reference) ? reference : path.resolve(handle.cwd, reference)); }
        catch (_) { /* Reject unavailable or untrusted input before any node is dispatched. */ }
        const roots = [handle.cwd, managedInputsRoot()].filter(Boolean);
        if (!source || !roots.some(root => {
          try { return require('./pi-session/attachments').inside(fs.realpathSync(root), source); }
          catch (_) { return false; }
        })) throw new Error('历史附件无法安全定位，请重新附加该文件');
        return { name: item.name, type: item.type, path: source };
      });
    const inputFiles = (record.inputAttachments || []).map(item => {
      const source = require('./personal-plugin-debug-runner').safeFile(handle.cwd, item.path);
      if (crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex') !== item.sha256)
        throw new Error('用户输入附件已变化，请重新发起协作');
      return { ...item, path: source };
    });
    const seen = new Set(inputFiles.map(item => item.path));
    const historical = historyFiles.filter(item => !seen.has(item.path) && seen.add(item.path));
    const room = Math.max(0, 20 - inputFiles.length);
    const retained = room ? historical.slice(-room) : [];
    if (retained.length < historical.length) record.prompt += '\n较早的部分附件未再次复制；仅使用本节点输入清单内的文件，不要猜测缺少的附件内容。';
    record.attachments = await stageInputs(handle, record, [...inputFiles, ...retained]);
    delete record.contextFile;
    if (snapshot.truncated) {
      const data = Buffer.from(snapshot.fullText);
      if (data.length <= 24 * 1024 * 1024) {
        const relative = path.join('.soduwork-debug-inputs', record.id, 'context-' + crypto.randomUUID() + '.txt');
        const target = require('./personal-plugin-debug-runner').safeFile(handle.cwd, relative, false);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        require('./personal-plugin-debug-runner').safeFile(handle.cwd, relative, false);
        fs.writeFileSync(target, data, { flag: 'wx', mode: 0o600 });
        record.contextFile = { path: relative.replace(/\\/g, '/'), name: '会话参考.txt', size: data.length,
          sha256: crypto.createHash('sha256').update(data).digest('hex') };
      } else record.prompt += '\n完整历史超出可带入的材料容量；如当前节点依赖未保留的历史细节，请明确请求补充，不要推断。';
    }
  }
  function make(handle, record) {
    let publication = Promise.resolve();
    const publish = (method, ...args) => {
      publication = publication.then(() => handle[method](...args));
      publication.catch(() => {});
    };
    const plugin = personal.get(app, record.pluginId);
    const executor = createExecutor({
      app, handle, plugin, identityOf, skillDirs: skillDirs(), deviceGrants: deviceGrants(),
      async assertOwner(identity, value) {
        assertOwner(identity, handle);
        if (ownerOf(identity) !== value.owner) throw new Error('账号或服务已变化，协作已暂停，请切回原账号与服务');
      },
    });
    const controller = core.create({ record, ...executor,
      async validateApproval(value, gate) {
        await checkedIdentity(handle, value);
        return require('./personal-plugin-approval.cjs').verify(value, gate, handle.cwd);
      },
      save(value) { persist(handle, value); },
      changed(value) { publish('pluginDebugChanged', value); },
      message(text, key) { publish('appendTaskMessage', 'assistant', text, [], '', 'plugin-debug:' + key); },
    });
    controller.flush = () => publication;
    controllers.set(handle.sessionId, controller);
    return controller;
  }
  async function queue(handle, controller) {
    if (controller.submitted) return controller.submission;
    if (((handle.snapshot().execution || {}).turnQueue || {}).paused) {
      throw new Error('当前会话队列已暂停，请先在输入框上方恢复队列，再恢复插件调试');
    }
    const record = controller.record;
    record.queueAttempt = (record.queueAttempt || 0) + 1;
    persist(handle, record);
    const submissionId = record.queueAttempt === 1 ? record.requestId : 'workflow-resume-' + record.id + '-' + record.queueAttempt;
    controller.submitted = true;
    let result;
    try { result = await handle.submit(record.mode === 'conversation' ? record.prompt : '本机调试插件：' + record.name, [], {
      executor: 'plugin-debug', pluginDebug: true, submissionId,
      controlled: { execute: async () => {
        await checkedIdentity(handle, record);
        await captureContext(handle, record);
        await checkedIdentity(handle, record);
        record.contextFrozen = true; persist(handle, record);
        if (record.mode === 'conversation') await handle.rememberWorkflowPlugin?.(record.pluginId);
        if (!record.announced) {
          const plugins = record.mode === 'conversation'
            ? require('./conversation/plugin-badges').publicBadges(record.plugins || [{
              pluginId: record.pluginId, name: record.name, version: record.version, scopeLabel: '仅自己',
            }]) : [];
          await handle.appendTaskMessage('user', record.mode === 'conversation' ? record.userText : '本机调试插件「' + record.name + '」v' + record.version + '\n' + record.prompt, (record.attachments || []).map(item => ({ ...item, path: path.join(handle.cwd, item.path) })), '', record.id + ':start', undefined, undefined, plugins);
          record.announced = true; persist(handle, record);
        }
        const result = await controller.execute();
        await controller.flush();
        return result;
      }, cancel: () => controller.cancel() },
      afterTurn: async status => {
        controller.submitted = false;
        if (status === 'stopped' && record.status === 'queued') await controller.cancel();
      },
    }); } catch (error) { controller.submitted = false; throw error; }
    if (!result.accepted) { controller.submitted = false; throw new Error('调试未能进入当前对话队列'); }
    controller.submission = result;
    Promise.resolve(result.completion).finally(() => { controller.submitted = false; }).catch(() => {});
    return result;
  }
  function snapshot(handle) {
    const controller = controllers.get(handle.sessionId);
    const record = controller ? controller.record : journal(handle).read();
    return { ok: true, run: core.view(record),
      recoverable: Boolean(record && !core.terminal.has(record.status) && !(controller && controller.submitted)) };
  }
  async function invoke(event, ref, options) {
    const handle = owned(event, ref);
    return invokeHandle(handle, options);
  }
  async function invokeHandle(handle, options) {
    const optionsSafe = options || {}, command = optionsSafe.command;
    const existing = controllers.get(handle.sessionId)?.record || journal(handle).read();
    const { owner } = await checkedIdentity(handle, existing);
    if (command === 'get') return snapshot(handle);
    if (pending.has(handle.sessionId)) throw new Error('调试请求正在处理，请稍候');
    const token = {};
    pending.set(handle.sessionId, token);
    try {
      await checkedIdentity(handle, existing);
      let controller = controllers.get(handle.sessionId);
      let record = controller ? controller.record : journal(handle).read();

      if (command === 'start') {
        if (!/^[a-zA-Z0-9_-]{12,80}$/.test(optionsSafe.requestId || '')) throw new Error('缺少有效的协作请求标识');
        const accepted = receipt(handle, owner, optionsSafe.requestId).read();
        if (accepted) {
          const prior = core.store(path.join(root, 'archive'), accepted.runId).read();
          if (!prior || prior.owner !== owner) throw new Error('协作回执无法核对，请保留记录后重试');
          return { ok: true, duplicate: true, run: core.view(prior),
            submitted: controller?.record.id === prior.id ? controller.submission : null };
        }
        if (record && !core.terminal.has(record.status)) throw new Error('当前会话已有协作，请先完成或停止，再开始新一轮');
        const plugin = personal.get(app, optionsSafe.pluginId);
        const prompt = String(optionsSafe.prompt || '');
        if (!prompt.trim() || prompt.length > 20000) throw new Error('请填写 1 至 20000 字的本次调试说明');
        record = core.createRecord(plugin, handle.sessionId, prompt);
        record.owner = owner; record.requestId = optionsSafe.requestId;
        record.mode = optionsSafe.mode === 'conversation' ? 'conversation' : 'debug';
        record.userText = prompt;
        record.parameters = core.inputValues(plugin.inputs, optionsSafe.parameters || {});
        if (Object.keys(record.parameters).length) record.prompt += '\n\n插件参数：\n' + JSON.stringify(record.parameters);
        record.contextBase = record.prompt;
        record.includeContext = optionsSafe.includeContext !== false;
        record.inputAttachments = await stageInputs(handle, record, Array.isArray(optionsSafe.attachments) ? optionsSafe.attachments : []);
        await captureContext(handle, record);
        await checkedIdentity(handle, record);
        persist(handle, record);
        controller = make(handle, record);
        await queue(handle, controller);
      } else {
        if (!record || record.id !== optionsSafe.runId) throw new Error('调试记录已更新，请重新打开调试卡');
        if (!controller) controller = make(handle, record);
        if (command === 'resume') {
          if (optionsSafe.revision !== record.revision) throw new Error('调试状态已更新，请重试');
          if (!controller.submitted) await queue(handle, controller);
        } else {
          await controller.action(command, optionsSafe.revision, optionsSafe.nodeKey, optionsSafe);
          try { await controller.flush(); }
          catch (error) {
            // action() has already confirmed node stop and saved cancellation.
            // A lost parent cannot receive a UI projection; its accepted main
            // callback must still unwind so the next process can be reopened.
            if (command !== 'cancel' || record.status !== 'cancelled' ||
                !handle.snapshot().runtimeUnavailable || error.code !== 'RUNTIME_PROCESS_GONE') throw error;
          }
        }
      }
      return { ...snapshot(handle), submitted: controller?.submission };
    } finally { if (pending.get(handle.sessionId) === token) pending.delete(handle.sessionId); }
  }
  ipcMain.handle('personal-plugin-debug', async (event, ref, options) => {
    try { const { submitted, ...result } = await invoke(event, ref, options); return result; }
    catch (error) { return { ok: false, reason: error.message || '插件调试暂时不可用' }; }
  });
  return {
    async submitConversation(handle, text, files, options, selections) {
      const explicit = Array.isArray(selections) ? selections : [];
      const workflows = explicit.filter(item => String(item?.pluginId || '').startsWith('local:'))
        .map(item => ({ selection: item, plugin: personal.get(app, item.pluginId) }))
        .filter(item => item.plugin.localDraft?.template === 'workflow');
      if (!workflows.length) return null;
      if (workflows.length !== 1 || explicit.length !== 1) throw new Error('一次只运行一个协作插件，请保留本次要执行的插件');
      if (options.taskId) throw new Error('需求中的协作请使用已发布并绑定项目的企业工作流');
      const item = workflows[0];
      if (item.plugin.conversationUse?.available === false) throw new Error(item.plugin.conversationUse.reason || '请先完成插件设置');
      const result = await invokeHandle(handle, { command: 'start', mode: 'conversation',
        pluginId: item.plugin.pluginId, requestId: options.submissionId, prompt: text,
        parameters: item.selection.inputValues || {}, includeContext: true, attachments: files });
      const submitted = result.submitted || { accepted: true, queued: false, completion: Promise.resolve({ ok: true, duplicate: true }) };
      return { ...submitted, workflowRun: result.run };
    },
    guard(handle) {
      const record = journal(handle).read(), controller = controllers.get(handle.sessionId);
      return record && !core.terminal.has(record.status) && !(controller && controller.submitted)
        ? (record.mode === 'conversation' ? '本次协作尚未恢复，请在对话下方恢复或停止后再继续' : '本次对话还有未恢复的插件调试，请输入 /调试插件，恢复或停止后再继续') : '';
    },
  };
}
module.exports = { install };
