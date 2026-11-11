import 'package:soduwork_mobile/ui/mobile_select_field.dart';
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/screens/plugin_installation_screen.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';

Map<String, dynamic> item({
  bool installed = false,
  List<Map<String, dynamic>>? fields,
}) => {
  'pluginId': 'report',
  'versionId': 'immutable-2',
  'version': '2.0.0',
  'name': '报告助手',
  'installed': installed,
  'setup': {
    'preferences':
        fields ??
        [
          {
            'key': 'subject',
            'label': '主题',
            'type': 'text',
            'required': true,
            'default': '默认主题',
          },
          {
            'key': 'count',
            'label': '数量',
            'type': 'number',
            'default': 2,
            'minimum': 0,
            'maximum': 5,
          },
          {'key': 'notify', 'label': '通知', 'type': 'boolean', 'default': true},
          {
            'key': 'format',
            'label': '格式',
            'type': 'select',
            'default': 2,
            'options': [
              {'value': 1, 'label': '简报'},
              {'value': 2, 'label': '详报'},
            ],
          },
          {
            'key': 'channels',
            'label': '渠道',
            'type': 'multiselect',
            'default': [false],
            'options': [
              {'value': true, 'label': '团队'},
              {'value': false, 'label': '个人'},
            ],
          },
        ],
  },
  'setupConfig': {'count': 0, 'notify': false},
};

class _Api extends SoduWorkApi {
  final calls = <Map<String, dynamic>>[];
  final probes = <Map<String, dynamic>>[];
  Object? failure;
  Completer<Map<String, dynamic>>? pending;
  _Api()
    : super(
        store: DeviceStore(),
        endpoint: const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'http://fixture.test',
        ),
      );
  @override
  Future<Map<String, dynamic>> setPluginInstallation(
    String id, {
    required bool enabled,
    String? expectedVersionId,
    Map<String, dynamic>? config,
  }) async {
    calls.add({
      'id': id,
      'enabled': enabled,
      'version': expectedVersionId,
      'config': config,
    });
    if (failure != null) {
      throw failure!;
    }
    return pending?.future ??
        {
          'ok': true,
          'pluginId': id,
          'installation': {'installed': enabled},
        };
  }

  @override
  Future<Map<String, dynamic>> probePluginInstallation(
    String id, {
    required String expectedVersionId,
    required Map<String, dynamic> config,
  }) async {
    probes.add({'id': id, 'version': expectedVersionId, 'config': config});
    if (failure != null) {
      throw failure!;
    }
    return {
      'ok': true,
      'message': '所有连接检查通过',
      'connections': [
        {'name': '资料库', 'ok': true, 'toolCount': 3},
      ],
    };
  }
}

class _State extends MobileState {
  int revision = 0;
  @override
  int get identityRevision => revision;
  void switchAccount() {
    revision++;
    notifyListeners();
  }
}

Future<void> _show(
  WidgetTester tester,
  _State state,
  Map<String, dynamic> value, {
  double width = 390,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, 844);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(state.dispose);
  await tester.pumpWidget(
    MobileScope(
      state: state,
      child: MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () async {
                final result = await Navigator.push<bool>(
                  context,
                  MaterialPageRoute(
                    builder: (_) => PluginInstallationScreen(item: value),
                  ),
                );
                if (context.mounted && result == true) {
                  ScaffoldMessenger.of(
                    context,
                  ).showSnackBar(const SnackBar(content: Text('已返回成功')));
                }
              },
              child: const Text('打开'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('打开'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('未知类型和错误选项结构显示校验错误而不崩溃', (tester) async {
    final api = _Api(), state = _State();
    state.api = api;
    await _show(
      tester,
      state,
      item(
        fields: [
          {
            'key': 'custom',
            'label': '扩展字段',
            'type': 'future',
            'default': {'a': 1},
          },
          {
            'key': 'choice',
            'label': '错误选项',
            'type': 'select',
            'options': {'a': 1},
          },
        ],
      ),
    );
    expect(tester.takeException(), isNull);
    await tester.tap(find.widgetWithText(FilledButton, '安装插件'));
    await tester.pumpAndSettle();
    expect(find.textContaining('插件设置定义需要修正'), findsOneWidget);
    expect(api.calls, isEmpty);
  });

  testWidgets('失效多选值可明确移除后保存', (tester) async {
    final api = _Api(), state = _State();
    state.api = api;
    final data = item(
      fields: [
        {
          'key': 'channels',
          'label': '渠道',
          'type': 'multiselect',
          'options': [
            {'value': 'team', 'label': '团队'},
          ],
        },
      ],
    );
    data['setupConfig'] = {
      'channels': ['old', 'team'],
    };
    await _show(tester, state, data);
    await tester.tap(find.byTooltip('移除失效选项'));
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, '安装插件'));
    await tester.pumpAndSettle();
    expect((api.calls.single['config'] as Map)['channels'], ['team']);
  });

  testWidgets('安装提交原始选项类型和存储的 false/0，不覆盖默认值', (tester) async {
    final api = _Api(), state = _State();
    state.api = api;
    final data = item();
    await _show(tester, state, data);
    data['versionId'] = 'mutated-after-opening';
    await tester.tap(find.widgetWithText(FilledButton, '安装插件'));
    await tester.pumpAndSettle();
    expect(api.calls.single, {
      'id': 'report',
      'enabled': true,
      'version': 'immutable-2',
      'config': {
        'subject': '默认主题',
        'count': 0,
        'notify': false,
        'format': 2,
        'channels': [false],
      },
    });
    expect(find.text('已返回成功'), findsOneWidget);
  });

  testWidgets('错误保留输入，重试保存设置成功', (tester) async {
    final api = _Api()..failure = const ApiFailure('连接暂不可用');
    final state = _State()..api = api;
    await _show(tester, state, item(installed: true));
    await tester.enterText(
      find.byKey(const ValueKey('preference-subject')),
      '新的报告主题',
    );
    await tester.tap(find.widgetWithText(FilledButton, '保存设置'));
    await tester.pumpAndSettle();
    expect(find.textContaining('连接暂不可用'), findsOneWidget);
    expect(find.text('新的报告主题'), findsOneWidget);
    api.failure = null;
    await tester.tap(find.widgetWithText(FilledButton, '保存设置'));
    await tester.pumpAndSettle();
    expect(api.calls.length, 2);
    expect((api.calls.last['config'] as Map)['subject'], '新的报告主题');
    expect(find.text('已返回成功'), findsOneWidget);
  });

  testWidgets('必填、数字范围、网址和凭据校验在提交前执行', (tester) async {
    final api = _Api(), state = _State();
    state.api = api;
    await _show(
      tester,
      state,
      item(
        fields: [
          {'key': 'subject', 'label': '主题', 'type': 'text', 'required': true},
          {
            'key': 'count',
            'label': '数量',
            'type': 'number',
            'minimum': 1,
            'maximum': 3,
          },
          {'key': 'url', 'label': '网址', 'type': 'url'},
        ],
      ),
    );
    await tester.enterText(find.byKey(const ValueKey('preference-count')), '8');
    await tester.enterText(
      find.byKey(const ValueKey('preference-url')),
      'https://user:pass@example.com',
    );
    await tester.tap(find.widgetWithText(FilledButton, '安装插件'));
    await tester.pumpAndSettle();
    expect(find.text('请填写此项'), findsOneWidget);
    expect(find.text('不能大于 3'), findsOneWidget);
    expect(find.text('请输入不含账号密码的完整 http/https 地址'), findsOneWidget);
    expect(api.calls, isEmpty);
    await tester.enterText(
      find.byKey(const ValueKey('preference-subject')),
      'token=abcdefghijklmno',
    );
    await tester.enterText(find.byKey(const ValueKey('preference-count')), '2');
    await tester.enterText(
      find.byKey(const ValueKey('preference-url')),
      'https://example.com',
    );
    await tester.tap(find.widgetWithText(FilledButton, '安装插件'));
    await tester.pumpAndSettle();
    expect(find.text('请通过企业连接配置凭据，不要填写在使用偏好中'), findsOneWidget);
    expect(api.calls, isEmpty);
  });

  testWidgets('测试连接只探测，展示服务端回执，修改配置清除旧回执', (tester) async {
    final api = _Api(), state = _State();
    state.api = api;
    await _show(
      tester,
      state,
      item(
        fields: [
          {
            'key': 'subject',
            'label': '主题',
            'type': 'textarea',
            'default': '报告',
          },
        ],
      ),
    );
    await tester.tap(find.text('测试连接'));
    await tester.pumpAndSettle();
    expect(api.calls, isEmpty);
    expect(api.probes.single['version'], 'immutable-2');
    await tester.scrollUntilVisible(
      find.text('所有连接检查通过'),
      200,
      scrollable: find
          .descendant(
            of: find.byType(ListView),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    expect(find.text('连接正常 · 3 个工具'), findsOneWidget);
    await tester.scrollUntilVisible(
      find.byKey(const ValueKey('preference-subject')),
      -200,
      scrollable: find
          .descendant(
            of: find.byType(ListView),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    await tester.enterText(
      find.byKey(const ValueKey('preference-subject')),
      '新的报告',
    );
    await tester.pump();
    expect(find.text('所有连接检查通过'), findsNothing);
  });

  testWidgets('卸载确认可取消，确认携带当前版本且不要求重填必填项', (tester) async {
    final api = _Api(), state = _State();
    state.api = api;
    await _show(
      tester,
      state,
      item(
        installed: true,
        fields: [
          {'key': 'subject', 'type': 'text', 'required': true},
        ],
      ),
    );
    await tester.tap(find.byTooltip('卸载插件'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(api.calls, isEmpty);
    await tester.tap(find.byTooltip('卸载插件'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('确认卸载'));
    await tester.pumpAndSettle();
    expect(api.calls.single, {
      'id': 'report',
      'enabled': false,
      'version': 'immutable-2',
      'config': null,
    });
    expect(find.text('已返回成功'), findsOneWidget);
  });

  testWidgets('忙碌阻止重复提交，账号切换后忽略原请求结果', (tester) async {
    final api = _Api()..pending = Completer<Map<String, dynamic>>();
    final state = _State()..api = api;
    await _show(tester, state, item());
    await tester.tap(find.widgetWithText(FilledButton, '安装插件'));
    await tester.pump();
    await tester.tap(find.text('处理中…'));
    await tester.pump();
    expect(api.calls.length, 1);
    await tester.pageBack();
    await tester.pump();
    expect(find.text('处理中…'), findsOneWidget);
    state.switchAccount();
    await tester.pump();
    expect(find.text('账号已切换，请返回插件目录重新打开。'), findsOneWidget);
    api.pending!.complete({'ok': true});
    await tester.pumpAndSettle();
    expect(find.text('已返回成功'), findsNothing);
    expect(
      tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
      isNull,
    );
  });

  testWidgets('缺少不可变版本拒绝安装和测试', (tester) async {
    final api = _Api(), state = _State();
    state.api = api;
    final data = item()..remove('versionId');
    await _show(tester, state, data);
    await tester.tap(find.text('测试连接'));
    await tester.pump();
    expect(find.text('版本信息不完整，请返回目录刷新后重试。'), findsOneWidget);
    expect(api.probes, isEmpty);
    await tester.tap(find.widgetWithText(FilledButton, '安装插件'));
    await tester.pump();
    expect(api.calls, isEmpty);
  });

  testWidgets('非法原选项不能静默改为第一项', (tester) async {
    final api = _Api(), state = _State();
    state.api = api;
    final data = item(
      fields: [
        {
          'key': 'format',
          'label': '格式',
          'type': 'select',
          'options': [
            {'value': 1, 'label': '简报'},
          ],
        },
      ],
    );
    data['setupConfig'] = {'format': '1'};
    await _show(tester, state, data);
    await tester.tap(find.widgetWithText(FilledButton, '安装插件'));
    await tester.pumpAndSettle();
    expect(find.text('请选择当前版本提供的选项'), findsOneWidget);
    expect(api.calls, isEmpty);
    await tester.tap(find.byType(MobileSelectField<int>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('简报').last);
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '安装插件'));
    await tester.pumpAndSettle();
    expect((api.calls.single['config'] as Map)['format'], 1);
  });

  for (final width in [320.0, 390.0]) {
    testWidgets('小屏键盘布局和返回取消 $width', (tester) async {
      final api = _Api(), state = _State();
      state.api = api;
      await _show(tester, state, item(), width: width);
      tester.view.viewInsets = const FakeViewPadding(bottom: 260);
      addTearDown(tester.view.resetViewInsets);
      await tester.tap(find.byKey(const ValueKey('preference-subject')));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(
        find.widgetWithText(FilledButton, '安装插件').hitTestable(),
        findsOneWidget,
      );
      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(api.calls, isEmpty);
      expect(find.text('打开'), findsOneWidget);
    });
  }
}
