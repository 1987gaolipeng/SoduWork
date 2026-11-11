import 'memory_device_auth.dart';
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/screens/ai_resources_screen.dart';
import 'package:soduwork_mobile/sdk/soduwork_brand.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';

void main() {
  testWidgets(
    'a proxy HTML page is an actionable error, not an empty environment',
    (tester) async {
      tester.view.physicalSize = const Size(320, 740);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      var repaired = false;
      final state = _State(
        MockClient(
          (request) async => repaired
              ? _json({'environments': []})
              : http.Response('<html>Proxy sign in</html>', 200),
        ),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(_app(state, section: AiResourceSection.cloud));
      await tester.pumpAndSettle();
      expect(find.textContaining('目录格式不正确'), findsOneWidget);
      expect(find.textContaining('尚无可用云端环境'), findsNothing);
      expect(find.byType(LinearProgressIndicator), findsNothing);
      repaired = true;
      await tester.scrollUntilVisible(find.text('重新加载'), 140);
      await tester.tap(find.text('重新加载'));
      await tester.pumpAndSettle();
      expect(find.textContaining('目录格式不正确'), findsNothing);
      expect(find.textContaining('尚无可用云端环境'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  for (final status in [
    'paused',
    'disabled',
    'revoked',
    'deployment_restricted',
    'at_capacity',
  ]) {
    testWidgets('online $status environment cannot advertise a ready Agent', (
      tester,
    ) async {
      final state = _State(
        MockClient(
          (request) async => _json({
            'environments': [
              {
                'name': '已配置的云电脑',
                'online': true,
                'status': status,
                'statusReason': '服务端限制接单',
                'agents': [
                  {'id': 'pi', 'name': 'Pi', 'ready': true},
                ],
              },
            ],
          }),
        ),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(_app(state, section: AiResourceSection.cloud));
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(find.text('Pi'), 120);
      expect(find.text('已就绪'), findsNothing);
      expect(find.byIcon(Icons.check_circle_outline_rounded), findsNothing);
      expect(find.text('服务端限制接单'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets(
    'unsupported environment API explains version mismatch rather than empty setup',
    (tester) async {
      final state = _State(
        MockClient((request) async => _json({'detail': 'Not Found'}, 404)),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(_app(state, section: AiResourceSection.cloud));
      await tester.pumpAndSettle();
      expect(find.textContaining('当前服务尚未提供云环境目录'), findsOneWidget);
      expect(find.textContaining('尚无可用云端环境'), findsNothing);
      expect(find.text('连接服务：hub.test'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  for (final online in [true, false]) {
    testWidgets(
      'cloud preparation catalog includes uninstalled Pi, online=$online',
      (tester) async {
        final methods = <String>[];
        final state = _State(
          MockClient((request) async {
            methods.add(request.method);
            return _json({
              'environments': [
                {
                  'name': '团队开发环境',
                  'online': online,
                  'statusText': online ? '可执行' : '离线',
                  'agents': [
                    {'id': 'opencode', 'name': 'OpenCode', 'ready': true},
                  ],
                  'availableAgents': [
                    {
                      'id': 'pi',
                      'name': 'Pi',
                      'installed': false,
                      'ready': false,
                      'installable': true,
                    },
                    {
                      'id': 'opencode',
                      'name': 'OpenCode',
                      'installed': true,
                      'ready': true,
                      'installable': true,
                    },
                  ],
                },
              ],
            });
          }),
        );
        addTearDown(state.dispose);
        await tester.pumpWidget(_app(state, section: AiResourceSection.cloud));
        await tester.pumpAndSettle();
        expect(find.text('Pi'), findsOneWidget);
        expect(find.text('OpenCode'), findsOneWidget);
        expect(find.text('未安装'), online ? findsOneWidget : findsNothing);
        expect(find.text('已就绪'), online ? findsOneWidget : findsNothing);
        expect(find.text('等待环境连接'), online ? findsNothing : findsNWidgets(2));
        await tester.scrollUntilVisible(find.textContaining('准备底座：'), 150);
        expect(methods, ['GET']);
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets(
    'legacy cloud inventory remains visible without preparation catalog',
    (tester) async {
      final state = _State(
        MockClient(
          (request) async => _json({
            'environments': [
              {
                'name': '旧版环境',
                'online': true,
                'agents': [
                  {'id': 'pi', 'name': 'Pi', 'ready': true},
                ],
              },
            ],
          }),
        ),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(_app(state, section: AiResourceSection.cloud));
      await tester.pumpAndSettle();
      expect(find.text('Pi'), findsOneWidget);
      expect(find.text('已就绪'), findsOneWidget);
      expect(find.textContaining('准备底座：'), findsNothing);
    },
  );

  testWidgets(
    '320px dark page loads real catalogs without automatically testing models',
    (tester) async {
      tester.view.physicalSize = const Size(320, 568);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final routes = <String>[];
      final state = _State(
        MockClient((request) async {
          routes.add(request.url.path);
          if (request.url.path.endsWith('/ai-agents')) return _catalog();
          return _json({'environments': []});
        }),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(_app(state, dark: true));
      await tester.pumpAndSettle();
      expect(find.text('团队模型 A'), findsOneWidget);
      expect(
        routes,
        unorderedEquals(['/api/v1/ai-agents', '/api/v1/cloud-environments']),
      );
      await tester.scrollUntilVisible(find.textContaining('尚无可用云端环境'), 180);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'explicit model check blocks duplicate input and retains actionable failures',
    (tester) async {
      final response = Completer<http.Response>();
      var configs = 0;
      final state = _State(
        MockClient((request) async {
          if (request.url.path.endsWith('/ai-agents')) return _catalog();
          if (request.url.path.endsWith('/config')) {
            configs++;
            return response.future;
          }
          return _json({'environments': []});
        }),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(_app(state));
      await tester.pumpAndSettle();
      await tester.tap(find.text('测试所选模型连接'));
      await tester.pump();
      expect(find.text('正在检查…'), findsOneWidget);
      expect(
        tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
        isNull,
      );
      response.complete(_json({'ok': false, 'reason': '公司网关额度不足'}));
      await tester.pumpAndSettle();
      expect(find.text('公司网关额度不足'), findsOneWidget);
      expect(configs, 1);
      expect(
        tester
            .widget<ListTile>(find.widgetWithText(ListTile, '团队模型 A'))
            .selected,
        isTrue,
      );
    },
  );

  testWidgets('partial failures preserve usable models and allow retry', (
    tester,
  ) async {
    var environmentCalls = 0;
    final state = _State(
      MockClient((request) async {
        if (request.url.path.endsWith('/ai-agents')) return _catalog();
        environmentCalls++;
        return environmentCalls == 1
            ? _json({'detail': '执行环境暂不可用'}, 503)
            : _json({
                'environments': [
                  {'name': '我的电脑', 'statusText': '可执行', 'statusReason': '连接正常'},
                ],
              });
      }),
    );
    addTearDown(state.dispose);
    await tester.pumpWidget(_app(state));
    await tester.pumpAndSettle();
    expect(find.text('团队模型 A'), findsOneWidget);
    await tester.scrollUntilVisible(find.text('重新加载'), 160);
    await tester.tap(find.text('重新加载'));
    await tester.pumpAndSettle();
    expect(find.text('我的电脑'), findsOneWidget);
    expect(find.text('执行环境暂不可用'), findsNothing);
  });

  testWidgets('switching account discards late previous-account catalogs', (
    tester,
  ) async {
    final oldCatalog = Completer<http.Response>();
    var catalogCalls = 0;
    final state = _State(
      MockClient((request) async {
        if (request.url.path.endsWith('/ai-agents')) {
          catalogCalls++;
          return catalogCalls == 1
              ? oldCatalog.future
              : _json({
                  'modelOptions': [
                    {'name': 'new', 'label': '新账号模型'},
                  ],
                });
        }
        return _json({'environments': []});
      }),
    );
    addTearDown(state.dispose);
    await tester.pumpWidget(_app(state));
    await tester.pump();
    state.switchIdentity();
    await tester.pump();
    await tester.pump();
    oldCatalog.complete(_catalog());
    await tester.pumpAndSettle();
    expect(find.text('新账号模型'), findsOneWidget);
    expect(find.text('团队模型 A'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}

Widget _app(
  MobileState state, {
  bool dark = false,
  AiResourceSection section = AiResourceSection.all,
}) => MobileScope(
  state: state,
  child: MaterialApp(
    theme: SoduWorkTheme.light(
      SoduWorkBrandTheme(brightness: dark ? Brightness.dark : Brightness.light),
    ),
    home: AiResourcesScreen(section: section),
  ),
);

class _State extends MobileState {
  int revision = 1;
  _State(http.Client client) {
    api = SoduWorkApi(
      store: _Store(),
      endpoint: const EndpointSettings(
        environment: SoduWorkEnvironment.development,
        baseUrl: 'https://hub.test',
      ),
      client: client,
    );
  }
  @override
  int get identityRevision => revision;
  void switchIdentity() {
    revision++;
    notifyListeners();
  }
}

class _Store extends DeviceStore with MemoryDeviceAuthentication {
  @override
  Future<String?> readSession(String endpoint) async =>
      'fixture-device-session';
}

http.Response _catalog() => _json({
  'defaultModel': 'chat-a',
  'modelOptions': [
    {'name': 'chat-a', 'label': '团队模型 A', 'providerName': '企业模型服务'},
  ],
});
http.Response _json(Object data, [int status = 200]) => http.Response(
  jsonEncode(data),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);
