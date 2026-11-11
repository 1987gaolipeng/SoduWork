import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker/image_picker.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/screens/plugin_package_screen.dart';
import 'package:soduwork_mobile/screens/plugin_builder_screen.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/plugin_workflow_contract.dart';

class _Api extends SoduWorkApi {
  final checks = <Map<String, dynamic>>[];
  Map<String, dynamic>? saved;
  bool rejected = false;
  _Api()
    : super(
        store: DeviceStore(),
        endpoint: const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'http://fixture.test',
        ),
      );
  @override
  Future<Map<String, dynamic>> preflightPluginDraft(
    Map<String, dynamic> draft,
  ) async {
    checks.add(cloneWorkflow(draft));
    return rejected
        ? {'ok': false, 'message': '节点预检被拒绝'}
        : {
            'manifest': {'name': draft['name']},
            'simulation': {
              'sideEffectFree': true,
              'order': [
                {
                  'index': 1,
                  'key': 'understand',
                  'name': '服务端确认的规划',
                  'type': 'ai',
                  'handoffs': ['来源 result → plan'],
                  'route': {'agentKind': 'local:pi'},
                },
              ],
            },
            'checks': [
              {'ok': false, 'label': '企业节点需审核绑定后执行'},
            ],
          };
  }

  @override
  Future<Map<String, dynamic>> createPluginDraft(
    Map<String, dynamic> draft,
  ) async {
    saved = cloneWorkflow(draft);
    return {
      'ok': true,
      'plugin': {'id': 'created-plugin'},
      'message': '已提交审核',
    };
  }
}

Map<String, dynamic> _draft() {
  final workflow = defaultPluginWorkflow('完成报告')
    ..['futureGraph'] = {'mode': 'keep'};
  final nodes = workflowRows(workflow['nodes']);
  nodes.first['futureNode'] = {'flag': true};
  (nodes.first['config'] as Map)['futureConfig'] = {
    'keep': [1, 2],
  };
  (nodes.first['outputs'] as List).first['futureOutput'] = 'keep';
  workflow['nodes'] = nodes;
  return {
    'template': 'workflow',
    'name': '导入流程插件',
    'description': '整理报告',
    'instructions': '完成报告',
    'version': '1.2.3',
    'workflow': workflow,
    'resources': [
      {'path': 'reference.txt', 'content': '原始资源'},
    ],
    'futurePlugin': {'preserve': true},
  };
}

Future<void> _tap(WidgetTester tester, Finder target) async {
  final scope = find.byType(Scaffold).last;
  final scrollable = find
      .descendant(of: scope, matching: find.byType(Scrollable))
      .first;
  if (target.hitTestable().evaluate().isEmpty) {
    await tester.scrollUntilVisible(
      target.hitTestable(),
      300,
      scrollable: scrollable,
    );
  }
  await tester.tap(target);
  await tester.pumpAndSettle();
}

Future<void> _app(WidgetTester tester, _Api api, Widget screen) async {
  final state = MobileState()..api = api;
  addTearDown(state.dispose);
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MobileScope(
      state: state,
      child: MaterialApp(home: screen),
    ),
  );
}

void main() {
  testWidgets('真实JSON导入→编辑节点→预检→再次修改失效→重新预检→保存保留所有扩展字段', (tester) async {
    final api = _Api(), original = _draft();
    final file = XFile.fromData(
      Uint8List.fromList(utf8.encode(jsonEncode(original))),
      path: 'workflow.json',
      name: 'workflow.json',
    );
    await _app(
      tester,
      api,
      PluginPackageScreen(chooseFiles: () async => [file]),
    );
    await _tap(tester, find.text('选择插件文件'));
    await _tap(tester, find.text('编辑并确认草稿'));
    await _tap(tester, find.text('编辑流程节点'));
    await _tap(tester, find.byKey(const ValueKey('workflow-node-understand')));
    await tester.enterText(find.byKey(const ValueKey('node-name-ai')), '手机规划');
    await _tap(tester, find.widgetWithText(FilledButton, '确认节点'));
    await _tap(tester, find.widgetWithText(FilledButton, '确认流程'));
    await _tap(tester, find.text('检查并继续'));
    expect(api.checks.length, 1);
    expect(api.saved, isNull);
    expect(find.text('服务端确认的规划'), findsOneWidget);
    expect(find.text('企业节点需审核绑定后执行'), findsOneWidget);

    await _tap(tester, find.text('编辑流程节点'));
    await _tap(tester, find.byKey(const ValueKey('workflow-node-understand')));
    await tester.enterText(
      find.byKey(const ValueKey('node-name-ai')),
      '再次修订规划',
    );
    await _tap(tester, find.widgetWithText(FilledButton, '确认节点'));
    await _tap(tester, find.widgetWithText(FilledButton, '确认流程'));
    expect(find.text('提交审核'), findsNothing);
    await _tap(tester, find.text('检查并继续'));
    expect(api.checks.length, 2);
    await _tap(tester, find.text('提交审核'));
    expect(api.saved, api.checks.last);
    expect(api.saved!['futurePlugin'], original['futurePlugin']);
    expect(api.saved!['resources'], original['resources']);
    final workflow = workflowMap(api.saved!['workflow']);
    expect(workflow['futureGraph'], {'mode': 'keep'});
    final node = workflowRows(workflow['nodes']).first;
    expect(node['name'], '再次修订规划');
    expect(node['futureNode'], {'flag': true});
    expect(workflowMap(node['config'])['futureConfig'], {
      'keep': [1, 2],
    });
    expect(workflowRows(node['outputs']).first['futureOutput'], 'keep');
    expect(
      workflowRows(workflowMap(original['workflow'])['nodes']).first['name'],
      '理解与规划',
    );
  });

  testWidgets('保留旧agent负向fixture：PC不支持的节点被阻止且原始字段不丢', (tester) async {
    final api = _Api(), original = _draft();
    original['workflow'] = {
      'futureGraph': {'keep': true},
      'nodes': [
        {
          'key': 'prepare',
          'name': '准备材料',
          'type': 'agent',
          'futureNode': {'keep': true},
        },
      ],
    };
    final snapshot = cloneWorkflow(original);
    await _app(tester, api, PluginBuilderScreen(initialValues: original));
    await _tap(tester, find.text('检查并继续'));
    expect(api.checks, isEmpty);
    expect(api.saved, isNull);
    expect(find.textContaining('不支持的节点类型：agent'), findsOneWidget);
    expect(original, snapshot);
    await _tap(tester, find.text('编辑流程节点'));
    await _tap(tester, find.byKey(const ValueKey('workflow-node-prepare')));
    expect(find.text('agent（导入值）'), findsWidgets);
    await tester.tap(find.byType(BackButton).last);
    await tester.pumpAndSettle();
    await tester.tap(find.byType(BackButton).last);
    await tester.pumpAndSettle();
    expect(original, snapshot);
  });

  testWidgets('服务端返回失败不能显示预检通过或开放保存', (tester) async {
    final api = _Api()..rejected = true;
    await _app(tester, api, PluginBuilderScreen(initialValues: _draft()));
    await _tap(tester, find.text('检查并继续'));
    expect(find.text('节点预检被拒绝'), findsOneWidget);
    expect(find.text('提交审核'), findsNothing);
    expect(api.saved, isNull);
  });
}
