import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/ui/plugin_workflow_contract.dart';

void main() {
  test('移动端关键校验与当前PC实际normalize实现对照', () async {
    final valid = defaultPluginWorkflow('完成报告');
    final fixtures = <Map<String, dynamic>>[
      valid,
      {
        'nodes': [newWorkflowNode('publish', 'finish')],
      },
      {
        'nodes': [newWorkflowNode('agent', 'legacy')],
      },
      {
        'nodes': [
          ...workflowRows(valid['nodes'])..first['dependsOn'] = ['complete'],
        ],
      },
    ];
    final badInput = cloneWorkflow(valid);
    (badInput['nodes'] as List)[1]['inputs'] = [
      {'key': 'missing', 'fromNode': 'understand', 'outputKey': 'not_declared'},
    ];
    fixtures.add(badInput);
    final machine = cloneWorkflow(valid);
    ((machine['nodes'] as List).first['config'] as Map)['execution'] = {
      'runnerId': 'machine',
    };
    fixtures.add(machine);
    final secret = cloneWorkflow(valid);
    ((secret['nodes'] as List).first['config'] as Map)['password'] =
        'not-allowed';
    fixtures.add(secret);
    for (final type in pluginEnterpriseDefaults.keys) {
      final enterprise = cloneWorkflow(valid);
      (enterprise['nodes'] as List).add(newWorkflowNode(type, 'enterprise'));
      fixtures.add(enterprise);
    }
    for (final alias in [
      'Pi',
      'Qwen Code',
      'Google Harness²',
      'local:codex_harness',
    ]) {
      final imported = cloneWorkflow(valid);
      ((imported['nodes'] as List).first['config'] as Map)['agentKind'] = alias;
      fixtures.add(imported);
    }
    final body = {
      'key': 'fixture',
      'template': 'workflow',
      'instructions': '完成报告',
      'skills': [],
      'mcpServers': [],
      'runtime': [],
      'platforms': [],
    };
    final module = File(
      '../client/main/personal-plugin-workflow.js',
    ).absolute.path;
    final script = """
const workflow = require(process.argv[1]);
const payload = JSON.parse(process.argv[2]);
const results = payload.fixtures.map(value => {
  try {
    const graph = workflow.normalize({...payload.body, workflow: value});
    return {ok: true, levels: workflow.simulation(graph).levels};
  } catch (error) { return {ok: false, error: error.message}; }
});
process.stdout.write(JSON.stringify(results));
""";
    final result = await Process.run('node', [
      '-e',
      script,
      module,
      jsonEncode({'body': body, 'fixtures': fixtures}),
    ]);
    expect(result.exitCode, 0, reason: result.stderr.toString());
    final pc = jsonDecode(result.stdout.toString()) as List;
    for (var i = 0; i < fixtures.length; i++) {
      final errors = validatePluginWorkflow(fixtures[i], plugin: body);
      expect(
        errors.isEmpty,
        pc[i]['ok'],
        reason: 'fixture $i: mobile=$errors pc=${pc[i]}',
      );
      if (errors.isEmpty) {
        expect(
          workflowLevels(workflowRows(fixtures[i]['nodes'])),
          pc[i]['levels'],
        );
      }
    }
  });
}
