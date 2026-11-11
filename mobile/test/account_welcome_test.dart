import 'package:soduwork_mobile/core/device_store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/screens/account_welcome.dart';
import 'package:soduwork_mobile/screens/account_sign_in_form.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/mobile_display_preferences.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';

class _State extends MobileState {
  int reads = 0;
  _State() {
    endpoint = const EndpointSettings(
      environment: SoduWorkEnvironment.development,
      baseUrl: 'https://fixture.invalid',
    );
    api = SoduWorkApi(store: store, endpoint: endpoint);
    phase = MobilePhase.pendingActivation;
  }
  @override
  Future<ClientAuthPolicy> authenticationPolicy() async {
    reads++;
    return const ClientAuthPolicy();
  }
}

void main() {
  testWidgets(
    'welcome loops through another cycle without stopping on the last phrase',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(home: Scaffold(body: AccountWelcomeStory())),
      );
      expect(find.byKey(const Key('welcome-story-dot')), findsOneWidget);
      await tester.pump(const Duration(milliseconds: 800));
      expect(find.text('整理想法'), findsOneWidget);
      await tester.pump(const Duration(seconds: 3));
      expect(find.text('推进工作'), findsOneWidget);
      await tester.pump(const Duration(seconds: 3));
      expect(find.text('交付成果'), findsOneWidget);
      await tester.pump(const Duration(seconds: 3));
      expect(find.text('开始吧'), findsOneWidget);
      await tester.pump(const Duration(milliseconds: 2100));
      expect(
        tester.widget<Text>(find.byKey(const Key('welcome-story-text'))).data,
        isEmpty,
      );
      await tester.pump(const Duration(milliseconds: 900));
      expect(find.text('整理想法'), findsOneWidget);
      await tester.pump(const Duration(seconds: 3));
      expect(find.text('推进工作'), findsOneWidget);
      expect(tester.binding.hasScheduledFrame, isTrue);
    },
  );
  testWidgets(
    'reduced motion shows a static complete phrase without a ticker',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: MediaQuery(
            data: const MediaQueryData(disableAnimations: true),
            child: Scaffold(body: AccountWelcomeStory()),
          ),
        ),
      );
      expect(find.text('开始吧'), findsOneWidget);
      await tester.pumpAndSettle();
      expect(tester.binding.hasScheduledFrame, isFalse);
    },
  );
  testWidgets(
    'story pauses behind the form and while the app is backgrounded',
    (tester) async {
      final active = ValueNotifier(true);
      addTearDown(active.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: ValueListenableBuilder<bool>(
            valueListenable: active,
            builder: (_, value, child) =>
                Scaffold(body: AccountWelcomeStory(active: value)),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 400));
      String text() => tester
          .widget<Text>(find.byKey(const Key('welcome-story-text')))
          .data!;
      active.value = false;
      await tester.pump();
      final paused = text();
      await tester.pump(const Duration(seconds: 6));
      expect(text(), paused);
      active.value = true;
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
      expect(text(), '整理想法');
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      final background = text();
      await tester.pump(const Duration(seconds: 4));
      expect(text(), background);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      await tester.pump(const Duration(seconds: 3));
      expect(text(), '推进工作');
      active.value = false;
      await tester.pumpAndSettle();
      expect(tester.binding.hasScheduledFrame, isFalse);
    },
  );
  for (final english in [false, true]) {
    for (final width in [320.0, 390.0]) {
      testWidgets(
        'welcome opens real sign-in and registration without stacking at $width English=$english',
        (tester) async {
          tester.view.physicalSize = Size(width, 740);
          tester.view.devicePixelRatio = 1;
          addTearDown(tester.view.resetPhysicalSize);
          addTearDown(tester.view.resetDevicePixelRatio);
          final state = _State();
          final prefs = MobileDisplayPreferences(persist: false);
          addTearDown(state.dispose);
          addTearDown(prefs.dispose);
          if (english) await prefs.update(language: MobileLanguage.english);
          await tester.pumpWidget(
            MaterialApp(
              theme: SoduWorkTheme.light(),
              home: MobileScope(
                state: state,
                child: MobileDisplayScope(
                  preferences: prefs,
                  child: Scaffold(
                    body: SafeArea(child: AccountWelcome(state: state)),
                  ),
                ),
              ),
            ),
          );
          await tester.pump(const Duration(milliseconds: 120));
          expect(state.reads, 0);
          expect(find.byType(TextField), findsNothing);
          await tester.tap(find.byKey(const Key('welcome-sign-in')));
          await tester.pumpAndSettle();
          expect(find.byType(AccountSignInForm), findsOneWidget);
          expect(
            tester.getCenter(find.byKey(const Key('close-account-form'))).dx,
            greaterThan(width - 50),
          );
          expect(
            find.text(english ? 'Sign in to SoduWork' : '登录 SoduWork'),
            findsOneWidget,
          );
          await tester.enterText(
            find.byKey(const Key('auth-account')),
            'private-user',
          );
          await tester.tap(find.byKey(const Key('close-account-form')));
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 400));
          expect(find.byType(AccountSignInForm), findsNothing);
          await tester.tap(find.byKey(const Key('welcome-register')));
          await tester.pumpAndSettle();
          expect(
            find.text(english ? 'Create your account' : '创建你的账号'),
            findsOneWidget,
          );
          expect(find.text('private-user'), findsNothing);
          expect(state.reads, 2);
          await tester.binding.handlePopRoute();
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 400));
          expect(find.byType(AccountSignInForm), findsNothing);
          expect(find.byKey(const Key('welcome-sign-in')), findsOneWidget);
          await tester.tap(find.byKey(const Key('welcome-sign-in')));
          await tester.pumpAndSettle();
          await tester.dragFrom(Offset(width / 2, 36), const Offset(0, 100));
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 400));
          expect(find.byType(AccountSignInForm), findsNothing);
          expect(tester.takeException(), isNull);
        },
      );
    }
  }
}
