import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/screens/plugin_builder_screen.dart';
import 'package:soduwork_mobile/ui/plugin_workflow_contract.dart';

void main() {
  testWidgets(
    'conversation draft preserves advanced configuration and requires preview before save',
    (tester) async {
      final state = MobileState();
      final api = _Api();
      state.api = api;
      state.phase = MobilePhase.ready;
      addTearDown(state.dispose);
      final draft = <String, dynamic>{
        'template': 'workflow',
        'name': '报告',
        'version': '1.2.3',
        'description': '生成报告',
        'instructions': '整理数据并验证结果',
        'inputs': [
          {'key': 'topic', 'type': 'text', 'label': '主题'},
        ],
        'setup': {
          'preferences': [
            {'key': 'language', 'type': 'text'},
          ],
        },
        'workflow': {
          ...defaultPluginWorkflow('整理数据并验证结果'),
          'futureGraph': {'keep': true},
        },
        'resources': [
          {'path': 'examples/a.txt', 'content': 'example'},
        ],
        'runtimeCapabilities': ['terminal'],
        'platforms': ['feishu'],
        'entrypoints': {
          'conversation': false,
          'task': true,
          'automation': true,
        },
      };
      await tester.pumpWidget(
        MobileScope(
          state: state,
          child: MaterialApp(home: PluginBuilderScreen(initialValues: draft)),
        ),
      );
      await tester.scrollUntilVisible(
        find.text('检查并继续'),
        500,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.text('检查并继续'));
      await tester.pumpAndSettle();
      expect(api.saved, isNull);
      expect(api.preview!['name'], '报告');
      expect(api.preview!['distribution'], '');
      for (final key in [
        'inputs',
        'setup',
        'workflow',
        'resources',
        'runtimeCapabilities',
        'platforms',
        'entrypoints',
      ]) {
        expect(api.preview![key], draft[key], reason: key);
      }
      await tester.ensureVisible(find.text('提交审核'));
      await tester.tap(find.text('提交审核'));
      await tester.pumpAndSettle();
      expect(api.saved, api.preview);
    },
  );
}

class _Api extends SoduWorkApi {
  Map<String, dynamic>? preview, saved;
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
    preview = draft;
    return {'name': draft['name']};
  }

  @override
  Future<Map<String, dynamic>> createPluginDraft(
    Map<String, dynamic> draft,
  ) async {
    saved = draft;
    return {
      'ok': true,
      'plugin': {'id': 'fixture-plugin'},
      'message': '已保存',
    };
  }
}
