import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/ui/plugin_workflow_contract.dart';
import 'package:soduwork_mobile/ui/plugin_workflow_editor.dart';

Future<void> _show(
  WidgetTester tester,
  Map<String, dynamic> value,
  ValueChanged<Map<String, dynamic>> changed, {
  double width = 390,
}) async {
  tester.view.physicalSize = Size(width, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SingleChildScrollView(
          child: PluginWorkflowEditor(
            value: value,
            plugin: const {'instructions': '完成报告'},
            onChanged: changed,
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('编辑流程节点'));
  await tester.pumpAndSettle();
}

Future<void> _tap(WidgetTester tester, Finder finder) async {
  if (finder.hitTestable().evaluate().isEmpty) {
    await tester.scrollUntilVisible(
      finder.hitTestable(),
      250,
      scrollable: find
          .descendant(
            of: find.byType(ListView).last,
            matching: find.byType(Scrollable),
          )
          .first,
    );
  }
  await Scrollable.ensureVisible(tester.element(finder), alignment: 0.5);
  await tester.pumpAndSettle();
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

Future<void> _openNode(WidgetTester tester, String key) =>
    _tap(tester, find.byKey(ValueKey('workflow-node-$key')));
Future<void> _confirm(WidgetTester tester, String text) =>
    _tap(tester, find.widgetWithText(FilledButton, text));

void main() {
  WidgetController.hitTestWarningShouldBeFatal = true;
  testWidgets('节点编辑仅确认流程后回传，取消节点保留原值及未知字段', (tester) async {
    final source = defaultPluginWorkflow('完成报告')
      ..['futureRoot'] = {'mode': 'keep'};
    final nodes = workflowRows(source['nodes']);
    nodes[0]['futureNode'] = {'setting': true};
    workflowMap(nodes[0]['config'])['unused'] = 'x';
    source['nodes'] = nodes;
    Map<String, dynamic>? saved;
    await _show(tester, source, (v) => saved = v);
    await _openNode(tester, 'understand');
    await tester.enterText(find.byKey(const ValueKey('node-name-ai')), '临时修改');
    await tester.tap(find.byType(BackButton).last);
    await tester.pumpAndSettle();
    expect(find.text('临时修改'), findsNothing);
    await _openNode(tester, 'understand');
    await tester.enterText(find.byKey(const ValueKey('node-name-ai')), '新的规划');
    await tester.enterText(
      find.byKey(const ValueKey('node-key-ai')),
      'new_plan',
    );
    await _confirm(tester, '确认节点');
    expect(saved, isNull);
    await _confirm(tester, '确认流程');
    expect(saved!['futureRoot'], {'mode': 'keep'});
    final edited = workflowRows(saved!['nodes']);
    expect(edited[0]['name'], '新的规划');
    expect(edited[0]['futureNode'], {'setting': true});
    expect(edited[1]['dependsOn'], ['new_plan']);
    expect(workflowRows(edited[1]['inputs']).first['fromNode'], 'new_plan');
    expect(nodes[0]['name'], '理解与规划');
  });

  testWidgets('完整流程取消不回传任何节点改动', (tester) async {
    Map<String, dynamic>? saved;
    await _show(tester, {}, (v) => saved = v);
    await _tap(tester, find.text('添加标准流程'));
    expect(
      find.byKey(const ValueKey('workflow-node-understand')),
      findsOneWidget,
    );
    await tester.tap(find.byType(BackButton).last);
    await tester.pumpAndSettle();
    expect(saved, isNull);
    expect(find.text('理解与规划 · AI 执行'), findsNothing);
  });

  testWidgets('连接形成环时拒绝节点确认并保留输入', (tester) async {
    Map<String, dynamic>? saved;
    await _show(tester, defaultPluginWorkflow('完成报告'), (v) => saved = v);
    await _openNode(tester, 'understand');
    await _tap(tester, find.text('上游与连接'));
    await _tap(tester, find.widgetWithText(CheckboxListTile, '办结沉淀'));
    await _confirm(tester, '确认节点');
    expect(find.text('连接会形成循环或引用不存在的节点'), findsOneWidget);
    expect(find.text('编辑流程节点'), findsWidgets);
    expect(saved, isNull);
  });

  testWidgets('所有PC实际类型都可新增并确认，企业配置保持真实结构', (tester) async {
    Map<String, dynamic>? saved;
    await _show(tester, defaultPluginWorkflow('完成报告'), (v) => saved = v);
    for (final entry in pluginWorkflowTypes.entries) {
      await _tap(tester, find.text('添加节点'));
      await _tap(tester, find.widgetWithText(ListTile, entry.value).last);
      await _confirm(tester, '确认节点');
    }
    await _confirm(tester, '确认流程');
    final nodes = workflowRows(saved!['nodes']);
    expect(nodes.length, 14);
    expect(nodes.skip(4).map((n) => n['type']), pluginWorkflowTypes.keys);
    expect(
      workflowMap(
        nodes.firstWhere((n) => n['type'] == 'quality')['config'],
      )['commands'],
      [
        {
          'name': '工程真实自测',
          'argv': ['project:selftest'],
          'timeoutSeconds': 1200,
        },
      ],
    );
  });

  testWidgets('企业配置非法JSON不保存，合法更新保留未知属性并等待流程确认', (tester) async {
    final workflow = defaultPluginWorkflow('完成报告');
    final nodes = workflowRows(workflow['nodes'])
      ..add(newWorkflowNode('quality', 'quality'));
    nodes.last['config'] = {
      ...workflowMap(nodes.last['config']),
      'futureCheck': {'keep': true},
    };
    workflow['nodes'] = nodes;
    Map<String, dynamic>? saved;
    await _show(tester, workflow, (v) => saved = v);
    await _openNode(tester, 'quality');
    await _tap(tester, find.text('编辑检查命令与参数'));
    await tester.enterText(
      find.byKey(const ValueKey('workflow-config-json')),
      '{bad',
    );
    await _confirm(tester, '确认配置');
    expect(find.textContaining('配置必须是合法的 JSON 对象'), findsOneWidget);
    await tester.tap(find.byType(BackButton).last);
    await tester.pumpAndSettle();
    await _tap(tester, find.text('编辑检查命令与参数'));
    await tester.enterText(
      find.byKey(const ValueKey('workflow-config-json')),
      '{"commands":[{"name":"验证","argv":["npm","test"],"timeoutSeconds":300}],"futureCheck":{"keep":true}}',
    );
    await _confirm(tester, '确认配置');
    await _confirm(tester, '确认节点');
    expect(saved, isNull);
    await _confirm(tester, '确认流程');
    final config = workflowMap(workflowRows(saved!['nodes']).last['config']);
    expect(config['futureCheck'], {'keep': true});
    expect((config['commands'] as List).first['argv'], ['npm', 'test']);
  });

  testWidgets('删除节点需确认并清理下游引用，取消删除保持原图', (tester) async {
    Map<String, dynamic>? saved;
    await _show(tester, defaultPluginWorkflow('完成报告'), (v) => saved = v);
    Future<void> menu() async {
      final tile = find.byKey(const ValueKey('workflow-node-understand'));
      await _tap(
        tester,
        find.descendant(
          of: tile,
          matching: find.byType(PopupMenuButton<String>),
        ),
      );
      await _tap(tester, find.text('删除节点'));
    }

    await menu();
    expect(find.textContaining('移除 1 个下游节点'), findsOneWidget);
    await _tap(tester, find.text('取消'));
    expect(
      find.byKey(const ValueKey('workflow-node-understand')),
      findsOneWidget,
    );
    await menu();
    await _tap(tester, find.widgetWithText(FilledButton, '删除节点'));
    await _confirm(tester, '确认流程');
    final nodes = workflowRows(saved!['nodes']);
    expect(nodes.map((n) => n['key']), ['work', 'accept', 'complete']);
    expect(nodes.first['dependsOn'], isEmpty);
    expect(nodes.first['inputs'], isEmpty);
  });

  testWidgets('导入未知类型可查看且确认被明确拒绝，不崩溃或默改', (tester) async {
    final source = defaultPluginWorkflow('完成报告');
    final nodes = workflowRows(source['nodes']);
    nodes.first['type'] = 'future_type';
    source['nodes'] = nodes;
    await _show(tester, source, (_) => fail('不应保存'));
    await _openNode(tester, 'understand');
    expect(tester.takeException(), isNull);
    await _confirm(tester, '确认节点');
    expect(find.textContaining('不支持的节点类型'), findsOneWidget);
  });

  for (final width in [320.0, 390.0]) {
    testWidgets('节点编辑在窄屏与键盘下可确认 $width', (tester) async {
      await _show(tester, defaultPluginWorkflow('完成报告'), (_) {}, width: width);
      await _openNode(tester, 'understand');
      tester.view.viewInsets = const FakeViewPadding(bottom: 260);
      addTearDown(tester.view.resetViewInsets);
      await tester.tap(find.byKey(const ValueKey('node-name-ai')));
      await tester.pumpAndSettle();
      expect(
        find.widgetWithText(FilledButton, '确认节点').hitTestable(),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    });
  }
}
