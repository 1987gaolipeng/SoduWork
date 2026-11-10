import 'memory_device_auth.dart';
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/mobile_app.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/cloud_conversation_request.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';

void main() {
  test(
    'a saved receipt survives list refresh failure and clears its pending request',
    () async {
      late CloudConversationRequest draft;
      final state = await _ready(
        MockClient((request) async {
          if (request.method == 'POST') {
            return _json({
              'ok': true,
              'taskId': 'saved-task',
              'phase': 'committed',
              'ref': 'saved-ref',
              'transferId': draft.id,
              'source': {
                'entryKind': 'cloud',
                'sessionId': draft.options['sessionId'],
                'adapterId': 'pi',
              },
            });
          }
          return _json({'detail': 'list unavailable'}, 503);
        }),
      );
      addTearDown(state.dispose);
      draft = await CloudConversationRequest.prepare(
        text: '整理清单',
        agentId: 'pi',
      );
      state.pendingCloudRequest = draft;
      final receipt = await state.startCloudConversation(
        text: '整理清单',
        request: draft,
      );
      expect(receipt['taskId'], 'saved-task');
      expect(state.pendingCloudRequest, isNull);
      expect(state.refreshError, contains('list unavailable'));
    },
  );

  test(
    'an incomplete receipt keeps the original request for verification',
    () async {
      final state = await _ready(MockClient((_) async => _json({'ok': true})));
      addTearDown(state.dispose);
      final draft = await CloudConversationRequest.prepare(
        text: '整理清单',
        agentId: 'pi',
      );
      state.pendingCloudRequest = draft;
      await expectLater(
        state.startCloudConversation(text: '整理清单', request: draft),
        throwsA(
          isA<ApiFailure>().having(
            (error) => error.isNetwork,
            'uncertain',
            isTrue,
          ),
        ),
      );
      expect(state.pendingCloudRequest, same(draft));
    },
  );

  test(
    'an old refresh cannot restore tasks or pending drafts after switching Hubs',
    () async {
      final oldResponse = Completer<http.Response>();
      final oldRequestStarted = Completer<void>();
      final state = await _ready(
        MockClient((request) async {
          if (request.url.path.endsWith('/clients/enroll')) {
            return _json({
              'session': 'new-session',
              'authState': 'active',
              'ownerUserId': 'new-user',
            });
          }
          if (request.url.path == '/api/v1/tasks') {
            if (request.url.host == 'old.test') {
              oldRequestStarted.complete();
              return oldResponse.future;
            }
            return _json([
              {'id': 'new-task', 'title': '新环境工作'},
            ]);
          }
          if (request.url.path == '/api/v1/reports') return _json({});
          return _json({'items': []});
        }),
      );
      addTearDown(state.dispose);
      state.pendingCloudRequest = await CloudConversationRequest.prepare(
        text: '旧环境工作',
        agentId: 'pi',
      );
      final oldRefresh = state.refreshAll();
      await oldRequestStarted.future;
      await state.setEndpoint(
        environment: SoduWorkEnvironment.development,
        developmentUrl: 'http://new.test',
      );
      oldResponse.complete(
        _json([
          {'id': 'old-task', 'title': '旧环境工作'},
        ]),
      );
      await oldRefresh;
      expect(state.tasks.map((task) => task.id), ['new-task']);
      expect(state.enrollment?.ownerUserId, 'new-user');
      expect(state.pendingCloudRequest, isNull);
      expect(state.refreshError, isEmpty);
      expect(state.phase, MobilePhase.ready);
    },
  );
  testWidgets(
    'failed account login preserves the registered form and displays its error',
    (tester) async {
      tester.view.physicalSize = const Size(390, 1400);
      tester.view.devicePixelRatio = 1;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });
      final response = Completer<http.Response>();
      final state = await _ready(MockClient((_) => response.future));
      addTearDown(state.dispose);
      state.phase = MobilePhase.pendingActivation;
      state.enrollment = const EnrollmentState(
        active: false,
        deviceId: 'fixture-device',
        deviceName: 'Test',
        authState: 'pending',
        ownerUserId: '',
      );
      await tester.pumpWidget(SoduWorkMobileApp(state: state));
      await tester.pump(const Duration(milliseconds: 400));
      await tester.tap(find.byKey(const Key('welcome-sign-in')));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.widgetWithText(TextField, '账号'),
        'fixture-account',
      );
      await tester.enterText(
        find.widgetWithText(TextField, '密码'),
        'fixture-password',
      );
      await tester.pump();
      await tester.tap(find.text('登录并继续'));
      await tester.pump();
      expect(state.phase, MobilePhase.connecting);
      expect(state.enrollment?.deviceId, 'fixture-device');
      expect(state.enrollment?.active, isFalse);
      expect(find.text('正在登录…'), findsOneWidget);
      response.complete(
        _json({
          'detail': {
            'code': 'ACCOUNT_OR_PASSWORD_INVALID',
            'message': '账号或密码不正确',
          },
        }, 401),
      );
      await tester.pumpAndSettle();
      expect(find.text('账号或密码不正确'), findsOneWidget);
      expect(
        tester
            .widget<TextField>(find.widgetWithText(TextField, '账号'))
            .controller!
            .text,
        'fixture-account',
      );
      expect(
        tester
            .widget<TextField>(find.widgetWithText(TextField, '密码'))
            .controller!
            .text,
        'fixture-password',
      );
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'sign in prioritizes the account form and keeps administrator activation collapsed on a small phone',
    (tester) async {
      tester.view.physicalSize = const Size(320, 568);
      tester.view.devicePixelRatio = 1;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });
      final state = await _ready(MockClient((_) async => _json({})));
      addTearDown(state.dispose);
      state.phase = MobilePhase.pendingActivation;
      state.enrollment = const EnrollmentState(
        active: false,
        deviceId: 'fixture-device',
        deviceName: 'Test',
        authState: 'pending',
        ownerUserId: '',
      );
      await tester.pumpWidget(SoduWorkMobileApp(state: state));
      await tester.pump(const Duration(milliseconds: 400));
      await tester.tap(find.byKey(const Key('welcome-sign-in')));
      await tester.pumpAndSettle();
      expect(find.text('登录 SoduWork'), findsOneWidget);
      expect(find.text('设备激活码'), findsNothing);
      expect(find.byTooltip('显示密码'), findsOneWidget);
      await tester.enterText(
        find.widgetWithText(TextField, '账号'),
        'fixture-account',
      );
      await tester.testTextInput.receiveAction(TextInputAction.next);
      await tester.pump();
      final password = tester.widget<TextField>(
        find.widgetWithText(TextField, '密码'),
      );
      expect(password.focusNode!.hasFocus, isTrue);
      await tester.enterText(
        find.widgetWithText(TextField, '密码'),
        'fixture-password',
      );
      await tester.tap(find.byTooltip('显示密码'));
      await tester.pump();
      expect(
        tester
            .widget<TextField>(find.widgetWithText(TextField, '密码'))
            .obscureText,
        isFalse,
      );
      tester.testTextInput.hide();
      await tester.ensureVisible(
        find.byKey(const Key('administrator-activation')),
      );
      await tester.tap(find.text('通过管理员激活'));
      await tester.pumpAndSettle();
      expect(find.text('设备激活码'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
}

Future<MobileState> _ready(http.Client client) async {
  final store = _Store();
  final state = MobileState(store: store);
  await state.init(connectNow: false);
  state.api.client.close();
  state.api = SoduWorkApi(store: store, endpoint: state.endpoint, client: client);
  state.phase = MobilePhase.ready;
  return state;
}

http.Response _json(Object value, [int status = 200]) => http.Response(
  jsonEncode(value),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

class _Store extends DeviceStore with MemoryDeviceAuthentication {
  @override
  Future<void> init() async {}
  @override
  EndpointSettings loadEndpoint() => const EndpointSettings(
    environment: SoduWorkEnvironment.development,
    baseUrl: 'http://old.test',
  );
  @override
  Future<void> saveEndpoint(EndpointSettings endpoint) async {}
  @override
  Future<String?> readSession(String endpoint) async => 'test-session';
  @override
  Future<void> writeSession(String endpoint, String session) async {}
  @override
  Future<void> clearSession(String endpoint) async {}
  @override
  Future<DeviceCredentials> credentials(String endpoint) async =>
      const DeviceCredentials(
        id: 'mobile-test',
        secret: 'unit-test-device-secret',
        name: 'Mobile',
        platform: 'test',
      );
}
