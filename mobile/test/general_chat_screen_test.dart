import 'package:flutter/material.dart';
import 'package:http/testing.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/screens/general_chat_screen.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';

void main() {
  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
    // Initialize the plugin before entering the widget fake-async zone.
    await SharedPreferences.getInstance();
  });
  testWidgets(
    'chat model popover keeps workspace scope and clears after account switch',
    (tester) async {
      final state = _State(owner: 'popover-owner');
      addTearDown(state.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: SoduWorkTheme.light(),
          home: MobileScope(
            state: state,
            child: Navigator(
              onGenerateRoute: (_) =>
                  MaterialPageRoute(builder: (_) => const GeneralChatScreen()),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), '保留模型切换草稿');
      await tester.tap(find.widgetWithText(TextButton, '隔离聊天模型'));
      await tester.pumpAndSettle();
      expect(find.text('聊天模型'), findsOneWidget);
      expect(find.widgetWithText(ListTile, '隔离聊天模型'), findsOneWidget);
      expect(state.synced, 0);
      expect(state.configReads, 0);
      state.switchIdentity();
      await tester.pumpAndSettle();
      expect(find.widgetWithText(ListTile, '隔离聊天模型'), findsNothing);
      expect(find.text('账号已变化，请关闭后重新选择。'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.tap(find.byTooltip('关闭'));
      await tester.pumpAndSettle();
      expect(find.text('保留模型切换草稿'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'ordinary chat sends the first message without a Runner and retains uncertain records',
    (tester) async {
      final state = _State(owner: 'initial-owner');
      addTearDown(state.dispose);
      var accepted = 0;
      await tester.pumpWidget(
        MobileScope(
          state: state,
          child: MaterialApp(
            theme: SoduWorkTheme.light(),
            home: GeneralChatScreen(
              initialText: '请解释一下光合作用',
              onInitialAccepted: () => accepted++,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(state.catalogReads, 1);
      expect(state.synced, 1);
      expect(state.configReads, 0);
      expect(accepted, 1);
      expect(find.text('请解释一下光合作用'), findsOneWidget);
      expect(find.textContaining('隔离Hub暂不可用'), findsOneWidget);
      final input = tester.widget<TextField>(find.byType(TextField));
      expect(input.controller!.text, isEmpty);
      expect(tester.widget<IconButton>(_sendButton).onPressed, isNull);
      state.switchIdentity();
      await tester.pumpAndSettle();
      expect(find.text('请解释一下光合作用'), findsNothing);
      expect(find.text('账号已变化，请返回后重新打开聊天。'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
  testWidgets(
    'new chat is sendable before it has messages and does not call a model just by opening',
    (tester) async {
      final state = _State(owner: 'empty-owner');
      addTearDown(state.dispose);
      await tester.pumpWidget(
        MobileScope(
          state: state,
          child: MaterialApp(
            theme: SoduWorkTheme.light(),
            home: const GeneralChatScreen(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(state.configReads, 0);
      expect(state.synced, 0);
      await tester.enterText(find.byType(TextField), '一个新问题');
      await tester.pump();
      expect(tester.widget<IconButton>(_sendButton).onPressed, isNotNull);
      await tester.tap(_sendButton);
      await tester.pumpAndSettle();
      expect(state.synced, 1);
      expect(find.text('一个新问题'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
}

Finder get _sendButton => find.byWidgetPredicate(
  (widget) => widget is IconButton && widget.tooltip == '发送',
);

class _Api extends SoduWorkApi {
  int catalogReads = 0, synced = 0, configReads = 0;
  _Api()
    : super(
        store: DeviceStore(),
        client: MockClient((request) async {
          throw StateError('Unexpected isolated API request');
        }),
        endpoint: const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'https://unit.test',
        ),
      );
  @override
  Future<Map<String, dynamic>> chatModelCatalog() async {
    catalogReads++;
    return {
      'usable': [
        {'name': 'unit', 'label': '隔离聊天模型', 'kind': 'openai-compat'},
      ],
    };
  }

  @override
  Future<Map<String, dynamic>> syncAccountConversation(
    Map<String, dynamic> body,
  ) async {
    synced++;
    throw const ApiFailure('隔离Hub暂不可用', status: 503);
  }

  @override
  Future<Map<String, dynamic>> chatModelConfiguration(String model) async {
    configReads++;
    throw StateError('must not charge');
  }
}

class _State extends MobileState {
  final chatApi = _Api();
  int revision = 1;
  _State({required String owner}) {
    api = chatApi;
    phase = MobilePhase.ready;
    enrollment = EnrollmentState(
      active: true,
      deviceId: 'unit-device',
      deviceName: 'Unit',
      authState: 'active',
      ownerUserId: owner,
    );
  }
  int get catalogReads => chatApi.catalogReads;
  int get synced => chatApi.synced;
  int get configReads => chatApi.configReads;
  @override
  int get identityRevision => revision;
  @override
  void dispose() {
    chatApi.client.close();
    super.dispose();
  }

  void switchIdentity() {
    revision++;
    notifyListeners();
  }
}
