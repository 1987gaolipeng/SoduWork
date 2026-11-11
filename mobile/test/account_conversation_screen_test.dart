import 'package:soduwork_mobile/screens/conversation_search.dart';
import 'memory_device_auth.dart';
import 'dart:convert';
import 'dart:ui' show SemanticsAction;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/models/account_conversation.dart';
import 'package:soduwork_mobile/screens/account_conversation_screen.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/conversation_drawer.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';

import 'account_conversation_sync_test.dart' as fixture;

void main() {
  testWidgets(
    'rich account replies retain native body semantics and message identity',
    (tester) async {
      final semantics = tester.ensureSemantics();
      final state = await ready(
        MockClient(
          (_) async => json({
            ...fixture.page([
              fixture.message(
                'rich',
                0,
                1,
                '## 完整成果标题\n\n第一段完整正文。\n\n第二段完整正文。\n\n[查看报告](https://example.com/report)\n\n```text\n完整代码内容\n```',
              ),
            ], 1),
            'conversation': fixture.row('conversation-one', 1),
          }),
        ),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(
        harness(
          state,
          AccountConversationScreen(
            conversation: AccountConversation.fromJson(
              fixture.row('conversation-one', 1),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('rich')), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp('完整成果标题')), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp('第一段完整正文。')), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp('第二段完整正文。')), findsOneWidget);
      final linkRoot = tester.getSemantics(
        find.text('查看报告', findRichText: true),
      );
      var accessibleLinks = 0;
      linkRoot.visitChildren((node) {
        final data = node.getSemanticsData();
        if (data.label == '查看报告' &&
            data.flagsCollection.isLink &&
            data.hasAction(SemanticsAction.tap)) {
          accessibleLinks++;
        }
        return true;
      });
      expect(accessibleLinks, 1);
      expect(
        tester.getSemantics(find.byTooltip('复制代码')).getSemanticsData().tooltip,
        '复制代码',
      );
      expect(find.byType(TextField), findsNothing);
      await tester.pumpWidget(const SizedBox.shrink());
      semantics.dispose();
    },
  );
  testWidgets(
    'a synced PC transcript is readable without exposing execution controls',
    (tester) async {
      final semantics = tester.ensureSemantics();
      final requests = <Uri>[];
      final state = await ready(
        MockClient((request) async {
          requests.add(request.url);
          expect(request.headers['Authorization'], 'Device test-session');
          return json({
            ...fixture.page([
              {...fixture.message('first', 0, 1, '手机里看到电脑的提问'), 'role': 'user'},
              fixture.message('second', 1, 2, '这是来源电脑的回答'),
            ], 2),
            'conversation': fixture.row('conversation-one', 1),
          });
        }),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(
        harness(
          state,
          AccountConversationScreen(
            conversation: AccountConversation.fromJson(
              fixture.row('conversation-one', 1),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('手机里看到电脑的提问'), findsOneWidget);
      expect(find.text('这是来源电脑的回答'), findsOneWidget);
      expect(find.bySemanticsLabel('这是来源电脑的回答'), findsOneWidget);
      expect(find.byTooltip('复制消息'), findsNWidgets(2));
      expect(find.byType(TextField), findsNothing);
      expect(find.text('叫停'), findsNothing);
      expect(
        requests.single.path,
        '/api/v1/account-conversations/conversation-one/messages',
      );
      expect(requests.single.queryParameters, {'after': '0', 'limit': '100'});
      state.phase = MobilePhase.pendingActivation;
      state.notifyListeners();
      await tester.pump();
      expect(find.text('手机里看到电脑的提问'), findsNothing);
      expect(find.text('这是来源电脑的回答'), findsNothing);
      expect(find.text('会话已关闭'), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
      semantics.dispose();
    },
  );

  testWidgets(
    'drawer filters computer conversations and archive state from real projection',
    (tester) async {
      final state = await ready(MockClient((_) async => json({})));
      addTearDown(state.dispose);
      await state.accountConversations.refresh(
        isCurrent: () => true,
        load: ({required after, required limit}) async => fixture.page([
          {...fixture.row('current', 1), 'title': '电脑周报'},
          {...fixture.row('archived', 2, archived: true), 'title': '归档记录'},
        ], 2),
      );
      AccountConversation? opened;
      await tester.pumpWidget(
        harness(
          state,
          Scaffold(
            body: ConversationDrawer(
              state: state,
              dark: false,
              onNew: () {},
              onDestination: (_) {},
              onEntry: (_) {},
              onTheme: () {},
              onAccountEntry: (row) => opened = row,
              onSearch: () => showConversationSearch(
                tester.element(find.byType(ConversationDrawer)),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('电脑周报'), findsOneWidget);
      expect(find.text('归档记录'), findsNothing);
      await tester.tap(find.text('电脑周报'));
      expect(opened?.id, 'current');
      await tester.tap(find.byTooltip('会话选项'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('已归档'));
      await tester.pumpAndSettle();
      expect(find.text('归档记录'), findsOneWidget);
      expect(find.text('电脑周报'), findsNothing);
      await tester.tap(find.byTooltip('搜索会话'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('conversation-search-input')),
        '不存在',
      );
      await tester.pump();
      expect(
        find.descendant(
          of: find.byType(ConversationSearch),
          matching: find.text('归档记录'),
        ),
        findsNothing,
      );
      expect(find.text('无结果'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  test(
    'account directory API uses its own incremental read endpoint',
    () async {
      final state = await ready(
        MockClient((request) async {
          expect(request.method, 'GET');
          expect(request.url.path, '/api/v1/account-conversations');
          expect(request.url.queryParameters, {'after': '21', 'limit': '50'});
          return json(fixture.page([], 21));
        }),
      );
      addTearDown(state.dispose);
      expect(
        (await state.api.accountConversations(after: 21, limit: 50))['cursor'],
        21,
      );
    },
  );
}

Widget harness(MobileState state, Widget page) => MaterialApp(
  theme: SoduWorkTheme.light(),
  home: MobileScope(state: state, child: page),
);

http.Response json(Object body) => http.Response(
  jsonEncode(body),
  200,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

Future<MobileState> ready(http.Client client) async {
  final state = MobileState(store: TestStore());
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
    deviceId: 'fixture-phone',
    deviceName: '测试手机',
    authState: 'active',
    ownerUserId: 'test-user',
  );
  return state;
}

class TestStore extends DeviceStore with MemoryDeviceAuthentication {
  @override
  Future<void> init() async {}
  @override
  EndpointSettings loadEndpoint() => const EndpointSettings(
    environment: SoduWorkEnvironment.development,
    baseUrl: 'http://fixture.test',
  );
  @override
  Future<String?> readSession(String endpoint) async => 'test-session';
}
