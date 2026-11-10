import 'package:shared_preferences/shared_preferences.dart';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/models/work_models.dart';
import 'package:soduwork_mobile/sdk/soduwork_brand.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/automation_editor.dart';
import 'package:soduwork_mobile/ui/mobile_display_preferences.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';
import 'package:soduwork_mobile/ui/work_widgets.dart';

import 'memory_device_auth.dart';

void main() {
  test(
    'primary actions retain readable contrast across light and dark accents',
    () async {
      final preferences = MobileDisplayPreferences(persist: false);
      addTearDown(preferences.dispose);
      for (final accent in ['brand', 'neutral', 'blue', 'green']) {
        await preferences.update(accent: accent);
        for (final brightness in Brightness.values) {
          final brand = preferences.apply(const SoduWorkBrandTheme(), brightness);
          final background = brand.primary.computeLuminance();
          final foreground = SoduWorkTheme.readableOn(
            brand.primary,
          ).computeLuminance();
          final contrast = background > foreground
              ? (background + .05) / (foreground + .05)
              : (foreground + .05) / (background + .05);
          expect(
            contrast,
            greaterThanOrEqualTo(4.5),
            reason: '$accent $brightness',
          );
        }
      }
    },
  );

  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'fresh storage uses brand accent and preserves an explicit older choice',
    () async {
      SharedPreferences.setMockInitialValues({});
      final fresh = MobileDisplayPreferences();
      await fresh.restore();
      expect(fresh.accent, 'brand');
      fresh.dispose();
      SharedPreferences.setMockInitialValues({
        'soduwork_mobile.accent': 'neutral',
      });
      final existing = MobileDisplayPreferences();
      await existing.restore();
      expect(existing.accent, 'neutral');
      existing.dispose();
    },
  );

  testWidgets(
    'language updates fixed UI while preserving task titles and values',
    (tester) async {
      final preferences = MobileDisplayPreferences(persist: false);
      addTearDown(preferences.dispose);
      await tester.pumpWidget(
        _app(
          preferences,
          Builder(
            builder: (context) => Column(
              children: [
                Text(mobileText(context, '新建项目')),
                TaskRow(
                  task: WorkTask.fromJson({
                    'id': 'task',
                    'title': '新建项目',
                    'status': 'done',
                  }),
                ),
                StatePill.task(
                  context,
                  WorkTask.fromJson({
                    'id': 'task',
                    'title': '设置',
                    'status': 'done',
                  }),
                ),
                Text(mobileText(context, '{0} 条未读消息', values: ['设置{1}'])),
              ],
            ),
          ),
        ),
      );
      expect(find.text('新建项目'), findsNWidgets(2));
      await preferences.update(language: MobileLanguage.english);
      await tester.pump();
      expect(find.text('New project'), findsOneWidget);
      expect(find.text('新建项目'), findsOneWidget);
      expect(find.text('Completed'), findsWidgets);
      expect(find.text('设置{1} unread messages'), findsOneWidget);
      await preferences.update(language: MobileLanguage.chinese);
      await tester.pump();
      expect(find.text('新建项目'), findsNWidgets(2));
      expect(find.text('设置{1} 条未读消息'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('template parameters and unknown content remain verbatim', (
    tester,
  ) async {
    final preferences = MobileDisplayPreferences(persist: false);
    await preferences.update(language: MobileLanguage.english);
    addTearDown(preferences.dispose);
    await tester.pumpWidget(
      _app(
        preferences,
        Builder(
          builder: (context) => Column(
            children: [
              Text(mobileText(context, '{0} · {1} 份证据', values: ['中文文件.md'])),
              Text(mobileText(context, '插件作者自己的说明')),
              Text(
                formatRelativeTime(
                  DateTime.now().subtract(const Duration(minutes: 8)),
                  context: context,
                ),
              ),
            ],
          ),
        ),
      ),
    );
    expect(find.text('中文文件.md · {1} evidence items'), findsOneWidget);
    expect(find.text('插件作者自己的说明'), findsOneWidget);
    expect(find.text('8 min ago'), findsOneWidget);
  });

  testWidgets(
    'English automation editor has translated frequency weekdays and validation on narrow screens',
    (tester) async {
      tester.view.physicalSize = const Size(360, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final preferences = MobileDisplayPreferences(persist: false);
      await preferences.update(language: MobileLanguage.english);
      final state = _State();
      addTearDown(preferences.dispose);
      addTearDown(state.dispose);
      await tester.pumpWidget(
        MobileScope(
          state: state,
          child: _app(preferences, const AutomationEditor()),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Schedule name'), findsOneWidget);
      await tester.tap(find.text('Daily'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Weekly').last);
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.text('Monday'),
        150,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.text('Monday'), findsOneWidget);
      await tester.tap(find.text('Monday'));
      await tester.pumpAndSettle();
      expect(find.text('Sunday'), findsOneWidget);
      await tester.tap(find.text('Sunday'));
      await tester.pumpAndSettle();
      final form = tester.state<FormState>(find.byType(Form));
      expect(form.validate(), isFalse);
      await tester.pump();
      await tester.scrollUntilVisible(
        find.byKey(const Key('automation-title')),
        -200,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.text('Enter a schedule name'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  test(
    'brand and saved neutral accents use matching foreground and soft colors',
    () async {
      final preferences = MobileDisplayPreferences(persist: false);
      addTearDown(preferences.dispose);
      expect(preferences.accent, 'brand');
      expect(
        preferences.apply(const SoduWorkBrandTheme(), Brightness.light).primary,
        const Color(0xFF7153A6),
      );
      expect(
        preferences.apply(const SoduWorkBrandTheme(), Brightness.dark).primary,
        const Color(0xFFBFA3EA),
      );
      await preferences.update(accent: 'neutral');
      final neutral = preferences.apply(
        const SoduWorkBrandTheme(),
        Brightness.light,
      );
      expect(neutral.primary, neutral.ink);
      await preferences.update(accent: 'blue');
      final blue = preferences.apply(const SoduWorkBrandTheme(), Brightness.light);
      expect(
        blue.primarySoft,
        Color.alphaBlend(blue.primary.withValues(alpha: 0.10), blue.surface),
      );
    },
  );
}

Widget _app(MobileDisplayPreferences preferences, Widget child) =>
    MobileDisplayScope(
      preferences: preferences,
      child: MaterialApp(
        theme: SoduWorkTheme.light(const SoduWorkBrandTheme()),
        home: Scaffold(body: child),
      ),
    );

class _State extends MobileState {
  _State() {
    api = _Api(
      store: _Store(),
      endpoint: const EndpointSettings(
        environment: SoduWorkEnvironment.development,
        baseUrl: 'https://hub.test',
      ),
      client: MockClient(
        (request) async => http.Response(
          jsonEncode({
            'substrates': [
              {'key': 'local:pi', 'name': 'Pi', 'available': true},
            ],
          }),
          200,
          headers: {'content-type': 'application/json; charset=utf-8'},
        ),
      ),
    );
  }
}

class _Store extends DeviceStore with MemoryDeviceAuthentication {
  @override
  Future<String?> readSession(String endpoint) async => 'fixture-session';
}

class _Api extends SoduWorkApi {
  _Api({required super.store, required super.endpoint, required super.client});
  @override
  Future<Map<String, dynamic>> cloudConversationTargets() async => {
    'targets': [],
  };
}
