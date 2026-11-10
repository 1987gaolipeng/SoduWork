import 'dart:convert';

const pluginWorkflowTypes = <String, String>{
  'ai': 'AI 执行',
  'ai_review': 'AI 审查',
  'spec': '需求基线',
  'quality': '质量门禁',
  'approval': '人工审批',
  'merge': '代码合并',
  'deploy_chain': '企业发布链',
  'validate': '上线核对',
  'human_review': '人工验收',
  'publish': '办结沉淀',
};
const pluginWorkflowOutputs = <String, String>{
  'evidence': '证据 / 成果',
  'file': '指定文件',
  'git': '代码提交',
  'url': '可访问地址',
  'decision': '结构化决策',
};
const pluginEnterpriseDefaults = <String, Map<String, dynamic>>{
  'spec': {'summary': '确认需求范围、假设与逐条验收标准'},
  'quality': {
    'commands': [
      {
        'name': '工程真实自测',
        'argv': ['project:selftest'],
        'timeoutSeconds': 1200,
      },
    ],
  },
  'approval': {'action': 'merge'},
  'merge': {'autoSubmit': true},
  'deploy_chain': {},
  'validate': {'deployVerify': true, 'shaCheck': true, 'http': []},
};

Map<String, dynamic> cloneWorkflow(Map<String, dynamic> value) =>
    Map<String, dynamic>.from(jsonDecode(jsonEncode(value)) as Map);
Map<String, dynamic> workflowMap(dynamic value) =>
    value is Map ? Map<String, dynamic>.from(value) : {};
List<Map<String, dynamic>> workflowRows(dynamic value) => value is List
    ? value
          .whereType<Map>()
          .map((row) => Map<String, dynamic>.from(row))
          .toList()
    : [];
List<String> workflowNames(dynamic value) =>
    (value is List
            ? value
            : (value is String ? value.split(RegExp(r'[,，\n]')) : []))
        .map((v) => v.toString().trim())
        .where((v) => v.isNotEmpty)
        .toSet()
        .toList();
bool workflowIsAi(dynamic type) => type == 'ai' || type == 'ai_review';

/// Compatibility spellings in the reviewed PC runtime catalog. Validation only:
/// imported values are not rewritten; Hub preflight resolves current runtimes.
String workflowAgentKind(String value) {
  final raw = value.trim().toLowerCase();
  if (raw.isEmpty || raw == 'hosted') return raw;
  final name = raw.startsWith('local:') ? raw.substring(6) : raw;
  final spelling = name.replaceAll('²', '2').replaceAll(RegExp(r'[\s_-]+'), '');
  const aliases = {
    'pi': 'pi',
    'codexharness': 'codex-harness',
    'opencode': 'opencode',
    'codex': 'codex',
    'qwen': 'qwen',
    'qwencode': 'qwen',
    'dsh': 'dsh',
    'deepseekharness': 'dsh',
    'harness2': 'harness2',
    'googleharness2': 'harness2',
  };
  final known = aliases[spelling];
  return known == null ? raw : 'local:$known';
}

final _key = RegExp(r'^[A-Za-z][A-Za-z0-9_-]{0,63}$');
final _secret = RegExp(
  r'password|passwd|token|secret|private.?key|api.?key',
  caseSensitive: false,
);

bool _hasSecret(dynamic value) {
  if (value is List) return value.any(_hasSecret);
  if (value is! Map) return false;
  return value.entries.any((entry) {
    final child = entry.value;
    final present = child is List || child is Map
        ? child.isNotEmpty
        : child != null && child.toString().trim().isNotEmpty;
    return (_secret.hasMatch(entry.key.toString()) && present) ||
        _hasSecret(child);
  });
}

Map<String, dynamic> newWorkflowNode(String type, String key) => {
  'key': key,
  'name': pluginWorkflowTypes[type] ?? type,
  'type': type,
  'dependsOn': <String>[],
  'inputs': <Map<String, dynamic>>[],
  'outputs': workflowIsAi(type)
      ? [
          {
            'key': type == 'ai_review' ? 'review' : 'result',
            'kind': 'evidence',
            'label': type == 'ai_review' ? '审查结论' : '交付成果',
            'required': true,
          },
        ]
      : <Map<String, dynamic>>[],
  'config': workflowIsAi(type)
      ? {
          'prompt': type == 'ai_review'
              ? '独立审查上游结果并给出明确结论。'
              : '完成本节点工作并交付可验证结果。',
          'timeoutSeconds': 3600,
        }
      : type == 'human_review'
      ? {'action': 'uat', 'summary': '按任务完成标准验收本次交付'}
      : type == 'publish'
      ? {'message': '成果已验收，任务完成并保留全过程证据'}
      : cloneWorkflow(pluginEnterpriseDefaults[type] ?? {}),
  'retry': {'maxAttempts': workflowIsAi(type) ? 2 : 1},
};

List<Map<String, dynamic>> workflowAutomaticInputs(
  Map<String, dynamic> node,
  List<Map<String, dynamic>> nodes,
) => [
  for (final dependency in workflowNames(node['dependsOn']))
    for (final parent in nodes.where((n) => n['key'] == dependency))
      for (final output in workflowRows(parent['outputs']))
        {
          'key': '${dependency}_${output['key']}',
          'fromNode': dependency,
          'outputKey': output['key'],
          'label': output['label'] ?? output['key'],
          'required': output['required'] != false,
        },
];

Map<String, dynamic> defaultPluginWorkflow(String instructions) {
  final understand = newWorkflowNode('ai', 'understand');
  understand['name'] = '理解与规划';
  understand['config'] = {
    'prompt': '理解目标、输入、限制和完成标准，形成可执行计划后继续推进。\n\n$instructions',
    'timeoutSeconds': 3600,
  };
  understand['outputs'] = [
    {'key': 'plan', 'kind': 'evidence', 'label': '执行计划', 'required': true},
  ];
  final work = newWorkflowNode('ai', 'work')..['name'] = '完成工作';
  work['dependsOn'] = ['understand'];
  work['config'] = {
    'prompt': instructions.trim().isEmpty ? '完成本节点工作并交付可验证结果。' : instructions,
    'timeoutSeconds': 3600,
  };
  final accept = newWorkflowNode('human_review', 'accept')..['name'] = '人工验收';
  accept['dependsOn'] = ['work'];
  final complete = newWorkflowNode('publish', 'complete');
  complete['dependsOn'] = ['accept'];
  final nodes = [understand, work, accept, complete];
  for (final node in nodes) {
    node['inputs'] = workflowAutomaticInputs(node, nodes);
  }
  return {'nodes': nodes};
}

/// Validation mirrors personal-plugin-workflow.js. Never silently truncate or
/// coerce imported data; the server remains the authority for package preflight.
List<String> validatePluginWorkflowNode(
  Map<String, dynamic> node,
  List<Map<String, dynamic>> nodes,
  Map<String, dynamic> plugin,
) {
  final errors = <String>[];
  final key = node['key']?.toString() ?? '';
  final name = (node['name'] ?? key).toString();
  void error(String message) => errors.add('「$name」$message');
  if (!_key.hasMatch(key)) error('节点标识需以字母开头，最多 64 位字母、数字、下划线或短横线');
  if (name.trim().isEmpty || name.length > 100) error('节点名称需为 1 至 100 字');
  final type = node['type']?.toString() ?? 'ai';
  if (!pluginWorkflowTypes.containsKey(type)) error('不支持的节点类型：$type');
  final deps = workflowNames(node['dependsOn']);
  if (node['dependsOn'] != null &&
      node['dependsOn'] is! List &&
      node['dependsOn'] is! String) {
    error('上游依赖格式不正确');
  }
  if (deps.length > 20) error('直接上游不能超过 20 个');
  for (final dep in deps) {
    if (dep == key) error('不能依赖自己');
    if (!nodes.any((n) => n['key'] == dep)) error('上游不存在：$dep');
  }
  final outputs = workflowRows(node['outputs']);
  if (node['outputs'] != null &&
      (node['outputs'] is! List ||
          outputs.length != (node['outputs'] as List).length)) {
    error('输出定义必须是对象数组');
  }
  if (outputs.length > 20) error('产出最多 20 项');
  if (workflowIsAi(type) && outputs.isEmpty) error('AI 节点至少声明一项可交接产出');
  final outputKeys = <String>{};
  var decisions = 0;
  for (final output in outputs) {
    final outputKey = output['key']?.toString() ?? '';
    if (!_key.hasMatch(outputKey) || !outputKeys.add(outputKey)) {
      error('产出标识无效或重复：$outputKey');
    }
    final kind = output['kind'] ?? 'evidence';
    if (!pluginWorkflowOutputs.containsKey(kind)) {
      error('产出类型不支持：$kind');
    }
    if ((output['label']?.toString() ?? '').length > 100) {
      error('产出名称不能超过 100 字');
    }
    if (kind == 'decision' && ++decisions > 1) error('只能声明一项结构化决策');
    if (kind == 'file' || kind == 'decision') {
      final path = (output['path'] ?? '').toString().replaceAll('\\', '/');
      if (path.isEmpty ||
          path.length > 300 ||
          path.startsWith('/') ||
          path.contains(RegExp(r'[:\x00]')) ||
          path.split('/').any((s) => s.isEmpty || s == '.' || s == '..')) {
        error('文件或决策产出必须使用工作目录内的相对路径');
      }
    }
  }
  final rawInputs = node['inputs'];
  final inputs = workflowRows(rawInputs);
  if (rawInputs != null &&
      (rawInputs is! List || inputs.length != rawInputs.length)) {
    error('输入定义必须是对象数组');
  }
  // Empty inputs follow the PC contract: receive every direct upstream output.
  final effective = inputs.isEmpty
      ? workflowAutomaticInputs(node, nodes)
      : inputs;
  if (effective.length > 40) error('接收的输入不能超过 40 项');
  final inputKeys = <String>{};
  for (final input in effective) {
    final inputKey = (input['key'] ?? input['outputKey'] ?? '').toString();
    if (!_key.hasMatch(inputKey) || !inputKeys.add(inputKey)) {
      error('输入标识无效或重复：$inputKey');
    }
    final source = input['fromNode'];
    if (!deps.contains(source)) error('输入只能引用直接上游，请先连接：$source');
    final matching = nodes.where((n) => n['key'] == source);
    if (matching.isEmpty ||
        !workflowRows(
          matching.first['outputs'],
        ).any((o) => o['key'] == input['outputKey'])) {
      error('引用了未声明的产出：$source.${input['outputKey']}');
    }
    if ((input['label']?.toString() ?? '').length > 100) {
      error('输入名称不能超过 100 字');
    }
  }
  if (node['config'] != null && node['config'] is! Map) error('执行配置必须是对象');
  final config = workflowMap(node['config']);
  final nested = workflowMap(config['execution']);
  for (final field in [
    'runnerId',
    'hostId',
    'clientId',
    'machineId',
    'endpoint',
  ]) {
    if (config.containsKey(field) || nested.containsKey(field)) {
      error('不能绑定具体机器：$field');
    }
  }
  for (final field in ['agent', 'agentId', 'adapterId', 'runtime']) {
    if (config.containsKey(field) || nested.containsKey(field)) {
      error('请使用 agentKind 指定底座，不支持：$field');
    }
  }
  if (_hasSecret(node)) error('节点不能保存密码、密钥或令牌');
  final retry = workflowMap(node['retry']);
  final attempts = retry['maxAttempts'];
  if (attempts != null && (attempts is! int || attempts < 1 || attempts > 5)) {
    error('最多尝试次数需为 1 至 5 的整数');
  }
  if (workflowIsAi(type)) {
    final prompt = config['prompt'];
    if (prompt is! String || prompt.trim().isEmpty || prompt.length > 12000) {
      error('工作指令需为 1 至 12000 字');
    }
    final timeout = config['timeoutSeconds'] ?? 3600;
    if (timeout is! int || timeout < 60 || timeout > 86400) {
      error('超时需为 60 至 86400 秒的整数');
    }
    dynamic route(String field) => nested[field] ?? config[field];
    final agent = workflowAgentKind((route('agentKind') ?? '').toString());
    if (agent != '' &&
        agent != 'hosted' &&
        !RegExp(r'^local:[a-z0-9][a-z0-9-]{0,31}$').hasMatch(agent)) {
      error('底座类型须为 hosted 或 local:底座标识');
    }
    final fallback = route('fallbackMode') ?? '';
    if (!['', 'strict', 'best-effort'].contains(fallback)) {
      error('失败策略必须为 strict 或 best-effort');
    }
    if ((route('model')?.toString() ?? '').length > 160) {
      error('模型名称不能超过 160 字');
    }
    final tags = workflowNames(route('runnerTags'));
    if (tags.length > 12 ||
        tags.any((t) => !RegExp(r'^[a-z0-9][a-z0-9._-]{0,39}$').hasMatch(t))) {
      error('执行机标签最多 12 项，使用小写字母、数字、点、短横线或下划线');
    }
    if (node['capabilities'] != null && node['capabilities'] is! Map) {
      error('节点能力必须是对象');
    }
    final caps = workflowMap(node['capabilities']);
    final allowed = {
      'skills': [
        ...workflowNames(plugin['skills']),
        if (plugin['key'] is String) plugin['key'],
      ],
      'mcpServers': workflowNames(plugin['mcpServers']),
      'runtime': workflowNames(
        plugin['runtimeCapabilities'] ?? plugin['runtime'],
      ),
    };
    for (final entry in allowed.entries) {
      for (final value in workflowNames(caps[entry.key])) {
        if (!entry.value.contains(value)) error('使用了插件未声明的能力：$value');
      }
    }
  }
  if (type == 'quality') {
    final commands = config['commands'];
    if (commands is! List ||
        commands.isEmpty ||
        commands.any(
          (c) => c is! Map || c['argv'] is! List || (c['argv'] as List).isEmpty,
        )) {
      error('质量门禁需配置 commands，每条命令使用非空 argv 数组');
    }
  }
  return errors;
}

List<String> validatePluginWorkflow(
  Map<String, dynamic> workflow, {
  Map<String, dynamic> plugin = const {},
  bool requireComplete = true,
}) {
  final raw = workflow['nodes'];
  if (raw != null && raw is! List) return ['流程节点必须为数组'];
  final nodes = workflowRows(raw);
  if (raw is List && nodes.length != raw.length) return ['每个流程节点都必须是对象'];
  if (nodes.isEmpty) return []; // PC generates its standard workflow.
  final errors = <String>[];
  if (nodes.length > 30) errors.add('流程最多 30 个节点');
  final keys = <String>{};
  for (final node in nodes) {
    if (!keys.add(node['key']?.toString() ?? '')) {
      errors.add('节点标识重复：${node['key']}');
    }
    errors.addAll(validatePluginWorkflowNode(node, nodes, plugin));
  }
  if (workflowLevels(nodes) == null) errors.add('流程存在循环或无效上游连接，请调整依赖');
  if (requireComplete) {
    if (!nodes.any((n) => workflowIsAi(n['type']))) {
      errors.add('自动化流程至少需要一个 AI 节点');
    }
    if (!nodes.any((n) => n['type'] == 'publish')) errors.add('自动化流程需要一个办结节点');
  }
  return errors.toSet().toList();
}

List<List<String>>? workflowLevels(List<Map<String, dynamic>> nodes) {
  final pending = <String, Set<String>>{};
  for (final node in nodes) {
    final key = node['key']?.toString() ?? '';
    if (pending.containsKey(key)) return null;
    pending[key] = workflowNames(node['dependsOn']).toSet();
  }
  final levels = <List<String>>[];
  while (pending.isNotEmpty) {
    final ready = pending.entries
        .where((e) => e.value.isEmpty)
        .map((e) => e.key)
        .toList();
    if (ready.isEmpty) return null;
    levels.add(ready);
    for (final key in ready) {
      pending.remove(key);
    }
    for (final deps in pending.values) {
      deps.removeAll(ready);
    }
  }
  return levels;
}

/// Rename updates explicit links without modifying any extension properties.
Map<String, dynamic> replaceWorkflowNode(
  Map<String, dynamic> workflow,
  int index,
  Map<String, dynamic> replacement,
) {
  final result = cloneWorkflow(workflow);
  final nodes = workflowRows(result['nodes']);
  final previous = nodes[index]['key'];
  nodes[index] = cloneWorkflow(replacement);
  if (previous != replacement['key']) {
    for (final node in nodes) {
      if (node['dependsOn'] != null) {
        node['dependsOn'] = workflowNames(
          node['dependsOn'],
        ).map((k) => k == previous ? replacement['key'] : k).toList();
      }
      for (final input in workflowRows(node['inputs'])) {
        if (input['fromNode'] == previous) {
          input['fromNode'] = replacement['key'];
        }
      }
      if (node['inputs'] is List) {
        node['inputs'] = (node['inputs'] as List).map((raw) {
          if (raw is! Map || raw['fromNode'] != previous) return raw;
          return {...raw, 'fromNode': replacement['key']};
        }).toList();
      }
    }
  }
  result['nodes'] = nodes;
  return result;
}

Map<String, dynamic> removeWorkflowNode(
  Map<String, dynamic> workflow,
  int index,
) {
  final result = cloneWorkflow(workflow);
  final nodes = workflowRows(result['nodes']);
  final removed = nodes.removeAt(index)['key'];
  for (final node in nodes) {
    if (node['dependsOn'] != null) {
      node['dependsOn'] = workflowNames(
        node['dependsOn'],
      ).where((k) => k != removed).toList();
    }
    if (node['inputs'] is List) {
      node['inputs'] = (node['inputs'] as List)
          .where((i) => i is! Map || i['fromNode'] != removed)
          .toList();
    }
  }
  result['nodes'] = nodes;
  return result;
}
