import 'dart:async';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/models/work_models.dart';
import 'package:soduwork_mobile/screens/conversation_search.dart';
import 'package:soduwork_mobile/screens/settings_sheet.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/adaptive_conversation_input.dart';
import 'package:soduwork_mobile/ui/mobile_display_preferences.dart';
import 'package:soduwork_mobile/ui/mobile_sheet.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';

void main() {
  for (final width in [320.0, 390.0]) {
    for (final work in [false, true]) {
      for (final scale in [1.0, 1.8]) {
        testWidgets(
          'input starts on one row and follows the correct focus mode at $width work=$work scale=$scale',
          (tester) async {
            tester.view.physicalSize = Size(width, 844);
            tester.view.devicePixelRatio = 1;
            addTearDown(tester.view.resetPhysicalSize);
            addTearDown(tester.view.resetDevicePixelRatio);
            addTearDown(tester.view.resetViewInsets);
            final text = TextEditingController(), focus = FocusNode();
            addTearDown(text.dispose);
            addTearDown(focus.dispose);
            await tester.pumpWidget(
              MaterialApp(
                theme: SoduWorkTheme.light(),
                builder: (context, child) => MediaQuery(
                  data: MediaQuery.of(
                    context,
                  ).copyWith(textScaler: TextScaler.linear(scale)),
                  child: child!,
                ),
                home: Scaffold(
                  body: Align(
                    alignment: Alignment.bottomCenter,
                    child: AdaptiveConversationInput(
                      controller: text,
                      focusNode: focus,
                      workMode: work,
                      voiceScopeKey: 'layout',
                      hint: '有问题，尽管问',
                      inputKey: const Key('input'),
                      onChanged: (_) {},
                      onTranscript: (_) {},
                      add: IconButton(
                        key: const Key('add'),
                        onPressed: () {},
                        icon: const Icon(CupertinoIcons.plus),
                      ),
                      model: TextButton(
                        onPressed: () {},
                        child: const Text('model-fixture'),
                      ),
                      send: IconButton(
                        key: const Key('send'),
                        onPressed: () {},
                        icon: const Icon(CupertinoIcons.arrow_up),
                      ),
                    ),
                  ),
                ),
              ),
            );
            final field = find.byKey(const Key('input')),
                surface = find.byType(AdaptiveConversationInput);
            final idle = tester.getSize(surface).height;
            expect(idle, lessThanOrEqualTo(scale > 1 ? 78 : 60));
            expect(
              tester.getCenter(field).dy,
              closeTo(tester.getCenter(find.byKey(const Key('add'))).dy, 1),
            );
            expect(find.text('model-fixture'), findsNothing);
            await tester.tap(field);
            await tester.pumpAndSettle();
            expect(focus.hasFocus, isTrue);
            tester.view.viewInsets = const FakeViewPadding(bottom: 300);
            await tester.pumpAndSettle();
            expect(
              tester.getBottomLeft(find.byKey(const Key('send'))).dy,
              lessThanOrEqualTo(544),
            );
            expect(focus.hasFocus, isTrue);
            if (work) {
              expect(tester.getSize(surface).height, greaterThan(idle + 30));
              expect(find.text('model-fixture'), findsOneWidget);
              expect(
                tester.getBottomLeft(field).dy,
                lessThanOrEqualTo(
                  tester.getTopLeft(find.byKey(const Key('add'))).dy + 1,
                ),
              );
            } else {
              expect(tester.getSize(surface).height, closeTo(idle, 1));
            }
            await tester.enterText(field, '保留这份草稿');
            await tester.pumpAndSettle();
            focus.unfocus();
            await tester.pumpAndSettle();
            expect(text.text, '保留这份草稿');
            expect(tester.takeException(), isNull);
            await tester.pumpWidget(const SizedBox.shrink());
          },
        );
      }
    }
  }

  testWidgets(
    'settings shows the verified current account and updates appearance and language in place',
    (tester) async {
      final state = _State(), prefs = MobileDisplayPreferences(persist: false);
      addTearDown(state.dispose);
      addTearDown(prefs.dispose);
      await _sheet(tester, state, prefs);
      expect(find.text('mobile_test'), findsWidgets);
      expect(find.text('移动测试用户'), findsWidgets);
      expect(find.byType(BackButton), findsNothing);
      await tester.scrollUntilVisible(
        find.text('外观'),
        180,
        scrollable: find
            .descendant(
              of: find.byType(SettingsSheet),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('外观'));
      await tester.pumpAndSettle();
      expect(
        find.byType(PopupMenuItem<MobileAppearanceMode>),
        findsNWidgets(3),
      );
      await tester.tap(find.text('深色'));
      await tester.pumpAndSettle();
      expect(prefs.appearance, MobileAppearanceMode.dark);
      expect(
        Theme.of(tester.element(find.byType(SettingsSheet))).brightness,
        Brightness.dark,
      );
      await tester.ensureVisible(find.text('语言'));
      await tester.tap(find.text('语言'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('English'));
      await tester.pumpAndSettle();
      expect(prefs.language, MobileLanguage.english);
      expect(find.text('Appearance'), findsOneWidget);
      await tester.drag(
        find.descendant(
          of: find.byType(SettingsSheet),
          matching: find.byType(ListView),
        ),
        const Offset(0, 700),
      );
      await tester.pumpAndSettle();
      expect(find.text('Account information'), findsOneWidget);
      expect(find.text('mobile_test'), findsWidgets);
      await tester.tap(find.byTooltip('Close'));
      await tester.pumpAndSettle();
      expect(find.byType(SettingsSheet), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'a settings response for a different account is never displayed',
    (tester) async {
      final state = _State(), prefs = MobileDisplayPreferences(persist: false);
      addTearDown(state.dispose);
      addTearDown(prefs.dispose);
      state.fake.profile = {
        'user': {'id': 'someone-else', 'username': 'private-other-account'},
      };
      await _sheet(tester, state, prefs);
      expect(find.text('private-other-account'), findsNothing);
      expect(find.text('账号资料暂时无法读取'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'identity switching rejects a late profile and disables the old settings',
    (tester) async {
      final state = _State(),
          prefs = MobileDisplayPreferences(persist: false),
          pending = Completer<Map<String, dynamic>>();
      addTearDown(state.dispose);
      addTearDown(prefs.dispose);
      state.fake.pending = pending.future;
      await _sheet(tester, state, prefs, settle: false);
      state.changeIdentity();
      await tester.pump();
      pending.complete({
        'user': {'id': 'alice', 'username': 'late-private-account'},
      });
      await tester.pumpAndSettle();
      expect(find.text('late-private-account'), findsNothing);
      expect(find.text('账号已变化，请关闭后重新打开。'), findsOneWidget);
      expect(find.text('退出当前账号'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'settings can be dragged down to return to the same underlying draft',
    (tester) async {
      final state = _State(),
          prefs = MobileDisplayPreferences(persist: false),
          draft = TextEditingController(text: 'underlying draft');
      addTearDown(state.dispose);
      addTearDown(prefs.dispose);
      addTearDown(draft.dispose);
      await _sheet(tester, state, prefs, draft: draft);
      final top = tester.getTopLeft(find.byType(DraggableScrollableSheet));
      await tester.dragFrom(Offset(220, top.dy + 14), const Offset(0, 700));
      await tester.pumpAndSettle();
      expect(find.byType(SettingsSheet), findsNothing);
      expect(draft.text, 'underlying draft');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'search filters chats and work, excludes another account and returns the selected item',
    (tester) async {
      final state = _State();
      addTearDown(state.dispose);
      state.tasks = [
        WorkTask.fromJson({
          'id': 'own',
          'title': '我的聊天',
          'note': '客户报价方案',
          'origin': 'cloud-conversation',
          'createdBy': 'alice',
        }),
        WorkTask.fromJson({
          'id': 'other',
          'title': '其他账号报价秘密',
          'origin': 'cloud-conversation',
          'createdBy': 'bob',
        }),
        WorkTask.fromJson({'id': 'work', 'title': '报价工作', 'origin': 'manual'}),
      ];
      ConversationSearchSelection? selected;
      await tester.pumpWidget(
        MaterialApp(
          theme: SoduWorkTheme.light(),
          home: MobileScope(
            state: state,
            child: Builder(
              builder: (context) => TextButton(
                onPressed: () async {
                  selected = await showConversationSearch(context);
                },
                child: const Text('open search'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open search'));
      await tester.pumpAndSettle();
      expect(find.text('搜索工作会话'), findsOneWidget);
      final input = find.byKey(const Key('conversation-search-input'));
      expect(tester.widget<TextField>(input).focusNode!.hasFocus, isTrue);
      await tester.enterText(input, '报价');
      await tester.pumpAndSettle();
      expect(find.text('我的聊天'), findsOneWidget);
      expect(find.text('报价工作'), findsOneWidget);
      expect(find.text('其他账号报价秘密'), findsNothing);
      await tester.tap(find.text('会话'));
      await tester.pumpAndSettle();
      expect(find.text('报价工作'), findsNothing);
      await tester.tap(find.text('我的聊天'));
      await tester.pumpAndSettle();
      expect(selected!.task!.task.id, 'own');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'search has a real no-result state and an explicit new-chat action',
    (tester) async {
      final state = _State();
      addTearDown(state.dispose);
      ConversationSearchSelection? selected;
      await tester.pumpWidget(
        MaterialApp(
          theme: SoduWorkTheme.light(),
          home: MobileScope(
            state: state,
            child: Builder(
              builder: (context) => TextButton(
                onPressed: () async {
                  selected = await showConversationSearch(context);
                },
                child: const Text('open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('conversation-search-input')),
        '没有这个内容',
      );
      await tester.pumpAndSettle();
      expect(find.text('无结果'), findsOneWidget);
      await tester.tap(find.text('新对话'));
      await tester.pumpAndSettle();
      expect(selected!.newChat, isTrue);
      expect(tester.takeException(), isNull);
    },
  );

  test(
    'presentation settings persist without any account or authentication data',
    () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = MobileDisplayPreferences();
      await prefs.update(
        appearance: MobileAppearanceMode.dark,
        language: MobileLanguage.english,
        accent: 'blue',
      );
      final restored = MobileDisplayPreferences();
      await restored.restore();
      expect(restored.appearance, MobileAppearanceMode.dark);
      expect(restored.language, MobileLanguage.english);
      expect(restored.accent, 'blue');
      final saved = await SharedPreferences.getInstance();
      expect(saved.getKeys(), everyElement(startsWith('soduwork_mobile.')));
      prefs.dispose();
      restored.dispose();
    },
  );
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
