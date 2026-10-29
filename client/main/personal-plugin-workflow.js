/* Structured personal workflow drafts. Concrete runners, credentials and environments stay out. */
'use strict';

const NODE_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const TAG = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const AGENT_KINDS = new Set(['', 'hosted']);
const LOCAL_AGENT_KIND = /^local:[a-z0-9][a-z0-9-]{0,31}$/;
const validAgentKind = (value) =>
  AGENT_KINDS.has(value) || LOCAL_AGENT_KIND.test(value);
const ENTERPRISE_TYPES = new Set([
  'spec', 'quality', 'approval', 'merge', 'deploy_chain', 'validate',
]);
const NODE_TYPES = new Set(['ai', 'ai_review', 'human_review', ...ENTERPRISE_TYPES, 'publish']);
const OUTPUT_KINDS = new Set(['file', 'git', 'evidence', 'url', 'decision']);
const AI_TYPES = new Set(['ai', 'ai_review']);
const SECRET_FIELD = /password|passwd|token|secret|private.?key|api.?key/i;
const CONCRETE_ROUTE_FIELDS = new Set(['runnerId', 'hostId', 'clientId', 'machineId', 'endpoint']);

function text(value, limit) {
  return String(value == null ? '' : value).trim().slice(0, limit);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function array(value, limit) {
  return (Array.isArray(value) ? value : []).slice(0, limit);
}

function uniqueNames(value, limit, itemLimit) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[,，\n]/);
  return [...new Set(source.map((item) => text(item, itemLimit)).filter(Boolean))].slice(0, limit);
}

function hasContent(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return String(value == null ? '' : value).trim() !== '';
}

function hasSecretField(value) {
  if (Array.isArray(value)) return value.some(hasSecretField);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) =>
    (SECRET_FIELD.test(key) && hasContent(child)) || hasSecretField(child));
}

function safePath(value, nodeKey) {
  const result = text(value, 300).replace(/\\/g, '/');
  const parts = result.split('/');
  if (!result || result.startsWith('/') || /[:\x00]/.test(result) || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('节点「' + nodeKey + '」的文件路径必须位于工作目录内');
  }
  return result;
}

function normalizeOutputs(value, nodeKey, nodeType) {
  const source = array(value, 20);
  if (AI_TYPES.has(nodeType) && !source.length) {
    throw new Error('AI 节点「' + nodeKey + '」至少要声明一项可交接的产出');
  }
  const keys = new Set();
  let decisionCount = 0;
  return source.map((raw, index) => {
    raw = object(raw);
    const key = text(raw.key || ('output_' + (index + 1)), 64);
    const kind = text(raw.kind || 'evidence', 20).toLowerCase();
    if (!NODE_KEY.test(key) || keys.has(key)) {
      throw new Error('节点「' + nodeKey + '」的产出标识不合法或重复：' + (key || '空值'));
    }
    if (!OUTPUT_KINDS.has(kind)) throw new Error('节点「' + nodeKey + '」不支持产出类型：' + kind);
    if (kind === 'decision' && ++decisionCount > 1) throw new Error('节点「' + nodeKey + '」只能声明一项节点决策');
    keys.add(key);
    const output = {
      key, kind, label: text(raw.label || key, 100), required: raw.required !== false,
    };
    if (kind === 'file' || kind === 'decision') output.path = safePath(raw.path, nodeKey);
    return output;
  });
}

function normalizeRoute(raw, nodeKey) {
  raw = object(raw);
  const route = require('./personal-plugin-agent-route.cjs').read(raw);
  const agentKind = text(route.agentKind, 40);
  const fallbackMode = text(route.fallbackMode, 20).toLowerCase();
  const model = text(route.model, 160);
  const runnerTags = uniqueNames(route.runnerTags, 12, 40)
    .map((item) => item.toLowerCase());
  if (!validAgentKind(agentKind)) throw new Error('节点「' + nodeKey + '」选择了不支持的 Agent');
  if (fallbackMode && !['strict', 'best-effort'].includes(fallbackMode)) {
    throw new Error('节点「' + nodeKey + '」的降级策略不合法');
  }
  const badTag = runnerTags.find((item) => !TAG.test(item));
  if (badTag) throw new Error('节点「' + nodeKey + '」的执行机标签不合法：' + badTag);
  return { agentKind, model, fallbackMode, runnerTags };
}

function normalizeCapabilities(raw, body, nodeKey) {
  raw = raw == null ? null : object(raw);
  const allowed = {
    skills: [body.key, ...body.skills], mcpServers: body.mcpServers.slice(), runtime: body.runtime.slice(),
  };
  const result = raw == null ? allowed : {
    skills: uniqueNames(raw.skills, 30, 80),
    mcpServers: uniqueNames(raw.mcpServers, 30, 80),
    runtime: uniqueNames(raw.runtime, 30, 80),
  };
  if (!result.skills.includes(body.key)) result.skills = [body.key, ...result.skills];
  for (const field of ['skills', 'mcpServers', 'runtime']) {
    const unknown = result[field].filter((item) => !allowed[field].includes(item));
    if (unknown.length) {
      throw new Error('节点「' + nodeKey + '」使用了插件未声明的能力：' + unknown.join('、'));
    }
  }
  return {
    skills: result.skills, mcpServers: result.mcpServers, secrets: [], runtime: result.runtime,
    network: result.mcpServers.length > 0 || Boolean(body.platforms?.length) || body.template === 'connector',
  };
}

function normalizeConfig(raw, node) {
  raw = object(raw);
  if (AI_TYPES.has(node.type)) {
    const prompt = text(raw.prompt, 12000);
    if (!prompt) throw new Error('AI 节点「' + node.key + '」需要写清楚工作指令');
    const timeout = Number(raw.timeoutSeconds || 3600);
    if (!Number.isInteger(timeout) || timeout < 60 || timeout > 86400) {
      throw new Error('节点「' + node.key + '」的超时必须在 60 到 86400 秒之间');
    }
    const route = normalizeRoute(raw, node.key);
    return {
      prompt, timeoutSeconds: timeout,
      ...(route.agentKind ? { agentKind: route.agentKind } : {}),
      ...(route.model ? { model: route.model } : {}),
      ...(route.fallbackMode ? { fallbackMode: route.fallbackMode } : {}),
      ...(route.runnerTags.length ? { runnerTags: route.runnerTags } : {}),
    };
  }
  if (node.type === 'human_review') {
    return {
      action: text(raw.action, 40) || 'uat',
      summary: text(raw.summary, 500) || '按任务完成标准验收本次交付',
    };
  }
  if (node.type === 'publish') {
    return { message: text(raw.message, 500) || '成果已验收，任务完成并保留全过程证据' };
  }
  if (ENTERPRISE_TYPES.has(node.type)) {
    // These contracts are executed only after the immutable package is reviewed,
    // approved and bound by Hub. Keep their portable, credential-free config so
    // employees can author a complete delivery or a standalone release plugin.
    const config = JSON.parse(JSON.stringify(raw));
    if (node.type === 'quality') {
      if (!Array.isArray(config.commands) || !config.commands.length || config.commands.some(
        command => !command || typeof command !== 'object' ||
          !Array.isArray(command.argv) || !command.argv.length)) {
        throw new Error('质量门禁节点「' + node.key + '」必须配置 commands，每条命令使用非空 argv 数组');
      }
    }
    return config;
  }
  return {};
}

function defaultNodes(body) {
  const capabilities = normalizeCapabilities(null, body, 'default');
  return [
    {
      key: 'understand', type: 'ai', name: '理解与规划', dependsOn: [], inputs: [],
      outputs: [{ key: 'plan', kind: 'evidence', label: '执行计划', required: true }],
      capabilities,
      config: {
        prompt: '理解目标、输入、限制和完成标准，形成可执行计划后继续推进。\n\n' + body.instructions,
        timeoutSeconds: 3600,
      },
      retry: { maxAttempts: 2 },
    },
    {
      key: 'work', type: 'ai', name: '完成工作', dependsOn: ['understand'],
      inputs: [{
        key: 'plan', fromNode: 'understand', outputKey: 'plan',
        label: '执行计划', required: true,
      }],
      outputs: [{ key: 'result', kind: 'evidence', label: '交付成果', required: true }],
      capabilities,
      config: { prompt: body.instructions, timeoutSeconds: 3600 },
      retry: { maxAttempts: 2 },
    },
    {
      key: 'accept', type: 'human_review', name: '人工验收', dependsOn: ['work'],
      inputs: [{
        key: 'result', fromNode: 'work', outputKey: 'result',
        label: '待验收成果', required: true,
      }],
      outputs: [],
      config: { action: 'uat', summary: '按任务完成标准验收本次交付' },
      retry: { maxAttempts: 1 },
    },
    {
      key: 'complete', type: 'publish', name: '办结沉淀', dependsOn: ['accept'],
      inputs: [], outputs: [],
      config: { message: '成果已验收，任务完成并保留全过程证据' },
      retry: { maxAttempts: 1 },
    },
  ];
}

function topological(nodes) {
  const pending = new Map(nodes.map((node) => [node.key, new Set(node.dependsOn)]));
  const order = [], levels = [];
  while (pending.size) {
    const ready = nodes.filter((node) => pending.has(node.key) && pending.get(node.key).size === 0);
    if (!ready.length) throw new Error('工作流存在循环依赖，请调整节点的上游关系');
    levels.push(ready.map((node) => node.key));
    ready.forEach((node) => { order.push(node.key); pending.delete(node.key); });
    pending.forEach((deps) => ready.forEach((node) => deps.delete(node.key)));
  }
  return { order, levels };
}

function normalizeInputs(rawInputs, node, outputsByNode) {
  const direct = new Set(node.dependsOn);
  const source = Array.isArray(rawInputs) && rawInputs.length ? rawInputs :
    node.dependsOn.flatMap((fromNode) => (outputsByNode.get(fromNode) || []).map((output) => ({
      key: fromNode + '_' + output.key, fromNode, outputKey: output.key,
      label: output.label, required: output.required,
    })));
  const keys = new Set();
  return array(source, 40).map((raw, index) => {
    raw = object(raw);
    const fromNode = text(raw.fromNode, 64);
    const outputKey = text(raw.outputKey, 64);
    const key = text(raw.key || outputKey || ('input_' + (index + 1)), 64);
    if (!NODE_KEY.test(key) || keys.has(key)) {
      throw new Error('节点「' + node.key + '」的输入标识不合法或重复');
    }
    if (!direct.has(fromNode)) throw new Error('节点「' + node.key + '」只能接收直接上游节点的产出：输入「' + key + '」引用了「' + fromNode + '」，请将该节点加入 dependsOn，或移除此输入；间接依赖不能代替直接依赖');
    const output = (outputsByNode.get(fromNode) || []).find((item) => item.key === outputKey);
    if (!output) {
      throw new Error('节点「' + node.key + '」引用了上游未声明的产出：' +
        fromNode + '.' + outputKey);
    }
    keys.add(key);
    return {
      key, fromNode, outputKey, label: text(raw.label || output.label || key, 100),
      required: raw.required !== false,
    };
  });
}

function normalizeCustom(body, rawWorkflow) {
  if (hasSecretField(rawWorkflow)) throw new Error('工作流节点不能保存密码、密钥或令牌');
  const source = array(object(rawWorkflow).nodes, 30);
  if (!source.length) return defaultNodes(body);
  const keys = new Set();
  const nodes = source.map((raw, index) => {
    raw = object(raw);
    const key = text(raw.key || ('step_' + (index + 1)), 64);
    const type = text(raw.type || 'ai', 32).toLowerCase();
    if (!NODE_KEY.test(key) || keys.has(key)) {
      throw new Error('工作流节点标识不合法或重复：' + (key || '空值'));
    }
    if (!NODE_TYPES.has(type)) throw new Error('个人插件编辑器暂不支持节点类型：' + type);
    keys.add(key);
    const node = {
      key, type, name: text(raw.name || key, 100),
      dependsOn: uniqueNames(raw.dependsOn, 20, 64),
      outputs: normalizeOutputs(raw.outputs, key, type),
      retry: {
        maxAttempts: Math.min(5, Math.max(1, Number(object(raw.retry).maxAttempts) || 1)),
      },
    };
    const rawConfig = object(raw.config);
    const nestedRoute = object(rawConfig.execution);
    const concrete = [...CONCRETE_ROUTE_FIELDS].filter((field) =>
      Object.prototype.hasOwnProperty.call(rawConfig, field) ||
      Object.prototype.hasOwnProperty.call(nestedRoute, field));
    if (concrete.length) throw new Error('节点「' + key + '」不能绑定具体机器：' + concrete.join('、'));
    node.config = normalizeConfig(rawConfig, node);
    if (AI_TYPES.has(type)) node.capabilities = normalizeCapabilities(raw.capabilities, body, key);
    return { ...node, _inputs: raw.inputs };
  });
  nodes.forEach((node) => {
    const missing = node.dependsOn.find((key) => !keys.has(key));
    if (missing) throw new Error('节点「' + node.key + '」依赖了不存在的节点：' + missing);
    if (node.dependsOn.includes(node.key)) throw new Error('节点「' + node.key + '」不能依赖自己');
  });
  topological(nodes);
  if (!nodes.some((node) => AI_TYPES.has(node.type))) throw new Error('自动化流程至少需要一个 AI 节点');
  if (!nodes.some((node) => node.type === 'publish')) throw new Error('自动化流程需要一个办结节点');
  const outputsByNode = new Map(nodes.map((node) => [node.key, node.outputs]));
  nodes.forEach((node) => {
    node.inputs = normalizeInputs(node._inputs, node, outputsByNode);
    delete node._inputs;
  });
  return nodes;
}

function normalize(body) {
  let nodes;
  if (body.template === 'workflow') nodes = normalizeCustom(body, body.workflow);
  else {
    const direct = defaultNodes(body).find((node) => node.key === 'work');
    direct.name = '使用插件能力';
    direct.dependsOn = [];
    direct.inputs = [];
    nodes = [direct];
  }
  return { nodes };
}

function simulation(graph) {
  const nodes = array(object(graph).nodes, 30);
  const topology = topological(nodes);
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  return {
    sideEffectFree: true,
    order: topology.order.map((key, index) => {
      const node = byKey.get(key);
      const config = object(node.config);
      return {
        index: index + 1, key, name: node.name, type: node.type,
        dependencies: node.dependsOn.slice(),
        handoffs: (node.inputs || []).map((input) =>
          input.fromNode + '.' + input.outputKey + ' → ' + input.key),
        outputs: (node.outputs || []).map((output) => output.key + ':' + output.kind),
        route: AI_TYPES.has(node.type) ? {
          agentKind: config.agentKind || '企业默认',
          model: config.model || '底座默认',
          fallbackMode: config.fallbackMode || 'best-effort',
          runnerTags: config.runnerTags || [],
        } : null,
      };
    }),
    levels: topology.levels,
  };
}

module.exports = {
  AI_TYPES, AGENT_KINDS, ENTERPRISE_TYPES, NODE_TYPES, OUTPUT_KINDS, validAgentKind,
  hasSecretField, normalize, simulation,
};
