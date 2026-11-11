import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/mobile_app.dart';
import 'package:soduwork_mobile/models/work_models.dart';
import 'package:soduwork_mobile/screens/profile_screen.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';

import 'memory_device_auth.dart';

void main() {
  test(
    'local data clears before an unresponsive remote logout completes',
    () async {
      final remote = Completer<http.Response>();
      final state = await _state(MockClient((_) => remote.future));
      addTearDown(state.dispose);
      state.tasks = [
        WorkTask.fromJson({'id': 'old-task', 'title': '旧账号任务'}),
      ];
      final operation = state.signOut();
      expect(state.tasks, isEmpty);
      expect(state.phase, MobilePhase.pendingActivation);
      expect(state.signingOut, isTrue);
      expect(state.enrollment?.active, isFalse);
      await expectLater(
        state.loginWithAccount(account: 'other', password: 'fixture'),
        throwsA(isA<ApiFailure>()),
      );
      remote.complete(_json({'detail': 'offline'}, 503));
      await operation;
      expect(state.signingOut, isFalse);
      expect(state.signOutNotice, contains('远端旧设备注销尚未确认'));
      expect(state.pendingApprovals, isEmpty);
      expect(state.brief, isNull);
    },
  );

  test(
    'signed-out restart shows account form without a network enrollment',
    () async {
      final store = _Store();
      await store.setAuthenticationLock(
        'https://hub.test',
        signedOut: true,
        uncertainLogout: true,
      );
      var calls = 0;
      final state = await _state(
        MockClient((_) async {
          calls++;
          return _json({'authState': 'active'});
        }),
        store: store,
      );
      addTearDown(state.dispose);
      await state.connect();
      expect(calls, 0);
      expect(state.phase, MobilePhase.pendingActivation);
      expect(state.enrollment?.ownerUserId, isEmpty);
      expect(state.signOutNotice, contains('远端旧设备注销尚未确认'));
    },
  );

  test('a late task detail cannot refill the cleared task cache', () async {
    final pending = Completer<http.Response>();
    final sent = Completer<void>();
    final state = await _state(
      MockClient((request) async {
        if (request.url.path.endsWith('/logout')) return _json({'ok': true});
        sent.complete();
        return pending.future;
      }),
    );
    addTearDown(state.dispose);
    final operation = state.loadTask('old-task');
    final rejected = expectLater(
      operation,
      throwsA(
        isA<ApiFailure>().having((e) => e.status, 'identity conflict', 409),
      ),
    );
    await sent.future;
    await state.signOut();
    pending.complete(_json({'id': 'old-task', 'title': '旧账号任务'}));
    await rejected;
    expect(state.tasks, isEmpty);
  });

  testWidgets(
    'signout removes nested old-account routes and cannot navigate back',
    (tester) async {
      final state = await _state(MockClient((_) async => _json({'ok': true})));
      addTearDown(state.dispose);
      final navigator = GlobalKey<NavigatorState>();
      await tester.pumpWidget(
        MaterialApp(
          theme: SoduWorkTheme.light(),
          home: SoduWorkWorkspace(state: state, navigatorKey: navigator),
        ),
      );
      await tester.pumpAndSettle();
      unawaited(
        navigator.currentState!.push(
          MaterialPageRoute<void>(
            builder: (_) => const Scaffold(body: Text('旧账号详情')),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('旧账号详情'), findsOneWidget);
      await state.signOut();
      // Wait for the route reset, not for the looping welcome ticker to stop.
      for (var frame = 0; frame < 8; frame++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(find.text('旧账号详情'), findsNothing);
      expect(navigator.currentState!.canPop(), isFalse);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'profile exit requires confirmation and About has a real license entry',
    (tester) async {
      var logouts = 0;
      final state = await _state(
        MockClient((_) async {
          logouts++;
          return _json({'ok': true});
        }),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(
        MobileScope(
          state: state,
          child: MaterialApp(
            theme: SoduWorkTheme.light(),
            home: const Scaffold(body: ProfileScreen()),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('关于'));
      await tester.tap(find.text('关于'));
      await tester.pumpAndSettle();
      expect(find.byType(AboutDialog), findsOneWidget);
      expect(find.text('开发预览'), findsOneWidget);
      // AboutDialog's native implementation supplies showLicensePage.
      expect(find.text('View licenses'), findsOneWidget);
      await tester.tap(find.text('Close'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('退出当前账号'));
      await tester.tap(find.text('退出当前账号'));
      await tester.pumpAndSettle();
      expect(find.text('退出当前账号？'), findsOneWidget);
      await tester.tap(find.text('取消'));
      await tester.pumpAndSettle();
      expect(logouts, 0);
      expect(state.phase, MobilePhase.ready);
    },
  );
}

Future<MobileState> _state(http.Client client, {_Store? store}) async {
  final state = MobileState(store: store ?? _Store());
  await state.init(connectNow: false);
  state.api.client.close();
  state.api = SoduWorkApi(
    store: state.store,
    endpoint: state.endpoint,
    client: client,
  );
  state.phase = MobilePhase.ready;
  state.enrollment = const EnrollmentState(
    active: true,
    deviceId: 'fixture-device',
    deviceName: 'Fixture Mobile',
    authState: 'active',
    ownerUserId: 'fixture-user',
  );
  return state;
}

class _Store extends DeviceStore with MemoryDeviceAuthentication {
  String? session = 'fixture-session';
  @override
  Future<void> init() async {}
  @override
  EndpointSettings loadEndpoint() => const EndpointSettings(
    environment: SoduWorkEnvironment.development,
    baseUrl: 'https://hub.test',
  );
  @override
  Future<String?> readSession(String endpoint) async => session;
  @override
  Future<void> clearSession(String endpoint) async {
    session = null;
  }

  @override
  Future<DeviceCredentials> credentials(String endpoint) async =>
      const DeviceCredentials(
        id: 'fixture-device',
        secret: 'fixture-key',
        name: 'Fixture Mobile',
        platform: 'test',
      );
}

http.Response _json(Object data, [int status = 200]) => http.Response(
  jsonEncode(data),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);
