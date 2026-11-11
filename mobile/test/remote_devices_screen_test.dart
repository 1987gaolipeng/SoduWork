import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/screens/remote_devices_screen.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';

void main() {
  testWidgets(
    'source directory lists real capability and does not request capture automatically',
    (tester) async {
      tester.view.physicalSize = const Size(320, 740);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final api = _ScreenApi();
      final state = MobileState()
        ..api = api
        ..phase = MobilePhase.ready;
      addTearDown(state.dispose);
      addTearDown(api.client.close);
      await tester.pumpWidget(
        MobileScope(
          state: state,
          child: MaterialApp(
            theme: SoduWorkTheme.light(),
            home: const RemoteDevicesScreen(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('我的办公电脑'), findsOneWidget);
      expect(find.text('离线电脑'), findsOneWidget);
      expect(find.text('伪装设备'), findsNothing);
      expect(api.methods, ['GET']);
      expect(tester.takeException(), isNull);
      await tester.tap(find.text('我的办公电脑'));
      await tester.pumpAndSettle();
      expect(find.textContaining('不允许鼠标'), findsOneWidget);
      expect(api.methods, ['GET']);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'old Hub has an explicit availability message without invented devices',
    (tester) async {
      final api = _ScreenApi()..unsupported = true;
      final state = MobileState()
        ..api = api
        ..phase = MobilePhase.ready;
      addTearDown(state.dispose);
      addTearDown(api.client.close);
      await tester.pumpWidget(
        MobileScope(
          state: state,
          child: MaterialApp(
            theme: SoduWorkTheme.light(),
            home: const RemoteDevicesScreen(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('当前 Hub 尚未开放远程看屏，请等待服务升级。'), findsOneWidget);
      expect(find.text('我的办公电脑'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );
}

class _ScreenApi extends SoduWorkApi {
  bool unsupported = false;
  final methods = <String>[];
  _ScreenApi()
    : super(
        store: DeviceStore(),
        endpoint: const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'http://127.0.0.1:18891',
        ),
      );
  @override
  Future<Map<String, dynamic>> remoteScreenRequest(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    methods.add(method);
    expect(path, '/api/v1/remote-screen/sources');
    if (unsupported) throw const ApiFailure('not found', status: 404);
    return {
      'items': [
        {
          'id': 'pc',
          'name': '我的办公电脑',
          'online': true,
          'capability': 'read-only-screen-v1',
        },
        {
          'id': 'offline',
          'name': '离线电脑',
          'online': false,
          'capability': 'read-only-screen-v1',
        },
        {
          'id': 'unknown',
          'name': '伪装设备',
          'online': true,
          'capability': 'unverified',
        },
      ],
    };
  }
}
