import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/screens/settings_sheet.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/mobile_display_preferences.dart';
import 'package:soduwork_mobile/ui/mobile_sheet.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';

void main() {
  testWidgets(
    'English settings preserve account data and translate account controls',
    (tester) async {
      final state = _State(), prefs = MobileDisplayPreferences(persist: false);
      addTearDown(state.dispose);
      addTearDown(prefs.dispose);
      await prefs.update(language: MobileLanguage.english);
      await _sheet(tester, state, prefs);
      expect(find.text('移动测试用户'), findsWidgets);
      expect(find.text('mobile_test'), findsWidgets);
      expect(find.text('Account information'), findsOneWidget);
      expect(find.text('Switch account'), findsOneWidget);
      await tester.scrollUntilVisible(
        find.text('Language'),
        180,
        scrollable: find
            .descendant(
              of: find.byType(SettingsSheet),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      expect(find.text('Appearance'), findsOneWidget);
      await tester.scrollUntilVisible(
        find.textContaining('The interface language applies'),
        120,
        scrollable: find
            .descendant(
              of: find.byType(SettingsSheet),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      expect(
        find.textContaining(
          'Your content, plugin descriptions and server messages',
        ),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('English settings invalidate old account actions immediately', (
    tester,
  ) async {
    final state = _State(), prefs = MobileDisplayPreferences(persist: false);
    addTearDown(state.dispose);
    addTearDown(prefs.dispose);
    await prefs.update(language: MobileLanguage.english);
    await _sheet(tester, state, prefs);
    state.changeIdentity();
    await tester.pumpAndSettle();
    expect(
      find.text('Your account changed. Close and reopen this panel.'),
      findsOneWidget,
    );
    expect(find.text('mobile_test'), findsNothing);
    expect(find.text('Switch account'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('English account loading errors retain an actionable retry', (
    tester,
  ) async {
    final state = _State(), prefs = MobileDisplayPreferences(persist: false);
    addTearDown(state.dispose);
    addTearDown(prefs.dispose);
    await prefs.update(language: MobileLanguage.english);
    state.fake.profile = {
      'user': {'id': 'different', 'username': 'do-not-show'},
    };
    await _sheet(tester, state, prefs);
    expect(find.text('Account information is unavailable'), findsOneWidget);
    expect(find.text('do-not-show'), findsNothing);
    state.fake.profile = {
      'user': {'id': 'alice', 'username': 'recovered-account'},
    };
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(find.text('recovered-account'), findsWidgets);
    expect(find.text('Account information is unavailable'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}

Future<void> _sheet(
  WidgetTester tester,
  _State state,
  MobileDisplayPreferences prefs, {
  bool settle = true,
  TextEditingController? draft,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: SoduWorkTheme.light(),
      home: MobileScope(
        state: state,
        child: MobileDisplayScope(
          preferences: prefs,
          child: Builder(
            builder: (context) => Scaffold(
              body: Column(
                children: [
                  if (draft != null) TextField(controller: draft),
                  TextButton(
                    onPressed: () => showMobileSheet<void>(
                      context,
                      builder: (_, scroll) => SettingsSheet(
                        scrollController: scroll,
                        preferences: prefs,
                        onResource: (_) {},
                      ),
                    ),
                    child: const Text('open settings'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open settings'));
  if (settle) {
    await tester.pumpAndSettle();
  } else {
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
  }
}

class _State extends MobileState {
  final fake = _Api();
  int revision = 1;
  _State() {
    api = fake;
    endpoint = fake.endpoint;
    phase = MobilePhase.ready;
    enrollment = const EnrollmentState(
      active: true,
      deviceId: 'phone',
      deviceName: '测试手机',
      authState: 'active',
      ownerUserId: 'alice',
    );
  }
  @override
  int get identityRevision => revision;
  void changeIdentity() {
    revision++;
    notifyListeners();
  }
}

class _Api extends SoduWorkApi {
  Map<String, dynamic> profile = {
    'user': {'id': 'alice', 'username': 'mobile_test', 'displayName': '移动测试用户'},
    'quota': {'enabled': true, 'limit': 1000, 'used': 20},
  };
  Future<Map<String, dynamic>>? pending;
  _Api()
    : super(
        store: DeviceStore(),
        endpoint: const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'https://fixture.invalid',
        ),
      );
  @override
  Future<Map<String, dynamic>> currentAccount() async =>
      pending == null ? profile : await pending!;
}
