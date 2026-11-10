import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/ui/plugin_workflow_contract.dart';
import 'package:soduwork_mobile/ui/plugin_workflow_ports.dart';

Future<void> _show(
  WidgetTester tester, {
  required bool input,
  required Map<String, dynamic> value,
  required ValueChanged<Map<String, dynamic>?> result,
  double width = 390,
}) async {
  tester.view.physicalSize = Size(width, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final nodes = workflowRows(defaultPluginWorkflow('完成报告')['nodes']);
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            onPressed: () async {
              result(
                await showWorkflowPortEditor(
                  context,
                  value: value,
                  input: input,
                  node: nodes[1],
                  nodes: nodes,
                ),
              );
            },
            child: const Text('打开'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('打开'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('产出路径校验、必需设置与未知字段保留', (tester) async {
    Map<String, dynamic>? result;
    await _show(
      tester,
      input: false,
      value: {
        'key': 'report',
        'kind': 'file',
        'label': '报告',
        'path': 'reports/original.md',
        'required': true,
        'futurePort': {'keep': true},
      },
      result: (v) => result = v,
    );
    await tester.enterText(
      find.byKey(const ValueKey('port-path')),
      '../outside',
    );
    await tester.tap(find.text('确认交接项'));
    await tester.pumpAndSettle();
    expect(find.text('请填写工作目录内的相对文件路径'), findsOneWidget);
    expect(result, isNull);
    await tester.enterText(
      find.byKey(const ValueKey('port-path')),
      'reports/new.md',
    );
    await tester.tap(find.byType(SwitchListTile));
    await tester.pump();
    await tester.tap(find.text('确认交接项'));
    await tester.pumpAndSettle();
    expect(result!['path'], 'reports/new.md');
    expect(result!['required'], false);
    expect(result!['futurePort'], {'keep': true});
  });

  testWidgets('输入引用只能选择直接上游输出，不能拿标签当key', (tester) async {
    Map<String, dynamic>? result;
    await _show(
      tester,
      input: true,
      value: {
        'key': 'plan',
        'label': '规划资料',
        'fromNode': 'understand',
        'outputKey': '显示名称',
        'required': true,
        'futureInput': {'keep': true},
      },
      result: (v) => result = v,
    );
    await tester.tap(find.text('确认交接项'));
    await tester.pumpAndSettle();
    expect(find.text('请选择直接上游已声明的产出'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('port-outputKey-显示名称')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('执行计划').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('确认交接项'));
    await tester.pumpAndSettle();
    expect(result!['outputKey'], 'plan');
    expect(result!['fromNode'], 'understand');
    expect(result!['futureInput'], {'keep': true});
  });

  testWidgets('320宽交接表单与取消不修改原数据', (tester) async {
    final value = <String, dynamic>{
      'key': 'result',
      'kind': 'evidence',
      'label': '完整名称',
      'required': true,
    };
    Map<String, dynamic>? result;
    await _show(
      tester,
      input: false,
      value: value,
      result: (v) => result = v,
      width: 320,
    );
    await tester.enterText(find.byKey(const ValueKey('port-label')), '修改未确认');
    tester.view.viewInsets = const FakeViewPadding(bottom: 260);
    addTearDown(tester.view.resetViewInsets);
    await tester.pumpAndSettle();
    expect(find.text('确认交接项').hitTestable(), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.tap(find.byType(BackButton).last);
    await tester.pumpAndSettle();
    expect(result, isNull);
    expect(value['label'], '完整名称');
  });
}
