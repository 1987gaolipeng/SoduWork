import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/screens/desktop_capabilities_screen.dart';
import 'package:soduwork_mobile/screens/plugin_builder_screen.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';

class Api extends SoduWorkApi {
  Api()
    : super(
        store: DeviceStore(),
        endpoint: const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'https://fixture.invalid',
        ),
      );
  bool online = true;
  bool failSwitch = false;
  Completer<Map<String, dynamic>>? pending;
  final calls = <Map<String, dynamic>>[];
  @override
  Future<Map<String, dynamic>> desktopCapabilityTargets() async => {
    'items': [
      {
        'id': 'pc',
        'name': '工作电脑',
        'ready': online,
        'reason': online ? '' : '电脑离线，不会改派',
      },
      {'id': 'other', 'name': '另一台电脑', 'ready': true},
    ],
  };
  @override
  Future<Map<String, dynamic>> desktopCapabilityRequest(
    String target,
    String operation,
    Map<String, dynamic> args,
    String requestId,
  ) async {
    calls.add({
      'target': target,
      'op': operation,
      'args': args,
      'id': requestId,
    });
    if (operation == 'catalog') {
      return pending?.future ??
          {
            'plugins': [
              {
                'pluginId': 'local:one',
                'name': '$target 本机插件',
                'description': '用途',
                'checksum': 'hash',
                'enabled': true,
              },
            ],
            'skills': [
              {'name': '$target 技能'},
            ],
            'connectors': [
              {'name': '$target 连接器'},
            ],
            'market': [
              {'name': '$target 市场'},
            ],
          };
    }
    if (operation == 'plugin.preflight') return {'ok': true};
    if (operation == 'skill.set') {
      if (failSwitch) throw const ApiFailure('电脑离线，未保存');
      return {'ok': true, ...args};
    }
    if (operation == 'plugin.install') {
      return {
        'ok': true,
        'plugin': {'pluginId': 'local:new'},
      };
    }
    throw StateError(operation);
  }
}

class StateFixture extends MobileState {
  int revision = 0;
  @override
  int get identityRevision => revision;
  void switchIdentity(Api next) {
    api = next;
    revision++;
    notifyListeners();
  }
}

Future<StateFixture> show(WidgetTester tester, Api api) async {
  tester.view.physicalSize = const Size(390, 1200);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final state = StateFixture()..api = api;
  addTearDown(state.dispose);
  addTearDown(api.client.close);
  await tester.pumpWidget(
    MobileScope(
      state: state,
      child: MaterialApp(
        home: Scaffold(body: DesktopCapabilitiesScreen(onEnterprise: () {})),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return state;
}

void main() {
  testWidgets('use sheet stays compact and can close without sending work', (
    tester,
  ) async {
    final api = Api();
    await show(tester, api);
    await tester.tap(find.text('使用'));
    await tester.pumpAndSettle();
    expect(find.byType(BottomSheet), findsOneWidget);
    expect(find.byType(AlertDialog), findsNothing);
    expect(find.text('在 工作电脑 上开始新会话'), findsOneWidget);
    expect(find.text('开始执行'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.tap(find.byTooltip('关闭'));
    await tester.pumpAndSettle();
    expect(api.calls.where((call) => call['op'] == 'plugin.use'), isEmpty);
  });

  testWidgets(
    'skill switch saves to selected PC and failed writes keep the original state',
    (tester) async {
      final api = Api();
      await show(tester, api);
      await tester.tap(find.widgetWithText(ChoiceChip, '技能'));
      await tester.pumpAndSettle();
      final toggle = find.byKey(const ValueKey('skill-pc 技能'));
      expect(tester.widget<Switch>(toggle).value, false);
      await tester.tap(toggle);
      await tester.pumpAndSettle();
      expect(tester.widget<Switch>(toggle).value, true);
      expect(api.calls.last['target'], 'pc');
      expect(api.calls.last['args'], {'name': 'pc 技能', 'enabled': true});
      api.failSwitch = true;
      await tester.tap(toggle);
      await tester.pumpAndSettle();
      expect(tester.widget<Switch>(toggle).value, true);
      expect(find.textContaining('未保存'), findsOneWidget);
      final failedId = api.calls.last['id'];
      api.failSwitch = false;
      await tester.tap(toggle);
      await tester.pumpAndSettle();
      expect(tester.widget<Switch>(toggle).value, false);
      expect(api.calls.last['id'], isNot(failedId));
    },
  );

  testWidgets('all tabs use the selected PC and expose no import/export', (
    tester,
  ) async {
    final api = Api();
    await show(tester, api);
    expect(find.text('pc 本机插件'), findsOneWidget);
    for (final entry in {
      '技能': 'pc 技能',
      '连接器': 'pc 连接器',
      '市场': 'pc 市场',
    }.entries) {
      await tester.tap(find.widgetWithText(ChoiceChip, entry.key));
      await tester.pumpAndSettle();
      expect(find.text(entry.value), findsOneWidget);
    }
    expect(api.calls.length, 1);
    expect(find.textContaining('导入'), findsNothing);
    expect(find.textContaining('导出'), findsNothing);
    await tester.tap(find.text('切换'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('另一台电脑').last);
    await tester.pumpAndSettle();
    expect(find.text('pc 市场'), findsNothing);
    expect(find.text('other 市场'), findsOneWidget);
    expect(api.calls.last['target'], 'other');
  });

  testWidgets(
    'offline refresh preserves selected PC instead of switching to another online PC',
    (tester) async {
      final api = Api();
      await show(tester, api);
      api.online = false;
      await tester.tap(find.byTooltip('刷新'));
      await tester.pumpAndSettle();
      expect(find.text('电脑离线，不会改派'), findsOneWidget);
      expect(find.text('pc 本机插件'), findsNothing);
      expect(api.calls.length, 1);
    },
  );

  testWidgets('account switch clears late old-account catalog', (tester) async {
    final api = Api();
    final state = await show(tester, api);
    api.pending = Completer();
    await tester.tap(find.byTooltip('刷新'));
    await tester.pump();
    final next = Api();
    state.switchIdentity(next);
    await tester.pumpAndSettle();
    api.pending!.complete({
      'plugins': [
        {'name': '旧账号隐私'},
      ],
    });
    await tester.pumpAndSettle();
    expect(find.text('旧账号隐私'), findsNothing);
    expect(find.text('pc 本机插件'), findsOneWidget);
    next.client.close();
  });

  testWidgets(
    'builder reuses PC preflight and install callbacks, no enterprise submission',
    (tester) async {
      final api = Api();
      await show(tester, api);
      await tester.tap(find.text('创建插件'));
      await tester.pumpAndSettle();
      expect(find.byType(PluginBuilderScreen), findsOneWidget);
      for (final entry in {
        '插件名称': '手机新插件',
        '用途': '整理资料',
        '工作方法': '阅读输入并汇总',
      }.entries) {
        final field = find.byWidgetPredicate(
          (w) => w is TextField && w.decoration?.labelText == entry.key,
        );
        await tester.ensureVisible(field);
        await tester.enterText(field, entry.value);
        await tester.pumpAndSettle();
      }
      await tester.ensureVisible(find.text('检查并继续'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('检查并继续'));
      await tester.pumpAndSettle();
      expect(api.calls.last['op'], 'plugin.preflight');
      expect(find.text('提交审核'), findsNothing);
      await tester.ensureVisible(find.text('安装到电脑'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('安装到电脑'));
      await tester.pumpAndSettle();
      expect(
        api.calls
            .where((call) => call['op'] == 'plugin.install')
            .single['target'],
        'pc',
      );
      expect(find.byType(PluginBuilderScreen), findsNothing);
    },
  );
}
