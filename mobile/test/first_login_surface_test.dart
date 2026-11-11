import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/mobile_app.dart';
import 'package:soduwork_mobile/screens/account_sign_in_form.dart';
import 'package:soduwork_mobile/screens/app_shell.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';

void main() {
  for (final locked in [true, false]) {
    for (final failure in <Object>[
      const ApiFailure('账号或密码不正确', status: 401),
      const ApiFailure('登录服务暂时不可用', status: 503),
      StateError('Connection interrupted'),
    ]) {
      testWidgets('first login keeps its form after $failure, locked=$locked', (
        tester,
      ) async {
        tester.view.physicalSize = const Size(390, 1000);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final state = _State(locked: locked);
        addTearDown(state.api.client.close);
        addTearDown(state.dispose);
        await tester.pumpWidget(SoduWorkMobileApp(state: state));
        await tester.pump(const Duration(milliseconds: 400));
        await tester.tap(find.byKey(const Key('welcome-sign-in')));
        await tester.pumpAndSettle();
        final form = tester.state(find.byType(AccountSignInForm));
        await tester.enterText(
          find.widgetWithText(TextField, '账号'),
          'test-user',
        );
        await tester.enterText(
          find.widgetWithText(TextField, '密码'),
          'test-password',
        );
        await tester.ensureVisible(find.text('登录并继续'));
        await tester.tap(find.text('登录并继续'));
        await tester.pump();
        expect(state.authenticatingAccount, isTrue);
        final stayedDuringRequest = find
            .byType(AccountSignInForm)
            .evaluate()
            .isNotEmpty;
        state.testApi.requests.single.completeError(failure);
        // A regressed return to the animated welcome page must fail the form
        // assertion rather than timing out while waiting for its loop to settle.
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 400));

        expect(stayedDuringRequest, isTrue);
        expect(find.byType(AccountSignInForm), findsOneWidget);
        expect(tester.state(find.byType(AccountSignInForm)), same(form));
        expect(state.phase, MobilePhase.pendingActivation);
        expect(state.authenticatingAccount, isFalse);
        expect(state.enrollment, isNull);
        expect(
          tester
              .widget<TextField>(find.widgetWithText(TextField, '账号'))
              .controller!
              .text,
          'test-user',
        );
        expect(
          tester
              .widget<TextField>(find.widgetWithText(TextField, '密码'))
              .controller!
              .text,
          'test-password',
        );
        expect(
          find.text(
            failure is ApiFailure ? failure.message : '登录暂时没有完成，请检查网络后重试。',
          ),
          findsOneWidget,
        );
        expect(find.byType(AppShell), findsNothing);

        await tester.ensureVisible(find.text('登录并继续'));
        await tester.tap(find.text('登录并继续'));
        await tester.pump();
        expect(state.testApi.requests, hasLength(2));
        state.testApi.requests.last.complete(
          const EnrollmentState(
            active: true,
            deviceId: 'test-device',
            deviceName: 'Test',
            authState: 'active',
            ownerUserId: '',
          ),
        );
        await tester.pumpAndSettle();
        expect(state.phase, MobilePhase.ready);
        expect(state.authenticatingAccount, isFalse);
        expect(find.byType(AccountSignInForm), findsNothing);
        expect(find.byType(AppShell), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    }
  }
  testWidgets('session restoration still shows startup until it completes', (
    tester,
  ) async {
    final state = _State()..phase = MobilePhase.connecting;
    addTearDown(state.api.client.close);
    addTearDown(state.dispose);
    await tester.pumpWidget(SoduWorkMobileApp(state: state));
    await tester.pump();
    expect(state.authenticatingAccount, isFalse);
    expect(find.byKey(const Key('welcome-sign-in')), findsNothing);
    expect(find.byType(AccountSignInForm), findsNothing);
  });
}

class _State extends MobileState {
  late final _Api testApi;
  _State({bool locked = true}) : super(endpointLocked: locked) {
    endpoint = const EndpointSettings(
      environment: SoduWorkEnvironment.development,
      baseUrl: 'https://fixture.invalid',
    );
    testApi = _Api(store, endpoint);
    api = testApi;
    phase = locked ? MobilePhase.disconnected : MobilePhase.pendingActivation;
  }

  @override
  Future<void> refreshAll() async {}

  @override
  Future<ClientAuthPolicy> authenticationPolicy() async =>
      const ClientAuthPolicy();
}

class _Api extends SoduWorkApi {
  final requests = <Completer<EnrollmentState>>[];
  _Api(DeviceStore store, EndpointSettings endpoint)
    : super(store: store, endpoint: endpoint);

  @override
  Future<EnrollmentState> loginWithAccount({
    required String account,
    required String password,
  }) {
    final request = Completer<EnrollmentState>();
    requests.add(request);
    return request.future;
  }
}
