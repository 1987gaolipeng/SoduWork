'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const workflow = require('./personal-plugin-workflow');

const terminal = new Set(['completed', 'cancelled']);
const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function store(root, conversationId) {
  const file = path.join(root, digest(String(conversationId)) + '.json');
  return {
    read() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw new Error('本机调试记录无法读取，请保留记录后检查磁盘'); } },
    write(value) {
      fs.mkdirSync(root, { recursive: true });
      const temp = file + '.' + crypto.randomUUID() + '.tmp';
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      try { require('./verified-file-replace.cjs').replaceFileSync(temp, file); }
      finally { try { fs.unlinkSync(temp); } catch (_) {} }
    },
  };
}
function inputValues(fields, provided = {}) {
  const result = {};
  for (const field of fields || []) {
    const value = Object.hasOwn(provided, field.key) ? provided[field.key] : field.default;
    if (value == null || value === '') {
      if (field.required) throw new Error('请填写插件参数：' + field.label);
      continue;
    }
    if (field.type === 'boolean' && typeof value !== 'boolean' ||
        field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value)) ||
        !['boolean', 'number'].includes(field.type) && (typeof value !== 'string' || value.length > 8000) ||
        field.type === 'select' && !(field.options || []).some(option => option.value === value)) {
      throw new Error('插件参数格式不正确：' + field.label);
    }
    result[field.key] = value;
  }
  if (Object.keys(provided).some(key => !(fields || []).some(field => field.key === key))) throw new Error('包含未声明的插件参数');
  return result;
}
function createRecord(plugin, conversationId, prompt) {
  if (!plugin.enabled || !plugin.localDraft || plugin.localDraft.template !== 'workflow') {
    throw new Error('请选择已安装并启用的个人工作流插件');
  }
  const graph = workflow.normalize(plugin.localDraft);
  const enterprise = graph.nodes.find(node => workflow.ENTERPRISE_TYPES.has(node.type));
  if (enterprise) {
    throw new Error('这个插件包含“' + enterprise.name + '”企业执行节点；请先提交企业审核并绑定项目，再从任务中运行完整流程');
  }
  const order = workflow.simulation(graph).order.map(node => node.key);
  return { schema: 1, id: crypto.randomUUID(), conversationId, pluginId: plugin.pluginId,
    name: plugin.name, version: plugin.version, checksum: plugin.checksum,
    plugins: require('./conversation/plugin-badges').publicBadges([{ ...plugin, scopeLabel: '仅自己' }]),
    prompt: String(prompt || ''), status: 'queued', revision: 0, createdAt: Date.now(),
    nodes: order.map(key => ({ ...graph.nodes.find(node => node.key === key), status: 'pending', attempt: 0, outputsFound: [] })) };
}
function view(record) {
  if (!record) return null;
  return { id: record.id, conversationId: record.conversationId, pluginId: record.pluginId,
    name: record.name, version: record.version, checksum: record.checksum, status: record.status,
    revision: record.revision, createdAt: record.createdAt, updatedAt: record.updatedAt,
    mode: record.mode || 'debug', issues: record.issues || [], reason: record.reason || '', nodes: record.nodes.map(node => ({
      key: node.key, name: node.name, type: node.type, status: node.status, attempt: node.attempt,
      pendingPermissions: node.pendingPermissions || [], canReconnect: Boolean(node.ref), maxAttempts: node.retry.maxAttempts, agent: node.agent || '', model: node.model || '', reason: node.reason || '',
      summary: node.type === 'human_review' ? node.config.summary : '',
      outputs: node.outputsFound || [],
    })) };
}
function create({ record, save, executeNode, stopNode, preflight, answerPermission, validateApproval = async () => [], changed = () => {}, message = () => {} }) {
  let driving = false, resolveWake = null, actionBusy = false, needsCheck = true;
  const wake = () => { if (resolveWake) { resolveWake(); resolveWake = null; } };
  const commit = () => { record.revision++; record.updatedAt = Date.now(); save(clone(record)); changed(view(record)); };
  const current = () => record.nodes.find(node => node.status !== 'completed');
  function inputValues(node) {
    return node.inputs.map(input => {
      const parent = record.nodes.find(item => item.key === input.fromNode);
      const value = parent.outputsFound.find(item => item.key === input.outputKey);
      if (!value && input.required) throw new Error('上游缺少产出：' + input.fromNode + '.' + input.outputKey);
      return value ? { ...value, inputKey: input.key, fromNode: input.fromNode } : null;
    }).filter(Boolean);
  }
  async function execute() {
    if (driving) throw new Error('本次调试已在执行');
    driving = true;
    try {
      if (terminal.has(record.status)) return { ok: record.status === 'completed', cancelled: record.status === 'cancelled' };
      if (record.status === 'queued') { record.status = 'running'; commit(); }
      for (;;) {
        if (record.status === 'cancelled') return { ok: true, cancelled: true };
        if (needsCheck && preflight) {
          needsCheck = false;
          let check;
          try { check = await preflight(record); }
          catch (error) { check = { ok: false, issues: [{ message: error.message || '运行前检查未完成' }] }; }
          if (record.status === 'cancelled') continue;
          if (!check.ok) {
            if (record.status !== 'blocked') record.resumeStatus = record.status;
            record.status = 'blocked'; record.issues = check.issues || [];
            record.reason = record.issues.map(item => (item.nodeName ? item.nodeName + '：' : '') + item.message).join('；');
            commit();
          } else {
            if (record.status === 'blocked') { record.status = record.resumeStatus || 'running'; delete record.resumeStatus; }
            record.issues = []; record.reason = '';
            for (const plan of check.nodes || []) {
              const target = record.nodes.find(item => item.key === plan.nodeKey);
              if (target && target.status === 'pending') { target.agent = plan.agent; target.model = plan.model; }
            }
            commit();
          }
        }
        const node = current();
        if (!node) {
          record.status = 'completed'; record.reason = ''; commit();
          message(record.mode === 'conversation' ? '协作已完成，成果与各步骤记录已保留。' : '本机工作流调试已完成。此结果不代表企业审核或上架。', record.id + ':completed');
          return { ok: true };
        }
        if (['waiting', 'failed', 'blocked'].includes(record.status)) {
          await new Promise(resolve => { resolveWake = resolve; });
          continue;
        }
        try {
          if (node.dependsOn.some(key => record.nodes.find(item => item.key === key).status !== 'completed')) {
            throw new Error('上游节点尚未完成');
          }
          const inputs = inputValues(node);
          if (node.type === 'human_review') {
            node.status = 'waiting'; record.status = 'waiting'; commit();
            message((record.mode === 'conversation' ? '请在输入框上方确认「' : '请在插件调试卡中确认「') + node.name + '」。确认前后续步骤不会执行。', record.id + ':' + node.key + ':waiting');
            continue;
          }
          if (node.type === 'publish') {
            // Personal debug "publish" means local completion, never enterprise publication.
            node.outputsFound = []; node.status = 'completed'; commit(); continue;
          }
          if (node.status !== 'running') {
            node.attempt++; node.status = 'running'; node.reason = '';
            node.dispatchId = 'plugin-debug:' + record.id + ':' + node.key + ':' + node.attempt;
            node.startedAt = Date.now();
          }
          record.status = 'running'; commit(); // durable intent BEFORE dispatch
          const result = await executeNode(node, inputs, record, () => commit());
          if (record.status === 'cancelled') return { ok: true, cancelled: true };
          node.outputsFound = result; node.status = 'completed'; commit();
        } catch (error) {
          if (record.status === 'cancelled') return { ok: true, cancelled: true };
          node.status = 'failed'; node.reason = String(error.message || '节点执行失败');
          record.status = 'failed'; record.reason = node.reason; commit();
          message((record.mode === 'conversation' ? '协作暂停：' : '插件调试暂停：') + node.reason + '。请在输入框上方处理，后续步骤尚未执行。',
            record.id + ':' + node.key + ':' + node.attempt + ':failed');
        }
      }
    } finally { driving = false; }
  }
  async function action(command, revision, nodeKey, payload) {
    if (actionBusy || revision !== record.revision) throw new Error('调试状态已更新，请查看最新状态后重试');
    actionBusy = true;
    try {
      const node = current();
      if (command === 'cancel' && !terminal.has(record.status)) {
        // A stop timeout is NOT acknowledgement. Retain the queue lock.
        if (node && node.dispatchId) await stopNode(node);
        record.status = 'cancelled'; record.reason = '';
        if (node) node.status = 'cancelled';
        commit(); wake(); return view(record);
      }
      if (command === 'recheck' && record.status === 'blocked') {
        record.status = record.resumeStatus || 'running'; delete record.resumeStatus;
        record.reason = ''; record.issues = []; needsCheck = true; commit(); wake(); return view(record);
      }
      if (!node || node.key !== nodeKey) throw new Error('当前步骤已改变，请刷新调试卡');
      if (command === 'permission' && record.status === 'running' && typeof answerPermission === 'function') {
        await answerPermission(record, { nodeKey, requestId: payload?.requestId, allow: payload?.allow });
        commit(); return view(record);
      }
      if (command === 'approve' && record.status === 'waiting' && node.type === 'human_review') {
        const evidence = await validateApproval(record, node);
        node.approvedEvidence = evidence;
        node.status = 'completed'; node.approvedAt = Date.now();
        record.status = 'running'; commit(); wake(); return view(record);
      }
      if (command === 'reconnect' && record.status === 'failed' && node.ref) {
        node.status = 'running'; record.status = 'running'; record.reason = '';
        needsCheck = true; commit(); wake(); return view(record);
      }
      if (command === 'retry' && record.status === 'failed') {
        if (node.attempt >= (node.retry.maxAttempts || 1)) throw new Error('已达到该节点重试上限，请修改插件后重新调试');
        // Unknown dispatch outcomes must be reconciled/stopped before a new attempt.
        if (node.dispatchId) await stopNode(node);
        delete node.ref; delete node.dispatchId; delete node.dispatched;
        node.status = 'pending'; node.outputsFound = [];
        record.status = 'running'; record.reason = ''; commit(); wake(); return view(record);
      }
      throw new Error('当前状态不支持此操作');
    } finally { actionBusy = false; }
  }
  return { execute, action, view: () => view(record), record, driving: () => driving,
    cancel: () => action('cancel', record.revision) };
}
module.exports = { create, createRecord, view, store, terminal, inputValues };
