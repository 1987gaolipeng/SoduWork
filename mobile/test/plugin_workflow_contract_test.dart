import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/ui/plugin_workflow_contract.dart';

Map<String, dynamic> _workflow() => defaultPluginWorkflow('整理资料并提供可验证报告');

void main() {
  test('标准4节点与PC类型、层次和显式交接一致', () {
    final workflow = _workflow();
    final nodes = workflowRows(workflow['nodes']);
    expect(pluginWorkflowTypes.keys, [
      'ai',
      'ai_review',
      'spec',
      'quality',
      'approval',
      'merge',
      'deploy_chain',
      'validate',
      'human_review',
      'publish',
    ]);
    expect(nodes.map((n) => n['key']), [
      'understand',
      'work',
      'accept',
      'complete',
    ]);
    expect(workflowLevels(nodes), [
      ['understand'],
      ['work'],
      ['accept'],
      ['complete'],
    ]);
    expect(validatePluginWorkflow(workflow), isEmpty);
    expect(workflowRows(nodes[1]['inputs']).single['fromNode'], 'understand');
  });

  test('重复、自依赖、缺失节点和环不能预检', () {
    for (final change in <void Function(List<Map<String, dynamic>>)>[
      (n) => n[1]['key'] = n[0]['key'],
      (n) => n[0]['dependsOn'] = ['understand'],
      (n) => n[0]['dependsOn'] = ['missing'],
      (n) => n[0]['dependsOn'] = ['complete'],
    ]) {
      final nodes = workflowRows(_workflow()['nodes']);
      change(nodes);
      expect(validatePluginWorkflow({'nodes': nodes}), isNotEmpty);
    }
  });

  test('必须有AI和办结节点，未知类型不能静默降级', () {
    expect(
      validatePluginWorkflow({
        'nodes': [newWorkflowNode('publish', 'end')],
      }),
      contains('自动化流程至少需要一个 AI 节点'),
    );
    expect(
      validatePluginWorkflow({
        'nodes': [newWorkflowNode('ai', 'work')],
      }),
      contains('自动化流程需要一个办结节点'),
    );
    final nodes = workflowRows(_workflow()['nodes']);
    nodes[0]['type'] = 'future_type';
    expect(
      validatePluginWorkflow({'nodes': nodes}).join(),
      contains('不支持的节点类型'),
    );
  });

  test('输入只能引用直接上游存在的产出，空输入沿用PC自动交接', () {
    final nodes = workflowRows(_workflow()['nodes']);
    nodes[1]['inputs'] = [];
    expect(validatePluginWorkflow({'nodes': nodes}), isEmpty);
    nodes[2]['inputs'] = [
      {'key': 'plan', 'fromNode': 'understand', 'outputKey': 'plan'},
    ];
    expect(validatePluginWorkflow({'nodes': nodes}).join(), contains('直接上游'));
    nodes[2]['inputs'] = [
      {'key': 'result', 'fromNode': 'work', 'outputKey': 'missing'},
    ];
    expect(validatePluginWorkflow({'nodes': nodes}).join(), contains('未声明的产出'));
  });

  test('产出文件与决策拒绝越界路径，AI不能无产出，决策仅一项', () {
    for (final path in [
      '../outside',
      '/absolute',
      'C:/absolute',
      'a//b',
      'a/./b',
      'a/../b',
    ]) {
      final nodes = workflowRows(_workflow()['nodes']);
      nodes[1]['outputs'] = [
        {'key': 'result', 'kind': 'file', 'path': path},
      ];
      expect(validatePluginWorkflow({'nodes': nodes}).join(), contains('相对路径'));
    }
    final nodes = workflowRows(_workflow()['nodes']);
    nodes[1]['outputs'] = [];
    expect(validatePluginWorkflow({'nodes': nodes}).join(), contains('至少声明一项'));
    nodes[1]['outputs'] = [
      {'key': 'result', 'kind': 'decision', 'path': 'result.json'},
      {'key': 'next', 'kind': 'decision', 'path': 'next.json'},
    ];
    expect(validatePluginWorkflow({'nodes': nodes}).join(), contains('只能声明一项'));
  });

  test('路由与能力必须可移植并在插件声明内，拒绝嵌套机器与凭据', () {
    final nodes = workflowRows(_workflow()['nodes']);
    nodes[0]['config'] = {
      'prompt': '工作',
      'timeoutSeconds': 1200,
      'execution': {
        'agentKind': 'local:pi',
        'model': 'model-a',
        'fallbackMode': 'strict',
        'runnerTags': ['windows'],
      },
    };
    nodes[0]['capabilities'] = {
      'skills': ['known'],
      'mcpServers': ['kb'],
      'runtime': ['terminal'],
      'secrets': [],
    };
    const plugin = {
      'skills': ['known'],
      'mcpServers': ['kb'],
      'runtimeCapabilities': ['terminal'],
    };
    expect(validatePluginWorkflow({'nodes': nodes}, plugin: plugin), isEmpty);
    (nodes[0]['config'] as Map)['apiKey'] = 'credential';
    expect(
      validatePluginWorkflow({'nodes': nodes}, plugin: plugin).join(),
      contains('不能保存'),
    );
    (nodes[0]['config'] as Map).remove('apiKey');
    ((nodes[0]['config'] as Map)['execution'] as Map)['runnerId'] = 'machine-a';
    expect(
      validatePluginWorkflow({'nodes': nodes}, plugin: plugin).join(),
      contains('不能绑定具体机器'),
    );
    expect(validatePluginWorkflow({'nodes': nodes}).join(), contains('未声明的能力'));
  });

  test('指令、超时、重试和标签真实校验，不截断或纠正非法值', () {
    final nodes = workflowRows(_workflow()['nodes']);
    nodes[0]['config'] = {
      'prompt': '',
      'timeoutSeconds': 59,
      'agentKind': 'remote:server',
      'fallbackMode': 'anything',
      'runnerTags': ['Upper Case'],
    };
    nodes[0]['retry'] = {'maxAttempts': 6};
    final errors = validatePluginWorkflow({'nodes': nodes}).join();
    for (final phrase in ['工作指令', '超时', '底座类型', '失败策略', '标签', '尝试']) {
      expect(errors, contains(phrase));
    }
  });

  test('企业类型保留真实配置，质量门禁必须非空commands/argv', () {
    final nodes = workflowRows(_workflow()['nodes']);
    for (final type in pluginEnterpriseDefaults.keys) {
      nodes.insert(nodes.length - 1, newWorkflowNode(type, type));
    }
    expect(validatePluginWorkflow({'nodes': nodes}), isEmpty);
    nodes.firstWhere((n) => n['type'] == 'quality')['config'] = {
      'commands': [
        {'argv': []},
      ],
    };
    expect(
      validatePluginWorkflow({'nodes': nodes}).join(),
      contains('commands'),
    );
  });

  test('重命名原子改写节点连接和输入，并保留各层未知字段', () {
    final workflow = _workflow()..['futureGraph'] = {'version': 3};
    final nodes = workflowRows(workflow['nodes']);
    nodes[0]['futureNode'] = {'anything': true};
    (nodes[1]['inputs'] as List).first['futureInput'] = 'keep';
    workflow['nodes'] = nodes;
    final replacement = cloneWorkflow(nodes[0])..['key'] = 'plan_new';
    final updated = replaceWorkflowNode(workflow, 0, replacement);
    final result = workflowRows(updated['nodes']);
    expect(updated['futureGraph'], {'version': 3});
    expect(result[0]['futureNode'], {'anything': true});
    expect(result[1]['dependsOn'], ['plan_new']);
    expect(workflowRows(result[1]['inputs']).single['fromNode'], 'plan_new');
    expect(workflowRows(result[1]['inputs']).single['futureInput'], 'keep');
    expect(nodes[0]['key'], 'understand');
    expect(validatePluginWorkflow(updated), isEmpty);
  });

  test('删除节点只移除对该节点的连接和输入，保留其他数据', () {
    final source = _workflow();
    final removed = removeWorkflowNode(source, 0);
    final nodes = workflowRows(removed['nodes']);
    expect(nodes.first['key'], 'work');
    expect(nodes.first['dependsOn'], isEmpty);
    expect(nodes.first['inputs'], isEmpty);
    expect(workflowRows(source['nodes']).length, 4);
    expect(validatePluginWorkflow(removed), isEmpty);
  });

  test('限制节点、输入和输出数量，不按PC内部slice静默丢数据', () {
    final nodes = workflowRows(_workflow()['nodes']);
    nodes.addAll(
      List.generate(28, (i) => newWorkflowNode('publish', 'extra_$i')),
    );
    expect(validatePluginWorkflow({'nodes': nodes}).join(), contains('最多 30'));
    expect(validatePluginWorkflow({'nodes': 'bad'}), contains('流程节点必须为数组'));
    expect(
      validatePluginWorkflow({
        'nodes': [null],
      }),
      contains('每个流程节点都必须是对象'),
    );
  });
}
