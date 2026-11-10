(function (global) {
  'use strict';
  const terminal = value => ['succeeded', 'failed', 'cancelled'].includes(value);
  const label = value => ({pending: '等待登记', queued: '排队中', running: '执行中', waiting: '等待处理',
    waiting_review: '等待审批', succeeded: '已完成', failed: '执行失败', cancelled: '已结束', skipped: '已跳过'}[value] || String(value || '等待开始'));
  const plain = value => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
  const safeName = value => String(value || '').replace(/[\\*_[\]<>#`]/g, '').slice(0, 160);
  const failure = error => ({ok: false, reason: String(error?.message || error)});
  function catalog(payload) {
    const rows = Array.isArray(payload?.items) ? payload.items : [], counts = new Map();
    for (const row of rows) counts.set(row.pluginId, (counts.get(row.pluginId) || 0) + 1);
    return {items: rows.map(row => {
      const workflow = row.capabilities?.hasWorkflow === true;
      const ready = workflow && row.runnable === true && row.bindingId && row.version && counts.get(row.pluginId) === 1;
      const blockers = (row.readiness?.blockers || []).map(item => typeof item === 'string' ? item : item.message || item.reason || '').filter(Boolean);
      const reason = !workflow ? '此能力没有远端工作流' : counts.get(row.pluginId) !== 1 ? '存在多个绑定，请先明确所属工程' :
        !row.bindingId || !row.version ? '工作流信息不完整，请刷新目录' : blockers.join('；') || '当前工作流暂不可执行';
      return {pluginId: row.pluginId, key: row.key || '', name: row.name, description: row.description,
        version: row.version, scope: '远端工作流', installed: Boolean(ready), inputs: row.inputs || [],
        workflow: row.workflow || [], capabilities: row.capabilities || {}, entrypoints: {conversation: true},
        conversationUse: {available: Boolean(ready), code: ready ? 'remote_workflow' : 'remote_workflow_unavailable',
          label: ready ? '在远端执行工作流' : reason}};
    }).filter(row => typeof row.pluginId === 'string' && row.pluginId)};
  }
  function project(handle) {
    const work = handle.workflow, run = work?.run, nodes = Array.isArray(run?.nodes) ? run.nodes : [];
    const messages = [], tools = [];
    const instruction = work?.instruction || run?.input?.instruction || run?.input?.requirement || '';
    if (typeof instruction === 'string' && instruction) messages.push({role: 'user', text: instruction,
      done: true, taskId: handle.taskId, taskOutputKey: 'workflow-request:' + (work.requestId || work.runId)});
    const lines = [safeName(run?.name || work?.label || '远端工作流') + ' · ' + label(run?.state || 'pending')];
    for (const node of nodes) lines.push('- ' + safeName(node.name || node.key || '流程节点') + '：' + label(node.state));
    if (run?.error) lines.push('执行说明：' + plain(run.error).slice(0, 4000));
    if (work?.sessionsTruncated) lines.push('执行节点较多，当前仅展示前 100 个节点的日志。');
    if (handle.error) lines.push('更新说明：' + String(handle.error).slice(0, 1000));
    messages.push({role: 'assistant', text: lines.join('\n\n'), done: true, taskId: handle.taskId,
      taskOutputKey: 'workflow-status:' + (work.runId || work.requestId), workflowRecord: true});
    for (const node of nodes) {
      const refs = [...(work.sessions?.values() || [])].filter(row => row.nodeId === node.id);
      for (const session of refs) {
        if (session.events.size && global.SoduWorkMobileSnapshot?.project) {
          const part = global.SoduWorkMobileSnapshot.project({events: session.events, status: session.page.status,
            adapterId: session.page.engine || node.executor?.resolved?.agentKind?.replace(/^local:/, '') || 'remote',
            taskId: handle.taskId, model: {name: session.page.model || ''}});
          const offset = messages.length;
          messages.push(...part.messages.map((message, index) => ({...message, taskId: handle.taskId,
            taskOutputKey: 'workflow-node:' + session.key + ':' + index, workflowNodeId: node.id})));
          tools.push(...part.tools.map(tool => ({...tool, id: session.key + ':' + tool.id,
            after: Math.max(0, Number(tool.after) || 0) + offset})));
        }
        if (session.error) messages.push({role: 'assistant', text: safeName(node.name || node.key) + '：' + session.error,
          done: true, taskId: handle.taskId, taskOutputKey: 'workflow-log-error:' + session.key, workflowRecord: true});
      }
      if (!node.executor?.ref && (node.output && Object.keys(Object(node.output)).length || node.error)) {
        const content = [safeName(node.name || node.key), node.error ? '执行说明：' + plain(node.error) : '',
          node.output ? plain(node.output).slice(0, 12000) : ''].filter(Boolean).join('\n\n');
        messages.push({role: 'assistant', text: content, done: true, taskId: handle.taskId,
          taskOutputKey: 'workflow-output:' + node.id, workflowRecord: true});
      }
    }
    if (run?.output && Object.keys(Object(run.output)).length) messages.push({role: 'assistant',
      text: '工作流结果\n\n' + plain(run.output).slice(0, 20000), done: true, taskId: handle.taskId,
      taskOutputKey: 'workflow-result:' + work.runId, workflowRecord: true});
    const busy = !terminal(run?.state);
    return {messages: messages.map(message => message.role === 'assistant' && !message.blocks ?
      {...message, blocks: [{kind: 'text', text: message.text, done: true}]} : message), tools, adapterId: '', displayName: '远端工作流', model: null, modelSelection: {name: '', model: null},
      status: busy ? 'streaming' : 'idle', statusText: label(run?.state || 'pending'),
      execution: {configured: false, visible: false, running: busy, stopped: ['failed', 'cancelled'].includes(run?.state), queue: []},
      accessControl: {supported: false}, remote: true, workflowTaskId: handle.taskId, workflowRunId: work.runId, workflowState: run?.state || 'pending'};
  }
  function create({bridge, handleOf}) {
    function current(handle) {if (handle.closed || handleOf(handle.ref) !== handle) throw Error('对话已关闭，请从历史中核对工作');}
    function apply(handle, result) {
      if (result?.ok !== true || result.workflow !== true || !result.taskId ||
          handle.taskId && result.taskId !== handle.taskId) throw Error('工作流回执与当前对话不一致');
      const work = handle.workflow || {sessions: new Map()};
      if (work.runId && result.runId && work.runId !== result.runId) throw Error('工作流运行编号发生变化，请重新打开核对');
      if (result.run && (result.run.id !== result.runId || result.run.taskId !== result.taskId)) throw Error('工作流记录归属不一致');
      handle.taskId = result.taskId; work.requestId = result.requestId || work.requestId || '';
      work.runId = result.runId || work.runId || ''; work.run = result.run || work.run || null;
      work.sessionsTruncated = result.sessionsTruncated === true;
      for (const item of result.sessions || []) {
        if (!item.key || item.key !== item.nodeId + ':' + item.ref || !(work.run?.nodes || []).some(node =>
          node.id === item.nodeId && node.executor?.ref === item.ref)) throw Error('节点日志与工作流不一致');
        const previous = work.sessions.get(item.key) || {key: item.key, nodeId: item.nodeId, ref: item.ref, events: new Map(), since: 0, page: {}};
        previous.error = item.error || '';
        if (item.page) {
          for (const event of item.page.items || []) {
            if (!Number.isSafeInteger(event.seq) || event.seq < 0) throw Error('节点日志序号无效');
            previous.events.set(event.seq, event);
          }
          if (!Number.isSafeInteger(item.page.last) || item.page.last < 0) throw Error('节点日志游标无效');
          previous.since = Math.max(previous.since, item.page.last); previous.page = item.page;
        }
        work.sessions.set(item.key, previous);
      }
      handle.workflow = work;
      handle.status = ({succeeded: 'completed', failed: 'failed', cancelled: 'cancelled'}[work.run?.state]) || 'running';
      return result;
    }
    async function start(handle, text, plugins, options = {}) {
      try {
        current(handle);
        if (handle.taskId) throw Error('请新建对话发起工作流，当前工作记录会保留');
        if (plugins.length !== 1 || (options.files || []).length || (options.skills || []).length) throw Error('每次请选择一个工作流；附件和额外技能请按插件参数填写');
        const fingerprint = JSON.stringify([text, plugins, options.projectId || '']);
        if (handle.pending && handle.pending.fingerprint !== fingerprint) throw Error('上一笔工作尚未确认，请保留原内容核对');
        const requestedRequestId = String(options.submissionId || '').trim();
        const requestId = handle.pending?.messageId ||
          (/^[A-Za-z0-9-]{1,80}$/.test(requestedRequestId) ? requestedRequestId : crypto.randomUUID());
        if (typeof requestId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(requestId)) throw Error('工作请求编号无效，请重新打开对话');
        handle.pending = {fingerprint, messageId: requestId};
        const result = await bridge.call('workflowStart', {requestId, instruction: text, plugins, projectId: options.projectId || ''});
        current(handle);
        // Host may recover the original persisted request id after a reload.
        if (!['started', 'pending'].includes(result?.phase) || typeof result.requestId !== 'string' ||
            !/^[A-Za-z0-9-]{1,80}$/.test(result.requestId) || result.phase === 'started' && !result.runId) throw Error('工作回执尚未核实，请保留原请求');
        apply(handle, result); handle.workflow.instruction = text; handle.workflow.label = plugins[0].name || '';
        handle.pending = null; handle.error = '';
        return result;
      } catch (error) {return failure(error);}
    }
    async function poll(handle) {
      current(handle); if (!handle.workflow) throw Error('当前不是工作流会话');
      const work = handle.workflow;
      const result = await bridge.call('workflowPoll', {taskId: handle.taskId, runId: work.runId,
        requestId: work.requestId, since: Object.fromEntries([...work.sessions].map(([key, row]) => [key, row.since]))});
      current(handle); return apply(handle, result);
    }
    async function restore(handle) {
      current(handle);
      const result = await bridge.call('workflowPoll', {taskId: handle.taskId, since: {}});
      current(handle);
      if (result?.ok === true && result.workflow === false && result.taskId === handle.taskId) return false;
      apply(handle, result); return true;
    }
    async function cancel(handle) {
      current(handle); if (!handle.workflow?.runId) throw Error('工作流回执尚未确认，请稍后再结束');
      const result = await bridge.call('workflowCancel', {taskId: handle.taskId, runId: handle.workflow.runId});
      current(handle);
      if (result?.ok !== true) throw Error(result?.reason || '工作流未能结束');
      apply(handle, result); return result;
    }
    return {catalog, start, poll, restore, cancel, project};
  }
  global.SoduWorkMobileWorkflow = {create, catalog, project};
})(window);
