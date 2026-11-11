import 'package:flutter/gestures.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/semantics.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:soduwork_mobile/models/conversation_models.dart';
import 'package:soduwork_mobile/models/work_models.dart';
import 'package:soduwork_mobile/core/cloud_conversation_request.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/direct_work_sender.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/mobile_app.dart';
import 'package:soduwork_mobile/screens/app_shell.dart';
import 'package:soduwork_mobile/screens/cloud_conversation_screen.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/sdk/soduwork_sdk_config.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/adaptive_conversation_input.dart';
import 'package:soduwork_mobile/ui/mobile_sidebar_surface.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';
import 'package:soduwork_mobile/ui/open_work_conversation.dart';

void main() {
  test('skill selection order does not change a retry request', () async {
    final state = _State()..fail = true;
    addTearDown(state.dispose);
    await expectLater(
      sendWorkDirectly(
        state,
        text: '继续工作',
        agentId: 'pi',
        skills: ['z-skill', 'a-skill'],
      ),
      throwsA(isA<ApiFailure>()),
    );
    final requestId = state.pendingCloudRequest!.id;
    await expectLater(
      sendWorkDirectly(
        state,
        text: '继续工作',
        agentId: 'pi',
        skills: ['z-skill', 'other-skill'],
      ),
      throwsA(isA<ApiFailure>()),
    );
    expect(state.posts, 1);
    state.fail = false;
    await sendWorkDirectly(
      state,
      text: '继续工作',
      agentId: 'pi',
      skills: [' z-skill ', 'a-skill', 'z-skill'],
    );
    expect(state.ids, [requestId, requestId]);
    expect(state.lastOptions?['requiredSkills'], ['a-skill', 'z-skill']);
  });

  setUp(() => SharedPreferences.setMockInitialValues({}));
  for (final width in [320.0, 390.0]) {
    testWidgets(
      'work EditableText keeps one identity and focus through keyboard/layout frames at $width',
      (tester) async {
        tester.view.physicalSize = Size(width, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        addTearDown(tester.view.resetViewInsets);
        final semanticsHandle = tester.ensureSemantics();
        final focus = FocusNode(), text = TextEditingController();
        var notifications = 0;
        focus.addListener(() => notifications++);
        addTearDown(focus.dispose);
        addTearDown(text.dispose);
        await tester.pumpWidget(
          MaterialApp(
            theme: SoduWorkTheme.light(),
            home: Scaffold(
              body: Align(
                alignment: Alignment.bottomCenter,
                child: AdaptiveConversationInput(
                  workMode: true,
                  controller: text,
                  focusNode: focus,
                  voiceScopeKey: 'stable-real-input',
                  inputKey: const Key('stable-input'),
                  hint: '工作内容',
                  onChanged: (_) {},
                  onTranscript: (_) {},
                  add: IconButton(
                    onPressed: () {},
                    icon: const Icon(CupertinoIcons.plus),
                  ),
                  model: TextButton(onPressed: () {}, child: const Text('模型')),
                  send: IconButton(
                    onPressed: () {},
                    icon: const Icon(CupertinoIcons.arrow_up),
                  ),
                ),
              ),
            ),
          ),
        );
        final fieldGroup = find.descendant(
          of: find.byType(AdaptiveConversationInput),
          matching: find.byWidgetPredicate((widget) {
            if (widget is! Semantics) return false;
            final key = widget.properties.sortKey;
            return key is OrdinalSortKey && key.order == 0;
          }),
        );
        final originalSemanticId = tester.getSemantics(fieldGroup).id;
        final initialField = tester.widget<EditableText>(
          find.byType(EditableText),
        );
        expect(initialField.maxLines, 6);
        expect(initialField.keyboardType, TextInputType.multiline);
        final original = tester.state<EditableTextState>(
          find.byType(EditableText),
        );
        await tester.tap(find.byKey(const Key('stable-input')));
        for (var i = 0; i < 20; i++) {
          await tester.pump(const Duration(milliseconds: 16));
          expect(focus.hasFocus, isTrue);
        }
        tester.view.viewInsets = const FakeViewPadding(bottom: 300);
        await tester.pumpAndSettle();
        expect(
          identical(
            original,
            tester.state<EditableTextState>(find.byType(EditableText)),
          ),
          isTrue,
        );
        expect(notifications, 1);
        expect(focus.hasFocus, isTrue);
        expect(tester.getSemantics(fieldGroup).id, originalSemanticId);
        final focusedField = tester.widget<EditableText>(
          find.byType(EditableText),
        );
        expect(focusedField.maxLines, initialField.maxLines);
        expect(focusedField.keyboardType, initialField.keyboardType);
        await tester.enterText(
          find.byKey(const Key('stable-input')),
          '一次点击即可连续输入',
        );
        await tester.pumpAndSettle();
        expect(text.text, '一次点击即可连续输入');
        expect(notifications, 1);
        expect(tester.takeException(), isNull);
        semanticsHandle.dispose();
      },
    );
  }
  testWidgets(
    'sidebar drag pushes a rounded main card and click on the card closes it',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final key = GlobalKey<MobileSidebarSurfaceState>();
      await tester.pumpWidget(
        MaterialApp(
          home: MobileSidebarSurface(
            key: key,
            surface: Colors.white,
            sidebar: const Center(child: Text('侧栏内容')),
            child: const Scaffold(body: Center(child: Text('主页面'))),
          ),
        ),
      );
      final card = find.byKey(const Key('sidebar-main-card'));
      expect(tester.getTopLeft(card).dx, 0);
      final drag = await tester.createGesture(kind: PointerDeviceKind.touch);
      await drag.down(const Offset(8, 300));
      for (var i = 1; i <= 5; i++) {
        await drag.moveBy(
          const Offset(55, 0),
          timeStamp: Duration(milliseconds: 100 * i),
        );
        await tester.pump(const Duration(milliseconds: 100));
      }
      await drag.up(timeStamp: const Duration(milliseconds: 600));
      await tester.pumpAndSettle();
      expect(tester.getTopLeft(card).dx, greaterThan(250));
      expect(
        (tester.widget<ClipRRect>(card).borderRadius as BorderRadius).topLeft.x,
        greaterThanOrEqualTo(30),
      );
      await tester.tapAt(const Offset(355, 350));
      await tester.pumpAndSettle();
      expect(tester.getTopLeft(card).dx, 0);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'locked standalone service opens the login form from welcome before any enrollment',
    (tester) async {
      final state = _State(locked: true)..phase = MobilePhase.disconnected;
      addTearDown(state.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: SoduWorkWorkspace(
            state: state,
            configuration: const SoduWorkSdkConfiguration(
              autoConnect: false,
              serviceBaseUrl: 'http://fixture.test',
              lockServiceEndpoint: true,
            ),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.byKey(const Key('welcome-sign-in')), findsOneWidget);
      expect(find.byType(TextField), findsNothing);
      await tester.tap(find.byKey(const Key('welcome-sign-in')));
      await tester.pumpAndSettle();
      expect(find.widgetWithText(TextField, '账号'), findsOneWidget);
      expect(find.widgetWithText(TextField, '密码'), findsOneWidget);
      expect(find.text('登录并继续'), findsOneWidget);
      expect(state.posts, 0);
    },
  );
  testWidgets(
    'sending stays in the same shell and new conversation keeps the sidebar',
    (tester) async {
      FlutterSecureStorage.setMockInitialValues({});
      final state = _State();
      addTearDown(state.dispose);
      await tester.pumpWidget(
        MobileScope(
          state: state,
          child: MaterialApp(theme: SoduWorkTheme.light(), home: const AppShell()),
        ),
      );
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('home-composer')), '执行工作');
      await tester.pump();
      await tester.tap(find.byKey(const Key('home-send')));
      await tester.pumpAndSettle();
      expect(state.posts, 1);
      expect(find.byType(CloudConversationScreen), findsOneWidget);
      expect(
        tester
            .widget<CloudConversationScreen>(
              find.byType(CloudConversationScreen),
            )
            .embedded,
        isTrue,
      );
      expect(find.byTooltip('打开侧栏'), findsOneWidget);
      expect(find.byTooltip('Back'), findsNothing);
      expect(find.text('测试工作结果'), findsOneWidget);
      await tester.tap(find.byTooltip('新对话'));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('home-composer')), findsOneWidget);
      expect(state.posts, 1);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'a conversation opened from a pushed workspace route returns to the existing main surface',
    (tester) async {
      FlutterSecureStorage.setMockInitialValues({});
      final state = _State();
      addTearDown(state.dispose);
      final observer = _ConversationRoutes();
      await tester.pumpWidget(
        MobileScope(
          state: state,
          child: MaterialApp(
            theme: SoduWorkTheme.light(),
            navigatorObservers: [observer],
            home: const AppShell(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final originalShell = tester.element(find.byType(AppShell));
      final navigator = tester.state<NavigatorState>(
        find.byType(Navigator).first,
      );
      navigator.push(
        MaterialPageRoute<void>(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () => openWorkConversation(
                context,
                taskId: 'task-one',
                title: '接续工作',
                ref: 'existing-ref',
              ),
              child: const Text('从旧入口接续'),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final pushes = observer.pushes;
      await tester.tap(find.text('从旧入口接续'));
      await tester.pumpAndSettle();
      expect(
        observer.pushes,
        pushes,
        reason: 'opening work must not push another execution page',
      );
      expect(tester.element(find.byType(AppShell)), same(originalShell));
      expect(navigator.canPop(), isFalse);
      expect(
        tester
            .widget<CloudConversationScreen>(
              find.byType(CloudConversationScreen),
            )
            .embedded,
        isTrue,
      );
      expect(find.byTooltip('打开侧栏'), findsOneWidget);
      expect(find.text('测试工作结果'), findsOneWidget);
      expect(state.lastSessionRef, 'existing-ref');
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
  test(
    'direct work send reports a missing environment without creating or submitting a request',
    () async {
      final state = _State()..empty = true;
      addTearDown(state.dispose);
      await expectLater(
        sendWorkDirectly(state, text: '你好', model: 'model'),
        throwsA(
          isA<ApiFailure>().having(
            (e) => e.message,
            'message',
            contains('执行环境'),
          ),
        ),
      );
      expect(state.posts, 0);
      expect(state.pendingCloudRequest, isNull);
    },
  );
  test(
    'personal target can execute a selected model even when the general roster is empty',
    () async {
      final state = _State();
      addTearDown(state.dispose);
      await sendWorkDirectly(state, text: '执行工作', model: 'chosen-model');
      expect(state.lastOptions?['model'], 'chosen-model');
      expect(state.lastOptions?['agentId'], 'pi');
      expect(state.posts, 1);
    },
  );
  test(
    'explicit unavailable foundation never silently falls back to a different agent',
    () async {
      final state = _State();
      addTearDown(state.dispose);
      await expectLater(
        sendWorkDirectly(state, text: '执行工作', agentId: 'missing-agent'),
        throwsA(isA<ApiFailure>()),
      );
      expect(state.posts, 0);
      expect(state.pendingCloudRequest, isNull);
      await sendWorkDirectly(state, text: '执行工作', agentId: 'pi');
      expect(state.lastOptions?['agentId'], 'pi');
    },
  );
  test(
    'uncertain direct work send retries the same request and refuses changed content',
    () async {
      final state = _State()..fail = true;
      addTearDown(state.dispose);
      await expectLater(
        sendWorkDirectly(state, text: '执行明确的任务', model: 'model'),
        throwsA(isA<ApiFailure>()),
      );
      final id = state.pendingCloudRequest!.id;
      await expectLater(
        sendWorkDirectly(state, text: '另外一件事', model: 'model'),
        throwsA(isA<ApiFailure>()),
      );
      expect(state.posts, 1);
      expect(state.pendingCloudRequest!.id, id);
      state.fail = false;
      final receipt = await sendWorkDirectly(
        state,
        text: '执行明确的任务',
        model: 'model',
      );
      expect(receipt['taskId'], 'task-one');
      expect(state.ids, [id, id]);
      expect(state.pendingCloudRequest, isNull);
    },
  );
}

class _State extends MobileState {
  bool empty = false, fail = false;
  String lastSessionRef = '';
  int posts = 0;
  final ids = <String>[];
  Map<String, dynamic>? lastOptions;
  _State({bool locked = false}) : super(endpointLocked: locked) {
    endpoint = const EndpointSettings(
      environment: SoduWorkEnvironment.development,
      baseUrl: 'http://fixture.test',
    );
    api = SoduWorkApi(store: store, endpoint: endpoint);
    phase = MobilePhase.ready;
  }
  @override
  Future<Map<String, dynamic>> loadConversationSession(
    String taskId, {
    String ref = '',
    int since = 0,
  }) async {
    lastSessionRef = ref;
    return {
      'ok': true,
      'status': 'done',
      'last': 2,
      'ref': 'fixture-ref',
      'items': [
        {'seq': 1, 'kind': 'user', 'text': '执行工作'},
        {'seq': 2, 'kind': 'say', 'text': '测试工作结果'},
      ],
    };
  }

  @override
  Future<AiExecutionStatus> loadAiStatus(String taskId) async =>
      AiExecutionStatus.fromJson({'ok': true, 'status': 'done'});
  @override
  Future<List<ConversationAttachment>> loadConversationAttachments(
    String taskId,
  ) async => [];
  @override
  Future<Map<String, dynamic>> loadConversationDelivery(String taskId) async =>
      {};
  @override
  Future<void> restorePendingBranch() async {}
  @override
  Future<Map<String, dynamic>> cloudConversationTargets() async => {
    'targets': empty
        ? []
        : [
            {
              'id': 'runner',
              'agentId': 'pi',
              'model': 'model',
              'remote': true,
              'online': true,
              'type': 'agent',
              'modelPick': true,
            },
          ],
  };
  @override
  Future<void> rememberCloudRequest(CloudConversationRequest request) async {
    pendingCloudRequest = request;
  }

  @override
  Future<Map<String, dynamic>> startCloudConversation({
    required String text,
    String agentId = '',
    String model = '',
    String title = '',
    List files = const [],
    CloudConversationRequest? request,
  }) async {
    posts++;
    ids.add(request!.id);
    lastOptions = request.options;
    if (fail) throw const ApiFailure('fixture timeout', isNetwork: true);
    pendingCloudRequest = null;
    return {'ok': true, 'taskId': 'task-one'};
  }
}

class _ConversationRoutes extends NavigatorObserver {
  int pushes = 0;
  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    pushes++;
  }
}
