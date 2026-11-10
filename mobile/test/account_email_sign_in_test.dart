import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/screens/account_sign_in_form.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/ui/mobile_display_preferences.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';

const _readyPolicy = ClientAuthPolicy(
  supportsEmail: true,
  mailReady: true,
  allowSelfRegistration: true,
  passwordMinLength: 10,
  requiredConsentVersions: {'terms': 'terms-v2', 'privacy': 'privacy-v3'},
  legalDocuments: [
    {
      'key': 'terms',
      'title': 'Workspace Terms',
      'version': 'terms-v2',
      'content': 'Actual terms supplied by the workspace.',
    },
    {
      'key': 'privacy',
      'title': 'Workspace Privacy',
      'version': 'privacy-v3',
      'content': 'Actual privacy supplied by the workspace.',
    },
  ],
);

class _AuthState extends MobileState {
  ClientAuthPolicy policy = _readyPolicy;
  Object? policyFailure, codeFailure, loginFailure;
  int policyReads = 0, codeRequests = 0, logins = 0, resets = 0;
  bool expired = false;
  String route = '', purpose = '', submittedEmail = '', submittedCode = '';
  Map<String, String>? consents;
  Completer<void>? pendingLogin;
  _AuthState() {
    endpoint = const EndpointSettings(
      environment: SoduWorkEnvironment.development,
      baseUrl: 'https://first.test',
    );
    api = SoduWorkApi(store: store, endpoint: endpoint);
    phase = MobilePhase.pendingActivation;
  }
  @override
  Future<ClientAuthPolicy> authenticationPolicy() async {
    policyReads++;
    if (policyFailure != null) throw policyFailure!;
    return policy;
  }

  @override
  Future<EmailAuthChallenge> requestEmailCode({
    required String email,
    required String purpose,
  }) async {
    codeRequests++;
    this.purpose = purpose;
    if (codeFailure != null) throw codeFailure!;
    return EmailAuthChallenge(
      id: 'challenge-$codeRequests',
      email: email,
      purpose: purpose,
      endpoint: endpoint.baseUrl,
      deviceId: 'device',
      authenticationRevision: 0,
      retryAfter: 0,
      retryAt: DateTime.now().subtract(const Duration(seconds: 1)),
      expiresAt: DateTime.now().add(Duration(seconds: expired ? -1 : 600)),
      deliveryState: 'queued',
    );
  }

  @override
  Future<EmailCodeDelivery> emailCodeDelivery(
    EmailAuthChallenge challenge,
  ) async => EmailCodeDelivery(challengeId: challenge.id, state: 'sent');
  Future<void> _login(
    String route, {
    String email = '',
    String code = '',
  }) async {
    logins++;
    this.route = route;
    submittedEmail = email;
    submittedCode = code;
    if (loginFailure != null) throw loginFailure!;
    await pendingLogin?.future;
  }

  @override
  Future<void> loginWithAccount({
    required String account,
    required String password,
  }) => _login('account', email: account);
  @override
  Future<void> loginWithEmailPassword({
    required String email,
    required String password,
  }) => _login('email-password', email: email);
  @override
  Future<void> loginWithEmailCode({
    required EmailAuthChallenge challenge,
    required String code,
  }) => _login('code', email: challenge.email, code: code);
  @override
  Future<void> registerWithEmail({
    required EmailAuthChallenge challenge,
    required String code,
    required String password,
    required Map<String, String> consents,
    String displayName = '',
  }) {
    this.consents = consents;
    return _login('register', email: challenge.email, code: code);
  }

  @override
  Future<void> resetPasswordWithEmail({
    required EmailAuthChallenge challenge,
    required String code,
    required String newPassword,
  }) async {
    resets++;
  }

  @override
  void dispose() {
    api.client.close();
    super.dispose();
  }
}

Future<void> _mount(
  WidgetTester tester,
  _AuthState state, {
  double width = 390,
  bool english = false,
}) async {
  tester.view.physicalSize = Size(width, 844);
  tester.view.devicePixelRatio = 1;
  final prefs = MobileDisplayPreferences(persist: false)
    ..language = english ? MobileLanguage.english : MobileLanguage.chinese;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
    prefs.dispose();
    state.dispose();
  });
  await tester.pumpWidget(_app(state, prefs));
  await tester.pumpAndSettle();
}

Widget _app(_AuthState state, MobileDisplayPreferences prefs) => MobileScope(
  state: state,
  child: MobileDisplayScope(
    preferences: prefs,
    child: MaterialApp(
      theme: SoduWorkTheme.light(),
      home: Scaffold(body: AccountSignInForm(state: state)),
    ),
  ),
);
Finder _key(String key) => find.byKey(Key(key));
Future<void> _tap(WidgetTester tester, Finder target) async {
  tester.testTextInput.hide();
  await tester.ensureVisible(target);
  await tester.tap(target);
  await tester.pumpAndSettle();
}

Future<void> _email(WidgetTester tester, {String mode = '验证码登录'}) async {
  await _tap(tester, find.text(mode));
  await tester.enterText(_key('auth-account'), 'worker@example.com');
  await _tap(tester, find.text('获取验证码'));
}

String _value(WidgetTester tester, String key) =>
    tester.widget<TextField>(_key(key)).controller!.text;

void main() {
  for (final english in [false, true]) {
    testWidgets(
      'local login explains storage and legacy registration at 320 english=$english',
      (tester) async {
        final state = _AuthState()
          ..policy = const ClientAuthPolicy(allowSelfRegistration: true);
        state.endpoint = const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'http://192.0.2.155:18893',
        );
        state.api.client.close();
        state.api = SoduWorkApi(
          store: state.store,
          endpoint: state.endpoint,
          deviceDisplayName: 'SoduWork Web 联调',
        );
        await _mount(tester, state, width: 320, english: english);
        expect(_key('auth-local-environment'), findsOneWidget);
        expect(
          find.text(english ? 'Local test account' : '本机测试账号'),
          findsOneWidget,
        );
        expect(
          find.textContaining(
            english ? 'does not sync with your online account' : '不与线上账号数据同步',
          ),
          findsOneWidget,
        );
        expect(
          find.textContaining(
            english ? 'does not verify your online identity' : '不代表已验证线上身份',
          ),
          findsOneWidget,
        );
        await tester.enterText(_key('auth-account'), 'local-test');
        await tester.enterText(_key('auth-password'), 'sample-password');
        await _tap(tester, _key('auth-submit'));
        expect(state.route, 'account');
        expect(state.logins, 1);
        expect(tester.takeException(), isNull);
      },
    );
  }
  testWidgets('ordinary LAN service is not labeled as isolated local testing', (
    tester,
  ) async {
    final state = _AuthState();
    state.endpoint = const EndpointSettings(
      environment: SoduWorkEnvironment.development,
      baseUrl: 'http://192.0.2.155:18893',
    );
    state.api.client.close();
    state.api = SoduWorkApi(store: state.store, endpoint: state.endpoint);
    await _mount(tester, state);
    expect(_key('auth-local-environment'), findsNothing);
    expect(find.textContaining('不代表已验证线上身份'), findsNothing);
  });
  testWidgets(
    'modern local authentication does not claim automatic registration',
    (tester) async {
      final state = _AuthState();
      state.endpoint = const EndpointSettings(
        environment: SoduWorkEnvironment.development,
        baseUrl: 'http://127.0.0.1:18893',
      );
      state.api.client.close();
      state.api = SoduWorkApi(
        store: state.store,
        endpoint: state.endpoint,
        deviceDisplayName: 'SoduWork Web 联调',
      );
      await _mount(tester, state);
      expect(_key('auth-local-environment'), findsOneWidget);
      expect(find.textContaining('不代表已验证线上身份'), findsNothing);
      expect(state.logins, 0);
    },
  );
  testWidgets('late password response does not touch a disposed sign-in form', (
    tester,
  ) async {
    final state = _AuthState()..pendingLogin = Completer<void>();
    await _mount(tester, state);
    await tester.enterText(_key('auth-account'), 'worker@example.com');
    await tester.enterText(_key('auth-password'), 'sample-password');
    await tester.ensureVisible(_key('auth-submit'));
    await tester.tap(_key('auth-submit'));
    await tester.pump();
    expect(state.logins, 1);
    await tester.pumpWidget(const SizedBox());
    state.pendingLogin!.complete();
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
  testWidgets(
    'unavailable policy preserves password login and disables code delivery',
    (tester) async {
      final state = _AuthState()..policyFailure = const ApiFailure('offline');
      await _mount(tester, state);
      await tester.enterText(_key('auth-account'), 'worker@example.com');
      await tester.enterText(_key('auth-password'), 'sample-password');
      await _tap(tester, _key('auth-submit'));
      expect(state.route, 'account');
      await _tap(tester, find.text('验证码登录'));
      expect(find.text('暂时无法读取登录选项，你仍可使用账号密码。'), findsOneWidget);
      expect(
        tester
            .widget<OutlinedButton>(
              find.widgetWithText(OutlinedButton, '获取验证码'),
            )
            .onPressed,
        isNull,
      );
      expect(state.codeRequests, 0);
    },
  );

  testWidgets(
    'mail unavailable disables registration and code but supports email password',
    (tester) async {
      final state = _AuthState()
        ..policy = const ClientAuthPolicy(
          supportsEmail: true,
          mailReady: false,
          allowSelfRegistration: true,
        );
      await _mount(tester, state);
      await tester.enterText(_key('auth-account'), 'worker@example.com');
      await tester.enterText(_key('auth-password'), 'sample-password');
      await _tap(tester, _key('auth-submit'));
      expect(state.route, 'email-password');
      await _tap(tester, find.text('创建账号'));
      expect(
        tester.widget<FilledButton>(_key('auth-submit')).onPressed,
        isNull,
      );
      expect(
        tester
            .widget<OutlinedButton>(
              find.widgetWithText(OutlinedButton, '获取验证码'),
            )
            .onPressed,
        isNull,
      );
      expect(state.codeRequests, 0);
    },
  );

  testWidgets('mode and email changes discard proofs and secrets', (
    tester,
  ) async {
    final state = _AuthState();
    await _mount(tester, state);
    await tester.enterText(_key('auth-password'), 'sample-password');
    await _email(tester);
    await tester.enterText(_key('auth-code'), '123456');
    await tester.enterText(_key('auth-account'), 'other@example.com');
    expect(_value(tester, 'auth-code'), isEmpty);
    await tester.enterText(_key('auth-code'), '123456');
    await _tap(tester, _key('auth-submit'));
    expect(state.logins, 0);
    await _tap(tester, find.text('密码登录'));
    expect(_value(tester, 'auth-password'), isEmpty);
    expect(find.byKey(const Key('auth-code')), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'invalid code retries same proof and successful login clears secret fields',
    (tester) async {
      final state = _AuthState()
        ..loginFailure = const ApiFailure('验证码不正确', status: 401);
      await _mount(tester, state);
      await _email(tester);
      expect(find.text('验证码已发送，请检查邮箱。'), findsOneWidget);
      await tester.enterText(_key('auth-code'), '000000');
      await _tap(tester, _key('auth-submit'));
      expect(find.text('验证码不正确'), findsOneWidget);
      state.loginFailure = null;
      await tester.enterText(_key('auth-code'), '123456');
      await _tap(tester, _key('auth-submit'));
      expect(state.logins, 2);
      expect(state.codeRequests, 1);
      expect(state.submittedCode, '123456');
      expect(_value(tester, 'auth-code'), isEmpty);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('expired challenge cannot submit', (tester) async {
    final state = _AuthState()..expired = true;
    await _mount(tester, state);
    await _email(tester);
    expect(find.text('验证码已过期，请重新获取。'), findsOneWidget);
    await tester.enterText(_key('auth-code'), '123456');
    await _tap(tester, _key('auth-submit'));
    expect(state.logins, 0);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'registration requires consent and displays actual legal content',
    (tester) async {
      final state = _AuthState();
      await _mount(tester, state);
      await _email(tester, mode: '创建账号');
      expect(state.purpose, 'register');
      await tester.enterText(_key('auth-code'), '123456');
      await tester.enterText(_key('auth-password'), 'long-password');
      await tester.enterText(_key('auth-confirm-password'), 'long-password');
      await _tap(tester, _key('auth-submit'));
      expect(state.logins, 0);
      expect(find.text('请阅读并同意用户协议与隐私政策。'), findsOneWidget);
      await _tap(tester, find.widgetWithText(TextButton, '用户协议'));
      expect(
        find.text('Actual terms supplied by the workspace.'),
        findsOneWidget,
      );
      expect(find.text('terms-v2'), findsOneWidget);
      await _tap(tester, find.byTooltip('关闭'));
      await _tap(tester, find.byType(CheckboxListTile));
      await _tap(tester, _key('auth-submit'));
      expect(state.route, 'register');
      expect(state.consents, {'terms': 'terms-v2', 'privacy': 'privacy-v3'});
      expect(_value(tester, 'auth-password'), isEmpty);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'reset returns to password login with no saved password or automatic login',
    (tester) async {
      final state = _AuthState();
      await _mount(tester, state);
      await _email(tester, mode: '忘记密码');
      expect(state.purpose, 'reset_password');
      await tester.enterText(_key('auth-code'), '123456');
      await tester.enterText(_key('auth-password'), 'new-password');
      await tester.enterText(_key('auth-confirm-password'), 'new-password');
      await _tap(tester, _key('auth-submit'));
      expect(state.resets, 1);
      expect(state.logins, 0);
      expect(find.text('密码已更新，请使用新密码登录。'), findsOneWidget);
      expect(_value(tester, 'auth-password'), isEmpty);
      expect(find.byKey(const Key('auth-code')), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    '429 resend countdown becomes available without another user action',
    (tester) async {
      final state = _AuthState()
        ..codeFailure = const ApiFailure('稍后再试', status: 429, retryAfter: 2);
      await _mount(tester, state);
      await _email(tester);
      final button = find.byType(OutlinedButton);
      expect(tester.widget<OutlinedButton>(button).onPressed, isNull);
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 2200)),
      );
      await tester.pump(const Duration(seconds: 3));
      expect(tester.widget<OutlinedButton>(button).onPressed, isNotNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'same state with a changed endpoint refreshes policy and discards old code',
    (tester) async {
      final state = _AuthState();
      await _mount(tester, state);
      await _email(tester);
      await tester.enterText(_key('auth-code'), '123456');
      state.endpoint = const EndpointSettings(
        environment: SoduWorkEnvironment.development,
        baseUrl: 'https://second.test',
      );
      // Rebuild the existing form element, as the host does on endpoint changes.
      final form = tester.element(find.byType(AccountSignInForm));
      await tester.pumpWidget(_app(state, MobileDisplayScope.maybeOf(form)!));
      await tester.pumpAndSettle();
      expect(state.policyReads, 2);
      expect(_value(tester, 'auth-code'), isEmpty);
      await tester.pumpWidget(const SizedBox());
    },
  );

  for (final width in [320.0, 390.0]) {
    for (final english in [false, true]) {
      testWidgets('all auth modes fit $width pixels english=$english', (
        tester,
      ) async {
        await _mount(tester, _AuthState(), width: width, english: english);
        for (final label
            in english
                ? [
                    'Email code',
                    'Create account',
                    'Back to sign in',
                    'Forgot password?',
                  ]
                : ['验证码登录', '创建账号', '返回登录', '忘记密码']) {
          await _tap(tester, find.widgetWithText(TextButton, label));
          expect(tester.takeException(), isNull);
        }
      });
    }
  }
}
